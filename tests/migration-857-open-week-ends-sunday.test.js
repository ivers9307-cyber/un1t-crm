// OPENWEEK.6 — mig 857: open week is seven days, Mon 23 to Sun 29 Nov 2026.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { sqlCode } from './helpers/sql-code.js'

const FILE = join(process.cwd(), 'supabase/migrations/857_open_week_ends_sunday.sql')
const code = () => sqlCode(readFileSync(FILE, 'utf8')).replace(/\s+/g, ' ')

describe('mig 857 open week ends Sunday', () => {
  it('exists', () => {
    expect(existsSync(FILE)).toBe(true)
  })

  it('moves only the two open week rows from 30 to 29 Nov', () => {
    const s = code()
    expect(s).toContain("SET window_ends_on = '2026-11-29'")
    expect(s).toContain("WHERE key IN ('hatch-open-week', 'stillorgan-open-week')")
    expect(s).toContain("AND kind = 'open_week'")
    expect(s).toContain("AND window_ends_on = '2026-11-30'")
  })

  it('checks its post-state', () => {
    expect(code()).toContain("window_ends_on <> '2026-11-29'")
  })
})
