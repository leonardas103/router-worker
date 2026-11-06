// A scripted executor for the end-to-end tests. It reads its task from RW_TASK and behaves by the
// task title: "ok" delivers, "stray" writes outside scope, "ask" blocks once then delivers on the
// answer, "silent" exits without reporting, "quota" fails like a capacity limit, "redgate" passes its
// own check but fails the merge gate until a follow-up arrives.
import { execFileSync, execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

const task = process.env.RW_TASK
const mode = process.argv[2] ?? 'start'
const prompt = readFileSync(0, 'utf8')
const contract = readFileSync(`work/tasks/${task}.md`, 'utf8')
const title = /^title: (.*)$/m.exec(contract)?.[1] ?? ''
const session = process.argv[3] || randomUUID()
console.log(JSON.stringify({ conversationId: session, mode, task }))

const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
const commit = (message) => { execSync('git add -A', { stdio: 'ignore' }); execSync(`git commit -q -m "${message}"`, { stdio: 'ignore' }) }
const accept = (/^accept: \[(.*)\]$/m.exec(contract)?.[1] ?? 'node check.mjs').split(', ').map((cmd) => cmd.replace(/^"|"$/g, ''))
const report = (state, question = '') => {
  const rows = accept.map((cmd) => `| \`${cmd}\` | PASS |`).join('\n')
  write(`work/reports/${task}.md`, `---\ntask: ${task}\nstate: ${state}\nquestion: ${JSON.stringify(question)}\n---\n## Summary\n\nfake ${state} for ${title}\n\n## Commands\n\n| Command | Result |\n| --- | --- |\n${rows}\n`)
}
const rw = (...args) => {
  try { console.log(execFileSync('rw', args, { encoding: 'utf8', shell: process.platform === 'win32' })) }
  catch (error) { console.log(String(error.stdout ?? ''), String(error.stderr ?? '')); process.exitCode = 0 }
}

if (process.env.RW_ROLE === 'reviewer') {
  const reviewFile = /Write your review to `([^`]+)`/.exec(prompt)?.[1]
  const round = Number(/Round (\d+) of/.exec(prompt)?.[1] ?? '1')
  const changes = title.includes('picky') && round === 1
  write(reviewFile, `## Verdict\n\n${changes ? 'changes' : 'approve'}\n\n## Findings\n\n${changes ? '1. `src/x:1` say please → add please' : 'none'}\n`)
  rw('verdict', task, changes ? '--changes' : '--approve')
  process.exit(0)
}
if (title.includes('quota') && process.env.FAKE_EXECUTOR !== 'second') {
  console.log('Error: usage limit reached, quota exhausted')
  process.exit(1)
}
if (title.includes('silent')) process.exit(0)
if (title.includes('slow')) {
  // a long-running executor: hold/stop must end it, not just its supervisor
  write(`../${task}.pid`, String(process.pid))
  await new Promise((resolve) => setTimeout(resolve, 60_000))
  process.exit(0)
}

if (title.includes('needsprep') && !(existsSync('.env.local') && existsSync('prepared.txt'))) {
  console.log('worktree was not prepared')
  process.exit(0)
}
const file = title.includes('shared') ? 'src/shared.txt' : `src/${task}.txt`
if (/\bask\b/.test(title) && !prompt.includes("owner's answer")) {
  report('blocked', 'Should the greeting say hello or hi?')
  rw('report', task, '--state', 'blocked')
  process.exit(0)
}
const answer = /The owner's answer: (.*)/.exec(prompt)?.[1]
const fixed = prompt.includes('Follow-up for') && title.includes('redgate')
if (title.includes('greet()')) {
  // the smoke-test task (scripts/smoke.mjs --executor fake)
  const word = /"(\w+)"/.exec(answer ?? '')?.[1] ?? 'Hello'
  write('src/greet.mjs', `export const greet = (name) => \`${word}, \${name}!\`\n`)
  report('ready')
  commit(`${task}: greet`)
  rw('report', task, '--state', 'ready')
  process.exit(0)
}
const please = prompt.includes('say please') ? 'please\n' : ''
write(file, `${title}\n${answer ?? ''}\n${title.includes('redgate') && !fixed ? 'RED' : 'GREEN'}\n${please}`)
if (title.includes('stray')) write('outside.txt', 'not mine\n')
if (title.includes('symlink')) execSync(`ln -s ../../README.md src/${task}.link`)
report('ready')
commit(`${task}: ${title}`)
rw('report', task, '--state', 'ready')
