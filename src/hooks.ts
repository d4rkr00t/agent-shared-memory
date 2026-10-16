import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { index, initStore, resolveScope, storeDir, TOPIC_RULE, writeFile } from './store.ts';

type HookInput = { session_id: string; transcript_path?: string; cwd: string };

function sessionStart(input: HookInput, dir: string): string {
  const { scopes } = resolveScope(input.cwd);
  return `# Shared agent memory (mcp agent-memory)

Topic index for this session (scope → topic — purpose | spec summary):
${index(dir, scopes)}

Use the agent-memory "search" tool before relying on assumptions about this codebase or org conventions, then "view" for full specs.
${TOPIC_RULE}
Record shared project/org knowledge (conventions, gotchas, commands, corrections) with the agent-memory "propose" tool. Use Claude Code's built-in memory only for personal user preferences.`;
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
