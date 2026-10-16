import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { initStore, logUsage, propose, resolveScope, search, storeDir, view } from './store.ts';

const USAGE = `usage:
  agent-memory search <regex> [--scope <scope>] [--topic <topic>]
  agent-memory view [path]
  agent-memory propose <<'EOF'
  {"scope","topic","delta","why","new_topic"?: {"name","purpose","boundary"}}
  EOF`;

type NewTopic = { name: string; purpose: string; boundary: string };

export function tools(cwd: string, dir: string, sessionId: string) {
  initStore(dir);
  const log = (event: string, data: object) => logUsage(dir, { session: sessionId, event, ...data });
  const { scopes } = resolveScope(cwd);
  return {
    scopes,
    log,
    search({ pattern, scope, topic }: { pattern: string; scope?: string; topic?: string }) {
      const { total, hits } = search(dir, scopes, pattern, { scope, topic });
      log('search', { pattern, scope, topic, total, hits: hits.map(({ scope, topic, requirement }) => ({ scope, topic, requirement })) });
      if (!total) return `No matches for /${pattern}/i. Reword or widen the pattern.`;
      const body = hits.map((h) => `${h.disputed ? '⚠ DISPUTED ' : ''}[${h.scope} / ${h.topic}]\n${h.text}`).join('\n\n');
      return `${total} match(es)${total > hits.length ? `, showing first ${hits.length}; narrow with scope/topic` : ''}.\n\n${body}`;
    },
    view({ path }: { path?: string }) {
      const out = view(dir, scopes, path);
      log('view', { path });
      return out;
    },
    propose({ scope, topic, delta, why, new_topic }: { scope: string; topic: string; delta: string; why: string; new_topic?: NewTopic }) {
      const id = propose(dir, scopes, { scope, topic, delta, why, newTopic: new_topic, sessionId });
      log('propose', { scope, topic, id });
      return `Proposed changes/${id}. It will be considered in the next dream run.`;
    },
  };
}

if (import.meta.main) {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { scope: { type: 'string' }, topic: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  const { positionals, values } = args;
  const [cmd, arg] = positionals;
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const t = tools(process.cwd(), storeDir(), process.env.CLAUDE_CODE_SESSION_ID ?? 'unknown');
  try {
    if (cmd === 'search' && arg) console.log(t.search({ pattern: arg, scope: values.scope, topic: values.topic }));
    else if (cmd === 'view') console.log(t.view({ path: arg }));
    else if (cmd === 'propose') console.log(t.propose(JSON.parse(readFileSync(0, 'utf8'))));
    else {
      console.error(USAGE);
      process.exitCode = 2;
    }
  } catch (e) {
    t.log(cmd, { error: (e as Error).message });
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
