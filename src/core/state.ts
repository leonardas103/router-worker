/** Pure state updates. rw writes `state.json` only through these, under the lock (src/app/repo.ts). */
import { TRANSITIONS, UserError, type LaneRecord, type State, type TaskRecord, type TaskState } from './model.ts'

export type Patch = Partial<Omit<TaskRecord, 'id' | 'state' | 'since' | 'history'>>

const HISTORY = 50

export function transition(state: State, id: string, action: keyof typeof TRANSITIONS | string, now: string, patch: Patch = {}, note?: string): State {
  const rule = TRANSITIONS[action]
  if (!rule) throw new Error(`unknown transition ${action}`)
  const current = state.tasks[id]
  const from: TaskState = current?.state ?? 'proposed'
  if (!rule.from.includes(from)) {
    throw new UserError(`${id} is ${from}; ${action} needs ${rule.from.join(' or ')}`)
  }
  const base: TaskRecord = current ?? { id, state: 'proposed', since: now, remediation: 0, reviewRounds: 0, history: [] }
  const entry = { at: now, action, from, to: rule.to, ...(note ? { note } : {}) }
  const next: TaskRecord = {
    ...base,
    ...patch,
    id,
    state: rule.to,
    since: rule.to === from ? base.since : now,
    history: [...base.history, entry].slice(-HISTORY),
  }
  return { ...state, tasks: { ...state.tasks, [id]: next } }
}

/** Record a task the gate created (proposed, or queued when the owner or an auto rule accepted it). */
export function register(state: State, id: string, to: 'proposed' | 'queued', now: string, note: string): State {
  if (state.tasks[id]) throw new UserError(`${id} is already registered (${state.tasks[id]?.state})`)
  const record: TaskRecord = {
    id, state: to, since: now, remediation: 0, reviewRounds: 0,
    history: [{ at: now, action: to === 'queued' ? 'add' : 'propose', from: 'proposed', to, note }],
  }
  return { ...state, tasks: { ...state.tasks, [id]: record } }
}

export function patchTask(state: State, id: string, patch: Patch): State {
  const current = state.tasks[id]
  if (!current) throw new UserError(`${id} is not registered`)
  return { ...state, tasks: { ...state.tasks, [id]: { ...current, ...patch } } }
}

export function setLane(state: State, key: string, lane: LaneRecord | undefined): State {
  const lanes = { ...state.lanes }
  if (lane) lanes[key] = lane
  else delete lanes[key]
  return { ...state, lanes }
}

export function patchLane(state: State, key: string, patch: Partial<LaneRecord>): State {
  const current = state.lanes[key]
  if (!current) return state
  return setLane(state, key, { ...current, ...patch })
}
