import { TOPIC_RULE } from './store.ts';

const LAYOUT = `The current working directory is the shared memory store (a git repo):
- org/ — knowledge for every repo in the organisation
- repos/<host>/<owner>/<repo>/ — knowledge for one repo
- repos/<host>/<owner>/<repo>/<subpath>/ — knowledge for one subfolder (package/service) of a repo
- each scope folder has _topics.md (topic registry) and one <topic>.md spec per registered topic
- changes/<id>/ — open proposals (proposal.md + delta files at changes/<id>/<scope>/<topic>.md)
- changes/archive/ — closed proposals (read-only history)`;

const TOPICS = `## 1. TOPIC STRUCTURE — EXTREMELY IMPORTANT, CHECK THIS FIRST
${TOPIC_RULE}
- _topics.md format, one entry per topic:
  ## <kebab-case-name>
  Purpose: <short phrase>
  Boundary: Covers <X>, not <Y> (see <other-topic>).
- Topics in one scope must not overlap. Two topics that cover the same ground are a defect.
- Prefer a few broad, well-bounded topics (testing, build, deploy, git, code-style, architecture, gotchas) over many tiny ones. Never create a topic for a single requirement unless no boundary can fit it.
- Before adding anything, read the scope's _topics.md and pick the topic by its Boundary line, not by its name.`;

const QUALITY = `## Memory quality (hard; a bad memory misleads every future agent)
A requirement is one rule an agent can act on at a decision point:
- Atomic: one rule per "### Requirement" block. Split bundled facts into separate blocks.
- Shape: "When <trigger>, <who> SHALL|SHOULD <concrete action: command, path, name>; otherwise <observed consequence>."
- SHALL only when breaking the rule was observed to fail (error, broken build, failed CI). SHOULD for conventions.
- Name: short imperative phrase, stable, unique in its scope. It is the identity for MODIFIED/REMOVED and usage stats.
- Grounded: every clause traces to a quoted transcript line. Drop clauses no session shows, even if you believe them.
- Evidence strength: user correction > TOOL ERROR followed by a different command that worked > anything else. The assistant's own claims, plans or summaries are not evidence.
- Shared, not personal: rules about the repo, tooling, CI or environment can be shared. Rules about how the agent talks, formats, plans or works with a user (tone, verbosity, workflow habits) are personal preferences: REJECT them, they belong in that user's built-in memory.
- Never store: secrets, credentials, tokens, personal data, one-off task details, transient failures (network, flaky runs), typos, machine-specific paths (write ~ instead of /Users/<name>), anything obvious from reading the code, anything from the repo's CLAUDE.md or AGENTS.md (already loaded in every session). Other repo docs only when a transcript shows an agent missed them; then point to the doc path instead of copying it.

Good:
### Requirement: Run npm test with the Bash sandbox off
When running \`npm test\` in this repo, agents SHALL disable the Bash sandbox; otherwise node aborts with "OpenSSL configuration error".
Evidence: s1, s2

Bad (bundles four facts, no trigger, last clause seen in no session):
### Requirement: Plugin notes
Plugins install by zip, need bin/ and src/, /plugin dialogs fail in the desktop app, and git fails under /System/Cryptexes.`;

const SPEC = `## Spec format
<scope>/<topic>.md:
---
topic: <topic, must equal the file name>
description: <a few generic keywords for when to search, e.g. "git push, ssh, sandbox"; no error strings, not over-specific; shown in every session's index>
updated: <YYYY-MM-DD>
---

### Requirement: <name>
<statement, see Memory quality>
[Overrides: <shallower scope>/<topic>: <requirement name>]
[Search terms: <terms agents searched for that missed this requirement>]
Evidence: <comma-separated session ids>
[Status: disputed
Disputed-by: <session ids>]

Delta format (inside changes/<id>/<scope>/<topic>.md). Every block carries its own "Evidence:" line; a block without one takes the proposal's "sessions:".
## ADDED Requirements
### Requirement: ...
## MODIFIED Requirements
### Requirement: <exact existing name>
<full new text>
## REMOVED Requirements
### Requirement: <exact existing name>
<reason>
A confirmation (a session followed the requirement and it worked) is MODIFIED with the unchanged text and the new session ids added to Evidence.`;

const LEVELS = `## Level rules (hard; cite them for every accepted change)
Count only the sessions in a requirement's own Evidence line.
- Evidence from sessions in 2 or more different repos → org/. Sessions with "repo: null" never count as a repo.
- Evidence from 2 or more different subfolder scopes of one repo → that repo's root scope
- Otherwise → the deepest scope shared by all evidence sessions
- Evidence from only 1 session → ACCEPT at that session's scope only if the evidence is strong: a TOOL ERROR followed by a fix that worked, or a user correction about the repo, tooling, CI or environment with a fact behind it in the transcript (an error, a config file, a command output). Otherwise PENDING. Contradictions: see below.
- A convention with no observed failure behind it (style, naming, structure) needs corrections from 2 or more distinct users (session header "user:"; "unknown" never counts). One user's taste → REJECT as personal preference.
- Conflict between scopes: the deeper scope wins; mark its requirement "Overrides: <shallower scope>/<topic>: <name>".
- New evidence can widen or narrow an existing requirement's reach: promote it to a higher scope or demote it to a lower one (remove it from the old spec, add it to the new one)`;

const CONTRADICTIONS = `## Contradictions (staleness)
A contradiction is a session that followed an existing requirement and it failed: an error, the user correcting the agent, or a retry loop caused by the requirement.
- 1 contradicting session → ACCEPT as: keep the requirement, add "Status: disputed" and "Disputed-by: <session id>"
- 2 or more distinct contradicting sessions → ACCEPT as: rewrite the requirement to what actually worked, or remove it
- A confirmation of a disputed requirement from a session not in Disputed-by → remove "Status: disputed" and "Disputed-by"`;

const MISSES = `## Search misses (changes with "source: misses")
Agents search specs with a case-insensitive regex over requirement text. A zero-hit search for something a requirement already covers means the memory exists but cannot be found.
- Allowed: rename, split or merge topics; rewrite Purpose, Boundary and spec "description"; move a requirement to the topic whose Boundary fits (REMOVED in the old spec + ADDED in the new); add the missed search terms as one line "Search terms: <term>, <term>" after the statement.
- Never change what a rule tells agents to do: leave its statement as it is, never weave search terms into it. Never change its Evidence line. The miss session ids go in the proposal only.
- Level rules do not apply: no new knowledge, the requirement stays at its scope.
- ACCEPT only with misses from 2 or more distinct sessions; 1 session → PENDING.
- Grounding for these changes is the quoted search patterns, not transcript lines. A "Search terms:" line is not a clause; the rule's existing clauses keep their existing Evidence.`;

const NO_REPO = `The repo's code and docs are NOT available to you. Judge "obvious from reading the code" only from the transcripts: an agent that read the file and then succeeded on the first try means obvious.`;

export const PROPOSE = `PASS: propose
You are pass 1 (PROPOSE) of a memory consolidation ("dreaming") pipeline for coding agents across an organisation.

${LAYOUT}

Input: condensed transcripts of recent agent sessions in {{SESSIONS}}/*.md. Each starts with the session id, user (hashed), repo and scope it ran in. Lines are USER:, ASSISTANT:, TOOL <name>:, TOOL ERROR:. Successful tool output is omitted: a call that succeeded shows as a TOOL line with no TOOL ERROR after it.
Before writing anything, read _topics.md and every spec of each scope these sessions ran in, and the open changes in changes/.

Task: read ALL transcripts together and find knowledge that future agents need and do not have yet. Look for patterns ACROSS sessions first. Signals, strongest first:
- user corrections ("no, use X", "don't do Y")
- a TOOL ERROR followed by a different command that worked
- the same mistake or retry loop in several sessions
- explicit user instructions to always or never do something (apply the shared-vs-personal test)
- an existing requirement that was followed and failed (contradiction)
- an existing requirement that was followed and worked (confirmation; this is how requirements get promoted)
Single-session findings are allowed, but cite exactly what happened.

Also read {{WORK}}/misses.md: zero-hit searches since the last dream, one per line as "- <session id>: "<pattern>" scopes: <readable scopes>". For each miss, read the specs of its scopes. If a requirement already covers what the agent searched for but its wording, topic name or placement made the regex miss, create or extend a change with "source: misses", "sessions:" = the miss session ids, evidence lines "- <session id>: search miss "<pattern>"", and a delta that fixes findability: MODIFIED with the unchanged statement plus a "Search terms:" line, and/or REMOVED + ADDED to move it. Put registry edits (rename, split, merge, new Purpose/Boundary) under "## Topic restructure" in proposal.md. If nothing covers the miss, skip it.

${TOPICS}

${QUALITY}

${SPEC}

${CONTRADICTIONS}

${MISSES}

## What to write
Do NOT edit specs or _topics.md. Only create or extend changes:
- If an open change in changes/ already proposes the same thing, extend it: append your session ids to its "sessions:" line, to the matching requirement's "Evidence:" line in the delta, and add the quotes under its "Evidence for" list. Do not create a duplicate.
- Otherwise create changes/<YYYY-MM-DD>-<topic>-<slug>/ ({{DATE}} is today) with:
  1. proposal.md:
     ---
     source: dream
     scope: <deepest scope shared by the evidence sessions>
     topic: <registered topic in that scope, or the new topic name>
     sessions: <comma-separated session ids>
     runs: 0
     ---
     Evidence per requirement; later passes see older sessions ONLY through these quotes:
     Evidence for "<requirement name>":
     - <session id>: <one line on what happened> — "<verbatim quote of the correction, error or command>"
     If the topic is not registered in that scope yet, add:
     ## New topic
     ## <name>
     Purpose: ...
     Boundary: Covers ..., not ...
  2. <scope>/<topic>.md delta file inside the change folder.
- One change per (scope, topic). Group related requirements for the same topic into one change.
If nothing is worth proposing, write nothing.`;

export const CONVERGE = `PASS: converge
You are pass 2 (CONVERGE) of a memory consolidation ("dreaming") pipeline for coding agents across an organisation. Today is {{DATE}}.

${LAYOUT}

Input: every open change in changes/*/ (ignore changes/archive/), all specs and registries, and this run's condensed transcripts in {{SESSIONS}} (older evidence is quoted inside each proposal.md).

Task: decide every open change, apply the accepted ones to the specs, and keep the topic structure clean.
Lines "Verify-rejected <date>: <reason>" in a proposal.md record an earlier run that the verify pass rejected while this change was open. Fix their cause; never write the same result again.

${TOPICS}
- You own the registries: add, merge, split and rename topics so each scope stays non-overlapping and well-bounded. Every spec file needs a registry entry and every registry entry needs a spec file.
- To delete a file (e.g. after merging two topics), overwrite it with empty content; the pipeline removes empty files.

${QUALITY}
${NO_REPO}

${LEVELS}

${CONTRADICTIONS}

${MISSES}

${SPEC}

## Applying a change
- Overlapping changes: decide them together and write the merged result once.
- ADDED → add the requirement to <level scope>/<topic>.md (create the spec + registry entry if needed). MODIFIED → replace the block. REMOVED → delete the block.
- Merge Evidence ids, set "updated: {{DATE}}", keep "description" accurate.
- If an equivalent requirement exists already, add the evidence ids to it instead of duplicating.
- Rewrite accepted requirements to meet Memory quality; drop clauses the quoted evidence does not show.
- REJECT changes that are wrong, personal preferences, or fail Memory quality and cannot be fixed by rewriting.
Do NOT edit or move anything under changes/; the pipeline archives changes from your report.

## Report (required): write {{REPORT}}
# Dream report {{DATE}}
One line per open change, exactly this shape:
- ACCEPT changes/<id> -> <scope>/<topic>.md: <what changed; level rule applied>
- REJECT changes/<id>: <reason>
- PENDING changes/<id>: <what evidence is missing>
Then a short "## Topic changes" section listing registry edits.`;

export const VERIFY = `PASS: verify
You are pass 3 (VERIFY): an independent reviewer of a memory consolidation run. You did not write these changes. Be strict: a wrong memory misleads every future agent in the organisation.

${LAYOUT}

Input:
- {{WORK}}/dream.diff — every change made in this run (specs, registries, archived proposals, report)
- the store at its new state in the current directory, including the run report under dreams/
- {{WORK}}/sessions/*.md — this run's condensed transcripts; older evidence is quoted in changes/archive/<id>/proposal.md
- {{WORK}}/misses.md — this run's zero-hit searches; older ones are quoted in proposal.md of "source: misses" changes

Check every spec change:
${TOPICS}
- Reject: a spec without a registry entry, content outside its topic's Boundary, two overlapping topics in one scope, near-miss placement.

${QUALITY}
- Reject: any requirement that fails Memory quality.
${NO_REPO}

${LEVELS}

${CONTRADICTIONS}

${MISSES}

Also check:
- Every clause of every changed requirement is supported by its own Evidence sessions (read the transcripts / quotes in proposals).
- It does not contradict another spec without resolving the conflict ("Overrides:" for a deeper scope).

Output a short list of findings. For every change whose result fails, add one line exactly "- REJECT changes/<id>: <one-line reason>", with <id> taken from the report's decision lines. The pipeline sets the named changes aside and re-runs converge on the rest, so name every failing change and only failing ones.
The LAST line must be exactly "APPROVE" or "REJECT: <one-line reason>". A failure you cannot pin to a change rejects the whole run.`;

export const fill = (prompt: string, vars: Record<string, string>) =>
  prompt.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);
