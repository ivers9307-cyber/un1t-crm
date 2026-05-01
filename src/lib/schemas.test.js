import { describe, it, expect } from 'vitest'
import {
  uuidLike, isoDate, timeOfDay, hexColor, email, phone, url,
  money, hours, days,
  roleSchema, employmentTypeSchema, leadSourceSchema, leadStatusSchema,
  dealStatusSchema, timeOffTypeSchema, timeOffStatusSchema,
  reportFrequencySchema, reportTypeSchema,
  permissionsSchema, audienceFilterSchema,
  ADMIN_ROLES, MANAGER_ROLES, DEFAULT_COLOR,
  passwordSchema, passwordRequirements, validatePasswordComplexity,
} from './schemas.js'

describe('shared scalar schemas', () => {
  it('isoDate accepts YYYY-MM-DD and rejects everything else', () => {
    expect(isoDate.safeParse('2026-04-30').success).toBe(true)
    expect(isoDate.safeParse('2026/04/30').success).toBe(false)
    expect(isoDate.safeParse('30-04-2026').success).toBe(false)
    expect(isoDate.safeParse('2026-04-30T00:00:00').success).toBe(false)
  })

  it('timeOfDay accepts HH:MM and HH:MM:SS but rejects out-of-range', () => {
    expect(timeOfDay.safeParse('09:30').success).toBe(true)
    expect(timeOfDay.safeParse('09:30:00').success).toBe(true)
    expect(timeOfDay.safeParse('25:00').success).toBe(false)
    expect(timeOfDay.safeParse('09:60').success).toBe(false)
  })

  it('hexColor only accepts #RRGGBB', () => {
    expect(hexColor.safeParse('#3B82F6').success).toBe(true)
    expect(hexColor.safeParse('#ABC').success).toBe(false)
    expect(hexColor.safeParse('blue').success).toBe(false)
  })

  it('email validates basic shapes', () => {
    expect(email.safeParse('a@b.co').success).toBe(true)
    expect(email.safeParse('not-an-email').success).toBe(false)
  })

  it('url requires http(s)', () => {
    expect(url.safeParse('https://example.com').success).toBe(true)
    expect(url.safeParse('not a url').success).toBe(false)
  })

  it('money rejects negatives and NaN', () => {
    expect(money.safeParse(0).success).toBe(true)
    expect(money.safeParse(50000.5).success).toBe(true)
    expect(money.safeParse(-1).success).toBe(false)
    expect(money.safeParse(NaN).success).toBe(false)
    expect(money.safeParse(Infinity).success).toBe(false)
  })

  it('hours bounds at 0..168', () => {
    expect(hours.safeParse(40).success).toBe(true)
    expect(hours.safeParse(168).success).toBe(true)
    expect(hours.safeParse(169).success).toBe(false)
    expect(hours.safeParse(-1).success).toBe(false)
  })

  it('days accepts half-day fractions (NUMERIC(5,1) in DB)', () => {
    expect(days.safeParse(20).success).toBe(true)
    expect(days.safeParse(22.5).success).toBe(true)
    expect(days.safeParse(367).success).toBe(false)
  })
})

describe('enum schemas', () => {
  it('roleSchema covers all 4 roles', () => {
    for (const r of ['owner', 'manager', 'head_coach', 'staff']) {
      expect(roleSchema.safeParse(r).success).toBe(true)
    }
    expect(roleSchema.safeParse('admin').success).toBe(false)
  })

  it('employmentTypeSchema rejects unknown values', () => {
    expect(employmentTypeSchema.safeParse('fte').success).toBe(true)
    expect(employmentTypeSchema.safeParse('contractor').success).toBe(true)
    expect(employmentTypeSchema.safeParse('parttime').success).toBe(false)
  })

  it('leadStatusSchema matches AudienceBuilder options', () => {
    for (const s of ['active_trial', 'cold', 'lost_member', 'member', 'returning']) {
      expect(leadStatusSchema.safeParse(s).success).toBe(true)
    }
  })

  it('dealStatusSchema only allows open/won/lost', () => {
    expect(dealStatusSchema.safeParse('open').success).toBe(true)
    expect(dealStatusSchema.safeParse('pending').success).toBe(false)
  })

  it('reportFrequencySchema covers cron frequencies', () => {
    for (const f of ['once', 'daily', 'weekly', 'monthly']) {
      expect(reportFrequencySchema.safeParse(f).success).toBe(true)
    }
  })
})

describe('permissionsSchema', () => {
  it('accepts a flat boolean record', () => {
    expect(permissionsSchema.safeParse({ dashboard: true, settings: false }).success).toBe(true)
  })

  it('accepts non-boolean values (lenient for legacy/future shapes)', () => {
    expect(permissionsSchema.safeParse({ custom: 'value', nested: { ok: true } }).success).toBe(true)
  })

  it('rejects non-objects', () => {
    expect(permissionsSchema.safeParse('not-an-object').success).toBe(false)
    expect(permissionsSchema.safeParse([1, 2]).success).toBe(false)
  })
})

describe('audienceFilterSchema', () => {
  it('accepts a well-formed filter object', () => {
    const r = audienceFilterSchema.safeParse({
      logic: 'and',
      filters: [{ field: 'lead_status', op: 'eq', value: 'member' }],
    })
    expect(r.success).toBe(true)
  })

  it('accepts undefined (filter is optional)', () => {
    expect(audienceFilterSchema.safeParse(undefined).success).toBe(true)
  })

  it('rejects unknown logic values', () => {
    expect(audienceFilterSchema.safeParse({ logic: 'xor', filters: [] }).success).toBe(false)
  })
})

describe('role groups + DEFAULT_COLOR', () => {
  it('ADMIN_ROLES includes master + owner + manager', () => {
    // Master added in mig 033 — platform super-admin sits above
    // owner. Both have full admin powers; owner is studio-scoped,
    // master is global.
    expect(ADMIN_ROLES).toEqual(['master', 'owner', 'manager'])
    expect(Object.isFrozen(ADMIN_ROLES)).toBe(true)
  })

  it('MANAGER_ROLES includes head_coach', () => {
    expect(MANAGER_ROLES).toContain('head_coach')
    expect(Object.isFrozen(MANAGER_ROLES)).toBe(true)
  })

  it('DEFAULT_COLOR is a valid hex', () => {
    expect(hexColor.safeParse(DEFAULT_COLOR).success).toBe(true)
  })
})

describe('password complexity', () => {
  // The Supabase project enforces 8+ chars + lower + upper + digit + symbol.
  // These tests pin the rules so a regex tweak doesn't accidentally relax
  // them past what the auth provider accepts.

  it('accepts a strong password', () => {
    const r = passwordSchema.safeParse('Strong!Pass1')
    expect(r.success).toBe(true)
  })

  it('rejects too short', () => {
    const r = passwordSchema.safeParse('Aa1!')
    expect(r.success).toBe(false)
  })

  it('rejects without lowercase', () => {
    const r = passwordSchema.safeParse('STRONG!PASS1')
    expect(r.success).toBe(false)
    expect(r.error?.issues.some(i => /lowercase/i.test(i.message))).toBe(true)
  })

  it('rejects without uppercase', () => {
    const r = passwordSchema.safeParse('strong!pass1')
    expect(r.success).toBe(false)
    expect(r.error?.issues.some(i => /uppercase/i.test(i.message))).toBe(true)
  })

  it('rejects without digit', () => {
    const r = passwordSchema.safeParse('Strong!Pass!')
    expect(r.success).toBe(false)
    expect(r.error?.issues.some(i => /digit/i.test(i.message))).toBe(true)
  })

  it('rejects without symbol', () => {
    const r = passwordSchema.safeParse('StrongPass123')
    expect(r.success).toBe(false)
    expect(r.error?.issues.some(i => /symbol/i.test(i.message))).toBe(true)
  })

  it('passwordRequirements list lines up with the schema', () => {
    // Should be 5 rules; bare-letters strings should fail every category check
    expect(passwordRequirements).toHaveLength(5)
    expect(passwordRequirements.map(r => r.id)).toEqual(
      ['length', 'lowercase', 'uppercase', 'digit', 'symbol'],
    )
    // Rules are pure functions
    for (const r of passwordRequirements) {
      expect(typeof r.test).toBe('function')
      expect(typeof r.label).toBe('string')
    }
  })

  it('validatePasswordComplexity returns null for strong / message for weak', () => {
    expect(validatePasswordComplexity('Strong!Pass1')).toBeNull()
    expect(validatePasswordComplexity('weak')).toMatch(/Password requires/i)
    expect(validatePasswordComplexity(undefined)).toBe('Password must be a string')
  })

  it('treats spaces and accented characters as valid symbols/letters', () => {
    // Defensive: don't break for non-ASCII users
    expect(passwordSchema.safeParse('Café!2024').success).toBe(true)
  })
})
