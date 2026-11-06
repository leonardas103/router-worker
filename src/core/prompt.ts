/**
 * Lane prompts are composed by code from ids and paths: the router never paraphrases a task into a
 * work plan. Templates live in `prompts/`; a repository appends its team text from `.rw/prompts/<name>.md`.
 */

export type Vars = Readonly<Record<string, string>>

/** Fill `{name}` placeholders; an unknown placeholder fails, so a renamed variable cannot ship a blank. */
export function fill(template: string, vars: Vars): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (whole, name: string) => {
    if (!(name in vars)) throw new Error(`prompt template uses {${name}}, which rw does not provide`)
    return vars[name] as string
  })
}

export function bullets(items: readonly string[], code = true): string {
  return items.map((item) => (code ? `- \`${item}\`` : `- ${item}`)).join('\n')
}

export function teamSection(text: string | undefined): string {
  const body = text?.replace(/<!--[\s\S]*?-->/g, '').trim()
  return body ? `\n## Team instructions\n\n${body}\n` : ''
}
