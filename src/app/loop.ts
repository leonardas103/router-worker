/**
 * The router as code. One pass: reconcile lanes, review and merge what reported ready, dispatch what is
 * ready. No model turn decides any of it; the model works inside lanes, and the owner answers questions.
 */
import { setLane, transition } from '../core/state.ts'
import type { Packet } from '../core/plan.ts'
import { laneActive } from '../infra/proc.ts'
import { settle } from './lane.ts'
import { dispatch, launch, merge, next, startReview } from './ops.ts'
import type { Repo } from './repo.ts'

export interface PassResult {
  readonly actions: readonly string[]
  readonly packet: Packet
}

function reconcile(repo: Repo, actions: string[]): void {
  const state = repo.state()
  for (const [key, lane] of Object.entries(state.lanes)) {
    const task = state.tasks[lane.task]
    if (lane.role !== 'worker' || task?.state !== 'running' || lane.status === 'manual') continue
    const dead = !laneActive(lane) && lane.status !== 'exited'
    if (lane.status === 'exited' && lane.pending.length) {
      launch(repo, key)
      actions.push(`${lane.task}: delivered a waiting follow-up`)
    } else if (dead || (lane.status === 'exited' && lane.pending.length === 0)) {
      settle(repo, key)
      actions.push(`${lane.task}: lane ended → ${repo.state().tasks[lane.task]?.state}`)
    }
  }
}

function review(repo: Repo, id: string, actions: string[]): boolean {
  const state = repo.state()
  const key = `${id}.review`
  const reviewer = state.lanes[key]
  if (!reviewer) {
    startReview(repo, id)
    actions.push(`${id}: review started`)
    return false
  }
  if (laneActive(reviewer)) return false
  if (reviewer.attempts.length >= 1) {
    const question = `The reviewer ended twice without a verdict (log: ${reviewer.log}). Review ${id} yourself (rw verdict ${id} --approve|--changes), or retry?`
    repo.update((current) => setLane(transition(current, id, 'escalate', repo.now(), { question }, question), key, undefined))
    actions.push(`${id}: reviewer unavailable twice → needs you`)
    return false
  }
  repo.update((current) => setLane(current, key, { ...reviewer, attempts: [{ executor: reviewer.executor, outcome: 'no verdict' }] }))
  launch(repo, key)
  actions.push(`${id}: reviewer relaunched`)
  return false
}

export function pass(repo: Repo): PassResult {
  const actions: string[] = []
  reconcile(repo, actions)
  for (const id of next(repo).review) {
    const record = repo.state().tasks[id]
    const task = repo.contract(id)
    if (task.review === 'required' && record?.reviewVerdict !== 'approve') {
      review(repo, id, actions)
      continue
    }
    const result = merge(repo, id)
    actions.push(result.outcome === 'merged'
      ? `${id}: merged ${result.commit.slice(0, 12)} (gate log ${result.log})${result.left.length ? `; left behind: ${result.left.join('; ')} → rw clean` : ''}`
      : `${id}: ${result.outcome} — ${result.reason}`)
  }
  for (const id of next(repo).ready) {
    try {
      const launched = dispatch(repo, id)
      actions.push(`${id}: dispatched to ${launched.executor}${launched.manual ? ` (manual: give ${launched.manual.promptFile} to an agent in ${launched.manual.worktree})` : ''}`)
    } catch (error) {
      actions.push(`${id}: not dispatched — ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { actions, packet: next(repo) }
}

export function exitCode(packet: Packet): number {
  if (!packet.halt) return 0
  return packet.attention.length || packet.waiting.length ? 3 : 0
}
