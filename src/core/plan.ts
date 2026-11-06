/**
 * The dispatch packet: the router's whole decision, computed, not reasoned. A dispatch turn reads the
 * packet; it never re-derives dependencies or scope conflicts from prose.
 */
import { OWNS_SCOPE, type State, type TaskContract, type TaskState } from './model.ts'
import { scopesOverlap } from './scope.ts'

export interface Attention {
  readonly task: string
  readonly state: TaskState
  readonly ask: string
}

export interface Packet {
  readonly ready: readonly string[]
  readonly waiting: readonly { readonly task: string; readonly reason: string }[]
  readonly attention: readonly Attention[]
  readonly review: readonly string[]
  readonly running: readonly string[]
  readonly done: number
  readonly dropped: number
  readonly halt: boolean
  readonly haltReason: string
}

export function stateOf(state: State, id: string): TaskState {
  return state.tasks[id]?.state ?? 'proposed'
}

function ask(id: string, state: State, contract: TaskContract | undefined): string {
  const record = state.tasks[id]
  const status = record?.state ?? 'proposed'
  if (status === 'proposed') {
    return contract && contract.basis !== 'explicit'
      ? `approve or reject the proposal under ${contract.basis}: rw approve ${id} | rw reject ${id}`
      : `approve the task file: rw approve ${id}`
  }
  if (status === 'blocked') {
    return record?.question
      ? `${record.question} → rw answer ${id} "…"`
      : `unblock: ${record?.note ?? 'see the report'} → rw answer ${id} "…" | rw retry ${id}`
  }
  if (status === 'failed') return `retry or stop: ${record?.note ?? 'the lane ended without a report'} (rw retry ${id} | rw stop ${id})`
  return `held by the owner: rw release ${id} when ready`
}

export function packet(contracts: readonly TaskContract[], state: State, maxLanes: number): Packet {
  const byId = new Map(contracts.map((task) => [task.id, task]))
  const ids = [...new Set([...byId.keys(), ...Object.keys(state.tasks)])].sort()
  const running: string[] = []
  const review: string[] = []
  const attention: Attention[] = []
  const waiting: { task: string; reason: string }[] = []
  const ready: string[] = []
  let done = 0, dropped = 0
  const owned: { id: string; scope: readonly string[] }[] = []

  for (const id of ids) {
    const status = stateOf(state, id)
    if (status === 'done') done++
    else if (status === 'dropped') dropped++
    else if (status === 'running') running.push(id)
    else if (status === 'review') review.push(id)
    if (status === 'proposed' || status === 'blocked' || status === 'failed' || status === 'held') {
      attention.push({ task: id, state: status, ask: ask(id, state, byId.get(id)) })
    }
    const contract = byId.get(id)
    if (OWNS_SCOPE.has(status) && contract) owned.push({ id, scope: contract.scope })
  }

  let free = Math.max(0, maxLanes - running.length)
  for (const id of ids) {
    if (stateOf(state, id) !== 'queued') continue
    const contract = byId.get(id)
    if (!contract) {
      waiting.push({ task: id, reason: 'task file is missing' })
      continue
    }
    const unmet = contract.depends.filter((dep) => stateOf(state, dep) !== 'done')
    if (unmet.length) {
      const dead = unmet.filter((dep) => stateOf(state, dep) === 'dropped')
      waiting.push({
        task: id,
        reason: dead.length ? `depends on dropped ${dead.join(', ')}: the owner rewrites or stops it` : `waits for ${unmet.join(', ')}`,
      })
      continue
    }
    const clash = owned.map((other) => ({ other, overlap: scopesOverlap(contract.scope, other.scope) })).find((item) => item.overlap)
    if (clash) {
      waiting.push({ task: id, reason: `scope overlaps ${clash.other.id} (${clash.overlap})` })
      continue
    }
    if (free === 0) {
      waiting.push({ task: id, reason: `all ${maxLanes} lane(s) busy` })
      continue
    }
    ready.push(id)
    owned.push({ id, scope: contract.scope })
    free--
  }

  const halt = running.length === 0 && ready.length === 0 && review.length === 0
  let haltReason = ''
  if (halt) {
    if (attention.length) haltReason = `waiting on the owner (${attention.length})`
    else if (waiting.length) haltReason = `queued work cannot start: ${waiting.map((item) => `${item.task} ${item.reason}`).join('; ')}`
    else haltReason = 'queue empty'
  }
  return { ready, waiting, attention, review, running, done, dropped, halt, haltReason }
}
