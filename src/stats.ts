#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { styleText } from 'node:util';
import { frontmatter, requirements, scopeDirs, storeDir, usageLog } from './store.ts';

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
  ].join('\n');
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

export function stats(dir = storeDir()): string {
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
  const never = reqs.filter((r) => !retrieved.has(key(r)) && !views.has(`${r.scope}/${r.topic}.md`));

  return `${section('📈', 'ADOPTION')}
  sessions ${sessions}   active ${active} (${rate(active, sessions, (p) => (p >= 50 ? 'green' : p >= 20 ? 'yellow' : 'red'))})   avg calls/active ${avg(calls.length, active)}

${table(['tool', 'calls', 'errors'], tools.map((t) => [t, calls.filter((e) => e.event === t).length, calls.filter((e) => e.event === t && e.error).length]), 1)}

${section('🔍', 'SEARCH')}
  searches ${searches.length}   zero-hit ${zero.length} (${rate(zero.length, searches.length, (p) => (p <= 20 ? 'green' : p <= 50 ? 'yellow' : 'red'))})   avg hits ${avg(totalHits, searches.length)}

${table(['zero-hit pattern', 'count'], [...counts(zero.map((e) => e.pattern!))].slice(0, 10), 1)}

${section('🧠', 'MEMORIES')}
${table(['requirement', 'search hits'], reqs.map((r) => [key(r), retrieved.get(key(r)) ?? 0]).sort((a, b) => +b[1] - +a[1]), 1)}

${table(['spec', 'views'], [...views], 1)}

  ${styleText('dim', `never retrieved (${never.length}/${reqs.length})`)}
${never.map((r) => `  ${key(r)}`).join('\n') || none}

${section('📝', 'PROPOSALS')}
${table(['source', 'open', 'accepted', 'rejected', 'expired'], proposals(dir))}
`;
}

if (import.meta.main) console.log(stats());
