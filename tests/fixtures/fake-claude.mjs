// Stands in for the Claude Code CLI in the end-to-end tests: it accepts the flags rw's claude adapter
// passes, speaks stream-json with a session_id the way `claude -p --output-format stream-json` does, and
// then does the scripted work of fake-worker.mjs. A resume must name the session the start was given.
import { appendFileSync, readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const value = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}
for (const required of ['-p', '--output-format', '--verbose', '--permission-mode']) {
  if (!argv.includes(required)) {
    console.error(`fake-claude: missing ${required} in ${argv.join(' ')}`)
    process.exit(2)
  }
}
const started = value('--session-id')
const resumed = value('--resume')
const session = resumed ?? started
if (!session || (started && resumed)) {
  console.error('fake-claude: exactly one of --session-id or --resume is required')
  process.exit(2)
}
// record every invocation so the test can check the flags across runs
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ started, resumed, model: value('--model') ?? '' })}\n`)
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: session }))
// Like the real CLI, keep the turn open for a moment after the worker's last command (a model writes its
// closing message after `rw report`): this is the window in which rw must already know the session.
const exit = process.exit.bind(process)
process.exit = (code) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500)
  exit(code)
}
// the final stream-json event; registered first, because the scripted worker may exit while it loads
process.on('exit', () => {
  process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', session_id: session, total_cost_usd: 0.001 })}\n`)
})
// hand over to the scripted worker as if it were the model; it reads the prompt from stdin
process.argv = [process.argv[0], process.argv[1], resumed ? 'resume' : 'start', session]
await import('./fake-worker.mjs')
