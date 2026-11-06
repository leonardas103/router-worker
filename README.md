# router-worker

A local, miniature super-agent for one repository. **The router is code, the workers are agents, the
watchdog is read-only, and the owner sees only what needs them.**

It distils [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype) (DeepSeek Harness's research prototype)
and the record of coding agents building a real project end to end into one zero-dependency CLI, `rw`,
that runs work through Claude Code, Antigravity, DSH or a person in the IDE.

```text
owner ──rw add──▶ work/tasks/TASK-007.md ──rw loop──▶ lane: worktree + branch + session
                                                      │ worker edits inside its scope
  needs you ◀── question ◀── rw report blocked ◀──────┤
  rw answer ───────────────── same session ──────────▶│
                                                      ▼ rw report ready
                     scope diff ✓ · accept re-run ✓ · review ✓ · gates ✓ ──▶ fast-forward main
```

## Quick start

```sh
# once per machine (Node 22.18+ or Bun; nothing to install)
cd router-worker && npm link

# once per repository
cd ../my-repo
rw init --host claude,antigravity      # kit + skills for each host; edit .rw/config.json, commit

# work
rw add "Show the queue length in the status bar" \
  --scope "src/ui/status-bar/**" --accept "npm test" \
  --goal "The status bar shows how many items are queued." --authority "Ada 2026-11-06"
rw loop          # dispatch, review, merge; halts when only you can continue
rw status        # what needs you, what is moving, what is next
rw answer TASK-001 "use the existing pill style"
```

Or open Claude Code / Antigravity in the repository and say "status": the rw-router skill does the
talking, and rw does the routing.

## What it guarantees

- **One writer per path.** A report or merge that changes a file outside the task's scope is refused.
- **The base never goes red.** rw re-runs the acceptance commands and merge gates on the branch merged
  with the base, then fast-forwards.
- **Follow-ups go to the same session.** Answers, review findings and red gates resume the worker that
  has the context, instead of starting over.
- **Quota runs out, work continues.** A capacity failure moves the lane to the next executor of its tier.
- **Agents propose, the owner authorizes.** Agent ideas are recorded in `observe` until a rule you wrote
  allows them.
- **It halts honestly**: empty queue, a question, a red gate after two rounds, a failed review twice.

## Documentation

Read in order; each builds on the ones before.

- [00 Principles](docs/00-principles.md): the attention principle and what the agents' record taught
- [01 Model](docs/01-model.md): tasks, lanes, reports, questions, follow-ups, states
- [02 Protocol](docs/02-protocol.md): files, gates, review, the loop, halts, settings
- [03 Executors](docs/03-executors.md): Claude Code, Antigravity bridge, manual, DSH; tiers and fallback
- [04 Hosts](docs/04-hosts.md): installing for Claude Code, Antigravity and the DSH plugin
- [05 Architecture](docs/05-architecture.md): code map and tests
- [06 Lineage](docs/06-lineage.md): what came from dsh-superagent and from the field record, and what did not
- [07 Decisions](docs/07-decisions.md): why it is built this way

## Credits

Based on [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype) by the DeepSeek
Harness Team (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[docs/06-lineage.md](docs/06-lineage.md).

## Development

`npm run check` (typecheck + tests; `npm install` first for TypeScript). `node src/cli.ts help` runs the
CLI from source. `npm run smoke:claude` runs one small live task through Claude Code in a throwaway
repository (ask → answer → resume → merge; a few cents on haiku). See [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE).
