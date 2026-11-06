# 04 Hosts

How each host runs router-worker, what it installs, and what it can enforce. Builds on
[03 Executors](03-executors.md).

## One source, three hosts

Agent instructions exist once, in this package's `skills/` (`rw-router`, `rw-intake`, `rw-worker`,
`rw-watchdog`) and `prompts/` (worker, reviewer, follow-up). `rw init --host …` copies the skills into the
host's own location; the DSH plugin registers them at runtime. Every host also reads the rw section that
`rw init` adds to the repository's `AGENTS.md`, between `<!-- rw:begin -->` and `<!-- rw:end -->`.
Re-running `rw init` refreshes the installed copies and that section, and keeps your config.

## Put `rw` on your PATH (once per machine)

```sh
cd <path-to>/router-worker
npm link              # creates the rw command; or: alias rw="bun C:/…/router-worker/src/cli.ts"
rw help
```

rw runs its TypeScript directly on Node 22.18+ or Bun; `npm install` is needed only for `npm run
typecheck`, and `npm run build` only for the DSH plugin. Lanes always get `rw` on their PATH from rw
itself, and every prompt also prints the explicit command, so an agent never depends on your shell setup.

## Claude Code

```sh
cd <repo> && rw init --host claude
```

Writes `.claude/skills/rw-*/SKILL.md` and makes `CLAUDE.md` import `AGENTS.md` (`@AGENTS.md`).

- **As the router**: open Claude Code in the repository and say "status" or "run the queue"; the
  rw-router skill loads. It calls `rw status`, writes tasks with `rw add`, relays questions, and runs
  `rw loop --once` per turn. Or skip the agent and run `rw loop` in a terminal.
- **As workers**: tier entries of kind `claude` run `claude -p` headless in each lane worktree.
- **Enforcement**: the reviewer's tools are restricted by `--allowedTools`/`--disallowedTools`; a
  worker's are as wide as `allowedTools` says. The owner-only guard (`RW_TASK`) holds for anything
  started through rw.

## Antigravity

```sh
cd <repo> && rw init --host antigravity
```

Writes `.agent/workflows/rw-*.md` (run `/rw-router`, `/rw-worker TASK-###` from the agent panel) and an
always-on rule `.agent/rules/router-worker.md` that points at the AGENTS.md section. Antigravity's folder
conventions have moved between releases: if your version reads workflows or rules from elsewhere, move
the files; their content does not depend on the location.

- **As workers, headless**: a `command` executor wired to an Antigravity bridge script
  ([03](03-executors.md)). Put it first in `build` to use that quota before Claude's; a quota failure
  falls back automatically.
- **As workers, in the IDE**: leave `manual` in the tier. rw prints the worktree and prompt file; open
  the worktree in Antigravity and run `/rw-worker TASK-###`. The lane is done when the agent runs
  `rw report`.
- **Enforcement**: rw has no control over an IDE agent's tools. Scope is still enforced at report and
  merge, and the base never goes red, because those checks are rw's code, not the agent's.

## DSH (DeepSeek Harness) plugin

The plugin (`plugin/dsh/`) runs inside a DSH profile:

- the router pass on a timer for each configured repository (`intervalSeconds`, default 30);
- the tools `rw_status`, `rw_add`, `rw_answer`, `rw_followup`, `rw_decide`, `rw_loop_once` and the rw
  skills on every Session, so the profile's own chat is the owner's console;
- executor kind `dsh`: each lane is a DSH Session in its worktree under the bundle's `rw-worker`
  preset (DSH's standard tools minus asking, presenting, planning, scheduling and plugin management).

Install, following dsh-superagent's procedure for a bundle:

```sh
cd <path-to>/router-worker
npm install && npm run build
dsh plugin --profile <profile> add "link:$PWD"
```

Then append [plugin/dsh/profile.example.yml](../plugin/dsh/profile.example.yml) to
`$DSH_HOME/profiles/<profile>/cordis.patch.yml` with your repository paths, and put `dsh` in a tier:

```json
"executors": { "dsh": { "kind": "dsh" } },
"tiers": { "build": ["dsh", "claude", "manual"] }
```

Only one router should drive a repository at a time: either the plugin's timer, or `rw loop` in a
terminal. Both are safe together (state is locked and merges are serialized) but they would race to
dispatch the same queue.

**Verification status.** The DSH calls (`sessionController.resolveAgent/create/rename`,
`workspaceRegistry.create`, `permissionPresets.set`, `agent.followup`, `agent.ctx.tools.register`,
`skills.register`, the `agent/created` and `agent/status` events) are taken from dsh-superagent's use of
DSH 0.2.1-alpha.2 and are declared structurally in `plugin/dsh/index.ts`, so the package builds without
DSH. `tests/dsh-plugin.test.ts` runs the plugin against a fake DSH context. It has not run inside a real
DSH yet: the first time, start the profile, check its log for `router-worker ready`, and dispatch one
`light` task to a `dsh` lane before relying on it.

**Enforcement**: DSH lanes do not get `RW_TASK` in their shell, so the owner-only guard does not apply
inside them; the prompt and the rw-worker skill state the rule, and scope is enforced at report and merge.

## A repository that already has a process

A common shape for agent-run repositories before rw: one hand-kept status file with a task queue,
round-by-round reports, decision records, and a lead agent dispatching by hand. Keep the decisions and
the specs; move the queue:

| Before | router-worker |
| --- | --- |
| a task-queue row in the status file (task, story, depends, write scope, acceptance) | `work/tasks/TASK-###.md`, with the same fields |
| a script or a model turn that works out what is ready | `rw next` |
| a read-only audit script | `rw watchdog`, with the repository's own invariant checks in `watchdog.checks` |
| the full gate a lead runs at the end of a round | `gates.merge`, run on every merge (for example `["npm run lint", "npm test", "npm run build"]`) |
| installing dependencies and copying `.env` into each worktree by hand | `worktree.prepare: ["npm ci"]` (or `bun install --frozen-lockfile`), `worktree.copy: [".env"]` |
| pausing merges while someone edits the status file or decisions | not needed: uncommitted edits block a merge only when they touch a file that merge changes |
| a report per round | the task report, plus a phase report when a phase ends |
| lane records kept by a bridge script | `.rw/state/lanes/` and the lane record |
| a halt pack written when the queue empties | the board's Needs-you list and the rw-router decision sheet |

Point `tasksDir` and `reportsDir` at existing folders if you want rw's records next to the old ones.
