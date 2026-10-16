#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTopics, commit, frontmatter, git, initStore, storeDir, withLock, writeFile } from './store.ts';
import { CONVERGE, fill, PROPOSE, VERIFY } from './prompts.ts';

export type DreamResult = { status: 'locked' | 'empty' | 'merged' | 'rejected'; reason?: string };

const MAX_RUNS = 3;

function condense(jsonl: string): string {
  const out: string[] = [];
  const clip = (s: string, n = 2000) => (s.length > n ? s.slice(0, n) + ' …' : s);
  for (const line of jsonl.split('\n')) {
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
  if (!metas.length && !openChanges(dir).length) return { status: 'empty' };

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const work = mkdtempSync(join(tmpdir(), 'dream-'));
  const sessions = join(work, 'sessions');
  const tree = join(work, 'tree');
  const branch = `dream/${ts}`;
  const report = `dreams/${ts}.md`;
  const vars = { SESSIONS: sessions, WORK: work, REPORT: report, DATE: ts.slice(0, 10) };
  mkdirSync(sessions);

  for (const m of metas) {
    const meta = JSON.parse(readFileSync(join(inbox, m), 'utf8'));
    const jsonl = join(inbox, `${meta.session_id}.jsonl`);
    const body = existsSync(jsonl) ? condense(readFileSync(jsonl, 'utf8')) : '';
    writeFile(join(sessions, `${meta.session_id}.md`), `# Session ${meta.session_id}\nrepo: ${meta.repo}\nscope: ${meta.scope}\ncwd: ${meta.cwd}\n\n${body}\n`);
  }

  git(dir, 'worktree', 'add', '-q', '-b', branch, tree, 'main');
  try {
    if (metas.length) {
      claude(tree, fill(PROPOSE, vars), 'Read,Write,Edit,Glob,Grep', sessions);
      commit(tree, 'dream: pass 1 propose');
      withLock(dir, 'commit', () => merge(dir, branch, `dream ${ts}: proposals`));
      mkdirSync(join(inbox, 'processed'), { recursive: true });
      for (const m of metas) {
        for (const f of [m, m.replace(/\.json$/, '.jsonl')]) if (existsSync(join(inbox, f))) renameSync(join(inbox, f), join(inbox, 'processed', f));
      }
    }
    const base = git(tree, 'rev-parse', 'HEAD');

    claude(tree, fill(CONVERGE, vars), 'Read,Write,Edit,Glob,Grep', sessions);
    removeEmptySpecs(tree);
    const decided = existsSync(join(tree, report)) && applyDecisions(tree, readFileSync(join(tree, report), 'utf8'), ts);
    commit(tree, 'dream: pass 2 converge');

    const topicErrors = checkTopics(tree);
    let verdict: string;
    if (!decided) {
      verdict = `REJECT: converge wrote no decisions to ${report}`;
    } else if (topicErrors.length) {
      verdict = `REJECT: checkTopics failed: ${topicErrors.join('; ')}`;
    } else {
      writeFile(join(work, 'dream.diff'), git(tree, 'diff', base, 'HEAD'));
      const out = claude(tree, fill(VERIFY, vars), 'Read,Glob,Grep', work);
      verdict = out.replace(/[*`]/g, '').trim().split('\n').filter(Boolean).at(-1)?.trim() ?? 'REJECT: verify produced no output';
    }

    const approved = verdict === 'APPROVE';
    withLock(dir, 'commit', () => {
      if (approved) merge(dir, branch, `dream ${ts}: converge`);
      bumpRuns(dir);
    });
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
  console.log(r.status + (r.reason ? `: ${r.reason}` : ''));
}
