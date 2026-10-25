// A module resolve hook for plain `node` runs of scripts that import src/lib
// modules which themselves import through the Next.js `@/` alias
// (jsconfig paths). Registered by a script with
//   register('./lib/at-alias-loader.mjs', import.meta.url)
// before it dynamically imports such a module. Not used under vitest, which
// resolves the alias itself.
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { existsSync } from 'node:fs'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../src')

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const base = path.join(SRC, specifier.slice(2))
    for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')]) {
      if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context)
    }
    return nextResolve(pathToFileURL(`${base}.js`).href, context)
  }
  return nextResolve(specifier, context)
}
