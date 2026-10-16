# agent-memory

Org-wide shared memory for coding agents. Prototype, runs locally.

- **Memory = specs.** One file per topic, `### Requirement:` blocks with SHALL/SHOULD + `Evidence:` session ids.
- **Sessions read live, never write specs.** They `search` / `view` and submit `propose` changes.
- **Dreaming** (`npm run dream`) turns session transcripts + proposals into spec changes: propose → converge → verify, auto-merged, no human in the loop. Safety net: verify pass + `git revert`.

Idea: Lamis Mukta, ["Learning while you sleep: Beyond memory to dreaming"](https://www.youtube.com/watch?v=tTcxVv8HHNw). Spec flow inspired by OpenSpec.

## Install

Requires Node ≥ 24, git, Claude Code.

```bash
npm install
```

Try it for one session:

```bash
claude --plugin-dir /path/to/agentic-distributed-memory
```

Install for every session (inside an interactive `claude`):

```
/plugin marketplace add /path/to/agentic-distributed-memory
/plugin install agent-memory@agent-memory-local
```

The plugin adds:
- MCP server `agent-memory` with tools `search`, `view`, `propose`
- `SessionStart` hook: injects the topic index for the session's scopes
- `SessionEnd` hook: copies the transcript to the store's `inbox/`

> Orgs with `allowManagedMcpServersOnly` must allowlist the server (`node <plugin>/src/server.ts`) for the MCP tools to load. Hooks and dreaming work without it.

## Store

Git repo at `~/.agent-memory/` (override with `AGENT_MEMORY_DIR`; only this tool reads it, Claude Code's built-in memory is untouched).

```
org/                                  knowledge for every repo
repos/<host>/<owner>/<repo>/          one repo
repos/<host>/<owner>/<repo>/<subpath>/  one package/service in a repo
  _topics.md                          topic registry for the scope
  <topic>.md                          spec, one per registered topic
changes/<id>/                         open proposals (proposal.md + delta files)
changes/archive/                      closed proposals
dreams/<ts>.md                        converge reports
inbox/                                raw transcripts (gitignored)
dream.log                             rejected runs (gitignored)
```

### Scopes

A session's scopes come from its cwd: `org` + repo (from `git remote get-url origin`) + optional subfolder. Declare subfolder scopes in the repo root:

```json
// .agent-memory.json
{ "scopes": ["packages/*", "services/api"] }
```

The deepest match wins. A non-git cwd only sees `org`.

### Topics (most important rule)

Every scope has `_topics.md`:

```markdown
## testing
Purpose: How tests are written and run.
Boundary: Covers test runner and fixtures, not CI pipelines (see ci).
```

Every spec file must match a registered topic, and topics must not overlap. `propose` rejects unknown topics unless `new_topic` is passed. Converge owns the registry. `checkTopics` and the verify pass reject any run that breaks the structure.

## Dreaming

```bash
npm run dream
```

1. Condense `inbox/` transcripts.
2. **Propose**: one agent reads all sessions and writes `changes/<id>/` for cross-session patterns and contradictions. These are committed to `main` straight away.
3. **Converge** (on a `dream/<ts>` worktree): decides ACCEPT / REJECT / PENDING for every open change, picks the level, edits the specs, writes `dreams/<ts>.md`.
   - Evidence from ≥ 2 repos → `org/`. Evidence from ≥ 2 subfolders → repo root. Otherwise the deepest shared scope. A single session stays pending.
   - Contradictions: 1 session → `Status: disputed`. 2 sessions → rewrite or remove.
4. `checkTopics` (mechanical), then **Verify**: an independent agent reviews the diff against the evidence. `APPROVE` merges into `main`. `REJECT` logs to `dream.log`, and the changes stay pending.
5. Every still-open change gets `runs += 1`. Changes reach 3 runs and expire.

Only one dream runs at a time (lock). Run it nightly:

```bash
0 3 * * * cd /path/to/agentic-distributed-memory && /usr/local/bin/node src/dream.ts >> ~/.agent-memory/cron.log 2>&1
```

Undo a bad dream: `git -C ~/.agent-memory revert -m 1 <merge-commit>`.

## Test

```bash
npm test
```

Integration tests use temp stores, real git, and a fake `claude` (`AGENT_MEMORY_CLAUDE`).

## Not built yet

Auth, remote store, transcript redaction, ranked search (SQLite FTS5 via built-in `node:sqlite`) / embeddings, confirmation dates and decay, per-session proposer fan-out.
