#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { styleText } from 'node:util';
import { startMessage } from './hooks.ts';
import { FLAG_DAYS, frontmatter, idle, parseTopics, REMOVE_DAYS, requirements, resolveScope, scopeDirs, storeDir, usageLog } from './store.ts';

type Ref = { scope: string; topic: string; requirement: string };
type Event = { session: string; event: string; error?: string; pattern?: string; total?: number; hits?: Ref[]; path?: string };

type Cell = string | number;
type Color = 'green' | 'yellow' | 'red';

const avg = (n: number, d: number) => (d ? (n / d).toFixed(1) : '0');
const rate = (n: number, d: number, color: (p: number) => Color) => {
  const p = d ? Math.round((100 * n) / d) : 0;
  return styleText(color(p), `${p}%`);
};
const section = (icon: string, title: string) => `${icon} ${styleText(['bold', 'cyan'], title)}`;
const none = `  ${styleText('dim', 'none')}`;

function table(head: string[], rows: Cell[][], bar = -1): string {
  if (!rows.length) return none;
  const num = head.map((_, i) => rows.every((r) => typeof r[i] === 'number'));
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const pad = (c: Cell, i: number) => (num[i] ? String(c).padStart(w[i]) : String(c).padEnd(w[i]));
  const max = bar < 0 ? 0 : Math.max(...rows.map((r) => +r[bar]));
  const paint = (c: Cell, i: number) =>
    c === 0 ? styleText('dim', pad(c, i)) : head[i] === 'errors' ? styleText('red', pad(c, i)) : pad(c, i);
  const chart = (n: number) => (max && n ? `  ${styleText('cyan', '█'.repeat(Math.max(1, Math.round((20 * n) / max))))}` : '');
  return [
    `  ${head.map((h, i) => styleText('dim', pad(h, i))).join('  ')}`,
    ...rows.map((r) => `  ${r.map(paint).join('  ')}${bar < 0 ? '' : chart(+r[bar])}`),
  ]
    .map((l) => l.trimEnd())
    .join('\n');
}

function counts(keys: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return new Map([...m].sort((a, b) => b[1] - a[1]));
}

function proposals(dir: string): Cell[][] {
  const changes = join(dir, 'changes');
  const list = (d: string) => (existsSync(d) ? readdirSync(d).filter((id) => existsSync(join(d, id, 'proposal.md'))) : []);
  const all = [
    ...list(changes).map((id) => ({ text: readFileSync(join(changes, id, 'proposal.md'), 'utf8'), status: 'open' })),
    ...list(join(changes, 'archive')).map((id) => {
      const text = readFileSync(join(changes, 'archive', id, 'proposal.md'), 'utf8');
      return { text, status: text.match(/^Archived: (accepted|rejected|expired)/m)?.[1] ?? 'unknown' };
    }),
  ];
  const statuses = ['open', 'accepted', 'rejected', 'expired'];
  const sources = [...new Set(all.map((p) => frontmatter(p.text).source ?? 'unknown'))].sort();
  return sources.map((s) => {
    const mine = all.filter((p) => (frontmatter(p.text).source ?? 'unknown') === s);
    return [s, ...statuses.map((st) => mine.filter((p) => p.status === st).length)];
  });
}

function openProposals(dir: string): Cell[][] {
  const d = join(dir, 'changes');
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((id) => existsSync(join(d, id, 'proposal.md')))
    .sort()
    .map((id) => {
      const fm = frontmatter(readFileSync(join(d, id, 'proposal.md'), 'utf8'));
      return [id, `${fm.scope} / ${fm.topic}`, fm.source ?? 'unknown', +(fm.runs ?? 0)];
    });
}

function dreams(dir: string): string {
  const ls = (d: string, ext: string) => (existsSync(join(dir, d)) ? readdirSync(join(dir, d)).filter((f) => f.endsWith(ext)).sort() : []);
  const reports = ls('dreams', '.md');
  const last = reports.at(-1);
  const text = last ? readFileSync(join(dir, 'dreams', last), 'utf8') : '';
  const n = (k: string) => text.match(new RegExp(`^- ${k} `, 'gm'))?.length ?? 0;
  return `  runs ${reports.length}   last ${last?.slice(0, -3) ?? 'never'}   accepted ${n('ACCEPT')}   rejected ${n('REJECT')}   pending ${n('PENDING')}
  inbox ${ls('inbox', '.json').length} waiting   ${ls('inbox/processed', '.json').length} processed`;
}

export function stats(dir = storeDir(), cwd = process.cwd()): string {
  if (!existsSync(usageLog(dir))) return 'no usage yet';
  const events: Event[] = readFileSync(usageLog(dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const calls = events.filter((e) => e.event !== 'session');
  const sessions = new Set(events.map((e) => e.session)).size;
  const active = new Set(calls.map((e) => e.session)).size;
  const tools = [...new Set(calls.map((e) => e.event))].sort();

  const searches = calls.filter((e) => e.event === 'search' && !e.error);
  const zero = searches.filter((e) => !e.total);
  const totalHits = searches.reduce((n, e) => n + (e.total ?? 0), 0);

  const key = (r: Ref) => `${r.scope} / ${r.topic} / ${r.requirement}`;
  const retrieved = counts(searches.flatMap((e) => e.hits ?? []).map(key));
  const views = counts(calls.filter((e) => e.event === 'view' && !e.error && e.path).map((e) => e.path!));
  const reqs = requirements(dir, scopeDirs(dir));
  const flagged = idle(dir).filter((r) => r.idle >= FLAG_DAYS);
  const topics = scopeDirs(dir).flatMap((scope) =>
    parseTopics(dir, scope).map((t) => {
      const mine = reqs.filter((r) => r.scope === scope && r.topic === t.name);
      const hits = mine.reduce((n, r) => n + (retrieved.get(key(r)) ?? 0), 0);
      return [`${scope} / ${t.name}`, mine.length, mine.filter((r) => r.disputed).length, flagged.filter((r) => r.scope === scope && r.topic === t.name).length, hits, views.get(`${scope}/${t.name}.md`) ?? 0, t.purpose];
    }),
  );
  const { scopes } = resolveScope(cwd);
  const message = startMessage(dir, scopes);

  return `${section('📈', 'ADOPTION')}
  sessions ${sessions}   active ${active} (${rate(active, sessions, (p) => (p >= 50 ? 'green' : p >= 20 ? 'yellow' : 'red'))})   avg calls/active ${avg(calls.length, active)}

${table(['tool', 'calls', 'errors'], tools.map((t) => [t, calls.filter((e) => e.event === t).length, calls.filter((e) => e.event === t && e.error).length]), 1)}

${section('🔍', 'SEARCH')}
  searches ${searches.length}   zero-hit ${zero.length} (${rate(zero.length, searches.length, (p) => (p <= 20 ? 'green' : p <= 50 ? 'yellow' : 'red'))})   avg hits ${avg(totalHits, searches.length)}

${table(['zero-hit pattern', 'count'], [...counts(zero.map((e) => e.pattern!))].slice(0, 10), 1)}

${section('🧠', 'MEMORIES')}
${table(['topic', 'reqs', 'disputed', 'flagged', 'hits', 'views', 'purpose'], topics)}

${table(['spec', 'views'], [...views], 1)}

  ${styleText('dim', `flagged for cleanup (${flagged.length}/${reqs.length})`)}
${flagged.map((r) => `  ${key(r)}  idle ${r.idle}/${REMOVE_DAYS}`).join('\n') || none}

${section('📝', 'PROPOSALS')}
${table(['source', 'open', 'accepted', 'rejected', 'expired'], proposals(dir))}

${table(['open change', 'scope / topic', 'source', 'runs'], openProposals(dir))}

${section('🌙', 'DREAMS')}
${dreams(dir)}

${section('💬', 'INITIAL MESSAGE')}
  scopes ${scopes.join(', ')}   ${message.length} chars   ~${Math.round(message.length / 4)} tokens

${message.replace(/^/gm, '  ')}
`;
}

if (import.meta.main) console.log(stats());
