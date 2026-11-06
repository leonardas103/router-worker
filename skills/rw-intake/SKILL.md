---
name: rw-intake
description: Turn an owner request, a spec, an epic or a story into router-worker task files that a worker can execute without asking. Use when new work must be written as tasks.
---

# rw-intake

A task is one bounded change that one worker can deliver and prove alone. Write it so the worker needs
nothing from you after dispatch.

## A task is ready only when you can state

- **title**: the outcome, in a few words.
- **scope**: the exact paths or globs it may change (`src/app/**`, `test/app/**`). Two tasks that must
  touch the same files are one task, or the second depends on the first.
- **accept**: the exact commands that prove it (`npm test`, `bun run gates`). A visual or manual
  check names the procedure in the body.
- **goal**: the owner's words, not your rewrite. Quote them.
- **read first**: the decision, spec section or file the worker needs, by path and section.
- **depends**: earlier tasks this one needs merged.

If you cannot state scope and accept, the work is not ready: ask the owner one concrete question, or
propose a decision first. Never hand a worker a task whose files and proof you could not name.

## Splitting

- One writer per path: split by the files they change, not by the steps you imagine.
- A schema or data change and the code that consumes it are two tasks; the second depends on the first.
- A design fork with two defensible answers is not a task. It is a decision for the owner.
- Prefer three tasks a worker can each finish in one session over one task that needs three.

## Writing them

With the owner present and asking: show the list once (id, title, scope, accept, depends), take one
confirmation, then for each:

    rw add "<title>" --scope "<glob>" --scope "<glob>" --accept "<command>" \
      --goal "<owner's words>" [--depends TASK-###] [--tier light|build] [--review] \
      [--parent "<story id>"] --authority "<owner> <date>"

Then fill each task file's `## Read first` and `## Out of scope` sections before the first dispatch;
the file is frozen once it is dispatched.

Without the owner's request, write proposals instead: `rw propose "<title>" --rule <rule-id> …`. A
hand-written `work/tasks/TASK-###.md` also works; it waits for `rw approve TASK-###`.
