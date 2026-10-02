// TODAYTZ.1 — /dashboard/today must key "today" off Europe/Dublin.
//
// The page is an async server component that fans out to half a dozen
// collaborators, so booting it in a test would be a rig around one line. The
// defect was one line: it built today from the SERVER's calendar date, and
// Vercel runs in UTC — between midnight and 01:00 Dublin during BST the server
// is still on yesterday, so the month grid highlighted the wrong cell and
// "on with you today" listed yesterday's shifts. CLAUDE.md's rule is
// dublinTodayStr() for a business today, and the guardrails lint rule only
// catches the `new Date().toISOString().slice(…)` spelling, not this one
// (local getters on a UTC box).
//
// A source scan is therefore the honest shape: it pins the one decision, in
// the one file, and says why.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { stripComments } from './helpers/js-code.js'
import { dublinTodayStr } from '../src/lib/dublin-time.js'

const PAGE = path.resolve(import.meta.dirname, '../src/app/dashboard/today/page.js')
const source = readFileSync(PAGE, 'utf8')

// Comments explain the defect by name; they must not count as the defect.
// They are blanked by the TypeScript parser's comment ranges
// (tests/helpers/js-code.js), never a regex: one comment contains a glob
// ("providers/*.js") that a block-comment regex reads as an opening `/*`,
// swallowing a third of the file (GUARDSTRIP.1).
const code = stripComments(source)

describe('/dashboard/today — "today" is a Dublin day', () => {
  it('the comment blanking keeps every line of code (GUARDSTRIP.1)', () => {
    const lines = (s) => s.split('\n').filter((l) => /\S/.test(l)).length
    expect(code).toHaveLength(source.length)
    expect(code).toMatch(/export default/)
    expect(lines(stripComments('// see providers/*.js\nconst a = 1\n/* x */\n'))).toBe(1)
  })

  it('imports and calls dublinTodayStr()', () => {
    expect(code).toMatch(/import\s*\{[^}]*\bdublinTodayStr\b[^}]*\}\s*from\s*['"]@\/lib\/dublin-time['"]/)
    expect(code).toMatch(/dublinTodayStr\(\)/)
  })

  it('derives no date string from the server clock', () => {
    // The two spellings that reintroduce it: local calendar getters over
    // `new Date()`, and the UTC-today form CLAUDE.md names.
    expect(code).not.toMatch(/new Date\(\)\.getFullYear\(\)/)
    expect(code).not.toMatch(/isoDate\(\s*new Date\(\)\s*\)/)
    expect(code).not.toMatch(/new Date\(\)\.toISOString\(\)\.(slice|split)/)
  })

  it('hands the SAME today to the month grid and to the swap actions', () => {
    // Two surfaces on one page disagreeing about today is its own bug; one
    // binding, used twice.
    expect(code).toMatch(/const todayIso = dublinTodayStr\(\)/)
    expect(code).toMatch(/buildMonthMatrix\([^)]*todayIso\)/)
    expect(code).toMatch(/todayIso=\{todayIso\}/)
    // Exactly one call site, so the two cannot drift or straddle midnight.
    expect(code.match(/dublinTodayStr\(\)/g)).toHaveLength(1)
  })

  // A4 REVENUEMTD.1 — fetchPersonalDashboardData runs HERE on the server (UTC),
  // so from 00:00 to 01:00 Dublin on a Monday in summer its "This week" was
  // last week while the grid above highlighted Dublin's Monday. Same today.
  it('hands the same Dublin today to fetchPersonalDashboardData', () => {
    expect(code).toMatch(/fetchPersonalDashboardData\(\s*db\s*,\s*user\.id\s*,\s*user\.activeLocation\?\.id\s*,\s*\{\s*todayIso\s*\}\s*\)/)
  })

  it('dublinTodayStr really answers a Dublin calendar day', () => {
    expect(dublinTodayStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(dublinTodayStr()).toBe(
      new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
    )
  })
})
