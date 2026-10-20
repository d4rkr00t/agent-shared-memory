import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dream } from '../src/dream.ts';
import { git, writeFile } from '../src/store.ts';
import { makeStore, spec, tmp, topics } from './helpers.ts';

const APP = 'repos/github.com/acme/app';
const PROPOSAL = (runs = 0) => `---\nsource: session\nscope: ${APP}\ntopic: testing\nsessions: s0\nruns: ${runs}\n---\n\nwhy\n`;

type Pass = 'propose' | 'converge' | 'verify';

// Fake claude: runs the JS snippet for the pass named in the prompt, with fs/path/cwd/prompt in scope.
function fakeClaude(handlers: Partial<Record<Pass, string>>): string {
  const bin = join(tmp(), 'claude');
  const cases = Object.entries(handlers).map(([pass, code]) => `if (prompt.includes('PASS: ${pass}')) { ${code} }`);
  writeFile(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), cwd = process.cwd();
const prompt = process.argv[process.argv.indexOf('-p') + 1];
const report = (prompt.match(/write (dreams\\/\\S+\\.md)/) || [])[1];
const write = (p, s) => { fs.mkdirSync(path.dirname(path.join(cwd, p)), { recursive: true }); fs.writeFileSync(path.join(cwd, p), s); };
fs.appendFileSync(${JSON.stringify(bin + '.calls')}, prompt.split('\\n')[0] + '\\n');
${cases.join('\n')}
`,
  );
  chmodSync(bin, 0o755);
  process.env.AGENT_MEMORY_CLAUDE = bin;
  return bin;
}

const calls = (bin: string) => (existsSync(bin + '.calls') ? readFileSync(bin + '.calls', 'utf8').trim().split('\n') : []);

const ACCEPT_TESTING = `
write('${APP}/_topics.md', ${JSON.stringify(topics(['testing', 'Tests', 'Covers tests, not CI']))});
write('${APP}/testing.md', ${JSON.stringify(spec('testing', 'Tests', ['Runner', 'Tests SHALL run with npm test.\nEvidence: s0, s1']))});
const id = fs.readdirSync(path.join(cwd, 'changes')).find((d) => d.startsWith('c-'));
write(report, '- ACCEPT changes/' + id + ' -> ${APP}\\n');`;

function storeWithInbox() {
  const store = makeStore();
  writeFile(join(store, 'inbox/s1.jsonl'), JSON.stringify({ type: 'user', message: { content: 'use npm test' } }) + '\n');
  writeFile(join(store, 'inbox/s1.json'), JSON.stringify({ session_id: 's1', user: 'u1', repo: APP, scope: APP, cwd: '/x' }));
  return store;
}

describe('dream', () => {
  it('should commit pass-1 changes to main and move transcripts to processed', () => {
    const store = storeWithInbox();
    fakeClaude({
      propose: `const sessions = process.argv[process.argv.indexOf('--add-dir') + 1];
const s1 = fs.readFileSync(path.join(sessions, 'sessions/s1.md'), 'utf8');
if (!s1.includes('user: u1') || !s1.includes('USER: use npm test')) process.exit(1);
write('changes/c-1/proposal.md', ${JSON.stringify(PROPOSAL())});`,
      converge: `write(report, '- PENDING changes/c-1\\n');`,
      verify: `console.log('REJECT: nothing to merge');`,
    });

    dream(store);

    assert.equal(git(store, 'show', 'main:changes/c-1/proposal.md').includes('scope: ' + APP), true);
    assert.equal(existsSync(join(store, 'inbox/s1.json')), false);
    assert.equal(existsSync(join(store, 'inbox/processed/s1.json')), true);
    assert.equal(existsSync(join(store, 'inbox/processed/s1.jsonl')), true);
  });

  it('should pass zero-hit searches since last report to propose with session scopes', () => {
    const store = storeWithInbox();
    writeFile(join(store, 'dreams/2026-10-18T00-00-00-000Z.md'), '# old report\n');
    const usage = [
      { ts: '2026-10-19T00:00:00.000Z', session: 's1', event: 'session', scopes: ['org', APP] },
      { ts: '2026-10-17T00:00:00.000Z', session: 's1', event: 'search', pattern: 'before-report', total: 0 },
      { ts: '2026-10-19T00:00:01.000Z', session: 's1', event: 'search', pattern: 'jest|vitest', topic: 'testing', total: 0 },
      { ts: '2026-10-19T00:00:02.000Z', session: 's1', event: 'search', pattern: 'has-hits', total: 1 },
      { ts: '2026-10-19T00:00:03.000Z', session: 's1', event: 'search', error: 'bad regex' },
    ];
    writeFile(join(store, 'usage.jsonl'), usage.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const bin = fakeClaude({
      propose: `const work = process.argv[process.argv.indexOf('--add-dir') + 1];
if (fs.readFileSync(path.join(work, 'misses.md'), 'utf8') !== '- s1: "jest|vitest" scopes: org, ${APP} --topic testing') process.exit(1);
if (!fs.existsSync(path.join(work, 'sessions/s1.md'))) process.exit(1);`,
    });

    dream(store);

    assert.equal(calls(bin)[0], 'PASS: propose');
  });

  it('should run dream on search misses alone with empty inbox', () => {
    const store = makeStore();
    writeFile(join(store, 'usage.jsonl'), JSON.stringify({ ts: '2026-10-19T00:00:00.000Z', session: 's1', event: 'search', pattern: 'jest', total: 0 }) + '\n');
    const bin = fakeClaude({ propose: `write('changes/c-1/proposal.md', ${JSON.stringify(PROPOSAL())});`, converge: `write(report, '- PENDING changes/c-1\\n');`, verify: `console.log('REJECT: pending');` });

    dream(store);

    assert.deepEqual(calls(bin), ['PASS: propose', 'PASS: converge', 'PASS: verify']);
    assert.equal(git(store, 'show', 'main:changes/c-1/proposal.md').includes('scope: ' + APP), true);
  });

  it('should condense only lines after meta offset for re-pulled session', () => {
    const store = makeStore();
    const lines = ['already dreamed', 'new turn'].map((t) => JSON.stringify({ type: 'user', message: { content: t } }) + '\n');
    writeFile(join(store, 'inbox/s1.jsonl'), lines.join(''));
    writeFile(join(store, 'inbox/s1.json'), JSON.stringify({ session_id: 's1', user: 'u1', repo: APP, scope: APP, cwd: '/x', host: 'box', offset: 1 }));
    fakeClaude({
      propose: `const s1 = fs.readFileSync(path.join(process.argv[process.argv.indexOf('--add-dir') + 1], 'sessions/s1.md'), 'utf8');
if (s1.includes('already dreamed') || !s1.includes('USER: new turn') || !s1.includes('host: box')) process.exit(1);`,
      converge: `write(report, '- PENDING changes/none\\n');`,
      verify: `console.log('REJECT');`,
    });

    assert.equal(dream(store).status, 'rejected');
  });

  it('should merge converged specs into main and archive accepted changes on verify approve', () => {
    const store = makeStore({ 'changes/c-1/proposal.md': PROPOSAL() });
    fakeClaude({ converge: ACCEPT_TESTING, verify: `console.log('looks good\\nAPPROVE');` });

    const r = dream(store);

    assert.deepEqual(r, { status: 'merged' });
    assert.match(readFileSync(join(store, APP, 'testing.md'), 'utf8'), /Tests SHALL run with npm test/);
    assert.equal(existsSync(join(store, 'changes/c-1')), false);
    assert.match(readFileSync(join(store, 'changes/archive/c-1/proposal.md'), 'utf8'), /Archived: accepted in dream/);
    assert.equal(git(store, 'status', '--porcelain'), '');
    assert.equal(git(store, 'branch', '--list', 'dream/*'), '');
  });

  it('should leave specs untouched and keep changes pending on verify reject', () => {
    const store = makeStore({ 'changes/c-1/proposal.md': PROPOSAL() });
    fakeClaude({ converge: ACCEPT_TESTING, verify: `console.log('REJECT: evidence from one session only');` });

    const r = dream(store);

    assert.deepEqual(r, { status: 'rejected', reason: 'REJECT: evidence from one session only' });
    assert.equal(existsSync(join(store, APP, 'testing.md')), false);
    assert.match(readFileSync(join(store, 'changes/c-1/proposal.md'), 'utf8'), /runs: 1[\s\S]*Verify-rejected \d{4}-\d{2}-\d{2}: REJECT: evidence from one session only/);
    assert.match(readFileSync(join(store, 'dream.log'), 'utf8'), /REJECT: evidence from one session only/);
  });

  it('should set aside changes verify names, re-converge the rest and merge them', () => {
    const store = makeStore({ 'changes/c-1/proposal.md': PROPOSAL(), 'changes/c-2/proposal.md': PROPOSAL() });
    const bin = fakeClaude({
      converge: `const ids = fs.readdirSync(path.join(cwd, 'changes')).filter((d) => d.startsWith('c-'));
write('${APP}/_topics.md', ${JSON.stringify(topics(['testing', 'Tests', 'Covers tests, not CI']))});
write('${APP}/testing.md', ${JSON.stringify(spec('testing', 'Tests', ['Runner', 'Tests SHALL run with npm test.\nEvidence: s0']))} + (ids.includes('c-2') ? '\\n### Requirement: Bad\\nBad.\\n' : ''));
write(report, ids.map((id) => '- ACCEPT changes/' + id + ' -> ${APP}\\n').join(''));`,
      verify: `const t = fs.readFileSync(path.join(cwd, '${APP}/testing.md'), 'utf8');
console.log(t.includes('Bad') ? '- **REJECT changes/c-2: ungrounded**\\nREJECT: c-2 ungrounded' : 'APPROVE');`,
    });

    assert.deepEqual(dream(store), { status: 'merged' });
    assert.deepEqual(calls(bin), ['PASS: converge', 'PASS: verify', 'PASS: converge', 'PASS: verify']);
    const testing = readFileSync(join(store, APP, 'testing.md'), 'utf8');
    assert.match(testing, /Tests SHALL run with npm test/);
    assert.doesNotMatch(testing, /Bad/);
    assert.equal(existsSync(join(store, 'changes/archive/c-1')), true);
    assert.match(readFileSync(join(store, 'changes/c-2/proposal.md'), 'utf8'), /runs: 1[\s\S]*Verify-rejected \d{4}-\d{2}-\d{2}: REJECT: ungrounded/);
    assert.equal(git(store, 'status', '--porcelain'), '');
  });

  it('should reject run without calling verify when spec file has no registry entry', () => {
    const store = makeStore({ 'changes/c-1/proposal.md': PROPOSAL() });
    const bin = fakeClaude({
      converge: `write('${APP}/testing.md', ${JSON.stringify(spec('testing', 'Tests'))}); write(report, '- ACCEPT changes/c-1\\n');`,
      verify: `console.log('APPROVE');`,
    });

    const r = dream(store);

    assert.equal(r.status, 'rejected');
    assert.match(r.reason!, /checkTopics failed: .*testing\.md has no entry/);
    assert.deepEqual(calls(bin), ['PASS: converge']);
  });

  it('should archive change as expired after 3 runs', () => {
    const store = makeStore({ 'changes/c-1/proposal.md': PROPOSAL(2) });
    fakeClaude({ converge: `write(report, '- PENDING changes/c-1\\n');`, verify: `console.log('APPROVE');` });

    dream(store);

    assert.equal(existsSync(join(store, 'changes/c-1')), false);
    assert.match(readFileSync(join(store, 'changes/archive/c-1/proposal.md'), 'utf8'), /runs: 3[\s\S]*Archived: expired after 3 runs/);
  });

  it('should exit when another dream holds lock', () => {
    const store = makeStore({ 'changes/c-1/proposal.md': PROPOSAL() });
    const bin = fakeClaude({});
    mkdirSync(join(store, '.git/dream.lock'));

    assert.deepEqual(dream(store), { status: 'locked' });
    assert.deepEqual(calls(bin), []);
  });

  it('should exit when lock owner is alive, reclaim lock of dead owner or pre-pid lock older than 60s', () => {
    const store = makeStore();
    fakeClaude({});
    const lock = join(store, '.git/dream.lock');

    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), String(process.pid));
    assert.deepEqual(dream(store), { status: 'locked' });

    writeFileSync(join(lock, 'pid'), '999999');
    assert.equal(dream(store).status, 'empty');
    assert.equal(existsSync(lock), false);

    mkdirSync(lock);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    assert.equal(dream(store).status, 'empty');
  });
});
