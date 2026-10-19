import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { commit, writeFile } from '../src/store.ts';
import { APP1, find, session, spec, topics, trial } from './helpers.ts';

const UV = 'Run tests with uv';

function seed(store: string): void {
  writeFile(
    join(store, APP1, '_topics.md'),
    topics(
      ['testing', 'Running and writing tests', 'Covers test commands, runners and fixtures, not compiling or bundling (see build)'],
      ['build', 'Compiling and bundling', 'Covers tsc, bundler and build output, not tests (see testing)'],
    ),
  );
  writeFile(join(store, APP1, 'testing.md'), spec('testing', 'uv run pytest', [UV, 'When running tests, agents SHALL use `uv run pytest`; otherwise imports fail with "No module named app".\nEvidence: s0']));
  writeFile(join(store, APP1, 'build.md'), spec('build', 'npm run build', ['Build with tsc -b', 'When building, agents SHALL run `npm run build`; otherwise project references are skipped.\nEvidence: s0']));
  commit(store, 'seed');
}

const topicNames = (store: string) => [...readFileSync(join(store, APP1, '_topics.md'), 'utf8').matchAll(/^## (\S+)/gm)].map((m) => m[1]).sort();

describe('topics', () => {
  trial(
    'should place requirement in topic whose Boundary fits',
    (store) => {
      seed(store);
      session(store, 's1', {
        repo: APP1,
        turns: [
          ['user', 'run the frontend tests'],
          ['tool', 'Bash', { command: 'npx vitest run' }],
          ['error', 'No test files found, exiting with code 1\ninclude: **/*.{test,spec}.?(c|m)[jt]s?(x)'],
          ['user', 'frontend tests live in web/e2e and are named *.e2e.ts, run `npx vitest run --dir web/e2e --include "**/*.e2e.ts"`'],
          ['tool', 'Bash', { command: 'npx vitest run --dir web/e2e --include "**/*.e2e.ts"' }],
          ['assistant', '12 passed.'],
        ],
      });
    },
    (store, status) => {
      assert.equal(status, 'merged');
      const reqs = find(store, /web\/e2e/);
      assert.ok(reqs.length > 0, 'no requirement mentions web/e2e');
      assert.ok(reqs.every((r) => r.path === `${APP1}/testing.md`), JSON.stringify(reqs.map((r) => r.path)));
      assert.deepEqual(topicNames(store), ['build', 'testing']);
    },
  );

  trial(
    'should add evidence instead of duplicating on confirmation',
    (store) => {
      seed(store);
      session(store, 's1', {
        repo: APP1,
        turns: [
          ['user', 'run the tests'],
          ['assistant', `Shared memory requirement "${UV}" says to use uv run pytest.`],
          ['tool', 'Bash', { command: 'uv run pytest' }],
          ['assistant', '42 passed. The shared memory requirement worked.'],
          ['user', 'thanks, yes that is the right command'],
        ],
      });
    },
    (store, status) => {
      assert.equal(status, 'merged');
      const reqs = find(store, /uv run pytest/);
      assert.equal(reqs.length, 1, JSON.stringify(reqs));
      assert.match(reqs[0].text, /Evidence:.*s1/);
    },
  );
});
