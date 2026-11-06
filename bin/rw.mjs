#!/usr/bin/env node
// Runs the TypeScript source directly on Node >= 22.18 (type stripping) or Bun; falls back to the
// built lib/ when the source cannot be loaded (for example from inside node_modules, where Node does not
// strip types).
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const built = join(root, 'lib', 'src', 'cli.js')
const source = join(root, 'src', 'cli.ts')
const insideNodeModules = root.split(/[\\/]/).includes('node_modules')
await import(pathToFileURL(insideNodeModules && existsSync(built) ? built : source).href)
