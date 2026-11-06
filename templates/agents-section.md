## router-worker

This repository runs its multi-agent work through router-worker (`rw`). The rules below hold for every
agent and every host (Claude Code, Antigravity, DSH, Codex).

**Start every session with `rw status`.** It shows, in order: what needs the owner, what is moving,
what is next. Do not reconstruct state from files; rw is the only writer of task state.

Roles:

- **Owner** (a person) authorizes work: `rw add`, `rw approve`, `rw answer`, `rw hold`, `rw stop`.
- **Router** is code: `rw loop` dispatches ready tasks, starts reviews, merges, and halts when only the
  owner can continue. An agent acting as router follows the rw-router skill and never edits code.
- **Worker** owns one task in its own worktree and branch, follows the rw-worker skill, and ends with
  `rw report`.
- **Watchdog** is `rw watchdog`: a read-only audit that prints only deviations.

Hard rules:

1. One writer per path. A task may change only its `scope`; rw rejects a report or a merge with files
   outside it.
2. A dispatched task file is immutable. Different or wider work is a new task.
3. Workers propose (`rw propose --rule …`); only the owner authorizes. rw refuses `rw add`/`rw approve`
   from inside a lane.
4. Report honestly: partial work is `blocked` (with one concrete question) or `failed`, never `ready`.
5. Prompts carry ids and paths, not paraphrase: the task file, AGENTS.md and the documents it names are
   the requirements.

Layout: `work/tasks/` contracts (committed), `work/reports/` results (merged with the work),
`.rw/config.json` settings (committed), `.rw/prompts/` team text appended to the built-in prompts,
`.rw/state/` runtime (ignored by git).
