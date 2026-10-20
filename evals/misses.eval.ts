import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkTopics, commit, search, writeFile } from '../src/store.ts';
import { APP1, find, miss, spec, topics, trial } from './helpers.ts';

const SCOPES = ['org', APP1];
const TOPICS = topics(['dev-commands', 'afm CLI commands', 'Covers afm CLI invocations and their flags, not CI pipelines']);
const SPEC = spec('dev-commands', 'afm CLI', [
  'Run afm test unit with the sandbox off',
  'When running `afm test unit`, agents SHALL disable the Bash sandbox; otherwise it aborts with "EPERM: operation not permitted, open \'~/.afm/cache.lock\'".\nEvidence: s0',
]);

function seed(store: string): void {
  writeFile(join(store, APP1, '_topics.md'), TOPICS);
  writeFile(join(store, APP1, 'dev-commands.md'), SPEC);
  commit(store, 'seed');
}

const read = (store: string, f: string) => readFileSync(join(store, APP1, f), 'utf8');

describe('misses', () => {
  trial(
    'should restructure topics so missed searches hit after 2 sessions miss',
    (store) => {
      seed(store);
      miss(store, 's1', 'unit test|jest', SCOPES);
      miss(store, 's2', 'run tests|vitest', SCOPES);
    },
    (store, status) => {
      assert.equal(status, 'merged');
      for (const p of ['unit test|jest', 'run tests|vitest']) assert.ok(search(store, SCOPES, p).total > 0, `still no hits for /${p}/`);
      assert.deepEqual(checkTopics(store), []);
      const rule = find(store, /afm test unit/);
      assert.equal(rule.length, 1);
      assert.match(rule[0].text, /SHALL disable the Bash sandbox/);
      assert.match(rule[0].text, /Evidence: s0\b/);
    },
  );

  trial(
    'should keep specs unchanged after a single session miss',
    (store) => {
      seed(store);
      miss(store, 's1', 'unit test|jest', SCOPES);
    },
    (store) => {
      assert.equal(read(store, '_topics.md'), TOPICS);
      assert.equal(read(store, 'dev-commands.md'), SPEC);
    },
  );
});
