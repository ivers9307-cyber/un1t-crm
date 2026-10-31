// PAGES.1 (Task 23, ruling R10) — the deprecated landing_page_settings table
// has no reader left. Every public route, resolver and non-page reader reads
// landing_pages / landing_page_studios (a studio is its kind='studio' page);
// the old table stays on disk for rollback until a later migration drops it
// (CLAUDE.md: deprecated columns stay on disk), so nothing may name it again.
//
// A plain text walk of src/, shared/ and scripts/, skipping node_modules and
// any *.test.* / *.spec.* file (a test may assert that a reader never touches
// the old table). The one allowed file is scripts/check-location-scoping.mjs,
// whose tenant-table notes name it. The text walk is deliberately blunt: a
// comment that names the table fails too, so a doc comment cannot hide a read.
// A floor, not a proof: a table name built at runtime is invisible.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')
const OLD_TABLE = 'landing_page_settings'
const ALLOWED = new Set(['scripts/check-location-scoping.mjs'])
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist'])
const isTestFile = (name) => /\.(test|spec)\./.test(name)

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out)
    } else if (!isTestFile(name)) {
      out.push(full)
    }
  }
  return out
}

describe('landing_page_settings readers (PAGES.1 R10)', () => {
  it('no file under src/, shared/ or scripts/ names the deprecated table', () => {
    const files = ['src', 'shared', 'scripts'].flatMap((d) => walk(path.join(ROOT, d)))
    expect(files.length).toBeGreaterThan(500)
    const offenders = files
      .map((f) => path.relative(ROOT, f))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => readFileSync(path.join(ROOT, rel), 'utf8').includes(OLD_TABLE))
    expect(offenders).toEqual([])
  })

  it('the guard reads real files: the migration that made the table still names it', () => {
    const sql = readFileSync(path.join(ROOT, 'supabase/migrations/792_landing_pages.sql'), 'utf8')
    expect(sql).toContain(OLD_TABLE)
    expect(readFileSync(path.join(ROOT, 'scripts/check-location-scoping.mjs'), 'utf8')).toContain(OLD_TABLE)
  })
})
