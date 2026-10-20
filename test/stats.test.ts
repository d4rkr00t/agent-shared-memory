import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stats } from '../src/stats.ts';
import { makeStore, spec, tmp, topics } from './helpers.ts';

const APP = 'repos/github.com/acme/app';

const proposal = (source: string, archived = '') => `---\nsource: ${source}\nscope: org\ntopic: git\nsessions: s1\nruns: 0\n---\n\nwhy\n${archived}`;

const log = (...events: object[]) => events.map((e) => JSON.stringify({ ts: '2026-10-16T00:00:00.000Z', ...e })).join('\n') + '\n';

const hit = (scope: string, topic: string, requirement: string) => ({ scope, topic, requirement });

function fixture() {
  return makeStore({
    'org/_topics.md': topics(['git', 'Git', 'Covers git']),
    'org/git.md': spec('git', 'Git rules', ['Branch names', 'Branches SHALL use ticket key.'], ['Squash', 'PRs SHOULD squash.']),
    [`${APP}/_topics.md`]: topics(['testing', 'Tests', 'Covers tests']),
    [`${APP}/testing.md`]: spec('testing', 'Test rules', ['Runner', 'Tests SHALL run with npm test.']),
    'changes/c1/proposal.md': proposal('session'),
    'changes/archive/c2/proposal.md': proposal('session', 'Archived: accepted in dream 2026-10-15\n'),
    'changes/archive/c3/proposal.md': proposal('dream', 'Archived: rejected in dream 2026-10-15\n'),
    'changes/archive/c4/proposal.md': proposal('session', 'Archived: expired after 3 runs without converging\n'),
    'dreams/2026-10-14T00-00-00-000Z.md': '# Dream report\n',
    'dreams/2026-10-15T00-00-00-000Z.md': '# Dream report\n\n- ACCEPT changes/c2 -> org/git.md: ok\n- REJECT changes/c3: no\n- PENDING changes/c1: wait\n',
    'inbox/s3.json': '{}',
    'inbox/processed/s1.json': '{}',
    'inbox/processed/s2.json': '{}',
    'usage.jsonl': log(
      { session: 's1', event: 'session', source: 'startup' },
      { session: 's1', event: 'session', source: 'compact' },
      { session: 's2', event: 'session', source: 'startup' },
      { session: 's3', event: 'session', source: 'startup' },
      { session: 's1', event: 'search', pattern: 'branch', total: 1, hits: [hit('org', 'git', 'Branch names')] },
      { session: 's1', event: 'search', pattern: 'deploy|ship', total: 0, hits: [] },
      { session: 's2', event: 'search', pattern: 'deploy|ship', total: 0, hits: [] },
      { session: 's2', event: 'search', pattern: 'branch|runner', total: 2, hits: [hit('org', 'git', 'Branch names'), hit(APP, 'testing', 'Runner')] },
      { session: 's2', event: 'view', path: `${APP}/testing.md` },
      { session: 's2', event: 'view', error: 'not found: x' },
    ),
  });
}

describe('stats', () => {
  it('should report adoption: unique sessions, active sessions, calls per tool', () => {
    const out = stats(fixture());

    assert.match(out, /sessions 3 {3}active 2 \(67%\) {3}avg calls\/active 3\.0/);
    assert.match(out, /search\s+4\s+0\s+█+\n\s+view\s+2\s+1\s+█+\n/);
  });

  it('should report zero-hit rate and top zero-hit patterns', () => {
    const out = stats(fixture());

    assert.match(out, /searches 4 {3}zero-hit 2 \(50%\) {3}avg hits 0\.8/);
    assert.match(out, /deploy\|ship\s+2\s+█+\n/);
  });

  it('should list every topic with requirement, disputed, hit and view counts', () => {
    const out = stats(fixture());

    assert.match(out, /org \/ git\s+2\s+0\s+2\s+0\s+Git\n/);
    assert.match(out, /repos\/github\.com\/acme\/app \/ testing\s+1\s+0\s+1\s+1\s+Tests\n/);
    assert.match(out, new RegExp(`${APP}/testing\\.md\\s+1\\s+█+\n`));
    assert.match(out, /never retrieved \(1\/3\)\n {2}org \/ git \/ Squash\n/);
  });

  it('should report proposal funnel per source from changes and archive', () => {
    const out = stats(fixture());

    assert.match(out, /dream\s+0\s+0\s+1\s+0\n\s+session\s+1\s+1\s+0\s+1\n/);
  });

  it('should list open proposals with scope, topic, source and runs', () => {
    const out = stats(fixture());

    assert.match(out, /c1\s+org \/ git\s+session\s+0\n/);
  });

  it('should report dream runs, last report decisions and inbox backlog', () => {
    const out = stats(fixture());

    assert.match(out, /runs 2 {3}last 2026-10-15T00-00-00-000Z {3}accepted 1 {3}rejected 1 {3}pending 1\n {2}inbox 1 waiting {3}2 processed/);
  });

  it('should show the initial session message for the cwd scopes', () => {
    const out = stats(fixture(), tmp());

    assert.match(out, /INITIAL MESSAGE\n {2}scopes org {3}\d+ chars {3}~\d+ tokens\n\n {2}# Shared agent memory\n/);
    assert.match(out, /\n {2}## org\n {2}- git — Git \| Git rules\n/);
  });

  it('should print "none" for empty memory sections', () => {
    const out = stats(makeStore({ 'usage.jsonl': log({ session: 's1', event: 'session', source: 'startup' }) }));

    assert.match(out, /MEMORIES\n {2}none\n\n {2}none\n\n {2}never retrieved \(0\/0\)\n {2}none\n/);
  });

  it('should print "no usage yet" without log', () => {
    assert.equal(stats(makeStore()), 'no usage yet');
  });
});
