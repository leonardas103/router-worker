/**
 * router-worker as a DSH (DeepSeek Harness) plugin.
 *
 * - runs the router pass on a timer for each configured repository (the same `pass` as `rw loop`);
 * - gives every Session the rw tools (plugin/dsh/tools.ts) and the rw skills;
 * - runs lanes of executor kind `dsh` as DSH Sessions in the lane worktree, under the bundle's
 *   `rw-worker` preset, delivering follow-ups to the same Session and settling the task when a turn
 *   ends without a report.
 *
 * The DSH surface used here mirrors dsh-superagent at DSH 0.2.1-alpha.2 (Context events, sessionController,
 * workspaceRegistry, permissionPresets, agent.ctx.tools / skills). It is declared structurally below so
 * this package builds without DSH installed; docs/04-hosts.md says how to verify it against your DSH.
 */
import { patchLane } from '../../src/core/state.ts'
import { skills } from '../../src/app/init.ts'
import { settle } from '../../src/app/lane.ts'
import { pass } from '../../src/app/loop.ts'
import { registerLauncher } from '../../src/app/ops.ts'
import { Repo } from '../../src/app/repo.ts'
import { parse } from '../../src/core/frontmatter.ts'
import { rwTools } from './tools.ts'

// ── the DSH surface, structurally ─────────────────────────────────────────────────────────────────

interface Disposable {
  (): void
}
interface ToolRegistry {
  register(tool: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => { type: 'text'; text: string }[] }
    execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown>
  }): Disposable
}
interface SkillRegistry {
  register(skill: { name: string; description: string; content: string; source: 'runtime' }): Disposable
}
interface Agent {
  readonly id: string
  readonly status?: string
  readonly session: unknown
  readonly ctx: {
    readonly tools: ToolRegistry
    inject(names: string[], fn: (scope: { skills: SkillRegistry }) => void): unknown
  }
  followup(message: unknown): void
}
interface Context {
  readonly logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
  readonly sessionController: {
    resolveAgent(id: string): Promise<{ agent: Agent } | { error: { code: string } }>
    create(options: { sessionId: string; workspaceId: string; agentPreset: string }): Promise<unknown>
    rename(options: { sessionId: string; title: string }): Promise<unknown>
  }
  readonly workspaceRegistry: { create(cwd: string): Promise<{ id: string }> }
  readonly permissionPresets: { set(session: unknown, preset: string): void }
  on(event: 'agent/created', fn: (payload: { agent: Agent }) => unknown): Disposable
  on(event: 'agent/status', fn: (payload: { agent: Agent; status: string }) => unknown): Disposable
  on(event: string, fn: (...args: never[]) => unknown): Disposable
  effect(fn: () => () => void | Promise<void>): void
}

export interface PluginConfig {
  /** Absolute paths of the repositories this profile routes. */
  readonly repos: readonly string[]
  /** Seconds between router passes; 0 turns the timer off (use the rw_loop_once tool or the CLI). */
  readonly intervalSeconds?: number
  /** The agent preset lane Sessions are created with (cordis.patch.yml). */
  readonly workerPreset?: string
}

export const name = 'router-worker'
export const inject = ['agents', 'sessionController', 'workspaceRegistry', 'permissionPresets', 'tools', 'skills']
export const WORKER_PRESET = 'rw-worker'

/** A lane Session's id: stable across restarts, so a follow-up finds the same Session. */
export function laneSessionId(repo: Repo, key: string): string {
  return `rw-${repo.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${key.toLowerCase().replace('.', '-')}`
}

export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const repos = [...(config.repos ?? [])]
  const preset = config.workerPreset ?? WORKER_PRESET
  /** lane Session id → (repository, lane key) */
  const lanes = new Map<string, { root: string; key: string }>()

  const open = (root: string): Repo => Repo.open(root)

  // Rebuild the Session map from state after a restart, so turn ends still settle their tasks.
  for (const root of repos) {
    try {
      const repo = open(root)
      for (const [key, lane] of Object.entries(repo.state().lanes)) if (lane.session.startsWith('rw-')) lanes.set(lane.session, { root, key })
    } catch (error) {
      ctx.logger.warn('router-worker: %s is not ready: %s', root, String(error))
    }
  }

  const deliver = async (sessionId: string, cwd: string, title: string, text: string): Promise<void> => {
    let result = await ctx.sessionController.resolveAgent(sessionId)
    if ('error' in result && result.error.code === 'session/not-found') {
      const workspace = await ctx.workspaceRegistry.create(cwd)
      await ctx.sessionController.create({ sessionId, workspaceId: workspace.id, agentPreset: preset })
      result = await ctx.sessionController.resolveAgent(sessionId)
      if (!('error' in result)) {
        // Lanes run unattended in their own worktree, as the operator's user, like dsh-superagent's workers.
        ctx.permissionPresets.set(result.agent.session, 'danger-full-access')
        await ctx.sessionController.rename({ sessionId, title })
      }
    }
    if ('error' in result) throw new Error(`router-worker could not open Session ${sessionId}: ${result.error.code}`)
    let message: unknown = { role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'router-worker' } }
    try {
      const llm = (await import('@deepseek-ai/dsh-llm' as string)) as { freezeMessage?: (m: unknown) => unknown; MessageId?: (id: string) => string }
      if (llm.freezeMessage) message = llm.freezeMessage({ ...(message as object), id: llm.MessageId?.(`router-worker:${sessionId}:${Date.now()}`) })
    } catch {
      // older or newer DSH: the plain message shape above
    }
    result.agent.followup(message)
  }

  const unregister = registerLauncher('dsh', (repo, key, lane, text) => {
    const sessionId = lane.session || laneSessionId(repo, key)
    lanes.set(sessionId, { root: repo.root, key })
    deliver(sessionId, lane.worktree, `${lane.task} ${lane.role}`, text).catch((error: unknown) => {
      ctx.logger.error('router-worker: lane %s could not start: %s', key, String(error))
      repo.update((state) => patchLane(state, key, { status: 'exited', exitCode: 1 }))
      settle(repo, key)
    })
    return sessionId
  })

  // A lane's turn ended: if the worker did not report, settle the task (auto-report from its file, or fail).
  const offStatus = ctx.on('agent/status', ({ agent, status }) => {
    const lane = lanes.get(agent.id)
    if (!lane) return
    try {
      const repo = open(lane.root)
      if (status === 'running') {
        repo.update((state) => patchLane(state, lane.key, { status: 'running', heartbeatAt: repo.now() }))
        return
      }
      if (status !== 'idle') return
      const record = repo.state().lanes[lane.key]
      if (!record) return
      repo.update((state) => patchLane(state, lane.key, { status: 'exited', heartbeatAt: repo.now() }))
      // A reviewer that ended without a verdict is relaunched once by the loop, then escalated.
      if (record.role === 'worker') settle(repo, lane.key)
    } catch (error) {
      ctx.logger.warn('router-worker: settling %s failed: %s', lane.key, String(error))
    }
  })

  // Every Session gets the rw tools and skills; lane Sessions use rw through bash like any other host.
  const toolSpecs = rwTools(repos, open)
  const skillList = skills().map((skill) => ({ name: skill.name, description: skill.description, content: parse(skill.text).body }))
  const offCreated = ctx.on('agent/created', ({ agent }) => {
    for (const tool of toolSpecs) {
      agent.ctx.tools.register({
        name: tool.name, description: tool.description, parameters: tool.parameters,
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async (args) => tool.execute((args ?? {}) as Record<string, unknown>),
      })
    }
    agent.ctx.inject(['skills'], (scope) => {
      for (const skill of skillList) scope.skills.register({ ...skill, source: 'runtime' })
    })
    return undefined
  })

  const seconds = config.intervalSeconds ?? 30
  const timer = seconds > 0
    ? setInterval(() => {
        for (const root of repos) {
          try {
            for (const action of pass(open(root)).actions) ctx.logger.info('router-worker %s: %s', root, action)
          } catch (error) {
            ctx.logger.warn('router-worker pass on %s failed: %s', root, String(error))
          }
        }
      }, seconds * 1000)
    : undefined

  ctx.effect(() => () => {
    if (timer) clearInterval(timer)
    unregister()
    offStatus()
    offCreated()
  })
  ctx.logger.info('router-worker ready for %d repositories', repos.length)
}
