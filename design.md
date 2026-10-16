# Design: agent-memory

Reference for agents working on this repo. Usage/install → [README.md](README.md).

Goal: org-wide shared memory for coding agents. Prototype, local only. Origin: Lamis Mukta, "Learning while you sleep: Beyond memory to dreaming" (AI Native DevCon 2026) — in-band memory can't see cross-session failures, so an async "dream" pass consolidates many transcripts. Spec flow borrowed from OpenSpec.

## Core model

- **Memory = spec.** One file per topic per scope, `### Requirement:` blocks (SHALL/SHOULD + `Evidence:` session ids).
- **Live sessions never write specs.** Read via `search`/`view`, write only `propose` → new `changes/<id>/`.
- **Only the dream pipeline changes specs**: propose → converge → verify, auto-merge, no human. Safety net = verify + `git revert`.
- **Topic structure is the #1 rule** (user requirement). Stated as "EXTREMELY IMPORTANT" in `TOPIC_RULE` (`src/store.ts`), reused by every prompt, tool description and SessionStart text. Keep it that way.

## Files

| File | Role |
|---|---|
| `src/store.ts` | store init, scope resolve, topic registry parse, index, `requirements` + grep search, view, propose, locks, `checkTopics`, `logUsage` |
| `src/cli.ts`, `bin/agent-memory` | Bash CLI: `search`, `view`, `propose`; logs each call to `usage.jsonl`. `bin/` wrapper fixes node env for the Bash sandbox |
| `src/hooks.ts` | `session-start` (inject index, log `session` event), `session-end` (copy transcript to `inbox/`) |
| `src/dream.ts` | dream CLI: condense, 3 passes, archive, expire, merge |
| `src/stats.ts` | `npm run stats`: aggregates `usage.jsonl` + `changes/` into markdown |
| `src/prompts.ts` | PROPOSE / CONVERGE / VERIFY prompts, `{{VAR}}` placeholders via `fill` |
| `.claude-plugin/`, `hooks/hooks.json` | Claude Code plugin + local marketplace |
| `test/*.test.ts` | integration tests: temp stores, real git, fake `claude` |

## Scopes

- `org` + `repos/<normalized origin remote>` + optional subfolder from repo's `.agent-memory.json` `{ "scopes": [globs] }`, deepest match.
- No git → `org` only. No remote → `repos/local/<dirname>`.
- A spec's scope = its directory. Session can read only its own scope list (sibling subfolders of same repo are NOT readable).

## Level rules (converge, hard)

- evidence ≥2 repos → `org/`
- evidence ≥2 subfolders of one repo → repo root
- else deepest shared scope
- 1 session → PENDING
- contradiction: 1 session → `Status: disputed` + `Disputed-by`; ≥2 → rewrite/remove

## Dream pipeline invariants

1. One dream at a time: mkdir lock `.git/dream.lock`. Live commits use `.git/commit.lock`.
2. Pass 1 runs in worktree `dream/<ts>`, its commit is merged into `main` **immediately**, inbox → `inbox/processed/`. Rejected runs therefore never lose proposals.
3. Converge edits specs/registries only. It writes decision lines `- ACCEPT|REJECT|PENDING changes/<id>` in `dreams/<ts>.md`; **the script** archives changes from those lines. No lines → run rejected.
4. Agents can't delete files (no Bash). Empty spec file = delete; script removes them.
5. `checkTopics` (mechanical) runs before verify; failure rejects without calling verify.
6. Verify last line must be exactly `APPROVE` (markdown `*`/`` ` `` stripped). Anything else = reject → `dream.log`.
7. `runs` bump + expiry (≥3) happens on `main` after merge/reject, so it counts rejected runs too.
8. Final merge can't conflict: live sessions only add new `changes/<id>/` dirs.
9. Dream `claude -p` calls: `--tools` whitelist, `acceptEdits`, `--no-session-persistence`, `--strict-mcp-config`, env `AGENT_MEMORY_DREAM=1` → hooks no-op (else dream transcripts feed inbox = loop).

## Non-obvious facts

- CLI session id = env `CLAUDE_CODE_SESSION_ID`, set in Claude Code's Bash tool (same id hooks receive).
- No hash/CAS concurrency (talk's approach) — unnecessary because live writes are append-only proposals.
- Search = regex grep, requirement-block granularity, cap 20 + total. Chosen over BM25/embeddings by user. Upgrade path: built-in `node:sqlite` FTS5 (verified on Node 24, zero deps).
- `AGENT_MEMORY_DIR` affects only this tool; Claude Code built-in memory untouched. SessionStart tells agents: shared knowledge → `propose`, built-in memory → personal prefs only.
- Fake `claude` in tests keys on `PASS: <name>` first line of each prompt and on `write dreams/….md` for report path. Keep both if editing prompts.
- Proposer skips knowledge obvious from code (by prompt) — e.g. it ignored a `npm test` → `test:ci` error that self-documents.

## Usage metrics

- Log `<store>/usage.jsonl`, append-only, one JSON line per event: `ts`, `session`, `event` + extras.
  - `session` (SessionStart hook): `source` (startup/resume/clear/compact), `scopes`. Fires again on resume/compact → stats count unique session ids.
  - `search`: raw `pattern`, `scope?`, `topic?`, `total`, `hits` = shown hits only (≤20) as `{scope, topic, requirement}`.
  - `view`: `path` (absent = list call). `propose`: `scope`, `topic`, `id`.
  - Tool throws → `{event: <tool>, error}` instead of extras (logged in the CLI's catch).
- Gitignored because store `commit` runs `git add -A`. Only new stores get the ignore line (`initStore`); older stores need it added by hand, else raw patterns land in git.
- Dream sessions don't log: hooks no-op on `AGENT_MEMORY_DREAM`, dream agents get no Bash, so they can't call the CLI.
- `npm run stats` (`src/stats.ts`): adoption, search zero-hit rate + top zero-hit patterns, per-requirement search hits + per-spec views + never-retrieved list, proposal funnel per `source`. Funnel reads `changes/` + `changes/archive/` (`Archived: accepted|rejected|expired` note), not the log.
- Requirement identity = `scope / topic / requirement name`. Renaming a requirement resets its count. No time filter (add `--since` when log grows).
- Not measured: whether an agent acted on the SessionStart index without calling tools.

## Environment gotchas

- `node` crashes inside the Claude Code macOS sandbox (OpenSSL conf read under `/System` + keychain via `NODE_USE_SYSTEM_CA=1`), and can't spawn `git` by bare name (denied `/System/Cryptexes` PATH entry aborts libuv's PATH search). `bin/agent-memory` sets env + `PATH` for this. Run `npm test` with sandbox off.
- Org policy `allowManagedMcpServersOnly: true` blocked the plugin's MCP server, so MCP was removed (2026-10-16): access is CLI-only via Bash, governed by Bash permissions and the sandbox.
- `node --test` needs a glob (`'test/*.test.ts'`), not a dir.
- Full `npm test` takes ~5 min (real git in temp stores). Run one file with `node --test test/<name>.test.ts` while iterating.

## Smoke result (2026-10-16)

Two real sessions in `acme/app1` + `acme/app2` → dream merged `org/gotchas.md` (new topic, cross-repo promotion, evidence ids). Next SessionStart index showed it. Empty dream = no-op.

## Not built (add when)

- Ranked search (FTS5) → grep misses/floods on real store; embeddings after.
- Confirmation dates, decay sweep → unused memories pile up (`npm run stats` lists never-retrieved ones).
- Per-session proposer fan-out → inbox outgrows one context.
- Auth, remote store, transcript redaction → leaving localhost.
- Stale lock recovery, transcript dedupe on resumed sessions (see `ponytail:` comments).
