// D1 DEADCODE.1 — code the scheduler waves left with no callers, deleted.
// Each name below lost its last caller to an earlier PR; the plan
// (docs/superpowers/plans/2026-09-27-followups/D1-DEADCODE.1.md) says which.
// A revived copy would bring back a rule the codebase has since replaced: a
// zero-only staffing count that calls an admin shift a gap, a client-side
// clash check that sees one studio, a route nothing asks.
//
// A source scan, so a FLOOR not proof: it cannot see a name built at runtime.
// supabase/ (applied migrations are forward-only and keep their comments) and
// docs/ (history) are not scanned. The deleted role-recipients helper has its
// own guard, tests/role-recipients-callers.test.js.
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCAN = ['src', 'shared', 'mobile', 'scripts', 'tests']
const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'dist', 'build'])
const SOURCE = /\.(js|jsx|mjs)$/
const SELF = 'tests/dead-code-callers.test.js'
// The tree is read once, at collection (~4,400 files); each test only matches.
const SCAN_TIMEOUT_MS = 30_000

// name -> the files (besides this one) still allowed to name it.
const GONE = {
  coachConflictsForBlock: [],
  isBlockUnstaffedFuture: [],
  fetchUnstaffedBlocksThisWeek: [],
  // Two negative assertions stay: the web's proof that it never asks the old
  // route, and the API reference's proof that it no longer documents it.
  '/api/schedule/working-time': [
    'src/components/ScheduleCalendar.candidates.test.jsx',
    'src/lib/openapi.test.js',
  ],
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (SOURCE.test(entry.name)) out.push(full)
  }
  return out
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
// An identifier matches as a whole word; a URL path matches as a substring.
const patternFor = (name) => new RegExp(/^\w+$/.test(name) ? `\\b${name}\\b` : escapeRe(name))

// name -> the repo-relative paths whose source names it. Only paths are kept,
// never the text.
const HITS = (() => {
  const names = Object.keys(GONE)
  const patterns = names.map((name) => [name, patternFor(name)])
  const hits = Object.fromEntries(names.map((name) => [name, []]))
  for (const full of SCAN.flatMap((d) => walk(join(ROOT, d)))) {
    const text = readFileSync(full, 'utf8')
    const rel = relative(ROOT, full).split(sep).join('/')
    for (const [name, re] of patterns) if (re.test(text)) hits[name].push(rel)
  }
  return hits
})()

describe('dead code stays deleted (D1 DEADCODE.1)', () => {
  it.each(Object.keys(GONE))('nothing names %s', (name) => {
    const allowed = new Set([SELF, ...GONE[name]])
    expect(HITS[name].filter((rel) => !allowed.has(rel)).sort()).toEqual([])
  }, SCAN_TIMEOUT_MS)

  it('the week-end date helper went with its only caller (shared/dashboard-data.js)', () => {
    const src = readFileSync(join(ROOT, 'shared/dashboard-data.js'), 'utf8')
    expect(src).not.toMatch(/export function endOfWeek\b/)
  })

  it('the working-time route is gone (CANDIDATES.1 replaced it with blocks/{id}/candidates)', () => {
    expect(existsSync(join(ROOT, 'src/app/api/schedule/working-time'))).toBe(false)
  })
})
