import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, commit } from '../src/store.ts';
import { join } from 'node:path';
import { APP1, find, session, spec, topics, trial } from './helpers.ts';

const OLD = 'Run tests with test:old';

function seed(store: string): void {
  writeFile(join(store, APP1, '_topics.md'), topics(['testing', 'Running and writing tests', 'Covers test commands and fixtures, not build or CI']));
  writeFile(
    join(store, APP1, 'testing.md'),
    spec('testing', 'npm run test:old', [OLD, 'When running tests in this repo, agents SHALL use `npm run test:old`; otherwise integration tests are skipped.\nEvidence: s0']),
  );
  commit(store, 'seed');
}

const contradict = (store: string, id: string) =>
  session(store, id, {
    repo: APP1,
    user: `u-${id}`,
    turns: [
      ['user', 'run the tests'],
      ['assistant', `Shared memory requirement "${OLD}" says to use npm run test:old.`],
      ['tool', 'Bash', { command: 'npm run test:old' }],
      ['error', 'npm error Missing script: "test:old"'],
      ['user', 'test:old was removed when we moved to vitest, the memory is wrong. use `npm test`, it runs unit and integration tests'],
      ['tool', 'Bash', { command: 'npm test' }],
      ['assistant', 'All tests passed.'],
    ],
  });

describe('contradictions', () => {
  trial(
    'should mark requirement disputed after 1 contradicting session',
    (store) => {
      seed(store);
      contradict(store, 's1');
    },
    (store, status) => {
      assert.equal(status, 'merged');
      const reqs = find(store, /test:old/);
      assert.ok(reqs.some((r) => /Status: disputed/.test(r.text) && /Disputed-by:.*s1/.test(r.text)), JSON.stringify(reqs));
    },
  );

  trial(
    'should rewrite requirement after 2 contradicting sessions',
    (store) => {
      seed(store);
      contradict(store, 's1');
      contradict(store, 's2');
    },
    (store, status) => {
      assert.equal(status, 'merged');
      assert.deepEqual(find(store, /SHALL use `?npm run test:old/), []);
      assert.ok(find(store, /`npm test`/).length > 0, 'no requirement mentions `npm test`');
    },
  );
});
