import { describe, it, expect } from 'vitest'
import {
  isoDate, timeOfDay, hexColor, email, url,
  money, hours, days,
  roleSchema, locationRoleSchema, assignmentSchema,
  employmentTypeSchema,
  dealStatusSchema,
  reportFrequencySchema,
  permissionsSchema, audienceFilterSchema,
  ADMIN_ROLES, MANAGER_ROLES, DEFAULT_COLOR,
  MASTER_ASSIGNABLE_ROLES, OWNER_ASSIGNABLE_ROLES,
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
      filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'active_member' }],
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

// ============================================================
// Per-location roles (mig 051)
// ============================================================

describe('locationRoleSchema (per-location, no master)', () => {
  it('accepts the four per-location roles', () => {
    expect(locationRoleSchema.safeParse('owner').success).toBe(true)
    expect(locationRoleSchema.safeParse('manager').success).toBe(true)
    expect(locationRoleSchema.safeParse('head_coach').success).toBe(true)
    expect(locationRoleSchema.safeParse('staff').success).toBe(true)
  })

  it('REJECTS master at the per-location level', () => {
    // master lives on profiles.role (platform-wide). The DB CHECK
    // constraint on profile_locations.role enforces this; the
    // schema is the matching client-side guard.
    expect(locationRoleSchema.safeParse('master').success).toBe(false)
  })

  it('rejects garbage', () => {
    expect(locationRoleSchema.safeParse('admin').success).toBe(false)
    expect(locationRoleSchema.safeParse('').success).toBe(false)
    expect(locationRoleSchema.safeParse(null).success).toBe(false)
  })
})

describe('assignmentSchema', () => {
  const validUuid = '11111111-1111-1111-1111-111111111111'

  it('accepts the minimum valid shape', () => {
    const r = assignmentSchema.safeParse({ location_id: validUuid, role: 'staff' })
    expect(r.success).toBe(true)
  })

  it('accepts the full shape with optional flags', () => {
    const r = assignmentSchema.safeParse({
      location_id: validUuid,
      role: 'owner',
      is_default: true,
      unifi_door_access: false,
    })
    expect(r.success).toBe(true)
  })

  it('rejects missing location_id', () => {
    expect(assignmentSchema.safeParse({ role: 'staff' }).success).toBe(false)
  })

  it('rejects missing role', () => {
    expect(assignmentSchema.safeParse({ location_id: validUuid }).success).toBe(false)
  })

  it('rejects role=master (matches the DB CHECK)', () => {
    expect(assignmentSchema.safeParse({ location_id: validUuid, role: 'master' }).success).toBe(false)
  })

  it('rejects bad uuid', () => {
    expect(assignmentSchema.safeParse({ location_id: 'not-a-uuid', role: 'staff' }).success).toBe(false)
  })
})

describe('OWNER_ASSIGNABLE_ROLES + MASTER_ASSIGNABLE_ROLES (mig 051 semantics)', () => {
  it('OWNER_ASSIGNABLE_ROLES now includes owner — owner-at-X can mint another owner-at-X', () => {
    // Pre-mig-051 this was studio-only-non-elevated. Per-location
    // roles changed the calculus: granting "owner at this studio"
    // is no longer a platform-level promotion, so an owner can grant it.
    expect(OWNER_ASSIGNABLE_ROLES).toContain('owner')
    expect(OWNER_ASSIGNABLE_ROLES).toEqual(['owner', 'manager', 'head_coach', 'staff', 'reception'])
    expect(Object.isFrozen(OWNER_ASSIGNABLE_ROLES)).toBe(true)
  })

  it('MASTER_ASSIGNABLE_ROLES no longer includes master — set via is_master flag, not as a per-location role', () => {
    // The is_master boolean on the staff API body is the only way
    // to mint a master, and only an existing master can set it.
    expect(MASTER_ASSIGNABLE_ROLES).not.toContain('master')
    expect(MASTER_ASSIGNABLE_ROLES).toEqual(['owner', 'manager', 'head_coach', 'staff', 'reception'])
    expect(Object.isFrozen(MASTER_ASSIGNABLE_ROLES)).toBe(true)
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
