import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { git, index, initStore, logUsage, resolveScope, storeDir, TOPIC_RULE, writeFile } from './store.ts';

type HookInput = { session_id: string; transcript_path?: string; cwd: string; source?: string };

function sessionStart(input: HookInput, dir: string): string {
  const { scopes } = resolveScope(input.cwd);
  logUsage(dir, { session: input.session_id, event: 'session', source: input.source, scopes });
  return startMessage(dir, scopes);
}

export function startMessage(dir: string, scopes: string[]): string {
  const cli = `sh "${join(import.meta.dirname, '../bin/agent-memory')}"`;
  return `# Shared agent memory

Other agents already hit failures in this repo and org and recorded the fixes here. Use them instead of rediscovering them.

You MUST search shared memory:
1. Before the first build, test, lint, typecheck or format command, e.g. \`${cli} search "test|lint|typecheck|format"\`.
2. Before git push, deploy or release, e.g. \`${cli} search "push|deploy|release"\`.
3. After any failed command, before retrying or working around it: search the error text or the tool name.
4. When a topic below looks related to the task: \`${cli} view <scope>/<topic>.md\` before starting.

Topic index for this session (scope → topic — purpose | spec summary). Summaries are pointers only; the requirements themselves are in the specs:
${index(dir, scopes)}

Shared memory is accessed ONLY through this CLI, run with the Bash tool from the session's working directory (there are no agent-memory MCP tools):
- Search: \`${cli} search "<regex>" [--scope <scope>] [--topic <topic>]\` — case-insensitive regex over requirement blocks in your readable scopes (max 20 hits). No hits → reword and widen with alternation, e.g. "deploy|release|ship".
- View: \`${cli} view\` lists topic registries, specs and open changes; \`${cli} view <path>\` reads one, e.g. "org/_topics.md".
- Propose: pipe JSON on stdin:
  \`\`\`
  ${cli} propose <<'EOF'
  {"scope": "<scope>", "topic": "<kebab-topic>", "delta": "## ADDED Requirements\\n\\n### Requirement: <name>\\n<statement with SHALL/SHOULD>", "why": "<what happened in this session>"}
  EOF
  \`\`\`
  Add "new_topic": {"name": "<topic>", "purpose": "...", "boundary": "covers X, not Y"} only when the topic is not registered yet.

Hits marked ⚠ DISPUTED must be verified before relying on them; report the outcome via propose.
${TOPIC_RULE}
Record shared project/org knowledge (conventions, gotchas, commands, corrections) with propose: only what this session discovered through a failure or a user correction, never what you just read in repo docs. Check the scope's _topics.md first.
- scope: the deepest scope where you observed it; the dream promotes it later.
- One rule per "### Requirement" block: "When <trigger>, SHALL|SHOULD <concrete command/path>; otherwise <what failed>."
- why: for each requirement, quote the error or the user's words verbatim.
- You followed a memory and it worked → propose MODIFIED with the unchanged text (a confirmation).
Delta sections: "## ADDED Requirements", "## MODIFIED Requirements" or "## REMOVED Requirements", each with "### Requirement: <name>" blocks. If a memory was wrong (you followed it and it failed), propose MODIFIED or REMOVED and explain in "why". Specs are never edited directly; a nightly dream pass consolidates proposals. Use Claude Code's built-in memory only for personal user preferences (how you talk, format, plan or work with this user).`;
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
