# 00 Principles

router-worker is a way of running several coding agents on one repository so that the owner's attention
goes only where it is needed. It is a miniature of dsh-superagent, rebuilt for one person on one machine,
and shaped by a field record: coding agents building a game end to end, over about eighty dispatch
rounds and three hundred commits, with a person as the only reviewer of last resort.

## The principle

**Take as little human attention as possible, and give as much value as possible.** (Inherited unchanged
from dsh-superagent.) Every message, question, setting, board row and paragraph of documentation costs
attention, and must give more than it costs.

## What the agents' record taught

Each rule below answers something observed in that record, not a preference. The project itself does
not matter; the failure modes recur in any repository where several agents work for one person.

| Observed | Rule in router-worker |
| --- | --- |
| Lane prompts grew into multi-page work plans written by the manager; one lane read 825k input tokens and 13.8M cached tokens over 37 minutes | **Prompts carry ids and paths, not paraphrase.** rw composes every lane prompt from the task file; nobody writes a plan into it ([02](02-protocol.md)) |
| The router's decisions (what is ready, what blocks what) were re-derived from status-file prose in model turns, until a small script computed them | **The router is code.** `rw loop` dispatches, reviews, merges and halts; no model turn decides any of it |
| A single status file was hand-maintained, grew to about 19 KB, and needed a validator for malformed tables | **Contracts are files; state is rw's.** Task files are immutable contracts in git; state lives in one locked JSON file only rw writes; the board is generated |
| "One writer per file" was a rule agents had to remember | **Scope is enforced by diff.** A report or merge with a file outside the task's scope is refused |
| The lead agent re-ran the full gates independently because lane claims were not proof | **Claims are re-run.** rw runs the acceptance commands and merge gates itself on the branch before it merges |
| Review defects went into new dispatch rounds, re-deciding what was already decided | **Thread pass-through.** Review findings, red gates and answers go to the same worker session |
| One provider's quota ran out mid-phase and the work moved to another by hand | **Tiers with fallback.** A capacity failure moves the lane to the next executor of its tier, recorded |
| The halt contract (empty queue, missing decision, red gate after two rounds, reviewer unavailable twice) kept runs honest | **Halts are built in**, with the same triggers, and the board says why |
| The watchdog only helps if it is independent and speaks only on deviation | **`rw watchdog` is read-only** and prints only deviations |

## What follows for agents

- **Act only on authorized work.** The owner's request is explicit; anything an agent finds by itself is
  a proposal under a rule the owner wrote, and starts in a mode that only records it.
- **Speak only when a person must act or can use a result.** Progress is internal.
- **Ask one concrete question at a time**, through the report's `question:`, so it reaches the owner.
- **Stop by impact, not effort.** A local change goes as far as a reviewed, merged result; a change that
  needs a product or design decision stops with one question.
- **Report honestly.** Partial work is blocked or failed, never ready.

## What follows for the design

- **Few concepts**: task, lane, report, question, follow-up, gate, watchdog. A need becomes an attribute
  of one of them or a line of prompt text, never a new concept ([01](01-model.md)).
- **Few settings**: a default replaces a setting when one value suits almost every repository.
- **No runtime dependencies.** The core is plain TypeScript run by Node 22.18+ or Bun.
- **Honest capability boundaries.** Where rw cannot enforce a rule (a host gives agents a shell), the
  document says so instead of implying it.
- **Documents read in order**; each builds only on the ones before it.

## The owner's part

Start narrow: one or two lanes, proposals in `observe`. Tune for less noise by making tasks smaller and
prompts stricter, not by adding messages. Read what merges. A task that went wrong is fixed by a better
contract next time, not by a longer prompt.
