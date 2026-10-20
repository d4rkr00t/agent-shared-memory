# Design: agent-memory

Reference for agents working on this repo. Usage/install → [README.md](README.md).

Goal: org-wide shared memory for coding agents. Prototype, local only. Origin: Lamis Mukta, "Learning while you sleep: Beyond memory to dreaming" (AI Native DevCon 2026) — in-band memory can't see cross-session failures, so an async "dream" pass consolidates many transcripts. Spec flow borrowed from OpenSpec.

## Core model

- **Memory = spec.** One file per topic per scope, `### Requirement:` blocks (SHALL/SHOULD + `Evidence:` session ids).
- **Live sessions never write specs.** Read via `search`/`view`, write only `propose` → new `changes/<id>/`.
- **Only the dream pipeline changes specs**: propose → converge → verify, auto-merge, no human. Safety net = verify + `git revert`.
- **Topic structure is the #1 rule** (user requirement). Stated as "EXTREMELY IMPORTANT" in `TOPIC_RULE` (`src/store.ts`), reused by every dream prompt. SessionStart carries only a one-line form (pick topic by Boundary, else `new_topic`, never a near-miss) to keep the message short (user, 2026-10-20). Keep it that way.

## Files

| File | Role |
|---|---|
| `src/store.ts` | store init, scope resolve, topic registry parse, index, `requirements` + grep search, view, propose, locks, `checkTopics`, `logUsage` |
| `src/cli.ts`, `bin/agent-memory` | Bash CLI: `search`, `view`, `propose`; logs each call to `usage.jsonl`. `bin/` wrapper fixes node env for the Bash sandbox |
| `src/hooks.ts` | `session-start` (inject index, log `session` event), `session-end` (copy transcript to `inbox/`) |
| `src/dream.ts` | dream CLI: condense, 3 passes, archive, expire, merge |
| `src/pull.ts` | `npm run pull`: copy new transcripts from SSH devboxes in `remotes.json` into `inbox/` |
| `src/stats.ts` | `npm run stats`: aggregates `usage.jsonl` + `changes/` into markdown |
| `src/prompts.ts` | PROPOSE / CONVERGE / VERIFY prompts, `{{VAR}}` placeholders via `fill` |
| `.claude-plugin/`, `hooks/hooks.json` | Claude Code plugin (hooks only, no MCP) + local marketplace |
| `test/*.test.ts` | integration tests: temp stores, real git, fake `claude`. `tools.test.ts` calls `tools()` directly, `cli.test.ts` spawns the CLI |
| `evals/*.eval.ts` | prompt evals: real `claude` dream runs on fixture stores, N trials, see Evals |

## CLI

- `sh <plugin>/bin/agent-memory search|view|propose`; `propose` takes JSON on stdin. The SessionStart text is the only place agents learn the commands, with absolute paths baked in from `import.meta.dirname`.
- SessionStart text opens with MUST search triggers (first build/test/lint/format, push/deploy/release, after a failed command, related topic in index → view). The old single "search before relying on assumptions" line got 0 searches from real sessions (2026-10-19). Pull only, no auto-inject hooks (user choice). Rest of the text: CLI usage, then what to record (failure/correction only, requirement template, scope/topic, delta sections one line each). Caveman-lite wording. Index line is `- <topic> — <spec description, else Purpose>`; dream writes description as a few generic keywords, not error strings.
- Scopes come from the Bash cwd (`resolveScope(process.cwd())`).
- Handlers live in `tools()` in `src/cli.ts`: they return a string or throw. The CLI prints errors to stderr: exit 1 for a tool error, exit 2 for usage or unknown flags. `--help` prints usage.
- `propose` rejects: unreadable scope, non-kebab topic, unregistered topic without matching `new_topic`, delta without an `## ADDED|MODIFIED|REMOVED Requirements` section or without a `### Requirement: <name>` block, empty `why`.
- `search --scope` outside the readable scopes errors instead of returning "No matches". `view` (list) only shows `_topics.md` files that exist.
- `logUsage` swallows write errors, so search and view still work on a read-only store. `propose` needs a writable store.
- Zero runtime deps (stdlib `parseArgs`); the plugin zip needs no `node_modules`.

## Scopes

- `org` + `repos/<normalized origin remote>` + optional subfolder from repo's `.agent-memory.json` `{ "scopes": [globs] }`, deepest match.
- No git → `org` only. No remote → `repos/local/<dirname>`.
- A spec's scope = its directory. Session can read only its own scope list (sibling subfolders of same repo are NOT readable).

## Level rules (converge, hard)

- counted per requirement (its own `Evidence:` line, not the change's `sessions:`)
- evidence ≥2 repos → `org/` (`repo: null` sessions don't count)
- evidence ≥2 subfolders of one repo → repo root
- else deepest shared scope
- 1 session → ACCEPT only on strong evidence (TOOL ERROR → fix, or user correction about repo/tooling/env backed by a fact in the transcript); else PENDING
- taste convention with no observed failure → needs ≥2 distinct `user` hashes, else REJECT as personal
- deeper scope overrides shallower (`Overrides:` line)
- contradiction: 1 session → `Status: disputed` + `Disputed-by`; ≥2 → rewrite/remove; later confirmation clears dispute
- confirmation = `MODIFIED` with unchanged text + new evidence

## Dream pipeline invariants

1. One dream at a time: mkdir lock `.git/dream.lock` holding a `pid` file. Live commits use `.git/commit.lock`. A lock whose pid is dead, or a lock with no pid older than 60s, is stale and reclaimed (Ctrl-C or a crash used to strand it forever). `npm run dream` prints `locked: another dream is running (pid N)` while one runs.
2. Pass 1 runs in worktree `dream/<ts>`, its commit is merged into `main` **immediately**, inbox → `inbox/processed/`. Rejected runs therefore never lose proposals.
3. Converge edits specs/registries only. It writes decision lines `- ACCEPT|REJECT|PENDING changes/<id>` in `dreams/<ts>.md`; **the script** archives changes from those lines. No lines → run rejected.
4. Agents can't delete files (no Bash). Empty spec file = delete; script removes them.
5. `checkTopics` (mechanical) runs before verify; failure rejects without calling verify.
6. Verify last line must be exactly `APPROVE` (markdown `*`/`` ` `` stripped). Verify names failing changes as `- REJECT changes/<id>: <reason>`; those are parked outside the tree and converge + verify re-run on the rest from `base` (≤3 attempts), so one bad change can't block the run (it used to: every run was rejected and good changes expired). A reject that names no change = whole run rejected. Rejections → `dream.log`.
7. `runs` bump + expiry (≥3) happens on `main` after merge/reject, so it counts rejected runs too. Each rejected change's `proposal.md` (only the named ones; all open ones when verify named none) first gets `Verify-rejected <date>: <reason>` so the next converge sees why (otherwise it repeats the same mistake until expiry).
8. Final merge can't conflict: live sessions only add new `changes/<id>/` dirs.
9. Each `claude -p` pass logs `[dream] HH:MM:SS pass: <name>…` to stderr. Passes take minutes; no output between them is normal.
10. Dream `claude -p` calls: `--tools` whitelist, `acceptEdits`, `--no-session-persistence`, `--strict-mcp-config`, env `AGENT_MEMORY_DREAM=1` → hooks no-op (else dream transcripts feed inbox = loop).
11. Search misses: `misses()` in `src/dream.ts` takes zero-hit `search` events from `usage.jsonl` newer than the newest `dreams/<ts>.md` on main (rejected runs write no report, so their misses are fed again), joins each with its session's `scopes`, writes `<work>/misses.md`. Misses alone start a run. Propose gets `--add-dir <work>` (sessions + misses). Propose turns misses on requirements that already exist into `source: misses` changes: rename/split/merge topics, rewrite Purpose/Boundary/description, move requirements, add the missed terms. Rule meaning and `Evidence:` never change, level rules don't apply, ACCEPT needs misses from 2+ sessions (else PENDING) (`MISSES` block in `src/prompts.ts`, shared by all 3 passes). Misses that no requirement covers are skipped; new knowledge comes only from transcripts.

## Remote pull

- Scope: the user's own SSH devboxes. Extraction only: remote sessions get no index and can't propose, and the remote needs no plugin (ssh + git + find + tar only).
- `<store>/remotes.json` = `{ "<ssh host>": "<watermark>" }`, gitignored. A new host starts with `""` (pulls everything).
- Separate command `npm run pull`, not part of dream. It takes the `dream` lock (no wait) and prints `locked: a dream is running` if a dream holds it, because a pull running mid-dream would rewrite inbox files that dream then moves to `processed/`, and their new lines would be lost. Cron: `pull; dream`.
- Per host: `ssh -o BatchMode=yes` lists `~/.claude/projects/*/*.jsonl` (`-maxdepth 2`, no subagent files) newer than the watermark, then `tar`s them over. Long-open sessions get pulled too (no SessionEnd needed).
- Watermark = remote `date -u +%Y%m%d%H%M.%S`, taken before `find`, so clock skew doesn't matter. Filter = `TZ=UTC touch -t` on a temp ref file + `find -newer`: BSD find rejects ISO `-newermt`.
- `repo`/`scopes`/`user` are resolved on the remote, one ssh call per host (`RESOLVE` script: realpath, git root, origin, `.agent-memory.json`, email), then fed to the pure `scopeOf` shared with `resolveScope`. Meta adds `host`.
- Growing sessions get re-pulled whole. Meta `offset` = line count of `inbox/processed/<id>.jsonl` (or the existing unprocessed meta's offset), and `condense` skips those lines.
- A host success logs `[pull] <host>: <n> sessions` (n = transcripts with a `cwd` written to `inbox/`). A host failure logs `[pull] <host> failed: …`, keeps its watermark and doesn't stop the other hosts. `AGENT_MEMORY_SSH` overrides the binary (tests use a fake that runs the command locally with a fake `HOME`).

## Non-obvious facts

- CLI session id = env `CLAUDE_CODE_SESSION_ID`, set in Claude Code's Bash tool (same id hooks receive).
- No hash/CAS concurrency (talk's approach) — unnecessary because live writes are append-only proposals.
- Search = regex grep, requirement-block granularity, cap 20 + total. Chosen over BM25/embeddings by user. Upgrade path: built-in `node:sqlite` FTS5 (verified on Node 24, zero deps).
- `AGENT_MEMORY_DIR` affects only this tool; Claude Code built-in memory untouched. SessionStart tells agents: shared knowledge → `propose`, built-in memory → personal prefs only.
- Inbox meta + session header carry `user` = first 12 hex of sha256(`git config user.email`, fallback OS username). Lets dreams count distinct users (personal vs shared) without storing identity. Pre-existing inbox entries show `user: unknown`, which never counts.
- Prompt quality rules live in one `QUALITY` block in `src/prompts.ts` (atomic, trigger/action/consequence, grounded clauses, evidence strength, shared-vs-personal, never-store list) shared by all 3 passes. Dream passes can't read repos (`NO_REPO`): "obvious from code" is judged from transcripts only.
- Fake `claude` in tests keys on `PASS: <name>` first line of each prompt and on `write dreams/….md` for report path. Keep both if editing prompts.
- Proposer skips knowledge obvious from code (by prompt) — e.g. it ignored a `npm test` → `test:ci` error that self-documents.

## Evals

- `npm run eval` (`evals/*.eval.ts`): real `claude -p` dream runs on fixture stores, graded by asserts on the merged store. Separate from `npm test`, which fakes `claude`. Run with sandbox off; `AGENT_MEMORY_CLAUDE` is ignored.
- Each case = `trial(name, setup, check)` in `evals/helpers.ts`: `EVAL_TRIALS` (default 3) fresh stores dream in parallel (`node src/dream.ts` with `AGENT_MEMORY_DIR`), pass at ≥ `EVAL_MIN_PASS` (default 2).
- Fixtures: `session(store, id, { repo, user, turns })` writes inbox jsonl + meta like the SessionEnd hook. Turns: `user`, `assistant`, `tool` (tool_use), `error` (tool_result `is_error`).
- Cases: level rules, rejections (personal pref, secret), contradictions, topic placement + confirmation dedupe, search misses (`miss()` writes usage events; 2 sessions → missed patterns hit, 1 → specs untouched). Negative cases accept any dream status; positive ones require `merged`.
- Session evals (`evals/search.eval.ts`): `trial(..., run)` with `runSession(task, files)` instead of dream. Real `claude -p --plugin-dir <repo>` in a temp `acme/app1` repo (push goes to a local bare repo), store via `AGENT_MEMORY_DIR`. Pass = `usage.jsonl` shows the planted requirement in `search` hits or a `view` of its spec. Cases: before tests, before push, after a failed command.
- Cost: 3 `claude -p` passes per trial, minutes each. Dream sessions load the runner's global CLAUDE.md, so results depend on whose machine runs them.

## Usage metrics

- Log `<store>/usage.jsonl`, append-only, one JSON line per event: `ts`, `session`, `event` + extras.
  - `session` (SessionStart hook): `source` (startup/resume/clear/compact), `scopes`. Fires again on resume/compact → stats count unique session ids.
  - `search`: raw `pattern`, `scope?`, `topic?`, `total`, `hits` = shown hits only (≤20) as `{scope, topic, requirement}`.
  - `view`: `path` (absent = list call). `propose`: `scope`, `topic`, `id`.
  - Tool throws → `{event: <tool>, error}` instead of extras (logged in the CLI's catch).
- Gitignored because store `commit` runs `git add -A`. Only new stores get the ignore line (`initStore`); older stores need it added by hand, else raw patterns land in git.
- The dream reads zero-hit searches from the log (Dream pipeline invariants 11), so the gitignored log is a dream input too, not only stats.
- Dream sessions don't log: hooks no-op on `AGENT_MEMORY_DREAM`, dream agents get no Bash, so they can't call the CLI.
- `npm run stats` (`src/stats.ts`): adoption, search zero-hit rate + top zero-hit patterns, per-topic table (reqs, disputed, search hits, views, purpose) + per-spec views + never-retrieved list, proposal funnel per `source` + open changes (scope/topic, source, runs), dreams (run count, last report ACCEPT/REJECT/PENDING, inbox waiting/processed), and the SessionStart message for the cwd's scopes with its size (`startMessage` in `src/hooks.ts`, shared with the hook so stats never logs a session). Funnel reads `changes/` + `changes/archive/` (`Archived: accepted|rejected|expired` note), not the log.
- Requirement identity = `scope / topic / requirement name`. Renaming a requirement resets its count. No time filter (add `--since` when log grows).
- Not measured: whether an agent acted on the SessionStart index without running the CLI.

## Environment gotchas

- `node` crashes inside the Claude Code macOS sandbox (OpenSSL conf read under `/System` + keychain via `NODE_USE_SYSTEM_CA=1`), and can't spawn `git` by bare name (denied `/System/Cryptexes` PATH entry aborts libuv's PATH search). `bin/agent-memory` sets env + `PATH` for this. Run `npm test` with sandbox off.
- Org policy `allowManagedMcpServersOnly: true` blocked the plugin's MCP server, so MCP was removed (2026-10-16): access is CLI-only via Bash, governed by Bash permissions and the sandbox.
- Sandboxed Bash can't write `~/.agent-memory` by default: `propose` fails with EPERM until the user adds it to `sandbox.filesystem.allowWrite`.
- Org `strictKnownMarketplaces` blocks `claude plugin marketplace add <dir>`. Install = upload a zip in the desktop app; the zip must contain `.claude-plugin/`, `hooks/`, `src/`, `bin/`, `package.json` (a manifest-only zip installs a plugin that does nothing). `/plugin` dialogs don't work in the desktop Code tab; use `claude plugin …` in a terminal.
- `node --test` needs a glob (`'test/*.test.ts'`), not a dir.
- Full `npm test` takes ~5 min (real git in temp stores). Run one file with `node --test test/<name>.test.ts` while iterating.

## Smoke result (2026-10-16)

Two real sessions in `acme/app1` + `acme/app2` → dream merged `org/gotchas.md` (new topic, cross-repo promotion, evidence ids). Next SessionStart index showed it. Empty dream = no-op.

## Not built (add when)

- Ranked search (FTS5) → grep misses/floods on real store; embeddings after.
- Confirmation dates, decay sweep → unused memories pile up (`npm run stats` lists never-retrieved ones).
- Per-session proposer fan-out → inbox outgrows one context.
- Auth, remote store, transcript redaction → leaving localhost. Remote pull copies raw transcripts too.
- Remote read side (index, propose on devboxes), teammates' machines, cloud sessions → remote sessions need memory, or need sharing beyond one user.
- Transcript dedupe on resumed sessions; lock pid-reuse guard (see `ponytail:` comments).
- Local transcripts only reach `inbox/` on `SessionEnd`, so long-open local desktop sessions never feed dreams. Fix = `pull` with no ssh prefix on local `~/.claude/projects/`.
