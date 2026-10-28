import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { APP1, find, session, trial } from './helpers.ts';

const BUILD_ERROR = "Error: Cannot find module '@acme/schema/generated' imported from src/db.ts";
const E2E_ERROR = 'Error: E2E_BASE_URL is not set';

describe('doom loops', () => {
  trial(
    'should store the fix that broke a doom loop from 1 session',
    (store) =>
      session(store, 's1', {
        repo: APP1,
        turns: [
          ['user', 'build the app'],
          ['tool', 'Bash', { command: 'npm run build' }],
          ['error', BUILD_ERROR],
          ['tool', 'Bash', { command: 'npm run build' }],
          ['error', BUILD_ERROR],
          ['tool', 'Bash', { command: 'npm run build -- --force' }],
          ['error', BUILD_ERROR],
          ['tool', 'Bash', { command: 'npm run codegen && npm run build' }],
          ['assistant', 'Build succeeded.'],
        ],
      }),
    (store, status) => {
      assert.equal(status, 'merged');
      assert.ok(find(store, /npm run codegen/).length > 0, 'no requirement mentions `npm run codegen`');
    },
  );

  trial(
    'should store nothing for a doom loop never broken',
    (store) =>
      session(store, 's1', {
        repo: APP1,
        turns: [
          ['user', 'run the e2e tests'],
          ['tool', 'Bash', { command: 'npm run e2e' }],
          ['error', E2E_ERROR],
          ['tool', 'Bash', { command: 'npm run e2e' }],
          ['error', E2E_ERROR],
          ['tool', 'Bash', { command: 'npm run e2e -- --headed' }],
          ['error', E2E_ERROR],
          ['assistant', "I couldn't run the e2e tests: E2E_BASE_URL needs a value I don't have."],
        ],
      }),
    (store) => assert.deepEqual(find(store, /e2e|E2E_BASE_URL/i), []),
  );
});
