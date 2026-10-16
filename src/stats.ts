#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frontmatter, requirements, scopeDirs, storeDir, usageLog } from './store.ts';

type Ref = { scope: string; topic: string; requirement: string };
type Event = { session: string; event: string; error?: string; pattern?: string; total?: number; hits?: Ref[]; path?: string };

const pct = (n: number, d: number) => `${d ? Math.round((100 * n) / d) : 0}%`;
const avg = (n: number, d: number) => (d ? (n / d).toFixed(1) : '0');
const table = (head: string[], rows: (string | number)[][]) =>
  rows.length ? [head, head.map(() => '---'), ...rows].map((r) => `| ${r.map((c) => String(c).replaceAll('|', '\\|')).join(' | ')} |`).join('\n') : '(none)';

function counts(keys: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return new Map([...m].sort((a, b) => b[1] - a[1]));
}

function proposals(dir: string): string[][] {
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
    return [s, ...statuses.map((st) => String(mine.filter((p) => p.status === st).length))];
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

  return `# Adoption

Sessions: ${sessions}, active (≥1 tool call): ${active} (${pct(active, sessions)}), avg calls per active session: ${avg(calls.length, active)}

${table(['tool', 'calls', 'errors'], tools.map((t) => [t, calls.filter((e) => e.event === t).length, calls.filter((e) => e.event === t && e.error).length]))}

# Search

Searches: ${searches.length}, zero-hit: ${zero.length} (${pct(zero.length, searches.length)}), avg hits: ${avg(totalHits, searches.length)}

Top zero-hit patterns:

${table(['pattern', 'count'], [...counts(zero.map((e) => e.pattern!))].slice(0, 10).map(([p, n]) => [`\`${p}\``, n]))}

# Per-memory

${table(['requirement', 'search hits'], reqs.map((r) => [key(r), retrieved.get(key(r)) ?? 0]).sort((a, b) => +b[1] - +a[1]))}

${table(['spec', 'views'], [...views])}

Never retrieved (${never.length}/${reqs.length}):
${never.map((r) => `- ${key(r)}`).join('\n') || '(none)'}

# Proposals

${table(['source', 'open', 'accepted', 'rejected', 'expired'], proposals(dir))}
`;
}

if (import.meta.main) console.log(stats());
