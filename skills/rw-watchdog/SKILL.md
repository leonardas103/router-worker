---
name: rw-watchdog
description: Independent read-only audit of a router-worker repository that speaks only on deviation. Use for a scheduled check, or when the owner asks whether the work loop is healthy.
---

# rw-watchdog

You audit; you never fix. Run it from a session that is not the router, so the audit does not share the
router's context.

1. Run `rw watchdog`.
2. `WATCHDOG OK`: say nothing, or one line if the owner asked.
3. Deviations: list each `DEVIATION` line once, with the one command that would resolve it if rw
   names one. Do not repeat deviations you already reported in this session unless they changed.

Do not edit files, change task state, restart lanes, or run `rw loop`. If a lane looks stuck, say so;
the owner or the router decides to `rw retry`, `rw hold` or `rw stop` it.
