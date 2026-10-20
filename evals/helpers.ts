import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { git, writeFile } from '../src/store.ts';
import { makeRepo, makeStore } from '../test/helpers.ts';

export { spec, topics } from '../test/helpers.ts';

export const APP1 = 'repos/github.com/acme/app1';
export const APP2 = 'repos/github.com/acme/app2';

const TRIALS = Number(process.env.EVAL_TRIALS ?? 3);
const MIN_PASS = Number(process.env.EVAL_MIN_PASS ?? 2);
const ROOT = join(import.meta.dirname, '..');
const DREAM = join(ROOT, 'src/dream.ts');

type Turn = ['user' | 'assistant', string] | ['tool', string, unknown] | ['error', string];

// Writes inbox/<id>.jsonl + .json in the shape the SessionEnd hook produces and condense() reads.
export function session(store: string, id: string, o: { repo: string; user?: string; turns: Turn[] }): void {
  const lines = o.turns.map(([kind, a, b]) => {
    if (kind === 'tool') return { type: 'assistant', message: { content: [{ type: 'tool_use', name: a, input: b }] } };
    if (kind === 'error') return { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: a }] } };
    return { type: kind, message: { content: a } };
  });
  writeFile(join(store, `inbox/${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  writeFile(join(store, `inbox/${id}.json`), JSON.stringify({ session_id: id, user: o.user ?? `u-${id}`, repo: o.repo, scope: o.repo, cwd: '/work' }));
}

// Appends a session event + zero-hit search to usage.jsonl like the CLI logs them.
export function miss(store: string, id: string, pattern: string, scopes: string[]): void {
  const ts = new Date().toISOString();
  const events = [
    { ts, session: id, event: 'session', source: 'startup', scopes },
    { ts, session: id, event: 'search', pattern, total: 0, hits: [] },
  ];
  appendFileSync(join(store, 'usage.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

export type Req = { path: string; text: string };

// Every "### Requirement:" block in spec files (not registries) of the store's main checkout.
export function requirements(store: string): Req[] {
  return ['org', 'repos']
    .filter((r) => existsSync(join(store, r)))
    .flatMap((r) => (readdirSync(join(store, r), { recursive: true }) as string[]).map((f) => join(r, f)))
    .filter((p) => p.endsWith('.md') && !p.endsWith('_topics.md'))
    .flatMap((path) =>
      readFileSync(join(store, path), 'utf8')
        .split(/^(?=### Requirement:)/m)
        .slice(1)
        .map((text) => ({ path, text })),
    );
}

export const find = (store: string, re: RegExp) => requirements(store).filter((r) => re.test(r.text));

async function runDream(store: string): Promise<string> {
  const env = { ...process.env, AGENT_MEMORY_DIR: store };
  delete env.AGENT_MEMORY_CLAUDE;
  const { stdout } = await promisify(execFile)(process.execPath, [DREAM], { env, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

type Run = (store: string) => Promise<string>;

// Live session in an acme/app1 repo with this plugin loaded; push goes to a local bare repo.
export function runSession(task: string, files: Record<string, string> = {}): Run {
  return async (store) => {
    const repo = makeRepo('git@github.com:acme/app1.git', files);
    const bare = makeRepo();
    git(repo, 'remote', 'set-url', '--push', 'origin', bare);
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=eval', '-c', 'user.email=eval@example.com', 'commit', '-qm', 'init', '--allow-empty');
    const env = { ...process.env, AGENT_MEMORY_DIR: store };
    delete env.AGENT_MEMORY_DREAM;
    // sandboxed Bash can't write the temp store, so usage.jsonl would stay empty
    const settings = JSON.stringify({ sandbox: { filesystem: { allowWrite: [store] } } });
    const args = ['-p', task, '--plugin-dir', ROOT, '--settings', settings, '--permission-mode', 'bypassPermissions', '--no-session-persistence'];
    const { stdout } = await promisify(execFile)('claude', args, { cwd: repo, env, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  };
}

// Runs setup + run (default: dream) + check on TRIALS fresh stores in parallel; passes when at least MIN_PASS checks pass.
export function trial(name: string, setup: (store: string) => void, check: (store: string, status: string) => void, run: Run = runDream): void {
  it(name, { timeout: 60 * 60_000 }, async () => {
    const results = await Promise.all(
      Array.from({ length: TRIALS }, async () => {
        const store = makeStore();
        setup(store);
        const status = await run(store);
        try {
          check(store, status);
          return null;
        } catch (e) {
          return `${store} (${status}): ${(e as Error).message}`;
        }
      }),
    );
    const failures = results.filter((r) => r !== null);
    console.log(`${name}: ${TRIALS - failures.length}/${TRIALS}${failures.length ? `\n  first failure: ${failures[0]}` : ''}`);
    assert.ok(TRIALS - failures.length >= MIN_PASS, failures.join('\n'));
  });
}
