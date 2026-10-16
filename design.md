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
| `src/store.ts` | store init, scope resolve, topic registry parse, index, grep search, view, propose, locks, `checkTopics` |
| `src/server.ts` | MCP stdio server: `search`, `view`, `propose` |
| `src/hooks.ts` | `session-start` (inject index), `session-end` (copy transcript to `inbox/`) |
| `src/dream.ts` | dream CLI: condense, 3 passes, archive, expire, merge |
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

- MCP server session id = env `CLAUDE_CODE_SESSION_ID` (same id hooks receive). ponytail: read once at spawn.
- No hash/CAS concurrency (talk's approach) — unnecessary because live writes are append-only proposals.
- Search = regex grep, requirement-block granularity, cap 20 + total. Chosen over BM25/embeddings by user. Upgrade path: built-in `node:sqlite` FTS5 (verified on Node 24, zero deps).
- `AGENT_MEMORY_DIR` affects only this tool; Claude Code built-in memory untouched. SessionStart tells agents: shared knowledge → `propose`, built-in memory → personal prefs only.
- Fake `claude` in tests keys on `PASS: <name>` first line of each prompt and on `write dreams/….md` for report path. Keep both if editing prompts.
- Proposer skips knowledge obvious from code (by prompt) — e.g. it ignored a `npm test` → `test:ci` error that self-documents.

## Environment gotchas

- `node` crashes inside the Claude Code macOS sandbox (OpenSSL conf read under `/System` + keychain via `NODE_USE_SYSTEM_CA=1`). Run node/npm with sandbox off.
- Org policy `allowManagedMcpServersOnly: true` blocks the plugin's MCP server in real Claude Code sessions. Hooks + dream work; MCP tools need org allowlisting. Don't work around the policy.
- `node --test` needs a glob (`'test/*.test.ts'`), not a dir.

## Smoke result (2026-10-16)

Two real sessions in `acme/app1` + `acme/app2` → dream merged `org/gotchas.md` (new topic, cross-repo promotion, evidence ids). Next SessionStart index showed it. Empty dream = no-op.

## Not built (add when)

- Ranked search (FTS5) → grep misses/floods on real store; embeddings after.
- Confirmation dates, decay sweep, usage log → unused memories pile up.
- Per-session proposer fan-out → inbox outgrows one context.
- Auth, remote store, transcript redaction → leaving localhost.
- Stale lock recovery, transcript dedupe on resumed sessions (see `ponytail:` comments).
