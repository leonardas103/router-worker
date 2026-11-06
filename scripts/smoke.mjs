#!/usr/bin/env node
// Live smoke test of a real executor: one small task in a throwaway repository, built to make the worker
// ask one question, so it exercises dispatch → blocked → rw answer → resume in the same session →
// report → gated fast-forward merge.
//
//   npm run smoke:claude                       # Claude Code (`claude` on PATH, logged in), haiku
//   node scripts/smoke.mjs --model sonnet      # another model alias or name
//   node scripts/smoke.mjs --executor fake     # self-test with the scripted test worker, no model
//   node scripts/smoke.mjs --keep              # keep the throwaway repository to inspect
//
// It never touches a real repository: everything happens under the OS temp directory.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'src', 'cli.ts')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const executor = flag('executor', 'claude')
const model = flag('model', 'haiku')
const keep = args.includes('--keep')
const minutes = Number(flag('minutes', '15'))

const dir = mkdtempSync(join(tmpdir(), 'rw-smoke-'))
const repo = join(dir, 'smoke')
const started = Date.now()
const log = (text) => console.log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s] ${text}`)

function run(command, argv, cwd = repo, quiet = false) {
  const result = spawnSync(command, argv, { cwd, encoding: 'utf8', shell: false, windowsHide: true })
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (!quiet && result.status !== 0) throw new Error(`${command} ${argv.join(' ')} failed (${result.status}):\n${out}`)
  return { code: result.status ?? -1, out }
}
const rw = (...argv) => run(process.execPath, [CLI, ...argv], repo, true)
const state = () => JSON.parse(readFileSync(join(repo, '.rw', 'state', 'state.json'), 'utf8'))
const task = () => state().tasks['TASK-001'] ?? {}
const lane = () => state().lanes['TASK-001'] ?? {}

async function until(what, predicate) {
  const deadline = Date.now() + minutes * 60_000
  let last = ''
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${minutes} min waiting for ${what}; task is ${task().state}: ${task().note ?? ''}`)
    const pass = rw('loop', '--once')
    const line = pass.out.trim()
    if (line && line !== last) log(line.split('\n').join(' | '))
    last = line
    if (task().state === 'failed') throw new Error(`the task failed: ${task().note ?? ''}`)
    await new Promise((r) => setTimeout(r, 3000))
  }
}

function setup() {
  run('git', ['init', '-q', '-b', 'main', repo], dir)
  run('git', ['config', 'user.email', 'smoke@router-worker.invalid'])
  run('git', ['config', 'user.name', 'rw smoke'])
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(repo, 'test'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), '{ "name": "smoke", "private": true, "type": "module" }\n')
  writeFileSync(join(repo, 'README.md'), '# smoke\n\nA throwaway repository for an rw executor smoke test.\n')
  writeFileSync(join(repo, 'test', 'greet.test.mjs'), [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { greet } from '../src/greet.mjs'",
    "test('greet names the person', () => assert.match(greet('Ada'), /Ada/))",
    '',
  ].join('\n'))
  run('git', ['add', '-A'])
  run('git', ['commit', '-q', '-m', 'smoke: initial'])
  const init = rw('init', '--host', 'claude')
  if (init.code !== 0) throw new Error(init.out)
  const fake = join(ROOT, 'tests', 'fixtures', 'fake-worker.mjs')
  const config = {
    base: 'main',
    worktreeRoot: join(dir, 'worktrees'),
    limits: { lanes: 1, staleMinutes: 10 },
    tiers: { build: [executor === 'fake' ? 'fake' : `claude:${model}`] },
    executors: executor === 'fake'
      ? { fake: { kind: 'command', start: ['node', fake, 'start'], resume: ['node', fake, 'resume', '{session}'], stdin: true, sessionPattern: '"conversationId":"([0-9a-f-]{36})"' } }
      : { claude: { kind: 'claude', models: { [model]: model } } },
  }
  writeFileSync(join(repo, '.rw', 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
  run('git', ['add', '-A'])
  run('git', ['commit', '-q', '-m', 'smoke: rw init'])
}

async function main() {
  log(`throwaway repository: ${repo}`)
  log(`executor: ${executor}${executor === 'fake' ? '' : ` (model ${model})`}`)
  setup()
  const goal = [
    'Create src/greet.mjs exporting greet(name), which returns a greeting that includes the name, so that `node --test` passes.',
    'The greeting word is a product decision that is NOT settled: before writing the file, report blocked and ask the owner which word to use.',
    "When the owner answers, use exactly their word, e.g. greet('Ada') returns '<word>, Ada!'.",
  ].join(' ')
  // "ask" in the title is what the scripted fake worker keys on; a real model follows the goal
  const added = rw('add', 'Add greet(), ask the greeting word', '--scope', 'src/greet.mjs', '--accept', 'node --test',
    '--goal', goal, '--authority', 'rw smoke test')
  if (added.code !== 0) throw new Error(added.out)
  log('TASK-001 added; dispatching')

  await until('the worker to ask its question', () => task().state === 'blocked' || task().state === 'review' || task().state === 'done')
  const asked = task().state === 'blocked'
  const firstSession = lane().session
  if (asked) log(`asked: ${task().question}`)
  else log(`WARNING: the worker did not ask (state ${task().state}); resume is not exercised`)
  if (asked) {
    const answer = rw('answer', 'TASK-001', 'Use the word "Howdy".')
    if (answer.code !== 0) throw new Error(answer.out)
    log('answered "Howdy"; the same session should continue')
  }
  await until('the merge', () => task().state === 'done')

  const merged = run('git', ['show', 'main:src/greet.mjs']).out
  const report = run('git', ['show', 'main:work/reports/TASK-001.md']).out
  const events = readFileSync(join(repo, '.rw', 'state', 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const exits = events.filter((event) => event.type === 'lane-exit')
  const cost = exits.reduce((sum, event) => sum + (event.costUsd ?? 0), 0)
  const laneLog = readFileSync(join(repo, '.rw', 'state', 'lanes', 'TASK-001.log'), 'utf8')
  const resumed = laneLog.includes(' resume ')
  const sessions = new Set([...laneLog.matchAll(/"(?:session_id|conversationId)"\s*:\s*"([0-9a-f-]{36})"/g)].map((match) => match[1]))
  const checks = [
    ['the worker asked a question (blocked report)', asked],
    ['the session id was recorded when it asked', !asked || Boolean(firstSession)],
    ['the answer resumed that session (one session id in the whole lane log)', !asked || (resumed && sessions.size === 1 && sessions.has(firstSession))],
    ['main has src/greet.mjs', merged.includes('greet')],
    ["the merged code uses the owner's word", !asked || /howdy/i.test(merged)],
    ['the report merged with the work', /state: ready/.test(report)],
    ['main\'s test passes', run('node', ['--test'], repo, true).code === 0],
  ]
  console.log('')
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  console.log(`\nexecutor runs: ${exits.length}${cost ? `, cost $${cost.toFixed(4)}` : ''}, ${Math.round((Date.now() - started) / 1000)}s`)
  const failed = checks.filter(([, ok]) => !ok).length
  console.log(failed ? `SMOKE FAILED (${failed})` : 'SMOKE OK')
  return failed ? 1 : 0
}

main().then((code) => {
  if (!keep) rmSync(dir, { recursive: true, force: true })
  else console.log(`kept: ${repo}`)
  process.exitCode = code
}, (error) => {
  console.error(`\nSMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`)
  console.error(`kept for inspection: ${repo} (lane log: .rw/state/lanes/TASK-001.log)`)
  process.exitCode = 1
})
