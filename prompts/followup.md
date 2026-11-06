Follow-up for {task} ({kind}). It belongs to your task and your worktree `{worktree}`; your contract `{taskFile}` is unchanged.

{text}

Handle it within the task's scope, update `{reportFile}` (keep its earlier sections; add what changed), commit, and run `rw report {task} --state <ready|blocked|dropped|failed>` again. If it asks for work beyond the scope, do not do it: report blocked with one question, or name it under Gaps.
