/** The git operations rw needs, and nothing else. Every call is explicit about its working directory. */
import { existsSync, rmSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { runArgv, type Run } from './proc.ts'

export class GitError extends Error {
  readonly args: readonly string[]
  readonly out: string
  constructor(args: readonly string[], out: string) {
    super(`git ${args.join(' ')} failed: ${out.trim().split('\n').slice(-3).join(' / ')}`)
    this.args = args
    this.out = out
    this.name = 'GitError'
  }
}

export function git(cwd: string, args: readonly string[], input?: string): Run {
  return runArgv(['git', ...args], cwd, input, { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' })
}

export function gitOk(cwd: string, args: readonly string[]): string {
  const result = git(cwd, args)
  if (!result.ok) throw new GitError(args, result.out)
  // NUL-separated output is kept raw: trimming could cut a path that starts or ends with a space
  return args.includes('-z') ? result.stdout : result.stdout.trim()
}

/** The main worktree of the repository `cwd` belongs to, even when `cwd` is a lane worktree. */
export function mainRoot(cwd: string): string {
  const common = gitOk(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const dir = resolve(common)
  return basename(dir) === '.git' ? dirname(dir) : resolve(gitOk(cwd, ['rev-parse', '--show-toplevel']))
}

export function head(cwd: string, ref = 'HEAD'): string {
  return gitOk(cwd, ['rev-parse', ref])
}

export function currentBranch(cwd: string): string {
  return gitOk(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
}

/** Tracked changes only: an untracked scratch file does not stop a fast-forward. */
export function trackedChanges(cwd: string): string[] {
  return lines(gitOk(cwd, ['status', '--porcelain', '--untracked-files=no']))
}

/** Every change, untracked included: a worker must commit its work. Paths are raw (NUL-separated, never C-quoted). */
export function allChanges(cwd: string): string[] {
  const out = gitOk(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'])
  const paths: string[] = []
  const records = out.split('\0')
  for (let i = 0; i < records.length; i++) {
    const record = records[i] as string
    if (record.length < 4) continue
    paths.push(record.slice(3))
    // a rename or copy is followed by its source path
    if (record[0] === 'R' || record[0] === 'C') i++
  }
  return paths
}

export function mergeBase(cwd: string, a: string, b: string): string {
  return gitOk(cwd, ['merge-base', a, b])
}

/** Files changed between two commits, as git stores them: NUL-separated, so no path is ever C-quoted. */
export function changedFiles(cwd: string, from: string, to = 'HEAD'): string[] {
  return gitOk(cwd, ['diff', '--name-only', '--no-renames', '-z', `${from}..${to}`]).split('\0').filter(Boolean)
}

/** Paths that are symbolic links after the change: a link inside the scope can point outside it. */
export function symlinksChanged(cwd: string, from: string, to = 'HEAD'): string[] {
  const fields = gitOk(cwd, ['diff', '--raw', '--no-renames', '-z', `${from}..${to}`]).split('\0')
  const links: string[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = (fields[i] as string).split(' ')
    if (meta[1] === '120000') links.push(fields[i + 1] as string)
  }
  return links
}

export function commitsBetween(cwd: string, from: string, to = 'HEAD'): number {
  return Number(gitOk(cwd, ['rev-list', '--count', `${from}..${to}`]))
}

export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]).ok
}

export function worktreeAdd(root: string, path: string, branch: string, base: string): void {
  gitOk(root, ['worktree', 'add', '-b', branch, path, base])
}

/**
 * Remove a lane worktree and never get stuck. On Windows a plain `git worktree remove` can delete the
 * worktree's .git link and then fail inside node_modules (a long path, a file still locked), after which git
 * no longer recognises the folder at all. So: one forced remove, then delete whatever is left with Node
 * (which handles long paths and read-only files, and retries locked ones), then prune git's record.
 * Returns why something could not be removed, or undefined.
 */
export function removeWorktree(root: string, path: string): string | undefined {
  git(root, ['worktree', 'remove', '--force', path])
  let problem: string | undefined
  if (existsSync(path)) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    } catch (error) {
      problem = `could not delete ${path}: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  git(root, ['worktree', 'prune'])
  return problem
}

/** Branches under `prefix`, such as rw/. */
export function branchesWithPrefix(root: string, prefix: string): string[] {
  return gitOk(root, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`]).split('\n').map((line) => line.trim()).filter(Boolean)
}

export function branchExists(root: string, branch: string): boolean {
  return git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok
}

export function deleteBranch(root: string, branch: string, force = false): boolean {
  return git(root, ['branch', force ? '-D' : '-d', branch]).ok
}

/** Bring `ref` into the current branch of `cwd`; on a conflict the merge is aborted and the files listed. */
export function mergeIn(cwd: string, ref: string): { ok: true } | { ok: false; conflicts: string[]; out: string } {
  const result = git(cwd, ['merge', '--no-edit', ref])
  if (result.ok) return { ok: true }
  const conflicts = lines(git(cwd, ['diff', '--name-only', '--diff-filter=U']).stdout)
  git(cwd, ['merge', '--abort'])
  return { ok: false, conflicts, out: result.out }
}

export function fastForward(root: string, ref: string): Run {
  return git(root, ['merge', '--ff-only', ref])
}

export function tracked(root: string, path: string): boolean {
  return git(root, ['ls-files', '--error-unmatch', '--', path]).ok
}

export function changedSinceHead(root: string, path: string): boolean {
  return !git(root, ['diff', '--quiet', 'HEAD', '--', path]).ok
}

/** Commit exactly `paths`, leaving anything else the owner has staged or changed alone. */
export function commitPaths(root: string, paths: readonly string[], message: string): void {
  gitOk(root, ['add', '--', ...paths])
  gitOk(root, ['commit', '--quiet', '-m', message, '--only', '--', ...paths])
}

export function showFile(cwd: string, ref: string, path: string): string | undefined {
  const result = git(cwd, ['show', `${ref}:${path.replaceAll('\\', '/')}`])
  return result.ok ? result.stdout : undefined
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean)
}
