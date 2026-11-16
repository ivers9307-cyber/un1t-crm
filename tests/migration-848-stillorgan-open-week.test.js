// OPENWEEK.1 — mig 848: Stillorgan's open week promo, bound to the Glofox
// plan "2) Black Friday Open Week." and switched off until launch.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { sqlCode } from './helpers/sql-code.js'

const FILE = join(process.cwd(), 'supabase/migrations/848_stillorgan_open_week.sql')
const code = () => sqlCode(readFileSync(FILE, 'utf8')).replace(/\s+/g, ' ')

describe('mig 848 Stillorgan open week', () => {
  it('exists', () => {
    expect(existsSync(FILE)).toBe(true)
  })

  it('seeds the promo by studio name, switched off, with the Glofox binding and the week', () => {
    const s = code()
    expect(s).toContain("WHERE name = 'UN1T Stillorgan'")
    expect(s).toContain('RAISE EXCEPTION')
    expect(s).toMatch(/\(stillorgan, 'stillorgan-open-week', 'Open Week \(Stillorgan\)', 'glofox', 5, 14, false, 'stillorgan-open-week', 'corp_promo', '690dbd7bf0dba128580158fa', '1762508130342', '2\) Black Friday Open Week\.', 'open_week', '2026-11-23', '2026-11-30', 5, 1\)/)
    expect(s).toContain('ON CONFLICT (location_id, key) DO NOTHING')
  })

  it('checks its post-state', () => {
    expect(code()).toContain("p.key = 'stillorgan-open-week'")
  })
})
