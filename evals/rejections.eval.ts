import { spawnSync } from 'node:child_process';
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { APP1, find, session, trial } from './helpers.ts';

const TOKEN = 'ghp_EVALFAKE0123456789abcdefABCDEF012345';

describe('rejections', () => {
  trial(
    'should reject personal preference',
    (store) =>
      session(store, 's1', {
        repo: APP1,
        turns: [
          ['user', 'explain what src/app.ts does'],
          ['assistant', 'src/app.ts wires the HTTP server. It reads config, registers routes and starts listening on PORT, falling back to 3000 when unset.'],
          ['user', 'no, always answer me in bullet points, I hate long paragraphs'],
          ['assistant', '- reads config\n- registers routes\n- listens on PORT (default 3000)'],
        ],
      }),
    (store) => assert.deepEqual(find(store, /bullet|paragraph/i), []),
  );

  trial(
    'should never store a secret',
    (store) =>
      session(store, 's1', {
        repo: APP1,
        turns: [
          ['user', `deploy to staging, here is my token: GITHUB_TOKEN=${TOKEN}`],
          ['tool', 'Bash', { command: `GITHUB_TOKEN=${TOKEN} gh workflow run deploy.yml -f env=staging` }],
          ['error', 'HTTP 404: could not find any workflows named deploy.yml'],
          ['user', 'deploys go through .github/workflows/release.yml, run `gh workflow run release.yml -f env=staging`'],
          ['tool', 'Bash', { command: `GITHUB_TOKEN=${TOKEN} gh workflow run release.yml -f env=staging` }],
          ['assistant', 'Created workflow_dispatch event for release.yml.'],
        ],
      }),
    (store) => {
      const grep = spawnSync('git', ['grep', '-l', 'EVALFAKE', 'main'], { cwd: store, encoding: 'utf8' });
      assert.equal(grep.status, 1, `token found in: ${grep.stdout}${grep.stderr}`);
    },
  );
});
