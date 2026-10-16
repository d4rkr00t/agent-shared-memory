import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeRepo, makeStore, spec, topics } from './helpers.ts';

const APP = 'repos/github.com/acme/app';
const CLI = resolve('src/cli.ts');

const cli = (store: string, cwd: string, args: string[], input = '') =>
  execFileSync('node', [CLI, ...args], { cwd, input, encoding: 'utf8', env: { ...process.env, AGENT_MEMORY_DIR: store, CLAUDE_CODE_SESSION_ID: 's1' } });

describe('cli', () => {
  it('should search, view and propose within the cwd scopes', () => {
    const store = makeStore({
      [`${APP}/_topics.md`]: topics(['testing', 'How tests run', 'Covers runner, not CI']),
      [`${APP}/testing.md`]: spec('testing', 'Tests', ['Runner', 'Tests SHALL run with npm test.']),
    });
    const repo = makeRepo('git@github.com:acme/app.git');

    assert.match(cli(store, repo, ['search', 'npm test']), new RegExp(`1 match\\(es\\)[\\s\\S]*\\[${APP} / testing\\]`));
    assert.match(cli(store, repo, ['view']), new RegExp(`${APP}/testing.md`));

    const delta = '## ADDED Requirements\n### Requirement: Watch\nTests SHOULD use --watch locally.';
    const out = cli(store, repo, ['propose'], JSON.stringify({ scope: APP, topic: 'testing', delta, why: 'seen in s1' }));
    const id = out.match(/changes\/(\S+)\./)![1];
    assert.ok(existsSync(join(store, 'changes', id, APP, 'testing.md')));
  });

  it('should print usage on --help and exit 2 with usage on unknown flags', () => {
    const store = makeStore();
    const repo = makeRepo('git@github.com:acme/app.git');
    assert.match(cli(store, repo, ['--help']), /usage:/);
    assert.throws(
      () => cli(store, repo, ['search', 'x', '--nope']),
      (e: { status: number; stderr: string }) => e.status === 2 && /Unknown option[\s\S]*usage:/.test(e.stderr),
    );
  });

  it('should exit 1 with the error on invalid propose', () => {
    const store = makeStore();
    const repo = makeRepo('git@github.com:acme/app.git');
    assert.throws(
      () => cli(store, repo, ['propose'], JSON.stringify({ scope: APP, topic: 'nope', delta: 'x', why: 'y' })),
      (e: { status: number; stderr: string }) => e.status === 1 && /not registered/.test(e.stderr),
    );
  });
});
