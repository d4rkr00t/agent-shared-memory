import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { initStore, logUsage, propose, resolveScope, search, storeDir, TOPIC_RULE, view } from './store.ts';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export function createServer(cwd: string, dir: string, sessionId: string): McpServer {
  initStore(dir);
  const log = (event: string, data: object) => logUsage(dir, { session: sessionId, event, ...data });
  const safe =
    <A>(tool: string, fn: (a: A) => string) =>
    async (a: A) => {
      try {
        return text(fn(a));
      } catch (e) {
        log(tool, { error: (e as Error).message });
        return { ...text((e as Error).message), isError: true };
      }
    };
  const { scopes } = resolveScope(cwd);
  const server = new McpServer(
    { name: 'agent-memory', version: '0.1.0' },
    { instructions: `Shared org memory. Readable scopes: ${scopes.join(', ')}.\n${TOPIC_RULE}` },
  );

  server.registerTool(
    'search',
    {
      description:
        'Search shared memory before relying on assumptions. Case-insensitive regex over specs in your readable scopes; returns whole requirement blocks with scope and topic (max 20, plus total). No hits → reword and widen with alternation, e.g. "deploy|release|ship". Hits marked ⚠ DISPUTED were contradicted by a session: verify before relying on them and report the outcome via propose.',
      inputSchema: { pattern: z.string(), scope: z.string().optional(), topic: z.string().optional() },
    },
    safe('search', ({ pattern, scope, topic }) => {
      const { total, hits } = search(dir, scopes, pattern, { scope, topic });
      log('search', { pattern, scope, topic, total, hits: hits.map(({ scope, topic, requirement }) => ({ scope, topic, requirement })) });
      if (!total) return `No matches for /${pattern}/i. Reword or widen the pattern.`;
      const body = hits.map((h) => `${h.disputed ? '⚠ DISPUTED ' : ''}[${h.scope} / ${h.topic}]\n${h.text}`).join('\n\n');
      return `${total} match(es)${total > hits.length ? `, showing first ${hits.length}; narrow with scope/topic` : ''}.\n\n${body}`;
    }),
  );

  server.registerTool(
    'view',
    {
      description: 'Without path: list topic registries, specs and open changes in your readable scopes. With path: read that file (e.g. "org/_topics.md", "repos/github.com/acme/app/testing.md", "changes/<id>/proposal.md").',
      inputSchema: { path: z.string().optional() },
    },
    safe('view', ({ path }) => {
      const out = view(dir, scopes, path);
      log('view', { path });
      return out;
    }),
  );

  server.registerTool(
    'propose',
    {
      description: `Propose a change to shared memory. Specs are never edited directly: proposals are consolidated by a later dream pass that decides what is kept and at which scope level. ${TOPIC_RULE}
Check the scope's _topics.md first. "delta" uses "## ADDED Requirements", "## MODIFIED Requirements" or "## REMOVED Requirements" sections, each holding "### Requirement: <name>" blocks with a SHALL/SHOULD statement. To report that a memory was wrong (you followed it and it failed), propose MODIFIED or REMOVED and explain the failure in "why".`,
      inputSchema: {
        scope: z.enum(scopes as [string, ...string[]]),
        topic: z.string().describe('kebab-case topic name registered in <scope>/_topics.md'),
        delta: z.string(),
        why: z.string().describe('what happened in this session that supports the change'),
        new_topic: z
          .object({ name: z.string(), purpose: z.string(), boundary: z.string().describe('covers X, not Y') })
          .optional()
          .describe('required only when topic is not registered yet; name must equal topic'),
      },
    },
    safe('propose', ({ scope, topic, delta, why, new_topic }) => {
      const id = propose(dir, scopes, { scope, topic, delta, why, newTopic: new_topic, sessionId });
      log('propose', { scope, topic, id });
      return `Proposed changes/${id}. It will be considered in the next dream run.`;
    }),
  );

  return server;
}

if (import.meta.main) {
  // ponytail: session id read once at spawn; /clear starts a new transcript but keeps this id
  const server = createServer(process.cwd(), storeDir(), process.env.CLAUDE_CODE_SESSION_ID ?? 'unknown');
  await server.connect(new StdioServerTransport());
}
