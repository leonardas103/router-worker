# 02 Protocol

The files, the loop, the gates and the halts, exactly as rw implements them. Builds on
[01 Model](01-model.md).

## Files in a repository

| Path | Class | Writer | In git |
| --- | --- | --- | --- |
| `.rw/config.json` | settings | owner | yes |
| `.rw/prompts/worker.md`, `reviewer.md` | team text appended to the built-in prompts | owner | yes |
| `work/tasks/TASK-###.md` | contracts | owner (or intake agent, then `rw approve`) | yes; rw commits them |
| `work/reports/TASK-###.md` | records | the task's worker, on its branch | yes; merged with the work; never edited after |
| `.rw/state/state.json` | task and lane state | rw only, under a lock | no |
| `.rw/state/STATUS.md` | the board, generated on every change | rw | no |
| `.rw/state/events.jsonl` | append-only audit: dispatch, report, merge, fallback… | rw | no |
| `.rw/state/lanes/` | prompts and executor logs per lane | rw | no |
| `~/.rw/worktrees/<repo>/TASK-###-<slug>` | lane worktrees (outside the repository) | the worker | branch `rw/TASK-###-<slug>` |

A fresh session reconstructs the work from git alone: contracts and reports are committed, and done work
is merged. Runtime state is machine-local, like the worktrees it points at.

## Task file

```markdown
---
id: TASK-007
title: Show the queue length in the status bar
parent: STORY S12          # optional: the spec id this slice implements
depends: [TASK-006]        # merged before this starts
tier: build                # light | build | review, or any tier the config defines
review: none               # none | required
basis: explicit            # explicit | rule:<rule-id>
authority: Ada 2026-11-06  # who authorized it, when
scope: [src/ui/status-bar/**, test/ui/status-bar/**]
accept: [npm test]
---
## Goal
The owner's words.
## Read first
- decisions/D-004.md
## Out of scope
- the sidebar
```

The frontmatter is a strict subset of YAML: `key: value`, inline `[a, b]` or block `- item` lists,
optional quotes. Anything else fails with its line number. A `state:` field is refused: state is rw's.

Scope globs: `dir/**` or `dir/` (everything below), `dir/*.ts` (one level), `**/*.md`, or a plain path
(that file, or everything below a directory of that name), and `{a,b}` alternatives, which may nest
(`packages/sim/src/{commands,index}.ts`). The task's own report path is always allowed.
Matching is exact: case-sensitive on every platform (a case mismatch is refused, never widened), and a
path with `.` or `..` segments or an absolute path never matches. rw reads paths from git NUL-separated,
so spaces and non-ASCII names are compared as stored.

## Report file

```markdown
---
task: TASK-007
state: ready          # ready | blocked | dropped | failed
commit: ""            # optional; rw reads HEAD
question: ""          # required when blocked: one concrete question, at most 80 words
---
## Summary
## Changed
## Commands
| Command | Result |
| --- | --- |
| `npm test` | PASS 214 tests |
## Risks
## Gaps
```

## The gates

**Intake** (`rw add`, `rw propose`, `rw approve`):

- `rw add` records the owner's request as `explicit`, queued at once, and commits the task file.
- `rw propose --rule <id>` checks the rule in `policy.rules` and `policy.mode`:
  `off` refuses; `observe` (default) records it as `proposed` for the owner; `auto` queues it if the rule
  is enabled, allows the task's tier, and the scope has at most `maxScope` entries; otherwise `proposed`.
- A hand-written task file is `proposed` until `rw approve`.
- `rw add`, `rw approve`, `rw answer`, `rw hold`, `rw stop`… are refused inside a lane.

**Report** (`rw report TASK --state …`), all checked before rw believes it:

- the report parses, names the task, and its state matches `--state`;
- `ready`: every `accept` command is in the Commands table with a result starting PASS/OK; no open
  question; the worktree has no uncommitted or untracked files; the branch has commits; the report is
  committed; every file changed since the merge base is inside `scope`, and none is a symbolic link;
- `blocked`: a `question:` of at most 80 words; `dropped`/`failed`: a body that says why.

A refusal lists every problem; the worker fixes them and reports again.

By default the Commands table is a claim, and the merge is where rw runs it. With `verifyReport: true`,
`rw report` also runs every acceptance command in the lane before it believes a ready report, so a
false PASS goes back to the worker in the same turn instead of a round later. It is off by default:
`rw report` then takes as long as the acceptance commands, and an agent's shell tool may time out on a
slow suite (Claude Code's default is two minutes).

**Merge** (`rw merge TASK`, or the loop), one task at a time under a merge lock:

1. if `review: required`, the reviewer must have approved;
2. the lane worktree is clean; rw merges the base into the lane branch (a conflict goes back to the
   worker with the file list);
3. the scope check runs again on the merged branch, and the branch may not add or change a symbolic
   link (a link inside the scope can point outside it);
4. rw runs every `accept` command, then every `gates.merge` command, in the lane worktree;
5. the worktree must still be clean: a command that writes (a formatter, codegen, a rebuild) goes back to
   the worker, who commits the generated output or makes the command check without writing, because the
   tree rw verified has to be the tree that lands;
6. only then it fast-forwards the base and removes the worktree and branch. When the base is checked out,
   rw runs `merge --ff-only` there. Your uncommitted edits do not block it: git refuses only when an
   edit touches a file the merge changes, and then nothing moves, your edit is kept, the board shows
   `merge waits: …`, and the next pass merges once the file is committed, stashed or reverted. When the
   base is not checked out, rw updates the branch ref.

Every gate command's exit code, duration and output go to `.rw/state/lanes/TASK-###.merge.log`, and the
merge line names that file. Removing the lane's worktree and branch never fails the merge: rw forces the
worktree removal, deletes what is left with retries (long paths, read-only and briefly locked files on
Windows), and prunes git's record. Anything it still could not remove is listed after the merge line and
reported by `rw watchdog` as a leftover until `rw clean` removes it. (Package managers such as Bun
hardlink `node_modules` from a shared cache, so removing a lane frees less disk than its folder size.)

A red step goes back to the same worker session as a follow-up with the output tail, up to
`limits.remediation` times; the next red step asks the owner instead. With the default of 2: the first
and second red merges go back to the worker, the third blocks the task with a question. The task's
`remediation` counts the returns. An owner's answer starts the count again, and so does `rw retry`. The
base branch is never left red by rw.

## Review

A task with `review: required` gets a reviewer lane (tier `review`, read-only tools) after its ready
report. The reviewer writes findings to `.rw/state/lanes/TASK-###.review.md` (most severe first, at most
`limits.maxFindings`) and runs `rw verdict TASK --approve|--changes`. Changes go to the worker's own
session; the next ready report starts the next round. After `limits.reviewRounds` rounds (default 2) still
asking for changes, the owner decides. A reviewer that ends without a verdict is relaunched once; the
second time the owner is asked. The owner can always decide with `rw verdict` themselves.

## The loop

`rw loop` repeats a pass every `--interval` seconds (default 30) until it halts. One pass:

1. **reconcile**: a lane whose process ended without a report is settled: if the report file exists,
   rw tries the report for it; otherwise the task fails with the log tail. Waiting follow-ups are
   delivered.
2. **review and merge** every task in review.
3. **dispatch** every ready task: queued, dependencies done, no scope overlap with a task that owns its
   scope, and a free lane (`limits.lanes`; reviewer lanes count).

It halts when nothing runs, nothing is ready and nothing is in review, and exits:

| Exit | Meaning |
| --- | --- |
| 0 | queue empty: everything merged or dropped |
| 3 | waiting on the owner: a proposal, question, failure or hold, or queued work that cannot start |
| 2 | an rw error (a refused command, a bad config); the message names it |
| 1 | an unexpected error |

`--once` runs one pass; `--watch` never halts. `rw next` prints the packet a pass would act on.

## Halt triggers

The loop stops instead of guessing when:

- the queue is empty;
- a worker asks a question (a decision outside the contract, a missing input);
- a merge is red again after `limits.remediation` returns to the worker (the third red with the default 2);
- review still asks for changes after `limits.reviewRounds` rounds, or the reviewer fails twice;
- a lane ends without a report (failed) and no follow-up is waiting;
- every executor of a tier hit a capacity limit (the last attempt's failure stands).

At a halt the board's **Needs you** section is the whole message to the owner. When the queue is empty and
the next step needs a new decision, the rw-router skill drafts it as one decision sheet: recommendation,
evidence, risks, what it unblocks.

## Watchdog

`rw watchdog` is read-only and prints only deviations: task files that do not parse, unknown or cyclic
dependencies, a dispatched contract that changed (mandate drift), a running task with no lane, a lane
whose process is gone or that has been silent longer than `limits.staleMinutes`, two tasks that own
overlapping scopes, a lane that lost its worktree, leftover lane branches and folders, and the
repository's own `watchdog.checks`.

| Exit | Output | Meaning |
| --- | --- | --- |
| 0 | `WATCHDOG OK` | every check ran, nothing is wrong |
| 1 | `DEVIATION …` lines | something is wrong; each line names it |
| 4 | `SKIPPED …` lines, `WATCHDOG PARTIAL` | nothing is wrong in what ran, but some checks could not run |

A partial audit happens where processes cannot be started, such as a scheduled session in a confined
sandbox: rw then finds the repository from `.git` on disk, runs every check that needs only files, and
skips the leftover-branch check (it needs git) and `watchdog.checks` (they need a shell). Give a scheduled
watchdog permission to run `git` if you want the full audit.

Each repository is audited on its own: its config, its state, its lanes and its checks. To watch several,
`rw watchdog --repos <path>,<path>` (or `--repos-file <file>`, one path per line, `#` for comments) runs
from any folder, audits each repository exactly as `rw watchdog` would inside it, prints the details for
the ones that are not clean, and then one line per repository:

```text
== C:/git/other-project
DEVIATION lane: TASK-012 lane silent for 47m (no executor output)
WATCHDOG OK  C:/git/game
WATCHDOG DEVIATIONS=1  C:/git/other-project
```

A path that is not an rw repository is `WATCHDOG ERROR` and does not stop the others. The exit code is the
worst verdict: 1 for any deviation or error, else 4 for any partial audit, else 0. `--json` gives one record
per repository.

## Owner commands

| Command | Effect |
| --- | --- |
| `rw answer TASK "…"` | blocked → running; the question and answer go to the same session |
| `rw followup TASK "…"` | more work for the same session, within the mandate |
| `rw hold TASK [why]` | ends its executor's whole process tree (the worktree stays) and holds it; nothing automatic resumes it |
| `rw release TASK` | held → queued; the next dispatch continues on the lane's work with a recovery note |
| `rw retry TASK` | failed/blocked → queued, the same way. A lane with no work (no commits, no uncommitted changes, as after a failed prepare) is discarded and restarts from the current base, so a fix committed there is picked up |
| `rw reset TASK [--force]` | failed/blocked/held/queued → queued with the lane discarded (worktree and branch); refused while the lane holds work unless `--force`, and a worktree that lost its `.git` link counts as holding work. A running or in-review task needs `--force`, which stops its executor first |
| `rw clean [--force]` | removes leftovers: rw branches no lane uses, folders rw created for a lane that is gone, and the lanes of dropped tasks that hold no work; `--force` also removes dropped lanes with work and unmerged orphan branches. Only folders rw itself created are ever touched |
| `rw dispatch TASK [--executor e] [--model m]` | starts a lane now. `--executor` alone takes the model that executor has in the task's tier, else its `models.default`; `--model` is a `models` alias or a model name |
| `rw stop TASK [why]` | dropped; the worktree stays for inspection |
| `rw verdict TASK --approve\|--changes` | decide a review |

## Settings

`.rw/config.json`; every key is optional and unknown keys fail.

| Key | Default | Meaning |
| --- | --- | --- |
| `base` | `main` | the branch work merges into |
| `tasksDir`, `reportsDir` | `work/tasks`, `work/reports` | where contracts and reports live |
| `worktreeRoot` | `~/.rw/worktrees/{repo}` | lane worktrees, outside the repository |
| `branchPrefix` | `rw/` | lane branch names |
| `commitTasks` | `true` | rw commits task files on the base when it is checked out |
| `verifyReport` | `false` | `rw report` runs the acceptance commands itself before accepting a ready report |
| `limits.lanes` | 2 | concurrent lanes, reviewers included |
| `limits.remediation` | 2 | red merges that go back to the worker; the next one asks the owner |
| `limits.reviewRounds` | 2 | review rounds before the owner is asked |
| `limits.maxFindings` | 7 | findings per review round |
| `limits.staleMinutes` | 20 | watchdog: a lane silent this long is a deviation |
| `limits.manualStaleHours` | 24 | the same for manual lanes |
| `limits.commandTimeoutMinutes` | 30 | per acceptance/gate command |
| `gates.merge` | `[]` | commands every merge runs after the task's own `accept` |
| `worktree.copy` | `[]` | ignored files or folders copied from the main worktree into each new lane worktree (`.env`, a generated input); a file git does not ignore is refused |
| `worktree.prepare` | `[]` | shell commands run once in each new lane worktree after the copy (`bun install --frozen-lockfile`); they get `RW_MAIN` and `RW_WORKTREE`, must leave `git status` clean, and a failure fails the task with the output before any agent runs |
| `policy.mode`, `policy.rules` | `observe`, `[]` | the intake gate for proposals |
| `tiers` | light/build/review → claude, then manual | [03 Executors](03-executors.md) |
| `executors` | `claude`, `manual` | [03 Executors](03-executors.md) |
| `watchdog.checks` | `[]` | `{name, command}` the watchdog also runs |
