// HOTFIX (9 Nov 2026) — a Server Component may not hand a FUNCTION to a
// Client Component: React refuses to serialise it and the whole page dies at
// render ("Functions cannot be passed directly to Client Components").
//
// Live: /host/events/[id] crashed for every host from the HOSTSERIES.1
// deploy (8 Nov) until this fix, because the page passed
// `editHrefFor={(id) => …}` to DuplicateEventButton ('use client'). Nothing
// caught it: the page's test stubs its child components, vitest never runs
// the RSC serialiser, and `next build` does not render a dynamic page.
//
// This guard reads every app entry file that is a Server Component (page /
// layout / template / default / not-found with no 'use client' directive)
// and fails when a JSX attribute holds an inline function AND the element is
// imported from a module that IS a client component. A function handed to a
// local or server component is fine and is not flagged.
//
// Blind spots (a floor, not proof): a function passed through a variable or
// a spread, a client component reached through a re-export barrel, and
// server components outside the app entry files.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { stripComments, isClientFile } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const APP = path.join(ROOT, 'src/app')
const ENTRY = /^(page|layout|template|default|not-found)\.jsx?$/

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (ENTRY.test(name)) out.push(full)
  }
  return out
}

// Comments are blanked with the repo's parser-based helper (never a regex:
// tests/comment-strip-meta-guard.test.js), which also answers "is this a
// client module?" from the directive, wherever a header comment puts it.
const isClientModule = (source) => isClientFile(source)

function resolveImport(fromFile, spec) {
  let base
  if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec)
  else return null
  for (const cand of [base, `${base}.jsx`, `${base}.js`, path.join(base, 'index.jsx'), path.join(base, 'index.js')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return null
}

/** Local name → resolved file, for default and named imports. */
function importsOf(file, source) {
  const map = new Map()
  const re = /import\s+([^;'"]+?)\s+from\s+['"]([^'"]+)['"]/g
  for (let m; (m = re.exec(source));) {
    const target = resolveImport(file, m[2])
    if (!target) continue
    const clause = m[1]
    const def = /^([A-Za-z_$][\w$]*)/.exec(clause.trim())
    if (def && !clause.trim().startsWith('{')) map.set(def[1], target)
    const named = /\{([^}]*)\}/.exec(clause)
    if (named) for (const part of named[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()
      if (name) map.set(name, target)
    }
  }
  return map
}

const FUNCTION_ATTR = /([A-Za-z_$][\w$]*)=\{\s*(?:async\s+)?(?:(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|function\b)/g

/** Every `<ClientComponent attr={fn}>` in one server entry file. */
export function functionPropsToClient(file, rawSource) {
  if (isClientModule(rawSource)) return []
  // Same length and line numbers as the raw text, comments blanked: a
  // commented-out attribute is not a finding.
  const source = stripComments(rawSource, file)
  const imports = importsOf(file, source)
  const out = []
  for (let m; (m = FUNCTION_ATTR.exec(source));) {
    let tag = null
    const before = source.slice(0, m.index)
    for (let t, re = /<([A-Z][\w$]*)\b/g; (t = re.exec(before));) tag = t[1]
    const target = tag && imports.get(tag)
    if (!target) continue
    if (!isClientModule(readFileSync(target, 'utf8'))) continue
    const line = before.split('\n').length
    out.push(`${path.relative(ROOT, file)}:${line}: <${tag} ${m[1]}={function}>`)
  }
  return out
}

describe('server → client function props', () => {
  it('no Server Component entry file hands a function to a Client Component', () => {
    const problems = walk(APP).flatMap((f) => functionPropsToClient(f, readFileSync(f, 'utf8')))
    expect(problems, 'a function cannot cross the server→client boundary: pass a string/number/plain object (a URL template, an id) and let the client build the value').toEqual([])
  })
  it('is not vacuous: it sees the directive below a header comment, and flags a real crossing', () => {
    expect(isClientModule("// header\n/* block */\n\n'use client'\nexport default function X() {}")).toBe(true)
    expect(isClientModule("import x from 'y'\n'use client'")).toBe(false)
    const page = path.join(APP, '__probe__/page.js')
    const src = "import DuplicateEventButton from '@/components/DuplicateEventButton'\nexport default function P() { return <DuplicateEventButton apiUrl=\"/x\" onDone={(id) => id} /> }"
    expect(functionPropsToClient(page, src)).toEqual(['src/app/__probe__/page.js:2: <DuplicateEventButton onDone={function}>'])
    // a function handed to a LOCAL (server) component is fine
    expect(functionPropsToClient(page, "function Cell() { return null }\nexport default function P() { return <Cell format={(n) => n} /> }")).toEqual([])
  })
})
