/**
 * The watchdog: an independent, read-only audit that speaks only on deviation. The app collects facts
 * (files, processes, git); this module judges them, so every rule is testable without a repository.
 */
import { OWNS_SCOPE, type State, type TaskContract } from './model.ts'
import { mandateHash } from './task.ts'
import { scopesOverlap } from './scope.ts'

export interface Facts {
  readonly now: string
  readonly state: State
  readonly contracts: readonly TaskContract[]
  /** Task files that did not parse, with why. */
  readonly invalid: readonly { readonly task: string; readonly problem: string }[]
  /** pid → alive, for lanes that recorded one. */
  readonly alive: Readonly<Record<number, boolean>>
  /** Worktrees that exist on disk. */
  readonly worktrees: ReadonlySet<string>
  /** Branches and worktree folders rw made that no live lane uses (src/app/ops.ts leftovers). */
  readonly leftovers: readonly string[]
  readonly staleMinutes: number
  readonly manualStaleHours: number
  /** Results of the repository's own checks (config watchdog.checks). */
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[]
}

export interface Deviation {
  readonly check: string
  readonly detail: string
}

export function audit(facts: Facts): Deviation[] {
  const out: Deviation[] = []
  const add = (check: string, detail: string) => out.push({ check, detail })
  const byId = new Map(facts.contracts.map((task) => [task.id, task]))
  const now = Date.parse(facts.now)

  for (const item of facts.invalid) add('task-file', `${item.task}: ${item.problem}`)

  for (const [id, record] of Object.entries(facts.state.tasks)) {
    const contract = byId.get(id)
    if (!contract) {
      if (!facts.invalid.some((item) => item.task === id)) add('task-file', `${id} has state ${record.state} but no task file`)
      continue
    }
    if (record.mandateHash && record.mandateHash !== mandateHash(contract)) {
      add('mandate', `${id} contract changed after dispatch; widen or change work with a new task (rw add), not by editing ${id}`)
    }
    const lane = facts.state.lanes[id]
    if (record.state === 'running') {
      if (!lane) add('lane', `${id} is running but has no lane record`)
      else if (lane.status === 'manual') {
        const hours = (now - Date.parse(lane.heartbeatAt)) / 3_600_000
        if (hours > facts.manualStaleHours) add('lane', `${id} manual lane silent for ${Math.round(hours)}h (no report yet)`)
      } else if (lane.status === 'exited' && lane.pending.length === 0) {
        add('lane', `${id} executor exited (code ${lane.exitCode ?? '?'}) but the task is still running; run rw loop --once to reconcile`)
      } else if (lane.pid > 0 && facts.alive[lane.pid] === false) {
        add('lane', `${id} lane process ${lane.pid} is gone without a report`)
      } else {
        const minutes = (now - Date.parse(lane.heartbeatAt)) / 60_000
        if (minutes > facts.staleMinutes) add('lane', `${id} lane silent for ${Math.round(minutes)}m (no executor output)`)
      }
    }
    if (OWNS_SCOPE.has(record.state) && lane && lane.status !== 'manual' && !facts.worktrees.has(lane.worktree) && record.state !== 'held') {
      add('worktree', `${id} (${record.state}) lost its worktree ${lane.worktree}`)
    }
  }

  const owners = Object.values(facts.state.tasks).filter((record) => OWNS_SCOPE.has(record.state))
  for (let i = 0; i < owners.length; i++) {
    for (let j = i + 1; j < owners.length; j++) {
      const a = byId.get(owners[i]!.id), b = byId.get(owners[j]!.id)
      if (!a || !b) continue
      const overlap = scopesOverlap(a.scope, b.scope)
      if (overlap) add('scope', `${a.id} and ${b.id} both own ${overlap}`)
    }
  }

  if (facts.leftovers.length) {
    const shown = facts.leftovers.slice(0, 5).join('; ')
    add('leftover', `${facts.leftovers.length} leftover lane branch(es)/folder(s): ${shown}${facts.leftovers.length > 5 ? '; …' : ''} → rw clean`)
  }
  for (const check of facts.checks) if (!check.ok) add(check.name, check.detail)
  return out
}
