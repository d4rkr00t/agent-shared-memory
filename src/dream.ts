#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTopics, commit, frontmatter, git, idle, initStore, REMOVE_DAYS, storeDir, usageLog, withLock, writeFile } from './store.ts';
import { CONVERGE, fill, PROPOSE, VERIFY } from './prompts.ts';

export type DreamResult = { status: 'locked' | 'empty' | 'merged' | 'rejected'; reason?: string };

const MAX_RUNS = 3;
const MAX_ATTEMPTS = 3;

function condense(jsonl: string, offset = 0): string {
  const out: string[] = [];
  const clip = (s: string, n = 2000) => (s.length > n ? s.slice(0, n) + ' …' : s);
  for (const line of jsonl.split('\n').slice(offset)) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    const content = e.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? []);
    for (const b of blocks) {
      if (b.type === 'text' && b.text?.trim()) out.push(`${e.type.toUpperCase()}: ${clip(b.text.trim())}`);
      else if (b.type === 'tool_use') out.push(`TOOL ${b.name}: ${clip(JSON.stringify(b.input), 300)}`);
      else if (b.type === 'tool_result' && b.is_error) {
        const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        out.push(`TOOL ERROR: ${clip(t, 800)}`);
      }
    }
  }
  return out.join('\n');
}

function claude(cwd: string, prompt: string, tools: string, addDir: string): string {
  console.error(`[dream] ${new Date().toTimeString().slice(0, 8)} ${prompt.split('\n')[0].replace('PASS: ', 'pass: ')}…`);
  return execFileSync(
    process.env.AGENT_MEMORY_CLAUDE ?? 'claude',
    ['-p', prompt, '--tools', tools, '--permission-mode', 'acceptEdits', '--add-dir', addDir, '--no-session-persistence', '--strict-mcp-config'],
    { cwd, encoding: 'utf8', env: { ...process.env, AGENT_MEMORY_DREAM: '1' }, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
  );
}

const openChanges = (dir: string) =>
  existsSync(join(dir, 'changes')) ? readdirSync(join(dir, 'changes')).filter((id) => id !== 'archive' && id !== '.gitkeep') : [];

const merge = (dir: string, branch: string, message: string) =>
  git(dir, '-c', 'user.name=agent-memory', '-c', 'user.email=agent-memory@localhost', 'merge', '-q', '--no-ff', '-m', message, branch);

function removeEmptySpecs(dir: string): void {
  for (const root of ['org', 'repos'].filter((r) => existsSync(join(dir, r)))) {
    for (const f of readdirSync(join(dir, root), { recursive: true }) as string[]) {
      const path = join(dir, root, f);
      if (f.endsWith('.md') && !readFileSync(path, 'utf8').trim()) rmSync(path);
    }
  }
}

function archive(dir: string, id: string, note: string): void {
  appendFileSync(join(dir, 'changes', id, 'proposal.md'), `\nArchived: ${note}\n`);
  mkdirSync(join(dir, 'changes/archive'), { recursive: true });
  renameSync(join(dir, 'changes', id), join(dir, 'changes/archive', id));
}

function applyDecisions(tree: string, report: string, ts: string): boolean {
  const decisions = [...report.matchAll(/^- (ACCEPT|REJECT|PENDING) changes\/([^\s/:]+)/gm)];
  for (const [, verdict, id] of decisions) {
    if (verdict !== 'PENDING' && existsSync(join(tree, 'changes', id))) archive(tree, id, `${verdict.toLowerCase()}ed in dream ${ts}`);
  }
  return decisions.length > 0;
}

function bumpRuns(dir: string): void {
  for (const id of openChanges(dir)) {
    const path = join(dir, 'changes', id, 'proposal.md');
    const text = readFileSync(path, 'utf8');
    const runs = Number(frontmatter(text).runs ?? 0) + 1;
    writeFile(path, text.replace(/^runs: .*$/m, `runs: ${runs}`));
    if (runs >= MAX_RUNS) archive(dir, id, `expired after ${runs} runs without converging`);
  }
  commit(dir, 'dream: bump runs, expire stale changes');
}

function cleanup(dir: string, ts: string): void {
  const stale = idle(dir).filter((r) => r.idle >= REMOVE_DAYS);
  if (!stale.length) return;
  withLock(dir, 'commit', () => {
    for (const r of stale) {
      const path = join(dir, r.scope, `${r.topic}.md`);
      const blocks = readFileSync(path, 'utf8').split(/^(?=### Requirement: )/m);
      writeFile(path, blocks.filter((b) => b.match(/^### Requirement: (.*)/)?.[1].trim() !== r.requirement).join(''));
      const line = `${ts} removed unused ${r.scope}/${r.topic}.md: ${r.requirement} (idle ${r.idle} active days)`;
      console.error(`[dream] ${line}`);
      appendFileSync(join(dir, 'dream.log'), line + '\n');
    }
    commit(dir, 'dream: remove unused requirements');
  });
}

// Zero-hit searches since the newest dream report on main, one line each, with the session's readable scopes.
function misses(dir: string): string[] {
  if (!existsSync(usageLog(dir))) return [];
  const reports = existsSync(join(dir, 'dreams')) ? readdirSync(join(dir, 'dreams')).sort() : [];
  const since = reports.at(-1)?.replace(/\.md$/, '') ?? '';
  const events = readFileSync(usageLog(dir), 'utf8').split('\n').flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const scopes = new Map(events.filter((e) => e.event === 'session').map((e) => [e.session, e.scopes]));
  return events
    .filter((e) => e.event === 'search' && !e.error && e.total === 0 && e.ts.replace(/[:.]/g, '-') > since)
    .map((e) => {
      const filter = [e.scope && `--scope ${e.scope}`, e.topic && `--topic ${e.topic}`].filter(Boolean).join(' ');
      return `- ${e.session}: "${e.pattern}" scopes: ${(scopes.get(e.session) ?? ['unknown']).join(', ')}${filter ? ' ' + filter : ''}`;
    });
}

export function dream(dir = storeDir()): DreamResult {
  initStore(dir);
  try {
    return withLock(dir, 'dream', () => run(dir), 0);
  } catch (e) {
    if ((e as Error).message.startsWith('lock busy')) return { status: 'locked' };
    throw e;
  }
}

function run(dir: string): DreamResult {
  const inbox = join(dir, 'inbox');
  const metas = existsSync(inbox) ? readdirSync(inbox).filter((f) => f.endsWith('.json')) : [];
  const missed = misses(dir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  cleanup(dir, ts);
  if (!metas.length && !openChanges(dir).length && !missed.length) return { status: 'empty' };

  const work = mkdtempSync(join(tmpdir(), 'dream-'));
  const sessions = join(work, 'sessions');
  const tree = join(work, 'tree');
  const branch = `dream/${ts}`;
  const report = `dreams/${ts}.md`;
  const vars = { SESSIONS: sessions, WORK: work, REPORT: report, DATE: ts.slice(0, 10) };
  mkdirSync(sessions);
  writeFile(join(work, 'misses.md'), missed.join('\n') || 'none');

  for (const m of metas) {
    const meta = JSON.parse(readFileSync(join(inbox, m), 'utf8'));
    const jsonl = join(inbox, `${meta.session_id}.jsonl`);
    const body = existsSync(jsonl) ? condense(readFileSync(jsonl, 'utf8'), meta.offset) : '';
    const host = meta.host ? `host: ${meta.host}\n` : '';
    writeFile(join(sessions, `${meta.session_id}.md`), `# Session ${meta.session_id}\nuser: ${meta.user ?? 'unknown'}\nrepo: ${meta.repo}\nscope: ${meta.scope}\ncwd: ${meta.cwd}\n${host}\n${body}\n`);
  }

  git(dir, 'worktree', 'add', '-q', '-b', branch, tree, 'main');
  try {
    if (metas.length || missed.length) {
      claude(tree, fill(PROPOSE, vars), 'Read,Write,Edit,Glob,Grep', work);
      commit(tree, 'dream: pass 1 propose');
      withLock(dir, 'commit', () => merge(dir, branch, `dream ${ts}: proposals`));
      mkdirSync(join(inbox, 'processed'), { recursive: true });
      for (const m of metas) {
        for (const f of [m, m.replace(/\.json$/, '.jsonl')]) if (existsSync(join(inbox, f))) renameSync(join(inbox, f), join(inbox, 'processed', f));
      }
    }
    const base = git(tree, 'rev-parse', 'HEAD');
    const open = openChanges(tree);
    const parked = join(work, 'parked');
    mkdirSync(parked);
    // Changes verify named as failing are parked and the rest re-converge, so one bad change can't block the run.
    const rejected = new Map<string, string>();
    let verdict = 'REJECT: no open changes left to converge';
    for (let attempt = 0; attempt < MAX_ATTEMPTS && rejected.size < open.length; attempt++) {
      git(tree, 'reset', '-q', '--hard', base);
      git(tree, 'clean', '-qfd');
      for (const id of rejected.keys()) renameSync(join(tree, 'changes', id), join(parked, id));
      claude(tree, fill(CONVERGE, vars), 'Read,Write,Edit,Glob,Grep', sessions);
      removeEmptySpecs(tree);
      const decided = existsSync(join(tree, report)) && applyDecisions(tree, readFileSync(join(tree, report), 'utf8'), ts);
      for (const id of rejected.keys()) renameSync(join(parked, id), join(tree, 'changes', id));
      commit(tree, 'dream: pass 2 converge');

      const topicErrors = checkTopics(tree);
      let out = '';
      if (!decided) {
        verdict = `REJECT: converge wrote no decisions to ${report}`;
      } else if (topicErrors.length) {
        verdict = `REJECT: checkTopics failed: ${topicErrors.join('; ')}`;
      } else {
        writeFile(join(work, 'dream.diff'), git(tree, 'diff', base, 'HEAD'));
        out = claude(tree, fill(VERIFY, vars), 'Read,Glob,Grep', work).replace(/[*`]/g, '');
        verdict = out.trim().split('\n').filter(Boolean).at(-1)?.trim() ?? 'REJECT: verify produced no output';
      }
      if (verdict === 'APPROVE') break;

      const named = [...out.matchAll(/^\s*- REJECT changes\/([^\s/:]+):\s*(.*)$/gm)].filter(([, id]) => open.includes(id) && !rejected.has(id));
      for (const [, id, reason] of named) rejected.set(id, `REJECT: ${reason.trim()}`);
      if (!named.length) {
        for (const id of open) if (!rejected.has(id)) rejected.set(id, verdict);
        break;
      }
    }

    const approved = verdict === 'APPROVE';
    withLock(dir, 'commit', () => {
      if (approved) merge(dir, branch, `dream ${ts}: converge`);
      for (const [id, reason] of rejected) appendFileSync(join(dir, 'changes', id, 'proposal.md'), `\nVerify-rejected ${ts.slice(0, 10)}: ${reason}\n`);
      bumpRuns(dir);
    });
    for (const [id, reason] of rejected) appendFileSync(join(dir, 'dream.log'), `${ts} changes/${id} ${reason}\n`);
    if (approved) return { status: 'merged' };
    appendFileSync(join(dir, 'dream.log'), `${ts} ${verdict}\n`);
    return { status: 'rejected', reason: verdict };
  } finally {
    git(dir, 'worktree', 'remove', '--force', tree);
    git(dir, 'branch', '-D', branch);
  }
}

if (import.meta.main) {
  const r = dream();
  let owner = '';
  if (r.status === 'locked') {
    try {
      owner = `: another dream is running (pid ${readFileSync(join(storeDir(), '.git/dream.lock/pid'), 'utf8')})`;
    } catch {}
  }
  console.log(r.status + (r.reason ? `: ${r.reason}` : owner));
}
