import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.ts';
import { readFileSync } from 'node:fs';
import { git, usageLog } from '../src/store.ts';
import { makeRepo, makeStore, spec, topics } from './helpers.ts';

const APP = 'repos/github.com/acme/app';
const OTHER = 'repos/github.com/acme/other';

const usage = (store: string) =>
  readFileSync(usageLog(store), 'utf8').trim().split('\n').map((l) => { const { ts, ...e } = JSON.parse(l); return e; });

async function connect(cwd: string, dir: string) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(cwd, dir, 'sess-1').connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0].text, isError: !!r.isError };
  };
}

describe('memory tools', () => {
  let store: string;
  let call: Awaited<ReturnType<typeof connect>>;

  beforeEach(async () => {
    store = makeStore({
      'org/_topics.md': topics(['git', 'Git workflow', 'Covers branching and commits, not CI']),
      'org/git.md': spec('git', 'Org git rules', ['Branch names', 'Branches SHALL use the ticket key prefix.']),
      [`${APP}/_topics.md`]: topics(['testing', 'How tests run', 'Covers test runner and fixtures, not CI']),
      [`${APP}/testing.md`]: spec(
        'testing',
        'App test rules',
        ['Runner', 'Tests SHALL run with `npm test`.'],
        ['Snapshots', 'Snapshot tests SHOULD be avoided.\nStatus: disputed\nDisputed-by: sess-9'],
      ),
      [`${OTHER}/_topics.md`]: topics(['testing', 'Other tests', 'Covers tests']),
      [`${OTHER}/testing.md`]: spec('testing', 'Other', ['Runner', 'Tests SHALL run with `make test`.']),
    });
    call = await connect(makeRepo('git@github.com:acme/app.git'), store);
  });

  it('should list and read specs in readable scopes only', async () => {
    const list = await call('view');
    assert.match(list.text, /org\/git\.md/);
    assert.match(list.text, new RegExp(`${APP}/testing\\.md`));
    assert.doesNotMatch(list.text, /acme\/other/);

    assert.match((await call('view', { path: `${APP}/testing.md` })).text, /npm test/);
    assert.equal((await call('view', { path: `${OTHER}/testing.md` })).isError, true);
    assert.equal((await call('view', { path: `${APP}/../other/testing.md` })).isError, true);
  });

  it('should return matching requirement blocks with scope + topic, skip unreadable scopes', async () => {
    const r = await call('search', { pattern: 'tests shall run' });

    assert.match(r.text, /^1 match/);
    assert.match(r.text, new RegExp(`\\[${APP} / testing\\]\\n### Requirement: Runner\\nTests SHALL run with \`npm test\`\\.`));
    assert.doesNotMatch(r.text, /make test/);
  });

  it('should cap hits at 20 and report total count', async () => {
    const reqs = Array.from({ length: 25 }, (_, i) => [`R${i}`, `Rule ${i} SHALL apply.`] as [string, string]);
    store = makeStore({
      'org/_topics.md': topics(['rules', 'Rules', 'Covers rules']),
      'org/rules.md': spec('rules', 'Many rules', ...reqs),
    });
    call = await connect(makeRepo('git@github.com:acme/app.git'), store);

    const r = await call('search', { pattern: 'SHALL apply' });

    assert.match(r.text, /^25 match\(es\), showing first 20/);
    assert.equal(r.text.match(/### Requirement:/g)!.length, 20);
  });

  it('should prefix disputed requirement hits with ⚠ DISPUTED', async () => {
    const r = await call('search', { pattern: 'snapshot|npm test' });

    assert.match(r.text, /⚠ DISPUTED \[.*\]\n### Requirement: Snapshots/);
    assert.match(r.text, /\n\[.*\]\n### Requirement: Runner/);
  });

  it('should commit proposal as new change dir on main', async () => {
    const r = await call('propose', {
      scope: APP,
      topic: 'testing',
      delta: '## ADDED Requirements\n\n### Requirement: Watch mode\nTests SHOULD use `npm test -- --watch` locally.',
      why: 'User asked for watch mode twice.',
    });
    assert.equal(r.isError, false);

    const id = r.text.match(/changes\/(\S+)\./)![1];
    assert.equal(git(store, 'status', '--porcelain'), '');
    assert.match(git(store, 'log', '-1', '--format=%s'), new RegExp(`propose ${id} \\(session sess-1\\)`));
    assert.match((await call('view', { path: `changes/${id}/proposal.md` })).text, /sessions: sess-1/);
    assert.match((await call('view', { path: `changes/${id}/${APP}/testing.md` })).text, /Watch mode/);
  });

  it('should reject proposal targeting scope outside readable scopes', async () => {
    const r = await call('propose', { scope: OTHER, topic: 'testing', delta: '## ADDED Requirements\n', why: 'x' });

    assert.equal(r.isError, true);
    assert.equal(git(store, 'log', '-1', '--format=%s'), 'fixture');
  });

  it('should reject proposal for unregistered topic without new_topic', async () => {
    const delta = '## ADDED Requirements\n\n### Requirement: Deploy\nDeploys SHALL go through the pipeline.';

    const rejected = await call('propose', { scope: APP, topic: 'deploy', delta, why: 'x' });
    const accepted = await call('propose', {
      scope: APP,
      topic: 'deploy',
      delta,
      why: 'x',
      new_topic: { name: 'deploy', purpose: 'Shipping the app', boundary: 'Covers deploy steps, not CI tests' },
    });

    assert.equal(rejected.isError, true);
    assert.match(rejected.text, /not registered/);
    assert.equal(accepted.isError, false);
  });

  describe('usage log', () => {
    it('should log search with pattern, total and shown hits', async () => {
      await call('search', { pattern: 'tests shall run|nothing-here', topic: 'testing' });

      assert.deepEqual(usage(store), [
        {
          session: 'sess-1',
          event: 'search',
          pattern: 'tests shall run|nothing-here',
          topic: 'testing',
          total: 1,
          hits: [{ scope: APP, topic: 'testing', requirement: 'Runner' }],
        },
      ]);
    });

    it('should log view path and propose id', async () => {
      await call('view');
      await call('view', { path: 'org/git.md' });
      const r = await call('propose', { scope: APP, topic: 'testing', delta: '## ADDED Requirements\n', why: 'x' });
      const id = r.text.match(/changes\/(\S+)\./)![1];

      assert.deepEqual(usage(store), [
        { session: 'sess-1', event: 'view' },
        { session: 'sess-1', event: 'view', path: 'org/git.md' },
        { session: 'sess-1', event: 'propose', scope: APP, topic: 'testing', id },
      ]);
    });

    it('should log tool error message when tool throws', async () => {
      await call('view', { path: `${OTHER}/testing.md` });

      assert.deepEqual(usage(store), [{ session: 'sess-1', event: 'view', error: `not readable from this session: ${OTHER}/testing.md` }]);
    });

    it('should keep usage.jsonl out of git after propose commit', async () => {
      await call('search', { pattern: 'x' });
      await call('propose', { scope: APP, topic: 'testing', delta: '## ADDED Requirements\n', why: 'x' });

      assert.doesNotMatch(git(store, 'ls-files'), /usage\.jsonl/);
      assert.equal(git(store, 'status', '--porcelain'), '');
    });
  });
});
