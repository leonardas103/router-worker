# Tasks

One file per task: `TASK-###.md`. A task file is a contract: who authorized the work (`basis`,
`authority`), how far it may go (`scope`), and how it is proven (`accept`). rw records the file's
fingerprint when it dispatches the task; editing a dispatched contract is a watchdog deviation. To
change or widen work, add a new task.

State is not in these files. rw keeps it in `.rw/state/` and shows it with `rw status`.

```markdown
---
id: TASK-007
title: Show the queue length in the status bar
parent: STORY S12
depends: [TASK-006]
tier: build
review: none
basis: explicit
authority: Ada 2026-11-06
scope: [src/ui/status-bar/**, test/ui/status-bar/**]
accept: [npm test]
---
## Goal

The owner's words: what should be true when this is done.

## Read first

- decisions/D-004.md (UI dependency policy)

## Out of scope

- The sidebar; it has its own story.
```

Create tasks with `rw add` (the owner's request) or `rw propose` (an agent's suggestion under a rule).
A file written by hand waits for `rw approve TASK-###`.
