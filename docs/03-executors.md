# 03 Executors

What runs a lane, how a tier picks one, and how to plug in Antigravity. Builds on
[02 Protocol](02-protocol.md).

## How a lane runs

From the CLI, `rw dispatch` (or the loop) starts a detached supervisor, `rw _lane TASK-###`, which:

1. prepares a new worktree once: copies `worktree.copy` from the main worktree and runs
   `worktree.prepare` ([02](02-protocol.md#settings)); a failure fails the task with the output;
2. writes the prompt to `.rw/state/lanes/` and starts the executor in the lane worktree, with `rw` on
   its `PATH` and `RW_TASK`, `RW_ROLE`, `RW_REPO` in its environment;
3. appends the executor's output to `.rw/state/lanes/TASK-###.log`, and refreshes the lane heartbeat
   whenever the output grows;
4. when the executor exits, reads the session id and cost from the log, delivers follow-ups that arrived
   meanwhile to the **same session** (resume), and falls back to the next executor of the tier if the
   run died of capacity;
5. settles the task if the worker did not report: rw tries the report from the report file, otherwise
   the task fails with the log tail.

There is no daemon. Each lane supervises itself; the loop only reconciles lanes whose supervisor died.

When a prepare failure shows depends on who runs the lane: a `manual` or `dsh` lane prepares inside
`rw dispatch`, which then fails at once (exit 2) with nothing started; a process lane prepares in its
supervisor, so `rw dispatch` returns 0 and the task turns `failed` a moment later. Either way the task's
note holds the command's output and the way out (fix it on the base, then `rw retry`).

## Tiers

A tier is an ordered list of `executor` or `executor:model-alias` entries:

```json
"tiers": {
  "light":  ["antigravity:flash", "claude:light", "manual"],
  "build":  ["antigravity", "claude", "manual"],
  "review": ["claude:strong", "manual"]
}
```

The task's `tier` picks the list; the first enabled executor runs it. `rw dispatch --executor <name>`
picks another executor, with the model it has in that tier (else its `models.default`), never the
tool's own default model; `--model` names one explicitly. On a capacity failure (the
executor's output tail matches its `capacityPattern`, such as `usage limit`, `quota`, `429`) the lane moves
to the next non-manual entry with a fresh session, and the event log records `fallback`. A model alias
resolves through the executor's `models` map; an unknown alias is passed through as the model name.

## Kinds

### `claude` — Claude Code, headless

```json
"claude": {
  "kind": "claude",
  "command": "claude",
  "models": { "default": "sonnet", "light": "haiku", "strong": "opus" },
  "permissionMode": "acceptEdits",
  "allowedTools": ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "TodoWrite"],
  "extraArgs": []
}
```

A worker runs `claude -p --output-format stream-json --verbose --session-id <uuid> --permission-mode
acceptEdits --allowedTools … --model …` with the prompt on stdin; a follow-up runs the same with
`--resume <uuid>`. A reviewer gets `reviewerTools` (read, search, `git diff/log/show`, `rw verdict`, and
Write for its review file through `--add-dir`) and `Edit` disallowed. The total cost from the stream's
result event is kept on the lane.

`acceptEdits` plus an allowlist that includes `Bash` lets a lane run any shell command without a prompt,
like dsh-superagent's workers ran as the operator's user. Narrow `allowedTools` (for example
`Bash(npm test:*)`) if that is too much for a repository.

### `command` — anything with a CLI, such as an Antigravity bridge

```json
"antigravity": {
  "kind": "command",
  "start":  ["node", "<path-to>/antigravity-bridge.mjs", "--prompt-file", "{promptFile}", "--cwd", "{cwd}", "--model", "{model}"],
  "resume": ["node", "<path-to>/antigravity-bridge.mjs", "--resume", "{session}", "--prompt-file", "{promptFile}"],
  "stdin": false,
  "models": { "default": "<model id>", "flash": "<a cheaper model id>" },
  "sessionPattern": "\"conversationId\"\\s*:\\s*\"([0-9a-f-]{36})\"",
  "capacityPattern": "quota|exhausted|RESOURCE_EXHAUSTED|429"
}
```

Placeholders: `{promptFile}` `{cwd}` `{model}` `{session}` `{task}` `{role}`. With `stdin: true` the
prompt is also written to stdin. `sessionPattern`'s first group, matched against the output, is the
session id `resume` receives. Without `resume`, a follow-up starts a new session with the full prompt
plus the follow-up.

rw has no built-in Antigravity executor. A `command` executor points at whatever runs one Antigravity
agent headless on your machine (its own command line if your version has one, or a bridge script): it
takes a prompt file, a working directory and a model, runs one agent conversation, and prints a
conversation id that `sessionPattern` can read. The template in `rw init`'s config is disabled until you
point `start` at it; rw does not guess Antigravity's flags. A bridge path is machine-specific: put the
executor (or just `enabled`, `start` and `resume`) in the gitignored `.rw/config.local.json`, which is merged
over the committed config ([02](02-protocol.md#settings)).

### `manual` — a person or an IDE agent

rw writes the full prompt to `.rw/state/lanes/TASK-###.prompt.md` and prints where to run it. Open an
agent in the worktree (Antigravity's Agent Manager, a Claude Code window, DSH), give it the prompt (or
`/rw-worker TASK-###`), and the agent ends with `rw report` like any other lane. Follow-ups append to the
prompt file. This is also the last entry of every default tier, so work never stops because an
executor is missing.

### `dsh` — a DSH Session (plugin only)

Inside the DSH plugin, a lane is a DSH Session named `rw-<repo>-task-###` in the lane worktree, under the
bundle's `rw-worker` preset. Follow-ups are messages to the same Session; a turn that ends without a report
settles the task. From the CLI this kind is refused. See [04 Hosts](04-hosts.md).

## Choosing

| Work | Tier | Typical executor |
| --- | --- | --- |
| mechanical, doc-only, rename | `light` | the cheapest model that follows instructions |
| one bounded change | `build` | the quota you have most of (Antigravity first, Claude second) |
| review of a decision, an architecture change | `review` | the strongest model, read-only |

Escalate a tier only after a real failure, not in advance.
