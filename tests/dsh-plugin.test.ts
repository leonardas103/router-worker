/** The DSH plugin against a fake DSH context: tools, lane Sessions, follow-ups and turn ends. */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { init } from '../src/app/init.ts'
import * as ops from '../src/app/ops.ts'
import { Repo } from '../src/app/repo.ts'
import { apply, laneSessionId } from '../plugin/dsh/index.ts'
import { rwTools } from '../plugin/dsh/tools.ts'

let dir = ''
let root = ''

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}

type Handler = (payload: never) => unknown

function fakeDsh() {
  const handlers = new Map<string, Handler[]>()
  const sessions = new Map<string, { messages: string[]; preset: string; cwd: string }>()
  const tools: string[] = []
  const skills: string[] = []
  const disposers: (() => void | Promise<void>)[] = []
  const agentOf = (id: string) => ({
    id, session: { id },
    ctx: {
      tools: { register: (tool: { name: string }) => { tools.push(tool.name); return () => {} } },
      inject: (_names: string[], fn: (scope: { skills: { register: (skill: { name: string }) => () => void } }) => void) =>
        fn({ skills: { register: (skill) => { skills.push(skill.name); return () => {} } } }),
    },
    followup: (message: { content: { text: string }[] }) => sessions.get(id)?.messages.push(message.content[0]!.text),
  })
  const workspaces = new Map<string, string>()
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    sessionController: {
      resolveAgent: async (id: string) => (sessions.has(id) ? { agent: agentOf(id) } : { error: { code: 'session/not-found' } }),
      create: async ({ sessionId, workspaceId, agentPreset }: { sessionId: string; workspaceId: string; agentPreset: string }) => {
        sessions.set(sessionId, { messages: [], preset: agentPreset, cwd: workspaces.get(workspaceId) ?? '' })
      },
      rename: async () => {},
    },
    workspaceRegistry: { create: async (cwd: string) => { const id = `ws${workspaces.size}`; workspaces.set(id, cwd); return { id } } },
    permissionPresets: { set: () => {} },
    on: (event: string, fn: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return () => {}
    },
    effect: (fn: () => () => void | Promise<void>) => { disposers.push(fn()) },
  }
  const emit = (event: string, payload: unknown) => (handlers.get(event) ?? []).forEach((fn) => fn(payload as never))
  return { ctx, sessions, tools, skills, emit, agentOf, dispose: () => disposers.forEach((fn) => fn()) }
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'rw-dsh-'))
  root = join(dir, 'repo')
  git(dir, 'init', '-q', '-b', 'main', root)
  git(root, 'config', 'user.email', 'rw@test')
  git(root, 'config', 'user.name', 'rw test')
  writeFileSync(join(root, 'README.md'), '# r\n')
  init(root, { hosts: [] })
  writeFileSync(join(root, '.rw', 'config.json'), JSON.stringify({
    worktreeRoot: join(dir, 'wt'),
    tiers: { build: ['dsh'] },
    executors: { dsh: { kind: 'dsh' } },
  }))
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
})

after(() => rmSync(dir, { recursive: true, force: true }))

describe('DSH plugin', () => {
  test('tools wrap the owner commands and refuse unknown repositories', () => {
    const tools = Object.fromEntries(rwTools([root]).map((tool) => [tool.name, tool]))
    assert.deepEqual(Object.keys(tools).sort(), ['rw_add', 'rw_answer', 'rw_decide', 'rw_followup', 'rw_loop_once', 'rw_status'])
    const added = tools.rw_add!.execute({ title: 'hello', goal: 'say hello', scope: ['src/hello.txt'], accept: ['node -e 0'], authority: 'owner test' }) as { task: string }
    assert.equal(added.task, 'TASK-001')
    assert.match((tools.rw_status!.execute({}) as { board: string }).board, /TASK-001 hello \| ready/)
    assert.match(String((tools.rw_status!.execute({ repo: '/elsewhere' }) as { error: string }).error), /not one of the configured/)
  })

  test('a dsh lane is a Session in the worktree; an idle turn without a report fails the task; a follow-up reaches the same Session', async () => {
    const dsh = fakeDsh()
    await apply(dsh.ctx as never, { repos: [root], intervalSeconds: 0 })
    dsh.emit('agent/created', { agent: dsh.agentOf('someone') })
    assert.ok(dsh.tools.includes('rw_status'))
    assert.ok(dsh.skills.includes('rw-worker'))

    const repo = Repo.open(root)
    ops.dispatch(repo, 'TASK-001')
    const lane = repo.state().lanes['TASK-001']!
    assert.equal(lane.session, laneSessionId(repo, 'TASK-001'))
    await new Promise((r) => setTimeout(r, 50))
    const session = dsh.sessions.get(lane.session)!
    assert.equal(session.preset, 'rw-worker')
    assert.equal(session.cwd, lane.worktree)
    assert.match(session.messages[0]!, /You are the worker for TASK-001/)

    dsh.emit('agent/status', { agent: dsh.agentOf(lane.session), status: 'idle' })
    assert.equal(repo.state().tasks['TASK-001']?.state, 'failed')

    ops.followup(repo, 'TASK-001', 'try again with the README in mind')
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(repo.state().tasks['TASK-001']?.state, 'running')
    assert.equal(session.messages.length, 2)
    assert.match(session.messages[1]!, /Follow-up for TASK-001 \(owner\)/)
    dsh.dispose()
  })
})
