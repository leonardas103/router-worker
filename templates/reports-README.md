# Reports

One file per task, `TASK-###.md`, written by the worker on its lane branch and merged with the work.
Records are never edited after the merge: a later change gets its own task and its own report.

rw refuses a ready report unless every acceptance command is in its Commands table with PASS, the
branch is committed and clean, and every changed file is inside the task's scope. It re-runs the
acceptance commands and merge gates itself before it merges.
