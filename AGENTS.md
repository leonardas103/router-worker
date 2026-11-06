# AGENTS.md — working on router-worker itself

This file is for agents changing router-worker. Repositories that *use* rw get their own section from
`rw init` (`templates/agents-section.md`).

Read order: `README.md` → `docs/00-principles.md` → `docs/01-model.md` → the numbered doc for the area you
touch → `docs/05-architecture.md` (code map) → the module.

## Hard rules

1. **No runtime dependencies.** Node built-ins only. `typescript` and `@types/node` are dev-only.
2. **Erasable TypeScript only**: no enums, parameter properties or namespaces; relative imports end in
   `.ts`. `node src/cli.ts` must keep working without a build.
3. **`src/core/` is pure**: no file system, clock, processes or environment. Facts come in as arguments.
4. **State has one writer**: `Repo.update`, through `core/state.ts`. A new transition goes into
   `TRANSITIONS` with a test.
5. **Commands return data; hosts print.** `src/app/ops.ts` never writes to stdout.
6. **Fail loudly with the fix.** A refused command throws `UserError` naming what to change.
7. **One source of agent text.** Skills in `skills/`, prompts in `prompts/`, repository templates in
   `templates/`. Never fork their content into code or into a host-specific copy.
8. **Docs match code.** A behaviour change updates the numbered doc that describes it in the same
   change; a new design choice adds an entry to `docs/07-decisions.md`.
9. **No new concept** without trying an attribute of an existing one first (`docs/00-principles.md`).
10. The design source is [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype); read it there when a lineage question needs the original.

## Layout

| Path | What | Read when |
| --- | --- | --- |
| `src/core/` | the pure model: tasks, reports, scope, packet, gate, board, watchdog | changing a rule |
| `src/app/` | commands, loop, lane supervisor, config, init | changing behaviour |
| `src/infra/` | fs, lock, git, processes | changing how rw touches the machine |
| `src/exec/` | executor adapters | adding or changing an executor |
| `plugin/dsh/` | the DSH plugin and its bundle patch | DSH work |
| `prompts/` | worker, reviewer, follow-up prompt templates | changing what lanes are told |
| `skills/` | rw-router, rw-intake, rw-worker, rw-watchdog | changing what host agents are told |
| `templates/` | what `rw init` writes into a repository | changing the repository kit |
| `tests/` | unit, end-to-end, plugin | every change |
| `docs/` | the numbered documentation | every behaviour change |

## Commands

    npm run check          # typecheck + all tests
    npm test               # node --test "tests/**/*.test.ts"
    node src/cli.ts help   # the CLI from source
    npm run build          # lib/ for the DSH plugin and node_modules installs
    RW_KEEP=1 npm test     # keep the end-to-end repository in the temp directory
    npm run smoke:claude   # one live task through Claude Code in a throwaway repository
