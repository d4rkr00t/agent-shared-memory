import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { git, index, initStore, logUsage, resolveScope, storeDir, writeFile } from './store.ts';

type HookInput = { session_id: string; transcript_path?: string; cwd: string; source?: string };

function sessionStart(input: HookInput, dir: string): string {
  const { scopes } = resolveScope(input.cwd);
  logUsage(dir, { session: input.session_id, event: 'session', source: input.source, scopes });
  return startMessage(dir, scopes);
}

export function startMessage(dir: string, scopes: string[]): string {
  const cli = `sh "${join(import.meta.dirname, '../bin/agent-memory')}"`;
  return `# Shared agent memory

Other agents already hit failures in this repo and org and recorded the fixes here. Use them instead of rediscovering.

You MUST search shared memory:
1. Before the first build, test, lint, typecheck or format command, e.g. \`${cli} search "test|lint|typecheck|format"\`.
2. Before git push, deploy or release, e.g. \`${cli} search "push|deploy|release"\`.
3. After any failed command, before retrying or working around it: search the error text or tool name.
4. When a topic below looks related: \`${cli} view <scope>/<topic>.md\` before starting.

Topics (scope → topic — keywords):
${index(dir, scopes)}

Use only this CLI, via Bash from the session cwd (no MCP tools):
- Search: \`${cli} search "<regex>" [--scope <scope>] [--topic <topic>]\` — case-insensitive, max 20 hits. No hits → widen with alternation, e.g. "deploy|release|ship".
- View: \`${cli} view\` lists registries, specs and open changes; \`${cli} view <path>\` reads one, e.g. "org/_topics.md".
- Hits marked ⚠ DISPUTED: verify before relying, report the outcome via propose.

Record only what this session learned from a failure or a user correction, never what repo docs say:
  \`\`\`
  ${cli} propose <<'EOF'
  {"scope": "<scope>", "topic": "<topic>", "delta": "## ADDED Requirements\\n\\n### Requirement: <name>\\nWhen <trigger>, SHALL|SHOULD <command/path>; otherwise <what failed>.", "why": "<error or user words, verbatim>"}
  EOF
  \`\`\`
- scope: deepest scope where observed.
- topic: pick from the scope's _topics.md by Boundary. None fits → add "new_topic": {"name": "<topic>", "purpose": "...", "boundary": "covers X, not Y"}. Never a near-miss topic.
- One rule per "### Requirement" block.
- ADDED: new rule. MODIFIED: rule was wrong, or unchanged text to confirm it worked. REMOVED: rule was wrong; say why.
- Personal preferences (tone, format, how you work with this user) → Claude Code built-in memory, not here.`;
}

// hashed so dreams can count distinct users without storing who they are
function userHash(cwd: string): string {
  let id: string;
  try {
    id = git(cwd, 'config', 'user.email');
  } catch {
    id = userInfo().username;
  }
  return hashUser(id);
}

export const hashUser = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 12);

// ponytail: resumed sessions re-copy the full transcript; dedupe by message uuid if dreams double-count
function sessionEnd(input: HookInput, dir: string): void {
  if (!input.transcript_path || !existsSync(input.transcript_path)) return;
  const { repo, scopes } = resolveScope(input.cwd);
  copyFileSync(input.transcript_path, join(dir, 'inbox', `${input.session_id}.jsonl`));
  const meta = { session_id: input.session_id, user: userHash(input.cwd), repo, scope: scopes.at(-1), scopes, cwd: input.cwd };
  writeFile(join(dir, 'inbox', `${input.session_id}.json`), JSON.stringify(meta, null, 2));
}

if (import.meta.main && !process.env.AGENT_MEMORY_DREAM) {
  const input: HookInput = JSON.parse(readFileSync(0, 'utf8'));
  const dir = initStore(storeDir());
  writeFile(join(dir, 'inbox', '.keep'), '');
  if (process.argv[2] === 'session-start') process.stdout.write(sessionStart(input, dir));
  else if (process.argv[2] === 'session-end') sessionEnd(input, dir);
  else throw new Error(`unknown hook: ${process.argv[2]}`);
}
