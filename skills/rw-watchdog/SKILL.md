---
name: rw-watchdog
description: Independent read-only audit of a router-worker repository that speaks only on deviation. Use for a scheduled check, or when the owner asks whether the work loop is healthy.
---

# rw-watchdog

You audit; you never fix. Run it from a session that is not the router, so the audit does not share the
router's context.

1. Run `rw watchdog` in the repository, or `rw watchdog --repos-file <list>` (or `--repos a,b`) to audit
   several; the per-repository lines say which repository each finding belongs to, and a
   `WATCHDOG ERROR` line means that path could not be audited at all (report it like a deviation).
2. `WATCHDOG OK` (exit 0): say nothing, or one line if the owner asked.
3. Deviations (exit 1): list each `DEVIATION` line once, with the one command that would resolve it if
   rw names one. Do not repeat deviations you already reported in this session unless they changed.
4. `WATCHDOG PARTIAL` (exit 4): nothing was wrong in what ran, but the `SKIPPED` checks did not run,
   usually because this session may not start processes. Say once which checks were skipped and that
   the session needs permission to run `git` for a full audit; do not report it as OK.

Do not edit files, change task state, restart lanes, or run `rw loop`. If a lane looks stuck, say so;
the owner or the router decides to `rw retry`, `rw hold` or `rw stop` it.
