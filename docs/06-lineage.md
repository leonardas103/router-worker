# 06 Lineage

Where each part of router-worker comes from, and what was left out. Read it when you know dsh-superagent
or the field workflow it was distilled from and want the mapping. Builds on [05 Architecture](05-architecture.md).

## From dsh-superagent

dsh-superagent (DeepSeek Harness team, MIT, research prototype; [https://github.com/deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)) is a
proactive agent for one GitHub repository: ~34k lines, GitHub and Feishu sources, an Eval per request, a
web panel. router-worker keeps its principle and its strongest mechanisms and drops what a single local
owner does not need.

| dsh-superagent | router-worker | Note |
| --- | --- | --- |
| 000 Philosophy: least attention, most value | [00 Principles](00-principles.md) | kept verbatim as the principle |
| Ticket | Task | the contract is a committed file instead of a database row |
| Mandate (Policy version, scope, strength, rules) | Mandate (basis, authority, scope, accept) | scope is a set of paths, enforced by diff |
| Assignment, Executor Session `worker-<id>` | Lane: worktree + branch + session | same one-writer idea; sessions are Claude, a CLI bridge, DSH or a person |
| Report: progress/waiting/ready/blocked/failed/dropped | ready/blocked/failed/dropped | progress and waiting dropped: liveness is the heartbeat |
| Attention via `human_action` | `question:` on a blocked report | one concrete question, shown first on the board |
| Subscription fan-out, follow-ups owned by the worker | Follow-up to the task's own session | thread pass-through without threads |
| Policy accept modes off/observe/auto, rules | `policy.mode`, `policy.rules`, `rw propose` | same modes, deterministic gate instead of a model assessment |
| Gate (deterministic) + assessment (model) | Gate only | the owner's requests are explicit; agent ideas wait in observe |
| Main Session routes, never implements | `rw loop` is code; the rw-router skill for the conversation | the routing decision moved out of the model |
| `orchestrator_ack`, `orchestrator_reply`, 100-word IM limit | the board and one-line owner messages | no IM channel locally |
| Stored work, retries with backoff | each command is one locked state update; the supervisor settles lanes | no effect queue needed without network sources |
| Restart recovery note | `Recovery:` line when a lane restarts on an existing branch | kept |
| Pause processing, a person's hold | `rw hold` / `rw release` | kept: nothing automatic lifts a hold |
| Automated reviewer round limit (3) | `limits.reviewRounds` (2) | kept as a limit |
| `dsh-superagent-worker` preset | `rw-worker` preset | same tool removals, DSH default waits |
| Prompts: team sections + overrides with defaults tracking | built-in prompts + `.rw/prompts/*.md` appended | no override versioning: the prompts are files in git |
| Sources (GitHub, Feishu), Threads, Correlation, Channels, Evals, the panel, migrations, locales | — | not needed locally; see [01](01-model.md) Rejected concepts |

## From the field record

The second source is the working process of a game repository built end to end by coding agents: a
single hand-kept status file holding a durable task queue and a story map, a report per dispatch round,
numbered decision records, a lead agent dispatching lanes through an Antigravity bridge with Claude for
reviews, and, late in its life, a small deterministic dispatch-packet script and a read-only watchdog.
The project is not needed to read this table.

| Field practice | router-worker |
| --- | --- |
| "one status file, and nothing else holds progress" | the board is the only status view, and it is generated |
| task-queue rows (task, round, story, depends, write scope, acceptance, report) | task file fields `id`, `parent`, `depends`, `scope`, `accept`; report path fixed by id |
| the dispatch-packet script | `core/plan.ts` + `rw next`, with scope overlap and lane limits added |
| the read-only watchdog (clean tree, queue consistency, silent lanes, rebuild determinism) | `rw watchdog` + `watchdog.checks` for repository-specific checks |
| one writer per task, write scope in the queue row | enforced at report and merge |
| ids-only lane prompts | `prompts/worker.md` filled from the task file |
| review findings returned to the same lane | follow-ups resume the same session |
| a model routing table | tiers with fallback |
| the autonomy and halt contract, the halt pack | halt triggers in [02](02-protocol.md); decision sheet in the rw-router skill |
| lane reports that open and close with ids, commands and results, and the commit | the report template |
| decision records with status, authority, review and enforcement lines | not part of rw: a repository's decisions stay its own documents, named in "Read first" |
| bridge lane records (conversation id, heartbeat, idle wait) | the `command` executor and lane records |

## What was deliberately not carried

- **Waves.** In the field record they were dispatch rounds forced by a lead dispatching by hand. rw dispatches whenever a task is
  ready; a repository that wants phase reports writes them at phase ends.
- **Epics, PRDs, milestones as rw concepts.** They are the repository's spec structure; a task points at
  its slice with `parent`.
- **A model in the dispatch path.** Both sources ended up there: dsh-superagent's main Session routes with
  heavy prompting to stop it from planning; the field workflow moved dispatch into a script. rw starts
  there.
