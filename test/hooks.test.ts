import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { usageLog } from '../src/store.ts';
import { makeRepo, makeStore, spec, tmp, topics } from './helpers.ts';

const APP = 'repos/github.com/acme/app';

const hook = (name: string, store: string, input: object) =>
  execFileSync('node', ['src/hooks.ts', name], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, AGENT_MEMORY_DIR: store },
  });

describe('hooks', () => {
  it('should print index grouped by scope → topic on session start', () => {
    const store = makeStore({
      'org/_topics.md': topics(['git', 'Git workflow', 'Covers commits, not CI']),
      'org/git.md': spec('git', 'Branch and commit rules'),
      [`${APP}/_topics.md`]: topics(['testing', 'How tests run', 'Covers runner, not CI']),
      [`${APP}/testing.md`]: spec('testing', 'Use npm test'),
      [`${APP}/packages/ui/_topics.md`]: topics(['styling', 'CSS conventions', 'Covers CSS, not JS']),
      [`${APP}/packages/ui/styling.md`]: spec('styling', 'Tokens only'),
    });
    const repo = makeRepo('git@github.com:acme/app.git', { '.agent-memory.json': JSON.stringify({ scopes: ['packages/*'] }) });
    mkdirSync(join(repo, 'packages/ui'), { recursive: true });

    const out = hook('session-start', store, { session_id: 's1', cwd: join(repo, 'packages/ui') });

    assert.match(
      out,
      new RegExp(
        `## org\\n- git — Git workflow \\| Branch and commit rules\\n` +
          `## ${APP}\\n- testing — How tests run \\| Use npm test\\n` +
          `## ${APP}/packages/ui\\n- styling — CSS conventions \\| Tokens only`,
      ),
    );
    assert.match(out, /TOPIC STRUCTURE IS EXTREMELY IMPORTANT/);
    assert.match(out, /built-in memory only for personal user preferences/);
  });

  it('should copy transcript + meta into inbox/ on session end', () => {
    const store = makeStore();
    const repo = makeRepo('git@github.com:acme/app.git');
    const transcript = join(tmp(), 't.jsonl');
    writeFileSync(transcript, '{"type":"user"}\n');

    hook('session-end', store, { session_id: 's1', cwd: repo, transcript_path: transcript });

    assert.equal(readFileSync(join(store, 'inbox/s1.jsonl'), 'utf8'), '{"type":"user"}\n');
    assert.deepEqual(JSON.parse(readFileSync(join(store, 'inbox/s1.json'), 'utf8')), {
      session_id: 's1',
      repo: APP,
      scope: APP,
      scopes: ['org', APP],
      cwd: repo,
    });
  });

  it('should log session event with source on session start', () => {
    const store = makeStore();
    const repo = makeRepo('git@github.com:acme/app.git');

    hook('session-start', store, { session_id: 's1', cwd: repo, source: 'resume' });

    const { ts, ...event } = JSON.parse(readFileSync(usageLog(store), 'utf8'));
    assert.match(ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(event, { session: 's1', event: 'session', source: 'resume', scopes: ['org', APP] });
  });
});
