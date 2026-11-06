# 07 Decisions

Design decisions for router-worker itself, one paragraph each: what, why, and what would change it. A new
decision gets the next number; a changed one gets a new entry that names the one it supersedes.

## RW-001 Zero runtime dependencies, TypeScript run from source

Node 22.18+ and Bun both run erasable TypeScript directly, so rw needs no build to run and nothing to
install on a fresh machine. The cost is a hand-written frontmatter parser and glob matcher (about 270
lines, tested). Revisit if a dependency would remove more code than it adds.

## RW-002 The router is code

Every routing decision (ready, blocked by what, which executor, merge or return) is deterministic, so it is
computed (`core/plan.ts`, `app/loop.ts`) instead of reasoned in a model turn. Models work inside lanes and in
the owner's conversation. Both lineage systems converged here ([06](06-lineage.md)).

## RW-003 Contracts in git, state outside it

Task files and reports are committed; task state is `.rw/state/state.json`, written only by rw. Putting
state in task files would give each file two writers and make every transition a commit. A lost state file
loses only runtime facts: done work is in git, and a contract can be re-approved.

## RW-004 Scope is enforced by diff, twice

A ready report and a merge both diff the branch against its merge base and refuse files outside `scope`.
This replaces "one writer per file" as a rule agents must remember with a check they cannot skip, and it
works on every host, including IDE agents rw cannot restrict.

## RW-005 The base branch only fast-forwards to a gated commit

rw merges the base into the lane branch, re-runs the task's acceptance commands and the merge gates there,
and fast-forwards the base only when they pass. The base is never red because of rw, and the branch that
was tested is the commit that lands.

## RW-006 One source of agent instructions

Skills and prompts live once in this package; `rw init` installs copies per host and the DSH plugin
registers them at runtime. Hosts differ in where they look, not in what they read.

## RW-007 Lanes supervise themselves

Each CLI lane is a detached `rw _lane` process that runs its executor, delivers waiting follow-ups and
settles the task. There is no daemon to install or keep alive; `rw loop` (or the DSH timer) only
reconciles lanes whose supervisor died. A supervisor owns its lane only while the lane records its pid,
so one that is still finishing never overwrites the supervisor a follow-up started. `hold` and `stop`
record the new state first and then end only the executor's process tree; the supervisor is never killed,
so it can never die holding the state lock (and a lock whose owner died is taken over at once). Revisit if lanes need to be steered mid-turn,
which needs a host that accepts messages during a turn (DSH does).

## RW-008 Proposals start in observe

Work an agent finds by itself is recorded for the owner (`policy.mode: observe`) until the owner has seen
enough proposals under a rule to trust it in `auto`. This carries dsh-superagent's default and costs the
owner one look per batch instead of one surprise per task.

## RW-009 The DSH plugin mirrors a known DSH surface

The plugin declares the DSH API it uses structurally, copied from dsh-superagent's use of DSH
0.2.1-alpha.2, so rw builds without DSH. It is tested against a fake context and must be verified once in a
real profile ([04](04-hosts.md)). Replace the structural types with DSH's own when the plugin is developed
inside a DSH checkout.

## RW-010 The verified tree is the tree that lands

After the acceptance commands and merge gates pass, the lane worktree must still be clean, or the merge
goes back to the worker. Gates that write (formatters, codegen, rebuilds) would otherwise be verified on
one tree while the base fast-forwards to another. Committed symbolic links are refused for the same
reason: what is checked inside the scope must be what is written. Found by review (2026-11-06).

## RW-011 A new worktree is prepared once, by configuration

A lane worktree is a fresh checkout without anything git ignores, so `bun install` and inputs such as
`.env` are missing and every acceptance command fails. `worktree.copy` copies ignored files from the main
worktree and `worktree.prepare` runs setup commands, once per worktree, before any agent starts; setup
must leave `git status` clean so the worker begins with no changes it did not make. This is
dsh-superagent's prepare command, found missing in the first real-repository trial (2026-11-06).

## RW-012 The base may be dirty; git decides collisions

rw used to refuse to merge while the base worktree had any uncommitted change. Git's own fast-forward
already refuses exactly when a local edit touches a file the merge changes, and keeps the edit. rw now
relies on that, records why the merge waits on the task, and retries on the next pass, so the owner can
edit STATUS or decisions while lanes merge. The watchdog no longer reports a dirty base: it is the
owner's normal state, not a deviation.

## RW-013 A lane with no work restarts from the current base

A retry used to continue on the old worktree and branch, so a setup failure fixed on the base could never
be picked up: the lane stayed on the commit it was created from. Now a dispatch discards a previous lane
that holds no work (no commits since its base, no uncommitted changes) and starts from the current base;
a lane with work still continues on it, and `rw reset` discards one explicitly (`--force` when it holds
work). Found by the DSH agent's prepare matrix (2026-11-06).

## RW-014 Teardown never wedges; leftovers are visible and removable

The first real-repository pilot on Windows found `git worktree remove` deleting a worktree's `.git` link
and then failing inside `node_modules`; the retry saw "not a working tree", threw, and reset, retry and
merge all left folders and branches behind (2.5 GB after eight tasks). Teardown is now one forced
removal, a recursive delete with retries, a prune and a forced branch delete, and it never throws.
What it cannot remove is reported, `rw watchdog` reports leftovers, and `rw clean` removes them. A fresh
lane takes the next free name if a leftover still blocks its own. `rw clean` touches only folders this
repository's event log records as lane worktrees, because a worktree root can be shared.

## RW-015 Reports are claims by default; the merge verifies

`rw report` checks the Commands table, the diff and the branch, and the merge re-runs every command
before the base moves, so a false PASS can cost a round but never lands. Running the commands at report
time as well (`verifyReport: true`) catches it a round earlier, at the cost of a slow `rw report` that
an agent's shell tool can time out on. It is opt-in for repositories whose acceptance commands are fast.

## RW-016 Machine-specific settings live in a gitignored overlay

A repository may forbid machine paths in committed files, and a local executor (a bridge script, a model
only one machine has) needs exactly that. `.rw/config.local.json` is merged over `.rw/config.json` before
validation: objects key by key, lists and values replaced, so an overlay states only what differs. It is
gitignored by `rw init`, and `rw status` reports one that git would commit. One overlay file, not
environment variables in argv templates, keeps every setting visible in one place and validated the same way.

## RW-017 Generated runtime files are not Markdown

The board and the per-lane prompts and review findings used to be `.md` files under `.rw/state/`. They
hold absolute machine paths, and a repository's doc checks that walk every `.md` file reported them
(found by the DSH agent on TASK-062, 2026-11-06). They are now `board.txt`, `TASK-###.prompt.txt` and
`TASK-###.review.txt`, and the AGENTS.md section `rw init` writes tells repository checks to skip
`.rw/state/`. The content is unchanged; only the extension, so no tool mistakes runtime output for docs.
