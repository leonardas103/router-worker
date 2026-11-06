/**
 * The rw tools a DSH Session gets: the owner's controls and the board, as JSON-schema tools over the same
 * ops the CLI calls. Nothing here imports DSH, so it is tested like the rest of rw.
 */
import * as ops from '../../src/app/ops.ts'
import { pass } from '../../src/app/loop.ts'
import { Repo } from '../../src/app/repo.ts'
import { UserError } from '../../src/core/model.ts'

export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly execute: (args: Record<string, unknown>) => unknown
}

const repoParam = { type: 'string', description: 'Absolute path of the repository; defaults to the first configured repository.' }
const taskParam = { type: 'string', pattern: '^TASK-\\d{3,}$', description: 'The task id, such as TASK-007.' }

function object(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties: { repo: repoParam, ...properties }, required, additionalProperties: false }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new UserError(`${name} is required`)
  return value
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function rwTools(repos: readonly string[], open: (path: string) => Repo = (path) => Repo.open(path)): ToolSpec[] {
  const repoOf = (args: Record<string, unknown>): Repo => {
    const path = typeof args.repo === 'string' && args.repo ? args.repo : repos[0]
    if (!path) throw new UserError('router-worker has no repositories configured (plugin config repos)')
    if (repos.length && !repos.some((item) => item.replaceAll('\\', '/').toLowerCase() === path.replaceAll('\\', '/').toLowerCase())) {
      throw new UserError(`${path} is not one of the configured repositories`)
    }
    return open(path)
  }
  const guarded = (fn: (args: Record<string, unknown>) => unknown) => (args: Record<string, unknown>) => {
    try {
      return fn(args)
    } catch (error) {
      if (error instanceof UserError) return { error: error.message }
      throw error
    }
  }
  const tools: ToolSpec[] = [
    {
      name: 'rw_status',
      description: 'The router-worker board: what needs the owner, what is moving, what is next. Read it before anything else.',
      parameters: object({}),
      execute: (args) => ({ board: ops.status(repoOf(args)), packet: ops.next(repoOf(args)) }),
    },
    {
      name: 'rw_add',
      description: 'Record work the owner asked for in this conversation as a queued task. Scope paths and acceptance commands must be exact; ask the owner if you cannot state them.',
      parameters: object({
        title: { type: 'string' }, goal: { type: 'string', description: "The owner's words." },
        scope: { type: 'array', items: { type: 'string' }, minItems: 1 }, accept: { type: 'array', items: { type: 'string' }, minItems: 1 },
        depends: { type: 'array', items: { type: 'string' } }, tier: { type: 'string' }, review: { type: 'boolean' },
        parent: { type: 'string' }, authority: { type: 'string', description: 'Who asked, and when.' },
      }, ['title', 'goal', 'scope', 'accept', 'authority']),
      execute: (args) => ({
        task: ops.add(repoOf(args), {
          title: text(args.title, 'title'), goal: text(args.goal, 'goal'), scope: list(args.scope), accept: list(args.accept),
          depends: list(args.depends), review: args.review === true ? 'required' : 'none', authority: text(args.authority, 'authority'),
          ...(typeof args.tier === 'string' ? { tier: args.tier } : {}), ...(typeof args.parent === 'string' ? { parent: args.parent } : {}),
        }),
      }),
    },
    {
      name: 'rw_answer',
      description: "Deliver the owner's answer to a blocked task's question, copied in their words; the task's own session continues.",
      parameters: object({ task: taskParam, text: { type: 'string' } }, ['task', 'text']),
      execute: (args) => ({ result: ops.answer(repoOf(args), text(args.task, 'task'), text(args.text, 'text')) ?? 'queued' }),
    },
    {
      name: 'rw_followup',
      description: "Send the owner's follow-up to a task it explicitly points at (its id, branch or the change just made). A similar topic is new work: use rw_add.",
      parameters: object({ task: taskParam, text: { type: 'string' } }, ['task', 'text']),
      execute: (args) => ({ result: ops.followup(repoOf(args), text(args.task, 'task'), text(args.text, 'text')) ?? 'queued' }),
    },
    {
      name: 'rw_decide',
      description: 'Apply an owner decision to tasks: approve or reject proposals, hold, release, stop, retry, or reset (discard a lane that holds no work and queue the task from the current base).',
      parameters: object({
        action: { type: 'string', enum: ['approve', 'reject', 'hold', 'release', 'stop', 'retry', 'reset'] },
        tasks: { type: 'array', items: taskParam, minItems: 1 }, reason: { type: 'string' },
      }, ['action', 'tasks']),
      execute: (args) => {
        const repo = repoOf(args)
        const ids = list(args.tasks)
        const reason = typeof args.reason === 'string' && args.reason ? args.reason : 'owner decision'
        switch (args.action) {
          case 'approve':
            return { approved: ops.approve(repo, ids) }
          case 'reject':
            ids.forEach((id) => ops.reject(repo, id, reason))
            break
          case 'hold':
            ids.forEach((id) => ops.hold(repo, id, reason))
            break
          case 'release':
            ids.forEach((id) => ops.release(repo, id))
            break
          case 'stop':
            ids.forEach((id) => ops.stop(repo, id, reason))
            break
          case 'retry':
            ids.forEach((id) => ops.retry(repo, id))
            break
          case 'reset':
            ids.forEach((id) => ops.reset(repo, id, false))
            break
          default:
            throw new UserError('unknown action')
        }
        return { done: args.action, tasks: ids }
      },
    },
    {
      name: 'rw_loop_once',
      description: 'Run one router pass now: reconcile lanes, review and merge what is ready, dispatch what can start. The plugin also runs passes on its own timer.',
      parameters: object({}),
      execute: (args) => {
        const result = pass(repoOf(args))
        return { actions: result.actions, halt: result.packet.halt, haltReason: result.packet.haltReason }
      },
    },
  ]
  return tools.map((tool) => ({ ...tool, execute: guarded(tool.execute) }))
}
