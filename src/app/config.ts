/**
 * `.rw/config.json`, committed with the repository. Few settings: a default replaces a setting whenever
 * one value suits almost every repository. Unknown keys fail, so a typo never silently does nothing.
 */
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { UserError } from '../core/model.ts'
import type { AcceptMode, Policy, Rule } from '../core/policy.ts'
import { readJson } from '../infra/fs.ts'

export interface ClaudeExecutor {
  readonly kind: 'claude'
  readonly command: string
  readonly models: Readonly<Record<string, string>>
  readonly permissionMode: string
  readonly allowedTools: readonly string[]
  readonly reviewerTools: readonly string[]
  readonly extraArgs: readonly string[]
  readonly capacityPattern: string
}

export interface CommandExecutor {
  readonly kind: 'command'
  /** argv with {promptFile} {cwd} {model} {session} {task} {role} placeholders. */
  readonly start: readonly string[]
  readonly resume: readonly string[]
  readonly stdin: boolean
  readonly models: Readonly<Record<string, string>>
  /** First capture group is the resumable session id, matched against the executor's output. */
  readonly sessionPattern: string
  readonly capacityPattern: string
}

export interface ManualExecutor {
  readonly kind: 'manual'
}

/** Runs only inside the DSH plugin, which creates DSH Sessions for lanes. */
export interface DshExecutor {
  readonly kind: 'dsh'
  readonly models: Readonly<Record<string, string>>
}

export type ExecutorConfig = (ClaudeExecutor | CommandExecutor | ManualExecutor | DshExecutor) & { readonly enabled: boolean }

export interface Config {
  readonly base: string
  readonly tasksDir: string
  readonly reportsDir: string
  readonly worktreeRoot: string
  readonly branchPrefix: string
  readonly commitTasks: boolean
  /** Run the acceptance commands at rw report instead of only at merge (slower reports, earlier feedback). */
  readonly verifyReport: boolean
  readonly limits: {
    readonly lanes: number
    readonly remediation: number
    readonly reviewRounds: number
    readonly maxFindings: number
    readonly staleMinutes: number
    readonly manualStaleHours: number
    readonly commandTimeoutMinutes: number
  }
  readonly gates: { readonly merge: readonly string[] }
  /** Run once in every new lane worktree: a fresh checkout has none of the files git ignores. */
  readonly worktree: {
    /** Ignored files or folders copied from the main worktree (.env, a generated input). */
    readonly copy: readonly string[]
    /** Shell commands run in the new worktree after the copy (bun install --frozen-lockfile). */
    readonly prepare: readonly string[]
  }
  readonly policy: Policy
  readonly tiers: Readonly<Record<string, readonly string[]>>
  readonly executors: Readonly<Record<string, ExecutorConfig>>
  readonly watchdog: { readonly checks: readonly { readonly name: string; readonly command: string }[] }
}

const CAPACITY = 'usage limit|rate[ -]?limit|quota|exhausted|overloaded|credit balance|\\b429\\b|resource_exhausted'

export const DEFAULTS: Config = {
  base: 'main',
  tasksDir: 'work/tasks',
  reportsDir: 'work/reports',
  worktreeRoot: '~/.rw/worktrees/{repo}',
  branchPrefix: 'rw/',
  commitTasks: true,
  verifyReport: false,
  limits: { lanes: 2, remediation: 2, reviewRounds: 2, maxFindings: 7, staleMinutes: 20, manualStaleHours: 24, commandTimeoutMinutes: 30 },
  gates: { merge: [] },
  worktree: { copy: [], prepare: [] },
  policy: { mode: 'observe', rules: [] },
  tiers: { light: ['claude:light', 'manual'], build: ['claude', 'manual'], review: ['claude:strong', 'manual'] },
  executors: {
    claude: {
      kind: 'claude', enabled: true, command: 'claude',
      models: { default: 'sonnet', light: 'haiku', strong: 'opus' },
      permissionMode: 'acceptEdits',
      allowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite'],
      reviewerTools: ['Read', 'Glob', 'Grep', 'Write', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(rw verdict:*)'],
      extraArgs: [],
      capacityPattern: CAPACITY,
    },
    manual: { kind: 'manual', enabled: true },
  },
  watchdog: { checks: [] },
}

const TOP_KEYS = Object.keys(DEFAULTS)

function fail(message: string): never {
  throw new UserError(`.rw/config.json: ${message}`)
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) fail(`${where} must be a list of strings`)
  return value as string[]
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${where} must be an object`)
  return value as Record<string, unknown>
}

function rule(value: unknown, index: number): Rule {
  const raw = object(value, `policy.rules[${index}]`)
  if (typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(raw.id)) fail(`policy.rules[${index}].id must be a lowercase slug`)
  if (typeof raw.text !== 'string' || !raw.text.trim()) fail(`policy.rules[${index}].text describes the work the rule allows`)
  return {
    id: raw.id,
    text: raw.text,
    enabled: raw.enabled !== false,
    tiers: raw.tiers === undefined ? [] : strings(raw.tiers, `policy.rules[${index}].tiers`),
    maxScope: typeof raw.maxScope === 'number' ? raw.maxScope : 3,
  }
}

function executor(name: string, value: unknown): ExecutorConfig {
  const raw = object(value, `executors.${name}`)
  const enabled = raw.enabled !== false
  const models = raw.models === undefined ? {} : (object(raw.models, `executors.${name}.models`) as Record<string, string>)
  switch (raw.kind) {
    case 'claude': {
      const base = DEFAULTS.executors.claude as ClaudeExecutor
      return {
        kind: 'claude', enabled,
        command: typeof raw.command === 'string' ? raw.command : base.command,
        models: { ...base.models, ...models },
        permissionMode: typeof raw.permissionMode === 'string' ? raw.permissionMode : base.permissionMode,
        allowedTools: raw.allowedTools === undefined ? base.allowedTools : strings(raw.allowedTools, `executors.${name}.allowedTools`),
        reviewerTools: raw.reviewerTools === undefined ? base.reviewerTools : strings(raw.reviewerTools, `executors.${name}.reviewerTools`),
        extraArgs: raw.extraArgs === undefined ? [] : strings(raw.extraArgs, `executors.${name}.extraArgs`),
        capacityPattern: typeof raw.capacityPattern === 'string' ? raw.capacityPattern : CAPACITY,
      }
    }
    case 'command': {
      const start = strings(raw.start, `executors.${name}.start`)
      if (start.length === 0) fail(`executors.${name}.start is the command that runs a lane`)
      return {
        kind: 'command', enabled, start,
        resume: raw.resume === undefined ? [] : strings(raw.resume, `executors.${name}.resume`),
        stdin: raw.stdin === true,
        models,
        sessionPattern: typeof raw.sessionPattern === 'string' ? raw.sessionPattern : '',
        capacityPattern: typeof raw.capacityPattern === 'string' ? raw.capacityPattern : CAPACITY,
      }
    }
    case 'manual':
      return { kind: 'manual', enabled }
    case 'dsh':
      return { kind: 'dsh', enabled, models }
    default:
      return fail(`executors.${name}.kind must be claude, command, manual or dsh`)
  }
}

export function parseConfig(raw: unknown): Config {
  const input = object(raw ?? {}, 'the file')
  const unknown = Object.keys(input).filter((key) => !TOP_KEYS.includes(key) && key !== '$schema' && key !== '//')
  if (unknown.length) fail(`unknown key(s) ${unknown.join(', ')}`)
  const limitsIn = input.limits === undefined ? {} : object(input.limits, 'limits')
  const limits = { ...DEFAULTS.limits }
  for (const [key, value] of Object.entries(limitsIn)) {
    if (!(key in limits)) fail(`unknown limit ${key}`)
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`limits.${key} must be a non-negative number`)
    ;(limits as Record<string, number>)[key] = value
  }
  if (limits.lanes < 1) fail('limits.lanes must be at least 1')
  const policyIn = input.policy === undefined ? {} : object(input.policy, 'policy')
  const mode = (policyIn.mode ?? DEFAULTS.policy.mode) as AcceptMode
  if (!['off', 'observe', 'auto'].includes(mode)) fail('policy.mode must be off, observe or auto')
  const rules = policyIn.rules === undefined ? [] : (Array.isArray(policyIn.rules) ? policyIn.rules.map(rule) : fail('policy.rules must be a list'))
  const executors: Record<string, ExecutorConfig> = { ...DEFAULTS.executors }
  if (input.executors !== undefined) {
    for (const [name, value] of Object.entries(object(input.executors, 'executors'))) executors[name] = executor(name, value)
  }
  const tiers: Record<string, readonly string[]> = { ...DEFAULTS.tiers }
  if (input.tiers !== undefined) {
    for (const [name, value] of Object.entries(object(input.tiers, 'tiers'))) tiers[name] = strings(value, `tiers.${name}`)
  }
  for (const [tier, chain] of Object.entries(tiers)) {
    if (chain.length === 0) fail(`tiers.${tier} needs at least one executor`)
    for (const entry of chain) {
      const name = entry.split(':')[0] as string
      if (!executors[name]) fail(`tiers.${tier} names executor ${name}, which executors does not define`)
    }
  }
  const gatesIn = input.gates === undefined ? {} : object(input.gates, 'gates')
  const worktreeIn = input.worktree === undefined ? {} : object(input.worktree, 'worktree')
  const worktreeUnknown = Object.keys(worktreeIn).filter((key) => key !== 'copy' && key !== 'prepare')
  if (worktreeUnknown.length) fail(`unknown key(s) worktree.${worktreeUnknown.join(', worktree.')}`)
  const copy = worktreeIn.copy === undefined ? [] : strings(worktreeIn.copy, 'worktree.copy')
  for (const path of copy) {
    if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.replaceAll('\\', '/').split('/').includes('..')) fail(`worktree.copy entry ${path} must be relative to the repository root`)
  }
  const watchIn = input.watchdog === undefined ? {} : object(input.watchdog, 'watchdog')
  const checks = watchIn.checks === undefined ? [] : (Array.isArray(watchIn.checks) ? watchIn.checks : fail('watchdog.checks must be a list'))
  const text = (key: keyof Config, fallback: string): string => {
    const value = input[key]
    if (value === undefined) return fallback
    if (typeof value !== 'string' || !value) fail(`${key} must be a non-empty string`)
    return value
  }
  return {
    base: text('base', DEFAULTS.base),
    tasksDir: text('tasksDir', DEFAULTS.tasksDir),
    reportsDir: text('reportsDir', DEFAULTS.reportsDir),
    worktreeRoot: text('worktreeRoot', DEFAULTS.worktreeRoot),
    branchPrefix: text('branchPrefix', DEFAULTS.branchPrefix),
    commitTasks: input.commitTasks === undefined ? DEFAULTS.commitTasks : input.commitTasks === true,
    verifyReport: input.verifyReport === true,
    limits,
    gates: { merge: gatesIn.merge === undefined ? [] : strings(gatesIn.merge, 'gates.merge') },
    worktree: { copy, prepare: worktreeIn.prepare === undefined ? [] : strings(worktreeIn.prepare, 'worktree.prepare') },
    policy: { mode, rules },
    tiers,
    executors,
    watchdog: {
      checks: checks.map((item, index) => {
        const check = object(item, `watchdog.checks[${index}]`)
        if (typeof check.name !== 'string' || typeof check.command !== 'string') fail(`watchdog.checks[${index}] needs name and command`)
        return { name: check.name, command: check.command }
      }),
    },
  }
}

/** The machine-local overlay: gitignored, for what may not be committed (a bridge path, a model id). */
export const LOCAL_CONFIG = 'config.local.json'

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Objects merge key by key, recursively; lists and values in `local` replace those in `base`. */
export function mergeConfig(base: unknown, local: unknown): unknown {
  if (local === undefined) return base
  if (!plainObject(base) || !plainObject(local)) return local
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(local)) out[key] = key in base ? mergeConfig(base[key], value) : value
  return out
}

/** `.rw/config.json`, with `.rw/config.local.json` merged over it when the file exists. */
export function loadConfig(root: string): Config {
  const base = readJson<unknown>(join(root, '.rw', 'config.json'), {})
  const local = readJson<unknown>(join(root, '.rw', LOCAL_CONFIG), undefined)
  if (local === undefined) return parseConfig(base)
  if (!plainObject(local)) throw new UserError(`.rw/${LOCAL_CONFIG} must be a JSON object`)
  try {
    return parseConfig(mergeConfig(base, local))
  } catch (error) {
    if (error instanceof UserError) throw new UserError(error.message.replace('.rw/config.json:', `.rw/config.json with .rw/${LOCAL_CONFIG}:`))
    throw error
  }
}

/** Where lane worktrees live: outside the repository, so tools that walk the tree never see them. */
export function worktreeRoot(config: Config, root: string): string {
  const raw = config.worktreeRoot.replace('{repo}', basename(root))
  const expanded = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw
  return isAbsolute(expanded) ? expanded : resolve(root, expanded)
}

/** A tier entry is `executor` or `executor:model-alias`. */
export function chain(config: Config, tier: string): { executor: string; model: string }[] {
  const entries = config.tiers[tier]
  if (!entries) throw new UserError(`unknown tier ${tier}; .rw/config.json tiers has ${Object.keys(config.tiers).join(', ')}`)
  return entries
    .map((entry) => {
      const [executor, alias = 'default'] = entry.split(':') as [string, string?]
      const spec = config.executors[executor]
      const models = spec && 'models' in spec ? spec.models : {}
      return { executor, model: models[alias] ?? (alias === 'default' ? '' : alias), enabled: spec?.enabled !== false }
    })
    .filter((entry) => entry.enabled)
    .map(({ executor, model }) => ({ executor, model }))
}
