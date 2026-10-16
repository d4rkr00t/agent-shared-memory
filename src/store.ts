import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, matchesGlob, normalize, relative } from 'node:path';

export type Scope = { repo: string | null; scopes: string[] };
export type Topic = { name: string; purpose: string; boundary: string };
export type Hit = { scope: string; topic: string; requirement: string; disputed: boolean; text: string };

export const TOPIC_RULE = `TOPIC STRUCTURE IS EXTREMELY IMPORTANT. Every memory lives in exactly one topic spec (<scope>/<topic>.md) listed in that scope's _topics.md registry. Put each requirement in the topic whose boundary fits it. If no topic fits, propose a new topic with name, purpose and boundary. Never dump a memory into a near-miss topic.`;

export const storeDir = () => process.env.AGENT_MEMORY_DIR ?? join(homedir(), '.agent-memory');

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(cwd: string, ...args: string[]): string | null {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
}

export function normalizeRemote(url: string): string {
  return url
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(\d+\/)?/, '$1/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

export function resolveScope(cwd: string): Scope {
  const root = tryGit(cwd, 'rev-parse', '--show-toplevel');
  if (!root) return { repo: null, scopes: ['org'] };
  const remote = tryGit(root, 'remote', 'get-url', 'origin');
  const repo = `repos/${remote ? normalizeRemote(remote) : `local/${basename(root)}`}`;
  const scopes = ['org', repo];

  const configPath = join(root, '.agent-memory.json');
  const globs: string[] = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, 'utf8')).scopes ?? []) : [];
  const segs = relative(root, realpathSync(cwd)).split('/').filter(Boolean);
  for (let i = segs.length; i > 0; i--) {
    const prefix = segs.slice(0, i).join('/');
    if (globs.some((g) => matchesGlob(prefix, g))) {
      scopes.push(`${repo}/${prefix}`);
      break;
    }
  }
  return { repo, scopes };
}

export function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  return Object.fromEntries(
    m[1].split('\n').flatMap((l) => {
      const i = l.indexOf(':');
      return i > 0 ? [[l.slice(0, i).trim(), l.slice(i + 1).trim()]] : [];
    }),
  );
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

export function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function initStore(dir = storeDir()): string {
  if (existsSync(join(dir, '.git'))) return dir;
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFile(join(dir, '.gitignore'), 'inbox/\ndream.log\nusage.jsonl\n');
  writeFile(join(dir, 'org/_topics.md'), '# Topics\n');
  writeFile(join(dir, 'changes/.gitkeep'), '');
  commit(dir, 'init store');
  return dir;
}

export function commit(dir: string, message: string): void {
  git(dir, 'add', '-A');
  if (tryGit(dir, 'diff', '--cached', '--quiet') !== null) return;
  git(dir, '-c', 'user.name=agent-memory', '-c', 'user.email=agent-memory@localhost', 'commit', '-q', '-m', message);
}

// Lock owner dead (crash, Ctrl-C) → stale. Lock without pid file = just created, or pre-pid lock if older than 60s.
// ponytail: pid reuse can keep a stale lock alive; add hostname + start time if that bites
function staleLock(lock: string): boolean {
  try {
    process.kill(Number(readFileSync(join(lock, 'pid'), 'utf8')), 0);
    return false;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true;
    try {
      return code === 'ENOENT' && Date.now() - statSync(lock).mtimeMs > 60_000;
    } catch {
      return false;
    }
  }
}

export function withLock<T>(dir: string, name: string, fn: () => T, waitMs = 10_000): T {
  const lock = join(dir, '.git', `${name}.lock`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), String(process.pid));
      break;
    } catch {
      if (staleLock(lock)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`lock busy: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function parseTopics(dir: string, scope: string): Topic[] {
  return read(join(dir, scope, '_topics.md'))
    .split(/^## /m)
    .slice(1)
    .map((block) => {
      const [name, ...rest] = block.split('\n');
      const field = (k: string) => rest.find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1).trim() ?? '';
      return { name: name.trim(), purpose: field('Purpose'), boundary: field('Boundary') };
    });
}

function specFiles(dir: string, scope: string): string[] {
  const d = join(dir, scope);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith('.md') && f !== '_topics.md')
    .map((f) => f.slice(0, -3))
    .sort();
}

export function index(dir: string, scopes: string[]): string {
  const out: string[] = [];
  for (const scope of scopes) {
    const topics = parseTopics(dir, scope);
    out.push(`## ${scope}`);
    if (!topics.length) out.push('(no topics yet)');
    for (const t of topics) {
      const desc = frontmatter(read(join(dir, scope, `${t.name}.md`))).description ?? '';
      out.push(`- ${t.name} — ${t.purpose}${desc ? ` | ${desc}` : ''}`);
    }
  }
  return out.join('\n');
}

export function requirements(dir: string, scopes: string[], filter: { scope?: string; topic?: string } = {}): Hit[] {
  const hits: Hit[] = [];
  for (const scope of scopes.filter((s) => !filter.scope || s === filter.scope)) {
    for (const topic of specFiles(dir, scope).filter((t) => !filter.topic || t === filter.topic)) {
      for (const block of read(join(dir, scope, `${topic}.md`)).split(/^(?=### Requirement: )/m).slice(1)) {
        const requirement = block.match(/^### Requirement: (.*)/)![1].trim();
        hits.push({ scope, topic, requirement, disputed: /^Status:\s*disputed/im.test(block), text: block.trim() });
      }
    }
  }
  return hits;
}

export function search(dir: string, scopes: string[], pattern: string, filter: { scope?: string; topic?: string } = {}) {
  if (filter.scope && !scopes.includes(filter.scope)) throw new Error(`scope not readable from this session: ${filter.scope}. Readable: ${scopes.join(', ')}`);
  const re = new RegExp(pattern, 'i');
  const hits = requirements(dir, scopes, filter).filter((h) => re.test(h.text));
  return { total: hits.length, hits: hits.slice(0, 20) };
}

export const usageLog = (dir: string) => join(dir, 'usage.jsonl');

// metrics are best-effort: a read-only store (sandboxed Bash) must not break search/view
export function logUsage(dir: string, event: Record<string, unknown>): void {
  try {
    appendFileSync(usageLog(dir), JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  } catch {}
}

function safePath(path: string): string {
  const p = normalize(path).replace(/^\/+|\/+$/g, '');
  if (p.startsWith('..')) throw new Error(`invalid path: ${path}`);
  return p;
}

function openChanges(dir: string, scopes: string[]): string[] {
  const d = join(dir, 'changes');
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((id) => id !== 'archive' && scopes.includes(frontmatter(read(join(d, id, 'proposal.md'))).scope))
    .sort();
}

export function view(dir: string, scopes: string[], path?: string): string {
  if (!path) {
    const specs = scopes.flatMap((s) => [...(existsSync(join(dir, s, '_topics.md')) ? [`${s}/_topics.md`] : []), ...specFiles(dir, s).map((t) => `${s}/${t}.md`)]);
    const changes = openChanges(dir, scopes).map((id) => `changes/${id}/`);
    return [...specs, ...changes].join('\n');
  }
  const p = safePath(path);
  const change = p.match(/^changes\/([^/]+)/)?.[1];
  const allowed = change ? openChanges(dir, scopes).includes(change) : scopes.includes(dirname(p));
  if (!allowed) throw new Error(`not readable from this session: ${path}`);
  const full = join(dir, p);
  if (!existsSync(full)) throw new Error(`not found: ${path}`);
  return change && !p.endsWith('.md')
    ? readdirSync(full, { recursive: true }).map((f) => `${p}/${f}`).join('\n')
    : readFileSync(full, 'utf8');
}

export type Proposal = { scope: string; topic: string; delta: string; why: string; newTopic?: Topic; sessionId: string };

export function propose(dir: string, scopes: string[], p: Proposal): string {
  if (!scopes.includes(p.scope)) throw new Error(`scope not readable from this session: ${p.scope}. Readable: ${scopes.join(', ')}`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.topic)) throw new Error(`topic must be kebab-case: ${p.topic}`);
  const known = parseTopics(dir, p.scope).some((t) => t.name === p.topic);
  if (!known && p.newTopic?.name !== p.topic) {
    throw new Error(`topic "${p.topic}" is not registered in ${p.scope}/_topics.md. Use an existing topic or pass new_topic with name, purpose and boundary.`);
  }
  if (!/^## (ADDED|MODIFIED|REMOVED) Requirements/m.test(p.delta)) {
    throw new Error('delta must contain "## ADDED Requirements", "## MODIFIED Requirements" or "## REMOVED Requirements"');
  }
  if (!/^### Requirement: \S/m.test(p.delta)) throw new Error('delta must contain at least one "### Requirement: <name>" block');
  if (!p.why?.trim()) throw new Error('why must describe what happened in this session that supports the change');
  const id = `${new Date().toISOString().slice(0, 10)}-${p.topic}-${randomBytes(3).toString('hex')}`;
  const newTopic = known ? '' : `\n## New topic\n\n## ${p.newTopic!.name}\nPurpose: ${p.newTopic!.purpose}\nBoundary: ${p.newTopic!.boundary}\n`;
  return withLock(dir, 'commit', () => {
    writeFile(
      join(dir, 'changes', id, 'proposal.md'),
      `---\nsource: session\nscope: ${p.scope}\ntopic: ${p.topic}\nsessions: ${p.sessionId}\nruns: 0\n---\n\n${p.why.trim()}\n${newTopic}`,
    );
    writeFile(join(dir, 'changes', id, p.scope, `${p.topic}.md`), p.delta.trim() + '\n');
    commit(dir, `propose ${id} (session ${p.sessionId})`);
    return id;
  });
}

export function scopeDirs(dir: string): string[] {
  const roots = ['org', 'repos'].filter((r) => existsSync(join(dir, r)));
  const dirs = roots.flatMap((r) => [
    r,
    ...readdirSync(join(dir, r), { recursive: true, withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => relative(dir, join(e.parentPath, e.name))),
  ]);
  return dirs.filter((d) => readdirSync(join(dir, d)).some((f) => f.endsWith('.md')));
}

export function checkTopics(dir: string): string[] {
  const errors: string[] = [];
  for (const scope of scopeDirs(dir)) {
    const topics = parseTopics(dir, scope).map((t) => t.name);
    const files = specFiles(dir, scope);
    for (const f of files) {
      if (!topics.includes(f)) errors.push(`${scope}/${f}.md has no entry in ${scope}/_topics.md`);
      const fm = frontmatter(read(join(dir, scope, `${f}.md`)));
      if (fm.topic !== f) errors.push(`${scope}/${f}.md frontmatter topic "${fm.topic ?? ''}" != file name`);
    }
    for (const t of topics) if (!files.includes(t)) errors.push(`${scope}/_topics.md lists "${t}" but ${scope}/${t}.md is missing`);
  }
  return errors;
}
