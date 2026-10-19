import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { hashUser } from '../src/hooks.ts';
import { pull } from '../src/pull.ts';
import { git, writeFile } from '../src/store.ts';
import { makeRepo, makeStore, tmp } from './helpers.ts';

const line = (cwd: string, text: string) => JSON.stringify({ type: 'user', cwd, message: { content: text } }) + '\n';

// Fake ssh: runs the remote command locally with HOME set to a fake devbox home; host "down" fails.
function fakeSsh(): string {
  const home = tmp();
  const bin = join(tmp(), 'ssh');
  writeFile(
    bin,
    `#!/bin/sh
for a; do h=$c; c=$a; done
[ "$h" = down ] && { echo "ssh: connect to host down port 22: Connection refused" >&2; exit 255; }
HOME=${JSON.stringify(home)} exec sh -c "$c"
`,
  );
  chmodSync(bin, 0o755);
  process.env.AGENT_MEMORY_SSH = bin;
  return home;
}

const transcript = (home: string, id: string, content: string, mtime?: Date) => {
  const path = join(home, '.claude/projects/-proj', `${id}.jsonl`);
  writeFile(path, content);
  if (mtime) utimesSync(path, mtime, mtime);
};

const meta = (store: string, id: string) => JSON.parse(readFileSync(join(store, 'inbox', `${id}.json`), 'utf8'));

describe('pull', () => {
  it('should copy remote transcripts into inbox with repo, scope, user hash and host from remote cwd', () => {
    const home = fakeSsh();
    const repo = makeRepo('git@github.com:acme/mono.git', { '.agent-memory.json': JSON.stringify({ scopes: ['packages/*'] }, null, 2) });
    git(repo, 'config', 'user.email', 'dev@acme.com');
    const cwd = join(repo, 'packages/api');
    mkdirSync(cwd, { recursive: true });
    transcript(home, 's1', line(cwd, 'use pnpm'));
    const store = makeStore({ 'remotes.json': JSON.stringify({ box: '' }) });

    pull(store);

    assert.equal(readFileSync(join(store, 'inbox/s1.jsonl'), 'utf8'), line(cwd, 'use pnpm'));
    assert.deepEqual(meta(store, 's1'), {
      session_id: 's1',
      user: hashUser('dev@acme.com'),
      repo: 'repos/github.com/acme/mono',
      scope: 'repos/github.com/acme/mono/packages/api',
      scopes: ['org', 'repos/github.com/acme/mono', 'repos/github.com/acme/mono/packages/api'],
      cwd,
      host: 'box',
      offset: 0,
    });
  });

  it('should only fetch transcripts changed since watermark, advance watermark and offset past processed lines', () => {
    const home = fakeSsh();
    const cwd = tmp();
    transcript(home, 'old', line(cwd, 'a'), new Date('2020-01-01'));
    transcript(home, 's2', line(cwd, 'a') + line(cwd, 'b'));
    const store = makeStore({ 'remotes.json': JSON.stringify({ box: '202501010000.00' }), 'inbox/processed/s2.jsonl': line(cwd, 'a') });

    pull(store);

    assert.equal(existsSync(join(store, 'inbox/old.json')), false);
    assert.equal(meta(store, 's2').offset, 1);
    assert.deepEqual(meta(store, 's2').scopes, ['org']);
    const { box } = JSON.parse(readFileSync(join(store, 'remotes.json'), 'utf8'));
    assert.match(box, /^\d{12}\.\d{2}$/);
    assert.ok(box > '202501010000.00');
  });

  it('should keep watermark of failed host and still pull other hosts', () => {
    const home = fakeSsh();
    transcript(home, 's3', line(tmp(), 'a'));
    const store = makeStore({ 'remotes.json': JSON.stringify({ down: '202501010000.00', box: '' }) });

    pull(store);

    assert.equal(JSON.parse(readFileSync(join(store, 'remotes.json'), 'utf8')).down, '202501010000.00');
    assert.equal(meta(store, 's3').host, 'box');
  });

  it('should exit locked without pulling when a dream holds the lock', () => {
    const home = fakeSsh();
    transcript(home, 's4', line(tmp(), 'a'));
    const store = makeStore({ 'remotes.json': JSON.stringify({ box: '' }) });
    mkdirSync(join(store, '.git/dream.lock'));

    const r = spawnSync(process.execPath, [join(import.meta.dirname, '../src/pull.ts')], { env: { ...process.env, AGENT_MEMORY_DIR: store }, encoding: 'utf8' });

    assert.equal(r.status, 1);
    assert.match(r.stdout, /locked: a dream is running/);
    assert.equal(existsSync(join(store, 'inbox/s4.json')), false);
  });
});
