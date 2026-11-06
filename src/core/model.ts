/**
 * The router-worker domain. Every other module uses these words and no others (docs/01-model.md).
 *
 * Task      — a unit of authorized work; its contract (the Mandate) is a committed file, immutable once dispatched.
 * Lane      — one executor run of one task: a worktree, a branch and a resumable session.
 * Report    — the worker's structured result, written on the lane branch.
 * Attention — one concrete question that waits for the owner.
 * Follow-up — text delivered to a task's existing lane: a review finding, an answer, a red gate.
 */

export const TASK_STATES = [
  'proposed', // an agent suggested it under a rule; the gate decides (docs/02-protocol.md §Gate)
  'queued', // authorized; waits for its dependencies and a free lane
  'running', // a lane owns it
  'review', // the worker reported ready; waits for review and the merge gate
  'blocked', // waits for the owner: a question, or a limit the loop will not cross alone
  'failed', // the lane ended without a usable report; a retry starts a new lane
  'held', // the owner paused it; nothing automatic resumes it
  'done', // merged to the base branch
  'dropped', // nothing to do, or the owner stopped it
] as const
export type TaskState = (typeof TASK_STATES)[number]

/** States that still own their write scope: no other lane may write there. */
export const OWNS_SCOPE: ReadonlySet<TaskState> = new Set(['running', 'review', 'blocked', 'failed', 'held'])
/** States the loop never moves on its own. */
export const WAITS_FOR_OWNER: ReadonlySet<TaskState> = new Set(['proposed', 'blocked', 'failed', 'held'])
export const FINAL: ReadonlySet<TaskState> = new Set(['done', 'dropped'])

/** Who may move a task, and from where. Anything not listed is refused (src/core/transitions.ts). */
export const TRANSITIONS: Readonly<Record<string, { from: readonly TaskState[]; to: TaskState }>> = {
  approve: { from: ['proposed'], to: 'queued' },
  reject: { from: ['proposed'], to: 'dropped' },
  dispatch: { from: ['queued'], to: 'running' },
  reportReady: { from: ['running'], to: 'review' },
  reportBlocked: { from: ['running'], to: 'blocked' },
  reportFailed: { from: ['running'], to: 'failed' },
  reportDropped: { from: ['running'], to: 'dropped' },
  laneLost: { from: ['running'], to: 'failed' },
  followup: { from: ['running', 'review', 'blocked', 'failed'], to: 'running' },
  answer: { from: ['blocked'], to: 'running' },
  merged: { from: ['review'], to: 'done' },
  escalate: { from: ['running', 'review'], to: 'blocked' },
  retry: { from: ['failed', 'blocked'], to: 'queued' },
  // running and review only with --force, which stops the executor first (src/app/ops.ts reset)
  reset: { from: ['failed', 'blocked', 'held', 'queued', 'running', 'review'], to: 'queued' },
  hold: { from: ['queued', 'running', 'review', 'blocked', 'failed'], to: 'held' },
  release: { from: ['held'], to: 'queued' },
  stop: { from: ['proposed', 'queued', 'running', 'review', 'blocked', 'failed', 'held'], to: 'dropped' },
}

/** Why the task may be done at all. */
export type Basis = 'explicit' | `rule:${string}`

/** The immutable part of a task file: what was authorized, how far it may go, and how it is proven. */
export interface Mandate {
  readonly basis: Basis
  readonly authority: string
  readonly scope: readonly string[]
  readonly accept: readonly string[]
}

export interface TaskContract extends Mandate {
  readonly id: string
  readonly title: string
  readonly parent: string
  readonly depends: readonly string[]
  readonly tier: string
  readonly review: 'none' | 'required'
  readonly body: string
}

export const REPORT_STATES = ['ready', 'blocked', 'failed', 'dropped'] as const
export type ReportState = (typeof REPORT_STATES)[number]

export interface CommandResult {
  readonly command: string
  readonly result: string
}

export interface Report {
  readonly task: string
  readonly state: ReportState
  readonly commit: string
  readonly question: string
  readonly commands: readonly CommandResult[]
  readonly body: string
}

/** Mutable task state, kept by rw alone in `.rw/state/state.json`. */
export interface TaskRecord {
  readonly id: string
  readonly state: TaskState
  readonly since: string
  /** sha256 of the mandate at dispatch; the watchdog fails on any later edit. */
  readonly mandateHash?: string
  /** The one open question for the owner. */
  readonly question?: string
  readonly note?: string
  readonly remediation: number
  readonly reviewRounds: number
  readonly reviewVerdict?: 'approve' | 'changes'
  readonly history: readonly { readonly at: string; readonly action: string; readonly from: TaskState; readonly to: TaskState; readonly note?: string }[]
}

export interface LaneRecord {
  readonly task: string
  readonly role: 'worker' | 'reviewer'
  readonly executor: string
  readonly model: string
  readonly branch: string
  readonly worktree: string
  readonly base: string
  readonly baseCommit: string
  readonly session: string
  /** The lane supervisor's pid (0 when a host runs the lane in-process). */
  readonly pid: number
  /** The executor process the supervisor started; hold and stop end its whole process tree. */
  readonly childPid?: number
  readonly status: 'starting' | 'running' | 'exited' | 'manual'
  /** worktree.copy and worktree.prepare have run in this worktree. */
  readonly prepared?: boolean
  readonly startedAt: string
  readonly heartbeatAt: string
  readonly exitCode?: number
  readonly log: string
  readonly costUsd?: number
  /** Follow-ups that arrived while the executor process was busy; delivered when it exits. */
  readonly pending: readonly string[]
  /** Executors tried in this lane, in order, with why each one ended. */
  readonly attempts: readonly { readonly executor: string; readonly outcome: string }[]
}

export interface State {
  readonly version: 1
  readonly tasks: Readonly<Record<string, TaskRecord>>
  readonly lanes: Readonly<Record<string, LaneRecord>>
}

export const emptyState = (): State => ({ version: 1, tasks: {}, lanes: {} })

export const TASK_ID = /^TASK-\d{3,}$/

export function taskNumber(id: string): number {
  return Number(id.slice('TASK-'.length))
}

export function formatTaskId(n: number): string {
  return `TASK-${String(n).padStart(3, '0')}`
}

/** A short, path-safe slug of a title, for branch and worktree names. */
export function slug(text: string, max = 32): string {
  const value = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (value.slice(0, max).replace(/-+$/, '') || 'task')
}

export class UserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserError'
  }
}
