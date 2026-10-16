import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { index, initStore, logUsage, resolveScope, storeDir, TOPIC_RULE, writeFile } from './store.ts';

type HookInput = { session_id: string; transcript_path?: string; cwd: string; source?: string };

function sessionStart(input: HookInput, dir: string): string {
  const { scopes } = resolveScope(input.cwd);
  logUsage(dir, { session: input.session_id, event: 'session', source: input.source, scopes });
  const cli = `sh "${join(import.meta.dirname, '../bin/agent-memory')}"`;
  return `# Shared agent memory

Topic index for this session (scope → topic — purpose | spec summary):
${index(dir, scopes)}

Shared memory is accessed ONLY through this CLI, run with the Bash tool from the session's working directory (there are no agent-memory MCP tools):
- Search: \`${cli} search "<regex>" [--scope <scope>] [--topic <topic>]\` — case-insensitive regex over requirement blocks in your readable scopes (max 20 hits).
- View: \`${cli} view\` lists topic registries, specs and open changes; \`${cli} view <path>\` reads one, e.g. "org/_topics.md".
- Propose: pipe JSON on stdin:
  \`\`\`
  ${cli} propose <<'EOF'
  {"scope": "<scope>", "topic": "<kebab-topic>", "delta": "## ADDED Requirements\\n\\n### Requirement: <name>\\n<statement with SHALL/SHOULD>", "why": "<what happened in this session>"}
  EOF
  \`\`\`
  Add "new_topic": {"name": "<topic>", "purpose": "...", "boundary": "covers X, not Y"} only when the topic is not registered yet.

Search before relying on assumptions about this codebase or org conventions, then view for full specs. No hits → reword and widen with alternation, e.g. "deploy|release|ship". Hits marked ⚠ DISPUTED must be verified before relying on them; report the outcome via propose.
${TOPIC_RULE}
Record shared project/org knowledge (conventions, gotchas, commands, corrections) with propose. Check the scope's _topics.md first. Delta sections: "## ADDED Requirements", "## MODIFIED Requirements" or "## REMOVED Requirements", each with "### Requirement: <name>" blocks. If a memory was wrong (you followed it and it failed), propose MODIFIED or REMOVED and explain in "why". Specs are never edited directly; a nightly dream pass consolidates proposals. Use Claude Code's built-in memory only for personal user preferences.`;
}

// ponytail: resumed sessions re-copy the full transcript; dedupe by message uuid if dreams double-count
function sessionEnd(input: HookInput, dir: string): void {
  if (!input.transcript_path || !existsSync(input.transcript_path)) return;
  const { repo, scopes } = resolveScope(input.cwd);
  copyFileSync(input.transcript_path, join(dir, 'inbox', `${input.session_id}.jsonl`));
  const meta = { session_id: input.session_id, repo, scope: scopes.at(-1), scopes, cwd: input.cwd };
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
