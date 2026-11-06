/**
 * A strict, tiny frontmatter dialect: the YAML subset agents write without thinking about it.
 *
 *   ---
 *   key: plain text to the end of the line
 *   quoted: "JSON string, escapes allowed"
 *   inline: [a, b, "c, d"]
 *   block:
 *     - first
 *     - second
 *   ---
 *   body
 *
 * Every value is a string or a list of strings. Anything else fails loudly with the line number, so a
 * malformed contract never parses into a silently different one.
 */

export type Value = string | readonly string[]
export type Fields = Readonly<Record<string, Value>>

export interface Document {
  readonly fields: Fields
  readonly body: string
}

export class FrontmatterError extends Error {
  readonly line: number
  constructor(line: number, message: string) {
    super(`frontmatter line ${line}: ${message}`)
    this.line = line
    this.name = 'FrontmatterError'
  }
}

const KEY = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*))?$/

function unquote(raw: string, line: number): string {
  const text = raw.trim()
  if (text.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(text)
      if (typeof value === 'string') return value
    } catch {
      // fall through to the error below
    }
    throw new FrontmatterError(line, `bad quoted string ${text}`)
  }
  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'")) throw new FrontmatterError(line, `bad quoted string ${text}`)
    return text.slice(1, -1).replaceAll("''", "'")
  }
  return text
}

function inlineList(raw: string, line: number): string[] {
  const inner = raw.trim().slice(1, -1)
  const items: string[] = []
  let current = ''
  let quote: string | null = null
  let braces = 0
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string
    if (quote) {
      current += ch
      if (ch === '\\' && quote === '"') {
        current += inner[++i] ?? ''
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '{') braces++
    else if (ch === '}') braces = Math.max(0, braces - 1)
    // a comma inside a {a,b} glob belongs to the item
    if (ch === ',' && braces === 0) {
      items.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (quote) throw new FrontmatterError(line, 'unterminated quote in list')
  items.push(current)
  const values = items.map((item) => unquote(item, line))
  if (values.length === 1 && values[0] === '') return []
  if (values.some((value) => value === '')) throw new FrontmatterError(line, 'empty list item')
  return values
}

/** Parse a document. A file without frontmatter fails: every rw document has a contract block. */
export function parse(text: string): Document {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  if (lines[0]?.trim() !== '---') throw new FrontmatterError(1, 'document must start with ---')
  const fields: Record<string, Value> = {}
  let index = 1
  let openList: { key: string; items: string[] } | null = null
  for (; index < lines.length; index++) {
    const raw = lines[index] as string
    const lineNo = index + 1
    if (raw.trim() === '---') break
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue
    const item = /^\s+-\s+(.*)$/.exec(raw)
    if (item) {
      if (!openList) throw new FrontmatterError(lineNo, 'list item without a key')
      const value = unquote(item[1] as string, lineNo)
      if (value === '') throw new FrontmatterError(lineNo, 'empty list item')
      openList.items.push(value)
      continue
    }
    if (/^\s/.test(raw)) throw new FrontmatterError(lineNo, 'unexpected indentation')
    const match = KEY.exec(raw)
    if (!match) throw new FrontmatterError(lineNo, `expected "key: value", got ${JSON.stringify(raw)}`)
    const key = match[1] as string
    if (key in fields) throw new FrontmatterError(lineNo, `duplicate key ${key}`)
    const rest = (match[2] ?? '').trim()
    openList = null
    if (rest === '') {
      const list = { key, items: [] as string[] }
      fields[key] = list.items
      openList = list
    } else if (rest.startsWith('[')) {
      if (!rest.endsWith(']')) throw new FrontmatterError(lineNo, `unterminated list for ${key}`)
      fields[key] = inlineList(rest, lineNo)
    } else {
      fields[key] = unquote(rest, lineNo)
    }
  }
  if (index >= lines.length) throw new FrontmatterError(index, 'frontmatter is not closed with ---')
  const body = lines.slice(index + 1).join('\n')
  return { fields, body: body.replace(/^\n+/, '') }
}

function needsQuote(value: string): boolean {
  return value === '' || /^[\s"'[#-]|\s$|[\n\r]/.test(value) || value.includes(': ') || value.includes(' #')
}

function scalar(value: string): string {
  return needsQuote(value) ? JSON.stringify(value) : value
}

function listItem(value: string): string {
  return needsQuote(value) || /[,\]]/.test(value) ? JSON.stringify(value) : value
}

/** Serialize in the given key order; lists are written inline so diffs stay one line per field. */
export function stringify(fields: Fields, body: string, order: readonly string[] = Object.keys(fields)): string {
  const keys = [...order.filter((key) => key in fields), ...Object.keys(fields).filter((key) => !order.includes(key))]
  const lines = ['---']
  for (const key of keys) {
    const value = fields[key] as Value
    lines.push(typeof value === 'string' ? `${key}: ${scalar(value)}` : `${key}: [${value.map(listItem).join(', ')}]`)
  }
  lines.push('---', '')
  return `${lines.join('\n')}${body.trim()}\n`
}

export function str(fields: Fields, key: string): string | undefined {
  const value = fields[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new FrontmatterError(0, `${key} must be a single value, not a list`)
  return value
}

export function list(fields: Fields, key: string): readonly string[] {
  const value = fields[key]
  if (value === undefined) return []
  if (typeof value === 'string') return value === '' || value === '—' || value === '-' ? [] : [value]
  return value
}
