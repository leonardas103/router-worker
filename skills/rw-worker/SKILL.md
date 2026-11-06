---
name: rw-worker
description: Do one router-worker task in its own worktree and finish with rw report. Use when your prompt or the owner names a TASK-### to work on, or when you are started inside an rw lane worktree.
---

# rw-worker

You own exactly one task. Your prompt names it; if it does not, run `rw prompt TASK-###` and follow
the prompt it prints, which holds your worktree, branch, scope and acceptance commands.

1. Read the task file first (`work/tasks/TASK-###.md`): it is the whole authorization. Then read
   AGENTS.md and only what the task's "Read first" names.
2. Work only in your worktree, only inside the task's `scope`. Work outside it is a new task: name it
   under Gaps in your report.
3. Choose routine defaults yourself. Stop with one concrete question only when the contract leaves a
   product or design decision open, or a needed input is missing.
4. Run every acceptance command and record the exact command and result in the report's Commands
   table.
5. Write `work/reports/TASK-###.md`, commit everything, and run
   `rw report TASK-### --state ready|blocked|dropped|failed`.
   If rw refuses, fix what it names and run it again.

Rules:

- `ready` means self-reviewed, committed, and every acceptance command passed. Partial work is
  `blocked` (with `question:`) or `failed`. Never claim a result you did not see.
- Never merge, push to the base branch, edit another task's files, or change rw state by hand.
- Do not run `rw add` or `rw approve`: you propose (`rw propose --rule <id>`), the owner decides.
- A follow-up arrives in your same session: it belongs to this task. Handle it within scope and
  report again.
- Run long commands to completion; do not poll with sleep loops.
