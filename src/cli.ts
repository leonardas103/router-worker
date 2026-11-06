#!/usr/bin/env node
/** `rw`: the router-worker command line. Run `rw help`. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPORT_STATES, UserError, type ReportState } from './core/model.ts'
import { chain } from './app/config.ts'
import { HOSTS, init, type Host } from './app/init.ts'
import { runLane } from './app/lane.ts'
import { exitCode, pass } from './app/loop.ts'
import * as ops from './app/ops.ts'
import { PACKAGE_ROOT, Repo } from './app/repo.ts'
import { lastLines } from './infra/proc.ts'
import { readText } from './infra/fs.ts'

const HELP = `rw — router-worker: one router (code), many workers (agents), one watchdog.

Start
  rw init [--host claude,antigravity,dsh] [--force]   add the kit to this repository
  rw status [--json]                                  the board: what needs you, what moves, what is next
  rw next                                             the dispatch packet (JSON)

Owner
  rw add "<title>" --scope <glob> --accept "<cmd>" [--goal "<text>"] [--depends TASK-001]
         [--tier build] [--review] [--parent "<spec id>"] [--authority "<who, when>"]
  rw approve <TASK...>          accept proposals or hand-written task files
  rw reject <TASK> [reason]
  rw answer <TASK> "<text>"     answer a blocked task's question; its own session continues
  rw followup <TASK> "<text>"   send more work to the task's own session
  rw hold <TASK> [reason] · rw release <TASK> · rw stop <TASK> [reason]
  rw retry <TASK>               queue again: continues on the lane's work, or restarts fresh if it has none
  rw reset <TASK> [--force]     discard the lane (worktree, branch) and queue again from the current base
  rw verdict <TASK> --approve|--changes   decide a review yourself

Router
  rw loop [--once] [--interval 30] [--watch]   dispatch, review, merge until halt (exit 0 empty, 3 needs you)
  rw dispatch <TASK> [--executor name] [--model alias]   start a lane now; the model comes from the tier
  rw review <TASK> · rw merge <TASK>            merge keeps every gate's output in .rw/state/lanes/TASK.merge.log
  rw clean [--force]            remove leftover lane branches and folders, and dropped tasks' lanes
  rw watchdog [--json] [--skip-checks]          read-only audit; prints only deviations (exit 1)

Workers and agents
  rw report <TASK> [--state ready|blocked|dropped|failed]   check and record the report
  rw propose "<title>" --rule <rule-id> --scope … --accept …  suggest work; the gate decides
  rw prompt <TASK>              print the worker prompt (for a manual or IDE lane)
  rw lane <TASK>                lane record and log tail

Docs: ${join(PACKAGE_ROOT, 'docs')}`

/** The help lines that name `rw <command>`, with their continuation lines; the whole help if none do. */
function commandHelp(command: string): string {
  const lines = HELP.split('\n')
  const out: string[] = []
  const names = new RegExp(`(^|[\\s·])rw ${command.replace(/[^a-z_-]/g, '')}(\\s|$)`)
  for (let i = 0; i < lines.length; i++) {
    if (!names.test(lines[i] as string)) continue
    out.push(lines[i] as string)
    while (i + 1 < lines.length && /^ {9,}\S/.test(lines[i + 1] as string) && !/^\s*rw /.test(lines[i + 1] as string)) out.push(lines[++i] as string)
  }
  return out.length ? `${out.join('\n')}\n\nAll commands: rw help` : HELP
}

interface Args {
  readonly positional: string[]
  readonly flags: Map<string, string[]>
}

const BOOLEAN = new Set(['json', 'once', 'watch', 'review', 'force', 'approve', 'changes', 'skip-checks', 'help'])

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = []
  const flags = new Map<string, string[]>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2)
      let value: string
      if (eq > 0) value = arg.slice(eq + 1)
      else if (BOOLEAN.has(name)) value = 'true'
      else {
        const following = argv[i + 1]
        if (following === undefined) throw new UserError(`--${name} needs a value`)
        value = following
        i++
      }
      flags.set(name, [...(flags.get(name) ?? []), value])
    } else positional.push(arg)
  }
  return { positional, flags }
}

const one = (args: Args, name: string): string | undefined => args.flags.get(name)?.at(-1)
/** Split on commas outside {…}, so `--scope "src/{a,b}.ts,test/**"` is two patterns. */
function splitList(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of value) {
    if (ch === '{') depth++
    else if (ch === '}') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      out.push(current)
      current = ''
    } else current += ch
  }
  out.push(current)
  return out
}

const many = (args: Args, name: string, split = false): string[] =>
  (args.flags.get(name) ?? []).flatMap((value) => (split ? splitList(value) : [value])).map((value) => value.trim()).filter(Boolean)
const has = (args: Args, name: string): boolean => args.flags.has(name)

function need(value: string | undefined, what: string): string {
  if (!value) throw new UserError(`missing ${what}; see rw help`)
  return value
}

function ids(args: Args): string[] {
  const list = args.positional.slice(1)
  if (list.length === 0) throw new UserError('name at least one task, such as TASK-001')
  return list.map((id) => (/^\d+$/.test(id) ? `TASK-${id.padStart(3, '0')}` : id.toUpperCase()))
}

function newTask(args: Args): ops.NewTask {
  return {
    title: need(args.positional[1], 'the title'),
    goal: one(args, 'goal') ?? args.positional[1] ?? '',
    scope: many(args, 'scope', true),
    accept: many(args, 'accept'),
    depends: many(args, 'depends', true),
    ...(one(args, 'tier') ? { tier: one(args, 'tier') as string } : {}),
    review: has(args, 'review') ? 'required' : 'none',
    ...(one(args, 'parent') ? { parent: one(args, 'parent') as string } : {}),
    ...(one(args, 'authority') ? { authority: one(args, 'authority') as string } : {}),
  }
}

function print(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
}

function launched(result: ops.LaunchResult | undefined, id: string): string {
  if (!result) return `${id}: queued for its running session`
  if (result.manual) {
    return `${id}: manual lane. Open an agent (Claude Code, Antigravity, DSH) in\n  ${result.manual.worktree}\nand give it the prompt in\n  ${result.manual.promptFile}\n(or run: rw prompt ${id})`
  }
  return `${id}: started on ${result.executor}`
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  const command = args.positional[0] ?? 'help'
  if (command === 'help' || has(args, 'help')) {
    print(command === 'help' ? HELP : commandHelp(command))
    return 0
  }
  if (command === 'version' || command === '--version') {
    print(JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version as string)
    return 0
  }
  if (command === 'init') {
    const hosts = many(args, 'host', true)
    for (const host of hosts) if (!(HOSTS as readonly string[]).includes(host)) throw new UserError(`unknown host ${host}; hosts are ${HOSTS.join(', ')}`)
    const result = init(process.cwd(), { hosts: hosts as Host[], force: has(args, 'force') })
    print(`rw init in ${result.root}`)
    for (const file of result.written) print(`  wrote ${file}`)
    for (const file of result.kept) print(`  kept  ${file}`)
    for (const note of result.notes) print(`  note  ${note}`)
    for (const warning of result.warnings) print(`  WARNING ${warning}`)
    print('Next: edit .rw/config.json (base branch, gates.merge, tiers), commit, then rw add …')
    return 0
  }

  const repo = Repo.open(process.cwd())
  switch (command) {
    case '_lane':
      await runLane(repo, need(args.positional[1], 'the lane key'))
      return 0
    case 'status': {
      if (has(args, 'json')) print(JSON.stringify({ packet: ops.next(repo), state: repo.state() }, null, 2))
      else print(ops.status(repo))
      return 0
    }
    case 'next':
      print(JSON.stringify(ops.next(repo), null, 2))
      return 0
    case 'add': {
      const id = ops.add(repo, newTask(args))
      print(`${id} queued (${repo.taskRel(id)}). Edit its body before dispatch if the goal needs more than the title.`)
      return 0
    }
    case 'propose': {
      const result = ops.propose(repo, { ...newTask(args), rule: need(one(args, 'rule'), '--rule') })
      print(`${result.id} ${result.outcome}: ${result.reason}`)
      return 0
    }
    case 'approve':
      print(`approved: ${ops.approve(repo, ids(args)).join(', ')}`)
      return 0
    case 'reject':
      ops.reject(repo, ids(args)[0] as string, args.positional.slice(2).join(' ') || 'rejected by the owner')
      print('rejected')
      return 0
    case 'dispatch': {
      const id = ids(args)[0] as string
      print(launched(ops.dispatch(repo, id, {
        ...(one(args, 'executor') ? { executor: one(args, 'executor') as string } : {}),
        ...(one(args, 'model') ? { model: one(args, 'model') as string } : {}),
      }), id))
      return 0
    }
    case 'report': {
      const id = ids(args)[0] as string
      const state = one(args, 'state')
      if (state && !(REPORT_STATES as readonly string[]).includes(state)) throw new UserError(`--state is one of ${REPORT_STATES.join(', ')}`)
      const result = ops.report(repo, id, state as ReportState | undefined)
      print(`${id}: report ${result.state} recorded${result.commit ? ` at ${result.commit.slice(0, 12)}, ${result.changed.length} file(s) in scope` : ''}. Your turn is done.`)
      return 0
    }
    case 'verdict': {
      if (has(args, 'approve') === has(args, 'changes')) throw new UserError('pass exactly one of --approve or --changes')
      print(ops.verdict(repo, ids(args)[0] as string, has(args, 'approve')).outcome)
      return 0
    }
    case 'followup': {
      const id = ids(args)[0] as string
      print(launched(ops.followup(repo, id, need(args.positional.slice(2).join(' '), 'the follow-up text')), id))
      return 0
    }
    case 'answer': {
      const id = ids(args)[0] as string
      print(launched(ops.answer(repo, id, need(args.positional.slice(2).join(' '), 'the answer')), id))
      return 0
    }
    case 'hold': {
      const result = ops.hold(repo, ids(args)[0] as string, args.positional.slice(2).join(' ') || 'held by the owner')
      print(result.stopped ? 'held; its executor was stopped, the worktree is kept' : 'held')
      return 0
    }
    case 'release':
      ops.release(repo, ids(args)[0] as string)
      print('released; it is queued again and continues on its branch')
      return 0
    case 'stop': {
      const result = ops.stop(repo, ids(args)[0] as string, args.positional.slice(2).join(' ') || 'stopped by the owner')
      print(`stopped${result.worktree ? `; its worktree stays at ${result.worktree}` : ''}`)
      return 0
    }
    case 'retry':
      ops.retry(repo, ids(args)[0] as string)
      print('queued again; the next dispatch continues on the lane\'s work with a recovery note, or starts fresh from the current base if the lane has none')
      return 0
    case 'reset': {
      const result = ops.reset(repo, ids(args)[0] as string, has(args, 'force'))
      print(`queued again from the current base${result.discarded.length ? `; discarded ${result.discarded.join(' and ')}` : ''}`)
      for (const problem of result.left) print(`  left behind: ${problem} (rw clean retries)`)
      return 0
    }
    case 'clean': {
      const result = ops.clean(repo, has(args, 'force'))
      for (const item of result.removed) print(`removed ${item}`)
      for (const item of result.kept) print(`kept    ${item}`)
      if (!result.removed.length && !result.kept.length) print('nothing to clean')
      return result.kept.length ? 3 : 0
    }
    case 'merge': {
      const result = ops.merge(repo, ids(args)[0] as string)
      if (result.outcome === 'merged') {
        print(`merged ${result.commit.slice(0, 12)}; gate log ${result.log}`)
        for (const problem of result.left) print(`  left behind: ${problem} (rw clean retries)`)
      } else print(`${result.outcome}: ${result.reason}${result.log ? `\n  gate log ${result.log}` : ''}`)
      return result.outcome === 'merged' ? 0 : 3
    }
    case 'review': {
      const id = ids(args)[0] as string
      print(launched(ops.startReview(repo, id), `${id}.review`))
      return 0
    }
    case 'loop': {
      const interval = Number(one(args, 'interval') ?? '30') * 1000
      for (;;) {
        const result = pass(repo)
        for (const action of result.actions) print(`[${repo.now().slice(11, 19)}] ${action}`)
        if (has(args, 'once')) return 0
        if (result.packet.halt && !has(args, 'watch')) {
          print(`HALT — ${result.packet.haltReason}. Board: rw status`)
          return exitCode(result.packet)
        }
        await new Promise((resolve) => setTimeout(resolve, Math.max(2000, interval)))
      }
    }
    case 'watchdog': {
      const deviations = ops.watchdog(repo, { skipChecks: has(args, 'skip-checks') })
      if (has(args, 'json')) print(JSON.stringify({ deviations }, null, 2))
      else if (deviations.length === 0) print('WATCHDOG OK')
      else {
        for (const item of deviations) print(`DEVIATION ${item.check}: ${item.detail}`)
        print(`WATCHDOG DEVIATIONS=${deviations.length}`)
      }
      return deviations.length ? 1 : 0
    }
    case 'prompt': {
      const id = ids(args)[0] as string
      const lane = repo.state().lanes[id]
      if (!lane) throw new UserError(`${id} has no lane yet; rw dispatch ${id} first`)
      print(ops.workerPrompt(repo, repo.contract(id), lane))
      return 0
    }
    case 'lane': {
      const id = ids(args)[0] as string
      const state = repo.state()
      const keys = Object.keys(state.lanes).filter((key) => key === id || key === `${id}.review`)
      if (keys.length === 0) throw new UserError(`${id} has no lane`)
      for (const key of keys) {
        const lane = state.lanes[key]!
        print(JSON.stringify(lane, null, 2))
        print(`--- ${lane.log} (tail)\n${lastLines(readText(lane.log) ?? '', 25)}`)
      }
      print(`tiers for ${repo.contract(id).tier}: ${chain(repo.config, repo.contract(id).tier).map((item) => `${item.executor}${item.model ? `/${item.model}` : ''}`).join(' → ')}`)
      return 0
    }
    default:
      throw new UserError(`unknown command ${command}; see rw help`)
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    if (error instanceof UserError || (error instanceof Error && error.name === 'FrontmatterError')) {
      process.stderr.write(`rw: ${error.message}\n`)
      process.exitCode = 2
    } else {
      process.stderr.write(`rw: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
      process.exitCode = 1
    }
  },
)
