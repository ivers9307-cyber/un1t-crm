import { describe, it, expect } from 'vitest'
import {
  uuidLike, isoDate, timeOfDay, hexColor, email, phone, url,
  money, hours, days,
  roleSchema, employmentTypeSchema, leadSourceSchema, leadStatusSchema,
  dealStatusSchema, timeOffTypeSchema, timeOffStatusSchema,
  reportFrequencySchema, reportTypeSchema,
  permissionsSchema, audienceFilterSchema,
  ADMIN_ROLES, MANAGER_ROLES, DEFAULT_COLOR,
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
  it('ADMIN_ROLES is owner+manager only', () => {
    expect(ADMIN_ROLES).toEqual(['owner', 'manager'])
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
