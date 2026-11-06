/**
 * The commands. Each one validates, changes state through Repo.update, records an event, and returns
 * what the caller prints. The CLI, the loop and the DSH plugin all call these and nothing below them.
 */
import { cpSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { slug, UserError, type LaneRecord, type ReportState, type TaskContract } from '../core/model.ts'
import { packet, type Packet } from '../core/plan.ts'
import { gate } from '../core/policy.ts'
import { bullets, fill, teamSection } from '../core/prompt.ts'
import { checkReport, parseReport, reportTemplate } from '../core/report.ts'
import { outside } from '../core/scope.ts'
import { patchLane, patchTask, register, setLane, transition } from '../core/state.ts'
import { bodyTemplate, mandateHash, parseTask, renderTask } from '../core/task.ts'
import { audit, type Deviation } from '../core/watchdog.ts'
import { exists, readText, withLock, writeAtomic } from '../infra/fs.ts'
import * as g from '../infra/git.ts'
import { alive, killTree, laneActive, lastLines, runShell, startDetached, waitGone } from '../infra/proc.ts'
import { chain, worktreeRoot } from './config.ts'
import { CLI_ENTRY, packageFile, type Repo } from './repo.ts'

// ── guards ────────────────────────────────────────────────────────────────────────────────────────

/** Workers propose; only the owner authorizes. A lane's environment carries RW_TASK. */
function ownerOnly(what: string): void {
  if (process.env.RW_TASK) {
    throw new UserError(`${what} is the owner's decision; from a lane use rw propose (lane ${process.env.RW_TASK})`)
  }
}

function ensureOnBase(repo: Repo, files: readonly string[], message: string): void {
  const changed = files.filter((rel) => !g.tracked(repo.root, rel) || g.changedSinceHead(repo.root, rel))
  if (changed.length === 0) return
  const branch = g.currentBranch(repo.root)
  if (!repo.config.commitTasks || branch !== repo.config.base) {
    throw new UserError(`commit ${changed.join(', ')} on ${repo.config.base} first (rw commits task files itself only when commitTasks is on and ${repo.config.base} is checked out; it is ${branch})`)
  }
  g.commitPaths(repo.root, changed, message)
}

// ── intake: add, propose, approve, reject ─────────────────────────────────────────────────────────

export interface NewTask {
  readonly title: string
  readonly goal: string
  readonly scope: readonly string[]
  readonly accept: readonly string[]
  readonly depends?: readonly string[]
  readonly tier?: string
  readonly review?: 'none' | 'required'
  readonly parent?: string
  readonly authority?: string
  readonly body?: string
}

function contractFrom(repo: Repo, id: string, input: NewTask, basis: TaskContract['basis'], authority: string): TaskContract {
  const tier = input.tier ?? 'build'
  chain(repo.config, tier) // fails on an unknown tier
  return {
    id, title: input.title.trim(), parent: input.parent ?? '', depends: input.depends ?? [], tier,
    review: input.review ?? 'none', basis, authority, scope: input.scope, accept: input.accept,
    body: input.body?.trim() || bodyTemplate(input.goal),
  }
}

/** Round-trip through the parser, so rw never writes a contract it would refuse to read. */
function writeContract(repo: Repo, task: TaskContract): void {
  const text = renderTask(task)
  const { problems } = parseTask(text, task.id)
  if (problems.length) throw new UserError(`${task.id}: ${problems.join('; ')}`)
  writeAtomic(repo.taskPath(task.id), text)
}

/** The owner's request: explicit, queued at once. */
export function add(repo: Repo, input: NewTask): string {
  ownerOnly('rw add')
  const id = repo.nextId()
  const task = contractFrom(repo, id, input, 'explicit', input.authority ?? `owner ${repo.now().slice(0, 10)}`)
  writeContract(repo, task)
  ensureOnBase(repo, [repo.taskRel(id)], `rw: add ${id} ${task.title}`)
  repo.update((state) => register(state, id, 'queued', repo.now(), task.authority))
  repo.event('add', { task: id })
  return id
}

/** Work an agent found: a proposal under a rule, which the gate records, accepts or refuses. */
export function propose(repo: Repo, input: NewTask & { readonly rule: string }): { id: string; outcome: string; reason: string } {
  const id = repo.nextId()
  const proposer = process.env.RW_TASK ? `proposed by ${process.env.RW_TASK}` : 'proposed by an agent'
  const draft = contractFrom(repo, id, input, `rule:${input.rule}`, proposer)
  const verdict = gate(draft, repo.config.policy)
  if (verdict.outcome === 'refuse') throw new UserError(`proposal refused: ${verdict.reason}`)
  const task = verdict.outcome === 'accept' ? { ...draft, authority: `${verdict.authority}; ${proposer}` } : draft
  writeContract(repo, task)
  if (verdict.outcome === 'accept') ensureOnBase(repo, [repo.taskRel(id)], `rw: accept ${id} under rule ${input.rule}`)
  repo.update((state) => register(state, id, verdict.outcome === 'accept' ? 'queued' : 'proposed', repo.now(), verdict.reason))
  repo.event('propose', { task: id, outcome: verdict.outcome, reason: verdict.reason })
  return { id, outcome: verdict.outcome === 'accept' ? 'queued' : 'proposed', reason: verdict.reason }
}

/** Approve proposals, or register task files a person or an intake agent wrote by hand. */
export function approve(repo: Repo, ids: readonly string[]): string[] {
  ownerOnly('rw approve')
  const tasks = ids.map((id) => repo.contract(id))
  ensureOnBase(repo, tasks.map((task) => repo.taskRel(task.id)), `rw: approve ${ids.join(', ')}`)
  repo.update((state) => {
    let next = state
    for (const task of tasks) {
      next = next.tasks[task.id]
        ? transition(next, task.id, 'approve', repo.now(), {}, 'approved by the owner')
        : register(next, task.id, 'queued', repo.now(), 'approved by the owner')
    }
    return next
  })
  for (const id of ids) repo.event('approve', { task: id })
  return ids.map((id) => id)
}

export function reject(repo: Repo, id: string, reason: string): void {
  ownerOnly('rw reject')
  repo.update((state) => {
    const known = state.tasks[id] ? state : register(state, id, 'proposed', repo.now(), 'hand-written task file')
    return transition(known, id, 'reject', repo.now(), { note: reason }, reason)
  })
  repo.event('reject', { task: id, reason })
}

// ── lanes ─────────────────────────────────────────────────────────────────────────────────────────

export interface LaunchResult {
  readonly key: string
  readonly executor: string
  readonly manual?: { readonly promptFile: string; readonly worktree: string }
}

function laneEnv(repo: Repo, key: string, role: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, RW_TASK: key.replace(/\.review$/, ''), RW_ROLE: role, RW_REPO: repo.root }
  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = `${repo.ensureShims()}${delimiter}${env[pathKey] ?? ''}`
  return env
}

export function lanePromptFile(repo: Repo, key: string): string {
  return join(repo.paths.lanes, `${key}.prompt.md`)
}

export function laneLog(repo: Repo, key: string): string {
  return join(repo.paths.lanes, `${key}.log`)
}

export function reviewFile(repo: Repo, id: string): string {
  return join(repo.paths.lanes, `${id}.review.md`)
}

export function workerPrompt(repo: Repo, task: TaskContract, lane: LaneRecord): string {
  const recovery = lane.attempts.length
    ? `\n> Recovery: an earlier lane on this branch ended (${lane.attempts.at(-1)?.outcome}). Check \`git log\` and the worktree before repeating any work, and continue from what is there.\n`
    : ''
  return recovery + fill(packageFile('prompts', 'worker.md'), {
    task: task.id, title: task.title, repo: repo.name, taskFile: repo.taskRel(task.id), reportFile: repo.reportRel(task.id),
    worktree: lane.worktree, branch: lane.branch, base: lane.base, baseCommit: lane.baseCommit.slice(0, 12),
    scope: bullets(task.scope), accept: bullets(task.accept), rwCommand: repo.rwCommand(),
    reportTemplate: reportTemplate(task).trim(), team: teamSection(repo.teamPrompt('worker')),
  })
}

export function reviewerPrompt(repo: Repo, task: TaskContract, lane: LaneRecord, round: number): string {
  const previous = round > 1 ? ' Earlier rounds asked for changes; check that each earlier finding is fixed before looking for new ones, and do not raise a finding the worker already answered with a reason.' : ''
  return fill(packageFile('prompts', 'reviewer.md'), {
    task: task.id, title: task.title, repo: repo.name, taskFile: repo.taskRel(task.id), reportFile: repo.reportRel(task.id),
    worktree: lane.worktree, branch: lane.branch, baseCommit: lane.baseCommit, round: String(round),
    maxRounds: String(repo.config.limits.reviewRounds), previous, maxFindings: String(repo.config.limits.maxFindings),
    reviewFile: reviewFile(repo, task.id), rwCommand: repo.rwCommand(), team: teamSection(repo.teamPrompt('reviewer')),
  })
}

export function followupPrompt(repo: Repo, task: TaskContract, lane: LaneRecord, kind: string, text: string): string {
  return fill(packageFile('prompts', 'followup.md'), {
    task: task.id, kind, worktree: lane.worktree, taskFile: repo.taskRel(task.id), reportFile: repo.reportRel(task.id), text: text.trim(),
  })
}

/**
 * A host that runs lanes in its own process (the DSH plugin) registers a launcher for its executor kind.
 * It receives the text to deliver: the full prompt for a new session, or the waiting follow-ups for an
 * existing one, and returns the session id it used.
 */
export type Launcher = (repo: Repo, key: string, lane: LaneRecord, text: string, resume: boolean) => string
const launchers = new Map<string, Launcher>()
export function registerLauncher(kind: string, launcher: Launcher): () => void {
  launchers.set(kind, launcher)
  return () => {
    if (launchers.get(kind) === launcher) launchers.delete(kind)
  }
}

/**
 * Make a new worktree usable: copy the ignored files the repository needs (worktree.copy) and run the
 * setup commands (worktree.prepare). Runs once per worktree. A copy must be of a file git ignores, and
 * setup must leave git status clean, so the worker starts with no changes it did not make.
 */
export function prepareLane(repo: Repo, key: string): { ok: true } | { ok: false; reason: string } {
  const lane = repo.state().lanes[key]
  if (!lane) return { ok: false, reason: `no lane ${key}` }
  if (lane.prepared || lane.role !== 'worker') return { ok: true }
  const { copy, prepare } = repo.config.worktree
  for (const rel of copy) {
    const from = join(repo.root, rel)
    if (!exists(from)) return { ok: false, reason: `worktree.copy: ${rel} does not exist in ${repo.root}` }
    if (!g.git(repo.root, ['check-ignore', '-q', '--', rel]).ok) {
      return { ok: false, reason: `worktree.copy: ${rel} is not ignored by git; a copy of it would be an uncommitted change in every lane (commit it instead, or add it to .gitignore)` }
    }
    cpSync(from, join(lane.worktree, rel), { recursive: true, force: true })
  }
  const env = { ...laneEnv(repo, key, 'prepare'), RW_MAIN: repo.root, RW_WORKTREE: lane.worktree }
  for (const command of prepare) {
    const run = runShell(command, lane.worktree, repo.config.limits.commandTimeoutMinutes * 60_000, env)
    if (!run.ok) return { ok: false, reason: `worktree.prepare \`${command}\` failed (exit ${run.code}): ${lastLines(run.out, 8, 800)}` }
  }
  const dirty = g.allChanges(lane.worktree)
  if (dirty.length) {
    return { ok: false, reason: `worktree.prepare left changes git sees: ${dirty.slice(0, 8).join(', ')} (make setup write only ignored files, for example bun install --frozen-lockfile)` }
  }
  repo.update((state) => patchLane(state, key, { prepared: true }))
  repo.event('prepare', { lane: key, copied: copy.length, commands: prepare.length })
  return { ok: true }
}

/** A failed prepare fails the task with the reason and the way out. */
export function prepareFailed(repo: Repo, key: string, reason: string): void {
  const lane = repo.state().lanes[key]
  if (!lane) return
  const hint = ` → fix it on ${repo.config.base}, then rw retry ${lane.task} (a lane with no work restarts from the current ${repo.config.base})`
  repo.update((state) => state.tasks[lane.task]?.state === 'running'
    ? transition(state, lane.task, 'laneLost', repo.now(), { note: reason.slice(0, 600 - hint.length) + hint }, 'prepare failed')
    : state)
  repo.event('prepare-failed', { lane: key, reason })
}

/** Start the lane's process (a detached supervisor), or, for a manual lane, write its prompt for a person. */
export function launch(repo: Repo, key: string): LaunchResult {
  const lane = repo.state().lanes[key]
  if (!lane) throw new UserError(`no lane ${key}`)
  const spec = repo.config.executors[lane.executor]
  if (!spec) throw new UserError(`lane ${key} names executor ${lane.executor}, which the config no longer has`)
  if (spec.kind === 'manual' || spec.kind === 'dsh') {
    // in-process and manual lanes have no supervisor to prepare their worktree
    const prepared = prepareLane(repo, key)
    if (!prepared.ok) {
      prepareFailed(repo, key, prepared.reason)
      throw new UserError(`${lane.task}: ${prepared.reason}`)
    }
  }
  if (spec.kind === 'manual') {
    const task = repo.contract(lane.task)
    const prompt = lane.role === 'reviewer'
      ? reviewerPrompt(repo, task, lane, (repo.state().tasks[lane.task]?.reviewRounds ?? 0) + 1)
      : [workerPrompt(repo, task, lane), ...lane.pending].join('\n\n---\n\n')
    const promptFile = lanePromptFile(repo, key)
    writeAtomic(promptFile, prompt)
    repo.update((state) => patchLane(state, key, { status: 'manual', pending: [], heartbeatAt: repo.now(), pid: 0 }))
    repo.event('launch', { lane: key, executor: lane.executor, manual: true })
    return { key, executor: lane.executor, manual: { promptFile, worktree: lane.worktree } }
  }
  if (spec.kind === 'dsh') {
    const launcher = launchers.get('dsh')
    if (!launcher) throw new UserError('the dsh executor runs inside the DSH plugin; from the CLI pick another executor (--executor)')
    const task = repo.contract(lane.task)
    const resume = lane.session !== '' && lane.role === 'worker'
    const text = lane.role === 'reviewer'
      ? readText(lanePromptFile(repo, key)) ?? reviewerPrompt(repo, task, lane, (repo.state().tasks[lane.task]?.reviewRounds ?? 0) + 1)
      : resume ? lane.pending.join('\n\n---\n\n') : [workerPrompt(repo, task, lane), ...lane.pending].join('\n\n---\n\n')
    const session = launcher(repo, key, lane, text, resume)
    repo.update((state) => patchLane(state, key, { status: 'running', pending: [], pid: 0, session, heartbeatAt: repo.now() }))
    repo.event('launch', { lane: key, executor: lane.executor, session })
    return { key, executor: lane.executor }
  }
  const pid = startDetached([process.execPath, ...process.execArgv.filter((flag) => !flag.startsWith('--inspect')), CLI_ENTRY, '_lane', key],
    repo.root, laneEnv(repo, key, lane.role))
  repo.update((state) => patchLane(state, key, { status: 'starting', pid, heartbeatAt: repo.now() }))
  repo.event('launch', { lane: key, executor: lane.executor, pid })
  return { key, executor: lane.executor }
}

export { laneEnv }

/** What a lane holds that a restart would lose: commits on its branch, and uncommitted changes in its worktree. */
export function laneWork(repo: Repo, lane: LaneRecord): { commits: number; dirty: string[] } {
  const commits = g.branchExists(repo.root, lane.branch) && g.git(repo.root, ['cat-file', '-e', lane.baseCommit]).ok
    ? g.commitsBetween(repo.root, lane.baseCommit, lane.branch)
    : 0
  let dirty: string[] = []
  if (exists(lane.worktree)) {
    // a folder that lost its .git link (an interrupted teardown) is not a checkout any more: its state is unknown
    if (!exists(join(lane.worktree, '.git'))) dirty = [`${lane.worktree} is no longer a git worktree`]
    else {
      try {
        dirty = g.allChanges(lane.worktree)
      } catch {
        dirty = [`${lane.worktree} could not be read by git`]
      }
    }
  }
  return { commits, dirty }
}

/**
 * Remove a lane's worktree and branch. Never throws: what could not be removed is returned, recorded as an
 * event, and reported by the watchdog as a leftover until `rw clean` removes it. Callers check laneWork first.
 */
export function teardown(repo: Repo, lane: Pick<LaneRecord, 'worktree' | 'branch' | 'task'>): string[] {
  const problems: string[] = []
  const folder = g.removeWorktree(repo.root, lane.worktree)
  if (folder) problems.push(folder)
  if (g.branchExists(repo.root, lane.branch) && !g.deleteBranch(repo.root, lane.branch, true)) problems.push(`could not delete branch ${lane.branch}`)
  if (problems.length) repo.event('teardown-incomplete', { task: lane.task, problems })
  return problems
}

function newLane(repo: Repo, task: TaskContract, role: 'worker' | 'reviewer', executor: string, model: string, previous?: LaneRecord): LaneRecord {
  const wtRoot = worktreeRoot(repo.config, repo.root)
  // A fresh lane never lands on a leftover a failed teardown could not remove: the next free name is used.
  let name = `${task.id}-${slug(task.title)}`
  if (!previous) {
    const base = name
    for (let n = 2; exists(join(wtRoot, name)) || g.branchExists(repo.root, `${repo.config.branchPrefix}${name}`); n++) name = `${base}-${n}`
  }
  const branch = previous?.branch ?? `${repo.config.branchPrefix}${name}`
  const worktree = previous?.worktree ?? join(wtRoot, name)
  return {
    task: task.id, role, executor, model, branch, worktree,
    base: repo.config.base,
    baseCommit: previous?.baseCommit ?? g.head(repo.root, repo.config.base),
    session: '', pid: 0, status: 'starting', startedAt: repo.now(), heartbeatAt: repo.now(),
    log: laneLog(repo, role === 'reviewer' ? `${task.id}.review` : task.id), pending: [],
    attempts: previous?.attempts ?? [],
    ...(previous?.prepared ? { prepared: true } : {}),
  }
}

/**
 * The executor and model a dispatch uses. `--executor` alone takes the model that executor has in the
 * task's tier, else its `models.default`; it never falls through to the executor's own default model,
 * which for Claude Code can be the most expensive one. `--model` is an alias from `models`, or a model name.
 */
function pickExecutor(repo: Repo, tier: string, candidates: { executor: string; model: string }[], options: { executor?: string; model?: string }): { executor: string; model: string } {
  const name = options.executor ?? candidates[0]?.executor
  if (!name) throw new UserError(`tier ${tier} has no enabled executor`)
  const spec = repo.config.executors[name]
  if (!spec) throw new UserError(`unknown executor ${name}; .rw/config.json executors has ${Object.keys(repo.config.executors).join(', ')}`)
  const models: Readonly<Record<string, string>> = 'models' in spec ? spec.models : {}
  if (options.model) return { executor: name, model: models[options.model] ?? options.model }
  const inTier = candidates.find((candidate) => candidate.executor === name)
  return { executor: name, model: inTier?.model || models.default || '' }
}

/** Give a ready task a worktree, a branch and an executor, and start it. */
export function dispatch(repo: Repo, id: string, options: { executor?: string; model?: string } = {}): LaunchResult {
  const task = repo.contract(id)
  const { contracts } = repo.readContracts()
  const state = repo.state()
  const plan = packet(contracts, state, repo.freeLanes(state))
  if (state.tasks[id]?.state !== 'queued') throw new UserError(`${id} is ${state.tasks[id]?.state ?? 'not registered'}; only a queued task is dispatched`)
  if (!plan.ready.includes(id)) {
    const why = plan.waiting.find((item) => item.task === id)?.reason ?? 'not ready'
    throw new UserError(`${id} is not ready: ${why}`)
  }
  ensureOnBase(repo, [repo.taskRel(id)], `rw: ${id} contract`)
  const onBase = g.showFile(repo.root, repo.config.base, repo.taskRel(id))
  if (onBase === undefined || onBase.replaceAll('\r\n', '\n') !== (readText(repo.taskPath(id)) ?? '').replaceAll('\r\n', '\n')) {
    throw new UserError(`${repo.taskRel(id)} on ${repo.config.base} differs from the file on disk; commit it first`)
  }
  const candidates = chain(repo.config, task.tier)
  const pick = pickExecutor(repo, task.tier, candidates, options)
  const previous = state.lanes[id]
  // A lane with no work to keep (a failed prepare, an executor that never got going) restarts from the
  // current base, so a fix committed there since is in the new worktree. A lane with work continues on it.
  const work = previous ? laneWork(repo, previous) : undefined
  const fresh = previous !== undefined && work !== undefined && work.commits === 0 && work.dirty.length === 0
  if (fresh) {
    teardown(repo, previous)
    repo.event('lane-fresh', { task: id, reason: 'no commits and no changes; restarting from the current base' })
  }
  if (!fresh && previous && exists(previous.worktree) && !exists(join(previous.worktree, '.git'))) {
    throw new UserError(`${id}'s worktree ${previous.worktree} is no longer a git worktree; rw reset ${id} --force discards it and the task starts from the current base`)
  }
  let lane = newLane(repo, task, 'worker', pick.executor, pick.model, fresh ? undefined : previous)
  if (fresh) lane = { ...lane, attempts: previous.attempts }
  if (!exists(lane.worktree)) {
    lane = { ...lane, prepared: false }
    if (g.branchExists(repo.root, lane.branch)) g.gitOk(repo.root, ['worktree', 'add', lane.worktree, lane.branch])
    else g.worktreeAdd(repo.root, lane.worktree, lane.branch, repo.config.base)
  }
  repo.update((current) => setLane(transition(current, id, 'dispatch', repo.now(), { mandateHash: mandateHash(task), question: undefined, reviewVerdict: undefined }, `${pick.executor}${pick.model ? `/${pick.model}` : ''}`), id, lane))
  repo.event('dispatch', { task: id, executor: pick.executor, model: pick.model, branch: lane.branch, worktree: lane.worktree })
  return launch(repo, id)
}

// ── reports ───────────────────────────────────────────────────────────────────────────────────────

export interface ReportResult {
  readonly state: ReportState
  readonly commit: string
  readonly changed: readonly string[]
}

/** The worker's report. rw checks it against the contract and the branch before it believes it. */
export function report(repo: Repo, id: string, claimed?: ReportState): ReportResult {
  const task = repo.contract(id)
  const state = repo.state()
  const record = state.tasks[id]
  if (record?.state !== 'running') throw new UserError(`${id} is ${record?.state ?? 'not registered'}; a report belongs to a running task`)
  const lane = state.lanes[id]
  if (!lane) throw new UserError(`${id} has no lane`)
  const file = join(lane.worktree, repo.reportRel(id))
  const text = readText(file)
  if (text === undefined) throw new UserError(`write ${repo.reportRel(id)} in your worktree first (template in your prompt)`)
  const parsed = parseReport(text)
  if (!parsed.report) throw new UserError(`${repo.reportRel(id)}: ${parsed.problems.join('; ')}`)
  const rep = parsed.report
  if (claimed && rep.state !== claimed) throw new UserError(`--state ${claimed} but the report file says state: ${rep.state}; make them agree`)
  const problems = checkReport(rep, task)
  let commit = ''
  let changed: string[] = []
  if (rep.state === 'ready') {
    const dirty = g.allChanges(lane.worktree)
    if (dirty.length) problems.push(`commit or remove uncommitted files first: ${dirty.slice(0, 8).join(', ')}`)
    commit = g.head(lane.worktree)
    if (rep.commit && !commit.startsWith(rep.commit) && !g.isAncestor(lane.worktree, rep.commit, commit)) {
      problems.push(`report commit ${rep.commit} is not on the lane branch`)
    }
    const base = g.mergeBase(lane.worktree, lane.base, 'HEAD')
    if (g.commitsBetween(lane.worktree, base) === 0) problems.push('the branch has no commits; a ready report delivers a change')
    changed = g.changedFiles(lane.worktree, base)
    const stray = outside(task.scope, changed, [repo.reportRel(id)])
    if (stray.length) problems.push(`files outside the task's scope: ${stray.join(', ')} (revert them, or report blocked and ask)`)
    const links = g.symlinksChanged(lane.worktree, base)
    if (links.length) problems.push(`symbolic links are not merged (a link in scope can point outside it): ${links.join(', ')}`)
    if (!changed.includes(repo.reportRel(id))) problems.push(`commit ${repo.reportRel(id)} on the branch`)
    // verifyReport: run the acceptance commands now instead of believing the table until the merge
    if (repo.config.verifyReport && problems.length === 0) {
      for (const command of task.accept) {
        const run = runShell(command, lane.worktree, repo.config.limits.commandTimeoutMinutes * 60_000)
        if (!run.ok) problems.push(`acceptance command failed when rw ran it: ${command} (exit ${run.code}): ${lastLines(run.out, 6, 600) || '(no output)'}`)
      }
      const written = g.allChanges(lane.worktree)
      if (written.length) problems.push(`the acceptance commands changed files: ${written.slice(0, 8).join(', ')}; commit generated output or make them check without writing`)
    }
  }
  if (problems.length) throw new UserError(`report refused:\n- ${problems.join('\n- ')}`)
  const summary = rep.body.split('\n').find((line) => line.trim() && !line.startsWith('#'))?.trim().slice(0, 160)
  repo.update((current) => {
    switch (rep.state) {
      case 'ready':
        return transition(current, id, 'reportReady', repo.now(), { question: undefined, note: summary }, `commit ${commit.slice(0, 12)}`)
      case 'blocked':
        return transition(current, id, 'reportBlocked', repo.now(), { question: rep.question, note: summary }, rep.question)
      case 'dropped':
        return transition(current, id, 'reportDropped', repo.now(), { note: summary }, summary)
      case 'failed':
        return transition(current, id, 'reportFailed', repo.now(), { note: summary }, summary)
    }
  })
  repo.event('report', { task: id, state: rep.state, commit, changed: changed.length })
  return { state: rep.state, commit, changed }
}

// ── follow-ups, answers, review verdicts ──────────────────────────────────────────────────────────

/** Deliver text to the task's own lane session: thread pass-through, not a new task. */
function deliver(repo: Repo, id: string, kind: string, text: string, action: 'followup' | 'answer' | null): LaunchResult | undefined {
  const task = repo.contract(id)
  const lane = repo.state().lanes[id]
  if (!lane) throw new UserError(`${id} has no lane to follow up; it was never dispatched`)
  const message = followupPrompt(repo, task, lane, kind, text)
  const running = lane.status !== 'manual' && lane.pid > 0 && alive(lane.pid)
  repo.update((state) => {
    let next = state
    if (action && next.tasks[id]?.state !== 'running') next = transition(next, id, action, repo.now(), { question: undefined, reviewVerdict: undefined }, `${kind}: ${text.slice(0, 120)}`)
    else if (action) next = patchTask(next, id, { reviewVerdict: undefined })
    return patchLane(next, id, { pending: [...(next.lanes[id]?.pending ?? []), message] })
  })
  repo.event('followup', { task: id, kind, queued: running })
  return running ? undefined : launch(repo, id)
}

export function followup(repo: Repo, id: string, text: string, kind = 'owner'): LaunchResult | undefined {
  if (!text.trim()) throw new UserError('a follow-up needs text')
  return deliver(repo, id, kind, text, 'followup')
}

export function answer(repo: Repo, id: string, text: string): LaunchResult | undefined {
  ownerOnly('rw answer')
  const record = repo.state().tasks[id]
  if (record?.state !== 'blocked') throw new UserError(`${id} is ${record?.state ?? 'not registered'}; only a blocked task waits for an answer`)
  const question = record.question ? `Your question: ${record.question}\n\nThe owner's answer: ${text}` : `The owner's answer: ${text}`
  // the owner's answer is new direction: the worker gets its red-gate returns again
  repo.update((state) => patchTask(state, id, { remediation: 0 }))
  return deliver(repo, id, 'answer', question, 'answer')
}

export function verdict(repo: Repo, id: string, approved: boolean): { outcome: string } {
  const state = repo.state()
  const record = state.tasks[id]
  if (record?.state !== 'review') throw new UserError(`${id} is ${record?.state ?? 'not registered'}; a verdict belongs to a task in review`)
  const findings = readText(reviewFile(repo, id))?.trim() ?? ''
  const round = record.reviewRounds + 1
  if (approved) {
    repo.update((current) => setLane(patchTask(current, id, { reviewVerdict: 'approve', reviewRounds: round }), `${id}.review`, undefined))
    repo.event('verdict', { task: id, approve: true, round })
    return { outcome: 'approved; the loop merges it after the gate' }
  }
  if (!findings) throw new UserError(`write the findings to ${reviewFile(repo, id)} first`)
  repo.update((current) => setLane(patchTask(current, id, { reviewVerdict: 'changes', reviewRounds: round }), `${id}.review`, undefined))
  repo.event('verdict', { task: id, approve: false, round })
  if (round >= repo.config.limits.reviewRounds) {
    escalate(repo, id, `Review round ${round} still asks for changes (findings: ${reviewFile(repo, id)}). Fix them in another round, merge as is, or stop?`)
    return { outcome: `review round limit (${repo.config.limits.reviewRounds}) reached; asking the owner` }
  }
  deliver(repo, id, 'review', findings, 'followup')
  return { outcome: `changes requested (round ${round}); the findings went to the worker's session` }
}

function escalate(repo: Repo, id: string, question: string): void {
  repo.update((state) => transition(state, id, 'escalate', repo.now(), { question }, question))
  repo.event('escalate', { task: id, question })
}

// ── owner controls ────────────────────────────────────────────────────────────────────────────────

/**
 * End a lane's executor and everything it started. Callers record the task's new state first: the
 * supervisor then sees the task is no longer running when its executor exits, settles nothing, and exits
 * by itself. It is never killed, so it can never die holding the state lock.
 */
function killLane(lane: LaneRecord | undefined): boolean {
  return lane?.childPid ? killTree(lane.childPid) : false
}

export function hold(repo: Repo, id: string, reason: string): { stopped: boolean } {
  ownerOnly('rw hold')
  const before = repo.state()
  repo.update((state) => patchLane(transition(state, id, 'hold', repo.now(), { note: reason }, reason), id, { pending: [] }))
  const stopped = killLane(before.lanes[id])
  killLane(before.lanes[`${id}.review`])
  repo.event('hold', { task: id, reason })
  return { stopped }
}

export function release(repo: Repo, id: string): void {
  ownerOnly('rw release')
  repo.update((state) => transition(state, id, 'release', repo.now(), { note: undefined }, 'released'))
  repo.event('release', { task: id })
}

export function stop(repo: Repo, id: string, reason: string): { worktree?: string } {
  ownerOnly('rw stop')
  const before = repo.state()
  const lane = before.lanes[id]
  repo.update((state) => patchLane(transition(state, id, 'stop', repo.now(), { note: reason }, reason), id, { pending: [] }))
  killLane(lane)
  killLane(before.lanes[`${id}.review`])
  repo.event('stop', { task: id, reason })
  return lane ? { worktree: lane.worktree } : {}
}

export function retry(repo: Repo, id: string): void {
  ownerOnly('rw retry')
  repo.update((state) => {
    const lane = state.lanes[id]
    const next = transition(state, id, 'retry', repo.now(), { question: undefined, remediation: 0 }, 'retry')
    return lane ? patchLane(next, id, { attempts: [...lane.attempts, { executor: lane.executor, outcome: state.tasks[id]?.note ?? state.tasks[id]?.state ?? 'ended' }] }) : next
  })
  repo.event('retry', { task: id })
}

/**
 * Throw a lane away and queue the task again from the current base. Refused while the lane holds work,
 * unless forced: rw retry continues on that work instead.
 */
export function reset(repo: Repo, id: string, force: boolean): { discarded: string[]; left: string[] } {
  ownerOnly('rw reset')
  const state = repo.state()
  const record = state.tasks[id]
  if (!record) throw new UserError(`${id} is not registered`)
  const lane = state.lanes[id]
  if ((record.state === 'running' || record.state === 'review') && !force) {
    throw new UserError(`${id} is ${record.state}; rw hold ${id} first, or rw reset ${id} --force stops its executor and discards the lane`)
  }
  if (lane && !force) {
    const work = laneWork(repo, lane)
    if (work.commits || work.dirty.length) {
      const what = [work.commits ? `${work.commits} commit(s) on ${lane.branch}` : '', work.dirty.length ? `${work.dirty.length} uncommitted change(s) in ${lane.worktree} (${work.dirty.slice(0, 3).join(', ')}${work.dirty.length > 3 ? ', …' : ''})` : ''].filter(Boolean).join(' and ')
      throw new UserError(`${id} has ${what}; rw reset ${id} --force discards them, rw retry ${id} continues on them`)
    }
  }
  repo.update((current) => setLane(setLane(transition(current, id, 'reset', repo.now(),
    { question: undefined, note: undefined, remediation: 0, reviewRounds: 0, reviewVerdict: undefined }, force ? 'reset (forced)' : 'reset'), id, undefined), `${id}.review`, undefined))
  killLane(lane)
  killLane(state.lanes[`${id}.review`])
  // give a stopped executor a moment to release its files (Windows locks them) before the worktree goes
  for (const pid of [lane?.childPid, state.lanes[`${id}.review`]?.childPid]) if (pid) waitGone(pid, 5_000)
  const discarded: string[] = []
  const left: string[] = []
  if (lane) {
    left.push(...teardown(repo, lane))
    discarded.push(lane.branch, lane.worktree)
  }
  repo.event('reset', { task: id, force, discarded, left })
  return { discarded, left }
}

export interface Leftover {
  readonly kind: 'branch' | 'folder'
  readonly path: string
  /** Set for a dropped task's lane; such a lane is kept for inspection until rw clean removes it. */
  readonly task?: string
  readonly work?: boolean
}

/** Branches and worktree folders rw made that no live lane uses any more, and the lanes of dropped tasks. */
export function leftovers(repo: Repo): Leftover[] {
  const state = repo.state()
  const live = Object.values(state.lanes).filter((lane) => state.tasks[lane.task]?.state !== 'dropped')
  const branches = new Set(live.map((lane) => lane.branch))
  const folders = new Set(live.map((lane) => lane.worktree.replaceAll('\\', '/').toLowerCase()))
  const out: Leftover[] = []
  for (const lane of Object.values(state.lanes)) {
    if (state.tasks[lane.task]?.state !== 'dropped' || lane.role !== 'worker') continue
    if (!exists(lane.worktree) && !g.branchExists(repo.root, lane.branch)) continue
    const work = laneWork(repo, lane)
    out.push({ kind: 'folder', path: lane.worktree, task: lane.task, work: work.commits > 0 || work.dirty.length > 0 })
  }
  const dropped = new Set(out.map((item) => item.path.replaceAll('\\', '/').toLowerCase()))
  const droppedBranches = new Set(Object.values(state.lanes).filter((lane) => state.tasks[lane.task]?.state === 'dropped').map((lane) => lane.branch))
  for (const branch of g.branchesWithPrefix(repo.root, repo.config.branchPrefix)) {
    if (!branches.has(branch) && !droppedBranches.has(branch)) out.push({ kind: 'branch', path: branch })
  }
  // Only folders this repository created count: the worktree root may be shared with other repositories.
  const created = new Set<string>()
  for (const line of (readText(repo.paths.events) ?? '').split('\n')) {
    if (!line.includes('"dispatch"')) continue
    try {
      const event = JSON.parse(line) as { type?: string; worktree?: unknown }
      if (event.type === 'dispatch' && typeof event.worktree === 'string') created.add(event.worktree)
    } catch {
      // a torn line at the end of the log
    }
  }
  for (const path of created) {
    const key = path.replaceAll('\\', '/').toLowerCase()
    if (exists(path) && !folders.has(key) && !dropped.has(key)) out.push({ kind: 'folder', path })
  }
  return out
}

/**
 * Remove leftovers: orphaned rw branches and folders, and the lanes of dropped tasks that hold no work.
 * A dropped task's lane that holds work, or an orphaned branch that is not merged into the base, needs --force.
 */
export function clean(repo: Repo, force: boolean): { removed: string[]; kept: string[] } {
  ownerOnly('rw clean')
  const removed: string[] = []
  const kept: string[] = []
  const merged = new Set(g.gitOk(repo.root, ['branch', '--merged', repo.config.base, '--format=%(refname:short)']).split('\n').map((line) => line.trim()))
  for (const item of leftovers(repo)) {
    if (item.task) {
      if (item.work && !force) {
        kept.push(`${item.task} lane ${item.path} holds work (rw clean --force removes it)`)
        continue
      }
      const lane = repo.state().lanes[item.task]
      if (lane) {
        const left = teardown(repo, lane)
        repo.update((state) => setLane(state, item.task as string, undefined))
        if (left.length) kept.push(...left)
        else removed.push(`${item.task} lane ${lane.branch}`)
      }
    } else if (item.kind === 'branch') {
      if (!merged.has(item.path) && !force) {
        kept.push(`branch ${item.path} is not merged into ${repo.config.base} (rw clean --force deletes it)`)
        continue
      }
      if (g.deleteBranch(repo.root, item.path, true)) removed.push(`branch ${item.path}`)
      else kept.push(`could not delete branch ${item.path}`)
    } else {
      const problem = g.removeWorktree(repo.root, item.path)
      if (problem) kept.push(problem)
      else removed.push(`folder ${item.path}`)
    }
  }
  repo.event('clean', { force, removed, kept })
  return { removed, kept }
}

/** Things that make lanes behave differently from what the owner sees: the kit must be committed on the base. */
export function kitProblems(repo: Repo): string[] {
  const problems: string[] = []
  const missing = ['.rw/config.json', 'AGENTS.md'].filter((rel) => exists(join(repo.root, rel)) && (!g.tracked(repo.root, rel) || g.changedSinceHead(repo.root, rel)))
  if (missing.length) problems.push(`commit ${missing.join(' and ')} on ${repo.config.base}: lane worktrees are checked out from ${repo.config.base} and do not see uncommitted files`)
  // the local overlay holds machine-specific settings, such as paths, which must never be committed
  const local = '.rw/config.local.json'
  if (exists(join(repo.root, local)) && (g.tracked(repo.root, local) || !g.git(repo.root, ['check-ignore', '-q', '--', local]).ok)) {
    problems.push(`${local} is ${g.tracked(repo.root, local) ? 'committed' : 'not ignored by git'}; it holds machine-specific settings: add it to .rw/.gitignore${g.tracked(repo.root, local) ? ` and git rm --cached ${local}` : ''} (rw init does)`)
  }
  return problems
}

// ── merge ─────────────────────────────────────────────────────────────────────────────────────────

export type MergeResult =
  | { readonly outcome: 'merged'; readonly commit: string; readonly log: string; readonly left: readonly string[] }
  | { readonly outcome: 'returned'; readonly reason: string; readonly log?: string }
  | { readonly outcome: 'escalated'; readonly reason: string; readonly log?: string }
  | { readonly outcome: 'waiting'; readonly reason: string; readonly log?: string }

export function mergeLog(repo: Repo, id: string): string {
  return join(repo.paths.lanes, `${id}.merge.log`)
}

/**
 * Merge one reviewed task. The base never goes red: rw merges the base into the lane branch, re-runs the
 * acceptance commands and merge gates there, and only then fast-forwards the base. A red gate goes back
 * to the same worker session; past the remediation limit it becomes the owner's question.
 */
export function merge(repo: Repo, id: string): MergeResult {
  const task = repo.contract(id)
  const timeout = repo.config.limits.commandTimeoutMinutes * 60_000
  return withLock(join(repo.paths.state, 'merge.lock'), () => {
    const state = repo.state()
    const record = state.tasks[id]
    const lane = state.lanes[id]
    if (record?.state !== 'review') throw new UserError(`${id} is ${record?.state ?? 'not registered'}; only a task in review merges`)
    if (!lane) throw new UserError(`${id} has no lane`)
    if (task.review === 'required' && record.reviewVerdict !== 'approve') {
      return { outcome: 'waiting', reason: 'review is required and has not approved yet' }
    }
    // A red merge goes back to the worker up to limits.remediation times; the next red asks the owner.
    // `remediation` counts the returns, so it never exceeds the limit.
    const sendBack = (kind: string, reason: string, detail: string): MergeResult => {
      const limit = repo.config.limits.remediation
      if (record.remediation >= limit) {
        const question = `${reason}, and it already went back to the worker ${limit} time(s). How should ${id} proceed?`
        repo.update((current) => transition(current, id, 'escalate', repo.now(), { question }, question))
        repo.event('escalate', { task: id, reason, returns: record.remediation })
        return { outcome: 'escalated', reason }
      }
      const rounds = record.remediation + 1
      repo.update((current) => patchTask(current, id, { remediation: rounds }))
      deliver(repo, id, kind, `${reason}.\n\n${detail}`, 'followup')
      return { outcome: 'returned', reason }
    }
    if (g.allChanges(lane.worktree).length) return sendBack('gate', 'the worktree has uncommitted changes', 'Commit or remove them and report again.')
    const merged = g.mergeIn(lane.worktree, lane.base)
    if (!merged.ok) {
      return sendBack('conflict', `merging ${lane.base} into ${lane.branch} conflicts`, `Conflicting files:\n${merged.conflicts.map((file) => `- ${file}`).join('\n')}\n\nRun \`git merge ${lane.base}\` in your worktree, resolve within your scope, commit, re-run the acceptance commands and report again.`)
    }
    const base = g.mergeBase(lane.worktree, lane.base, 'HEAD')
    const stray = outside(task.scope, g.changedFiles(lane.worktree, base), [repo.reportRel(id)])
    if (stray.length) return sendBack('gate', 'the branch changes files outside the task scope', stray.map((file) => `- ${file}`).join('\n'))
    const links = g.symlinksChanged(lane.worktree, base)
    if (links.length) return sendBack('gate', 'the branch adds or changes symbolic links', links.map((file) => `- ${file}`).join('\n'))
    // Every gate run is kept: what ran, where, how long, and its output, so a merge can be audited later.
    const log = mergeLog(repo, id)
    const entries: string[] = [`# ${id} merge gate, ${repo.now()}`, `branch ${lane.branch} at ${g.head(lane.worktree)}, merged with ${lane.base}`, '']
    for (const command of [...task.accept, ...repo.config.gates.merge]) {
      const startedAt = Date.now()
      const run = runShell(command, lane.worktree, timeout)
      entries.push(`## \`${command}\` → exit ${run.code} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`, '', '```', run.out.trimEnd() || '(no output)', '```', '')
      writeAtomic(log, `${entries.join('\n')}\n`)
      if (!run.ok) {
        const result = sendBack('gate', `\`${command}\` failed (exit ${run.code}) on the branch merged with ${lane.base}`, `Last output:\n\n\`\`\`\n${lastLines(run.out, 40) || '(no output)'}\n\`\`\`\n\nFull gate log: ${log}`)
        return { ...result, log }
      }
    }
    // The tree that was verified must be the tree that lands: a gate that writes (a formatter, codegen, a
    // rebuild) leaves changes the fast-forward would silently drop.
    const written = g.allChanges(lane.worktree)
    if (written.length) {
      return sendBack('gate', 'the acceptance or merge gate commands changed files in the worktree',
        `Changed by the gates:\n${written.slice(0, 20).map((file) => `- ${file}`).join('\n')}\n\nRun the generator yourself and commit its output (inside your scope), or make the commands check without writing; then report again.`)
    }
    const tip = g.head(lane.worktree)
    const waiting = (reason: string): MergeResult => {
      repo.update((current) => patchTask(current, id, { note: `merge waits: ${reason}` }))
      return { outcome: 'waiting', reason }
    }
    const checkedOut = g.currentBranch(repo.root) === lane.base
    if (checkedOut) {
      // Uncommitted edits in the base worktree do not block a merge: git refuses the fast-forward only when
      // they touch a file the merge changes, and then nothing moves and the owner's edits are kept.
      const ff = g.fastForward(repo.root, tip)
      if (!ff.ok) {
        const collides = /would be overwritten/i.test(ff.out)
        return waiting(collides
          ? `your uncommitted changes in ${repo.root} touch files this merge changes (${lastLines(ff.out.replace(/\s+/g, ' '), 1, 300)}); commit, stash or revert them and the next pass merges`
          : `${lane.base} moved while the gate ran; the next pass merges again (${lastLines(ff.out, 2)})`)
      }
    } else {
      const ff = g.git(repo.root, ['fetch', '.', `${tip}:refs/heads/${lane.base}`])
      if (!ff.ok) return waiting(`could not fast-forward ${lane.base}: ${lastLines(ff.out, 2)}`)
    }
    repo.update((current) => setLane(transition(current, id, 'merged', repo.now(), { note: `merged ${tip.slice(0, 12)}`, question: undefined }, tip.slice(0, 12)), id, undefined))
    // The merge stands whatever happens next; a leftover is reported by the watchdog and removed by rw clean.
    const left = teardown(repo, lane)
    repo.event('merge', { task: id, commit: tip, log, left })
    return { outcome: 'merged', commit: tip, log, left }
  }, { timeoutMs: timeout, staleMs: timeout + 60_000 })
}

// ── review lanes ──────────────────────────────────────────────────────────────────────────────────

export function startReview(repo: Repo, id: string): LaunchResult {
  const task = repo.contract(id)
  const state = repo.state()
  const worker = state.lanes[id]
  if (!worker) throw new UserError(`${id} has no lane to review`)
  const key = `${id}.review`
  const pick = chain(repo.config, 'review')[0]
  if (!pick) throw new UserError('tier review has no enabled executor')
  const previous = state.lanes[key]
  const lane: LaneRecord = {
    ...newLane(repo, task, 'reviewer', pick.executor, pick.model, worker),
    attempts: previous?.attempts ?? [],
    log: laneLog(repo, key),
  }
  repo.update((current) => setLane(current, key, lane))
  const round = (state.tasks[id]?.reviewRounds ?? 0) + 1
  writeAtomic(lanePromptFile(repo, key), reviewerPrompt(repo, task, lane, round))
  repo.event('review', { task: id, round, executor: pick.executor })
  return launch(repo, key)
}

// ── reads ─────────────────────────────────────────────────────────────────────────────────────────

export function next(repo: Repo): Packet {
  const { contracts } = repo.readContracts()
  const state = repo.state()
  return packet(contracts, state, repo.freeLanes(state))
}

export function status(repo: Repo): string {
  return repo.renderBoard(undefined, kitProblems(repo))
}

export interface WatchdogResult {
  readonly deviations: Deviation[]
  /** Checks that could not run here (a sandbox that forbids starting processes): the audit is partial. */
  readonly skipped: string[]
}

/**
 * The read-only audit. Where git or a shell cannot be started (a confined scheduled session), it still runs
 * every check that needs only files, and names the ones it skipped instead of reporting a partial OK as OK.
 */
export function watchdog(repo: Repo, options: { skipChecks?: boolean } = {}): WatchdogResult {
  const { contracts, invalid } = repo.readContracts()
  const state = repo.state()
  const pids = Object.values(state.lanes).map((lane) => lane.pid).filter((pid) => pid > 0)
  const skipped: string[] = []
  let left: string[] = []
  try {
    left = leftovers(repo).map((item) => item.task
      ? `${item.task} (dropped) still has its lane ${item.path}${item.work ? ', with work' : ''}`
      : `${item.kind} ${item.path} belongs to no lane`)
  } catch (error) {
    if (!(error instanceof g.GitUnavailable)) throw error
    skipped.push(`leftover branches and folders: ${error.message}`)
  }
  const checks: { name: string; ok: boolean; detail: string }[] = []
  if (!options.skipChecks) {
    for (const check of repo.config.watchdog.checks) {
      const run = runShell(check.command, repo.root, repo.config.limits.commandTimeoutMinutes * 60_000)
      if (run.spawnError) skipped.push(`check ${check.name}: a shell could not be started (${run.spawnError})`)
      else checks.push({ name: check.name, ok: run.ok, detail: run.ok ? 'ok' : `\`${check.command}\` exit ${run.code}: ${lastLines(run.out, 1, 200)}` })
    }
  }
  const deviations = audit({
    now: repo.now(), state, contracts, invalid, leftovers: left,
    alive: Object.fromEntries(pids.map((pid) => [pid, alive(pid)])),
    worktrees: new Set(Object.values(state.lanes).map((lane) => lane.worktree).filter((path) => exists(path))),
    staleMinutes: repo.config.limits.staleMinutes,
    manualStaleHours: repo.config.limits.manualStaleHours,
    checks,
  })
  return { deviations, skipped }
}
