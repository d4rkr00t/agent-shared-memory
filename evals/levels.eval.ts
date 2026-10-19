import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { APP1, APP2, find, session, trial } from './helpers.ts';

const registryFix = (store: string, id: string, repo: string) =>
  session(store, id, {
    repo,
    turns: [
      ['user', 'install the dependencies'],
      ['tool', 'Bash', { command: 'npm ci' }],
      ['error', 'npm error code E401\nnpm error Unable to authenticate, need: Basic realm="Artifactory Realm"'],
      ['user', 'no, public npm is blocked here. always install through our mirror: npm ci --registry=https://npm.acme.internal'],
      ['tool', 'Bash', { command: 'npm ci --registry=https://npm.acme.internal' }],
      ['assistant', 'Dependencies installed.'],
    ],
  });

describe('levels', () => {
  trial(
    'should promote to org/ when same error and fix seen in 2 repos',
    (store) => {
      registryFix(store, 's1', APP1);
      registryFix(store, 's2', APP2);
    },
    (store, status) => {
      assert.equal(status, 'merged');
      const reqs = find(store, /npm\.acme\.internal/);
      assert.ok(reqs.some((r) => r.path.startsWith('org/') && /Evidence:.*s1/.test(r.text) && /Evidence:.*s2/.test(r.text)), JSON.stringify(reqs));
    },
  );

  trial(
    'should keep single-session error and user fix at repo scope',
    (store) =>
      session(store, 's1', {
        repo: APP1,
        turns: [
          ['user', 'run the tests'],
          ['tool', 'Bash', { command: 'pytest' }],
          ['error', "ImportError while loading conftest '/work/tests/conftest.py'.\nModuleNotFoundError: No module named 'app'"],
          ['user', 'no, tests must run via `uv run pytest`, the venv is managed by uv and plain pytest uses the system python'],
          ['tool', 'Bash', { command: 'uv run pytest' }],
          ['assistant', '42 passed.'],
        ],
      }),
    (store, status) => {
      assert.equal(status, 'merged');
      const reqs = find(store, /uv run pytest/);
      assert.ok(reqs.length > 0, 'no requirement mentions uv run pytest');
      assert.ok(reqs.every((r) => r.path.startsWith(APP1 + '/')), JSON.stringify(reqs.map((r) => r.path)));
    },
  );

  trial(
    'should not store weak single-session claim',
    (store) =>
      session(store, 's1', {
        repo: APP1,
        turns: [
          ['user', 'add lodash'],
          ['assistant', 'This repo probably prefers pnpm over npm, I will keep that in mind for later.'],
          ['tool', 'Bash', { command: 'npm install lodash' }],
          ['assistant', 'Added lodash.'],
        ],
      }),
    (store) => assert.deepEqual(find(store, /pnpm/i), []),
  );
});
