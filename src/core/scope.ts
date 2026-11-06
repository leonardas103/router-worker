/**
 * Write scopes: repository-relative globs.
 *
 *   src/app/**      every file below src/app
 *   src/app/        the same (a trailing slash means the directory)
 *   src/app         the file src/app, or everything below a directory of that name
 *   src/*.ts        files directly in src ending in .ts
 *   docs/**\/*.md    markdown anywhere below docs
 *   src/{a,b}.ts    src/a.ts or src/b.ts (braces expand first, and may nest)
 *
 * Matching is case-sensitive and uses forward slashes; Windows paths are normalised first.
 */

export function normalisePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/')
}

function hasWildcard(segment: string): boolean {
  return /[*?[]/.test(segment)
}

function segmentRegex(segment: string): RegExp {
  let source = ''
  for (const ch of segment) {
    if (ch === '*') source += '[^/]*'
    else if (ch === '?') source += '[^/]'
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

const MAX_ALTERNATIVES = 64

/** Why a pattern cannot be used, or undefined: unbalanced braces, or more alternatives than anyone means. */
export function patternProblem(pattern: string): string | undefined {
  let depth = 0
  for (const ch of pattern) {
    if (ch === '{') depth++
    else if (ch === '}' && --depth < 0) return `unbalanced } in ${pattern}`
  }
  if (depth !== 0) return `unbalanced { in ${pattern}`
  if (braceExpand(pattern).length > MAX_ALTERNATIVES) return `${pattern} expands to more than ${MAX_ALTERNATIVES} patterns`
  return undefined
}

/** `src/{a,b/{c,d}}.ts` → src/a.ts, src/b/c.ts, src/b/d.ts. Commas split only at the group's own level. */
export function braceExpand(pattern: string): string[] {
  const open = pattern.indexOf('{')
  if (open < 0) return [pattern]
  let depth = 0
  const parts: string[] = []
  let start = open + 1
  for (let i = open; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        parts.push(pattern.slice(start, i))
        const before = pattern.slice(0, open)
        const after = pattern.slice(i + 1)
        const out: string[] = []
        for (const part of parts) {
          for (const tail of braceExpand(after)) out.push(...braceExpand(before + part + tail))
          if (out.length > MAX_ALTERNATIVES) return out
        }
        return out
      }
    } else if (ch === ',' && depth === 1) {
      parts.push(pattern.slice(start, i))
      start = i + 1
    }
  }
  return [pattern] // unbalanced: matched literally, and patternProblem reports it
}

function expand(pattern: string): string[] {
  const clean = normalisePath(pattern.trim())
  if (clean.endsWith('/')) return [...clean.slice(0, -1).split('/'), '**']
  return clean.split('/')
}

function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
  if (pattern.length === 0) return path.length === 0
  const [head, ...rest] = pattern as [string, ...string[]]
  if (head === '**') {
    for (let skip = 0; skip <= path.length; skip++) if (matchSegments(rest, path.slice(skip))) return true
    return false
  }
  if (path.length === 0) return false
  if (!segmentRegex(head).test(path[0] as string)) return false
  return matchSegments(rest, path.slice(1))
}

export function matches(pattern: string, path: string): boolean {
  return braceExpand(pattern).some((alternative) => matchOne(alternative, path))
}

function matchOne(pattern: string, path: string): boolean {
  const segments = expand(pattern)
  const target = normalisePath(path).split('/')
  // git never reports these, but a path that could climb out of a directory must never count as inside it
  if (target.some((segment) => segment === '..' || segment === '.' || segment === '') || /^[A-Za-z]:/.test(path) || path.startsWith('/')) return false
  if (!segments.some(hasWildcard)) {
    // A plain path names a file or everything below a directory of that name.
    return target.length >= segments.length && segments.every((segment, i) => segment === target[i])
  }
  return matchSegments(segments, target)
}

export function inScope(scope: readonly string[], path: string): boolean {
  return scope.some((pattern) => matches(pattern, path))
}

/** Files outside the scope. `always` names paths every task may write, such as its own report. */
export function outside(scope: readonly string[], paths: readonly string[], always: readonly string[] = []): string[] {
  return paths.filter((path) => !always.includes(normalisePath(path)) && !inScope(scope, path))
}

function staticPrefix(pattern: string): string[] {
  const segments = expand(pattern)
  const index = segments.findIndex(hasWildcard)
  return index < 0 ? segments : segments.slice(0, index)
}

/**
 * Whether two patterns may name a common file. Conservative: when both have wildcards, they overlap
 * unless their literal prefixes diverge. Two lanes never share a write scope, so a false "overlap" only
 * serialises work; a false "no overlap" would let two writers collide.
 */
export function patternsOverlap(a: string, b: string): boolean {
  return braceExpand(a).some((x) => braceExpand(b).some((y) => overlapOne(x, y)))
}

function overlapOne(a: string, b: string): boolean {
  const aWild = expand(a).some(hasWildcard)
  const bWild = expand(b).some(hasWildcard)
  if (!aWild && !bWild) {
    const x = expand(a), y = expand(b)
    const n = Math.min(x.length, y.length)
    return x.slice(0, n).every((segment, i) => segment === y[i])
  }
  return prefixRelated(a, b)
}

function prefixRelated(a: string, b: string): boolean {
  const x = staticPrefix(a), y = staticPrefix(b)
  const n = Math.min(x.length, y.length)
  return x.slice(0, n).every((segment, i) => segment === y[i])
}

export function scopesOverlap(a: readonly string[], b: readonly string[]): string | undefined {
  for (const x of a) for (const y of b) if (patternsOverlap(x, y)) return `${x} ∩ ${y}`
  return undefined
}
