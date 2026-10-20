import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from '../src/store.ts';
import { APP1, runSession, spec, topics, trial } from './helpers.ts';

const ERROR = 'EVALERR: seed needs TZ=UTC';

const memory = (topic: string, purpose: string, name: string, body: string) => (store: string) => {
  writeFile(join(store, `${APP1}/_topics.md`), topics([topic, purpose, `Covers ${topic}, nothing else`]));
  writeFile(join(store, `${APP1}/${topic}.md`), spec(topic, purpose, [name, `${body}\nEvidence: s0`]));
};

// The agent found the requirement: a search returned it, or it viewed the spec.
const retrieved = (topic: string, name: string) => (store: string) => {
  const events = readFileSync(join(store, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const ok = events.some(
    (e) => (e.event === 'search' && e.hits?.some((h: { requirement: string }) => h.requirement === name)) || (e.event === 'view' && e.path === `${APP1}/${topic}.md`),
  );
  assert.ok(ok, `not retrieved; calls: ${JSON.stringify(events.filter((e) => e.event !== 'session').map((e) => [e.event, e.pattern ?? e.path]))}`);
};

describe('search', () => {
  trial(
    'should search memory before running the tests',
    memory('testing', 'How tests run', 'Run tests with test:ci', 'When running tests, agents SHALL run `npm run test:ci`; otherwise `npm test` starts watch mode and hangs.'),
    retrieved('testing', 'Run tests with test:ci'),
    runSession('Run the tests and tell me if they pass.', {
      'package.json': JSON.stringify({ name: 'app1', scripts: { test: 'echo ok', 'test:ci': 'echo ok' } }),
    }),
  );

  trial(
    'should search memory before pushing',
    memory('git-workflow', 'How to push changes', 'Push with --no-verify', 'When pushing to origin, agents SHALL run `git push --no-verify`; otherwise the pre-push hook runs the full e2e suite for 40 minutes.'),
    retrieved('git-workflow', 'Push with --no-verify'),
    runSession('Push the current branch to origin.'),
  );

  trial(
    'should search memory after a failed command',
    memory('seed-data', 'How dev data is seeded', 'Seed with TZ=UTC', `When \`npm run seed\` fails with "${ERROR}", agents SHALL run \`TZ=UTC npm run seed\`; otherwise seeded dates shift by the local offset.`),
    retrieved('seed-data', 'Seed with TZ=UTC'),
    runSession('Seed the dev data with npm run seed.', {
      'package.json': JSON.stringify({ name: 'app1', scripts: { seed: `node -e "if (process.env.TZ !== 'UTC') { console.error('${ERROR}'); process.exit(1) }"` } }),
    }),
  );
});
