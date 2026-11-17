// OPENWEEK.1 — mig 849: Stillorgan's open week is bound to the public Glofox
// membership "2) Black Friday Open Week." (690dbd7619bfd5948a0ac79d). Mig 848
// bound an older copy of the same name (690dbd7bf0dba128580158fa) that Glofox
// no longer sells: the first claim was refused ERROR_CONNECTING_WITH_MEMBERSHIP_SERVICE.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { sqlCode } from './helpers/sql-code.js'

const FILE = join(process.cwd(), 'supabase/migrations/849_stillorgan_open_week_plan.sql')
const code = () => sqlCode(readFileSync(FILE, 'utf8')).replace(/\s+/g, ' ')

describe('mig 849 Stillorgan open week plan', () => {
  it('exists', () => {
    expect(existsSync(FILE)).toBe(true)
  })

  it('rebinds only the Stillorgan open week row, from the old membership to the public one', () => {
    const s = code()
    expect(s).toContain("SET glofox_membership_id = '690dbd7619bfd5948a0ac79d'")
    expect(s).toContain("WHERE key = 'stillorgan-open-week'")
    expect(s).toContain("AND glofox_membership_id = '690dbd7bf0dba128580158fa'")
  })

  it('checks its post-state', () => {
    const s = code()
    expect(s).toContain("p.glofox_membership_id = '690dbd7619bfd5948a0ac79d'")
    expect(s).toContain("p.glofox_plan_code = '1762508130342'")
  })
})
