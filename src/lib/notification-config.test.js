// NOTIF.3 — unit tests for the notification-config helper.
//
// These cover the validator + the default-merge logic that the cron
// + API endpoint + settings UI all depend on.

import { describe, it, expect } from 'vitest'
import {
  getEffectiveConfig, getLeadTimes, getBookingNotifyRoles,
  validateConfig, formatLeadTime, formatLeadTimes,
  DEFAULT_NOTIFICATION_CONFIG,
  LEAD_TIME_MIN_MINUTES, LEAD_TIME_MAX_MINUTES,
  VALID_NOTIFY_ROLES,
} from './notification-config'

describe('getEffectiveConfig', () => {
  it('returns built-in defaults when stored is null', () => {
    const eff = getEffectiveConfig(null)
    expect(eff.categories.tasks.lead_times_minutes).toEqual([60, 1440])
    expect(eff.categories.bookings.lead_times_minutes).toEqual([60, 1440])
    expect(eff.categories.bookings.notify_roles).toEqual(['owner', 'manager', 'head_coach'])
  })

  it('returns defaults for missing categories in stored', () => {
    const eff = getEffectiveConfig({ categories: { tasks: { lead_times_minutes: [30] } } })
    expect(eff.categories.tasks.lead_times_minutes).toEqual([30])
    expect(eff.categories.bookings.lead_times_minutes).toEqual([60, 1440])
  })

  it('returns a fresh object each call (safe to mutate)', () => {
    const a = getEffectiveConfig(null)
    const b = getEffectiveConfig(null)
    a.categories.tasks.lead_times_minutes.push(9999)
    expect(b.categories.tasks.lead_times_minutes).toEqual([60, 1440])
  })

  it('filters unknown roles silently', () => {
    const eff = getEffectiveConfig({ categories: { bookings: { notify_roles: ['owner', 'hacker'] } } })
    expect(eff.categories.bookings.notify_roles).toEqual(['owner'])
  })

  it('uses defaults for empty arrays (treats empty as unset)', () => {
    const eff = getEffectiveConfig({ categories: { tasks: { lead_times_minutes: [] } } })
    expect(eff.categories.tasks.lead_times_minutes).toEqual([60, 1440])
  })
})

describe('validateConfig', () => {
  it('null → ok with null value', () => {
    expect(validateConfig(null)).toEqual({ ok: true, value: null })
  })

  it('empty object → ok with null value', () => {
    expect(validateConfig({})).toEqual({ ok: true, value: null })
  })

  it('non-object root → error', () => {
    expect(validateConfig([]).ok).toBe(false)
    expect(validateConfig('string').ok).toBe(false)
  })

  it('accepts a valid full config', () => {
    const out = validateConfig({
      categories: {
        tasks: { lead_times_minutes: [60, 1440] },
        bookings: { lead_times_minutes: [60], notify_roles: ['owner'] },
      },
    })
    expect(out.ok).toBe(true)
    expect(out.value.categories.tasks.lead_times_minutes).toEqual([60, 1440])
  })

  it('dedups duplicate lead times', () => {
    const out = validateConfig({ categories: { tasks: { lead_times_minutes: [60, 60, 1440] } } })
    expect(out.value.categories.tasks.lead_times_minutes).toEqual([60, 1440])
  })

  it('sorts lead times ascending', () => {
    const out = validateConfig({ categories: { tasks: { lead_times_minutes: [1440, 60, 120] } } })
    expect(out.value.categories.tasks.lead_times_minutes).toEqual([60, 120, 1440])
  })

  it('rejects lead times below min', () => {
    expect(validateConfig({ categories: { tasks: { lead_times_minutes: [LEAD_TIME_MIN_MINUTES - 1] } } }).ok)
      .toBe(false)
  })

  it('rejects lead times above max', () => {
    expect(validateConfig({ categories: { tasks: { lead_times_minutes: [LEAD_TIME_MAX_MINUTES + 1] } } }).ok)
      .toBe(false)
  })

  it('rejects non-integer lead times', () => {
    expect(validateConfig({ categories: { tasks: { lead_times_minutes: [60.5] } } }).ok).toBe(false)
  })

  it('rejects empty lead-times array (operator should toggle off instead)', () => {
    expect(validateConfig({ categories: { tasks: { lead_times_minutes: [] } } }).ok).toBe(false)
  })

  it('rejects unknown roles', () => {
    expect(validateConfig({ categories: { bookings: { notify_roles: ['ceo'] } } }).ok).toBe(false)
  })

  it('rejects empty role array', () => {
    expect(validateConfig({ categories: { bookings: { notify_roles: [] } } }).ok).toBe(false)
  })

  it('silently drops unknown categories (forward-compat)', () => {
    const out = validateConfig({ categories: { ghost: { lead_times_minutes: [60] } } })
    expect(out.ok).toBe(true)
    expect(out.value).toBeNull()
  })

  it('returns field-level errors', () => {
    const out = validateConfig({ categories: { tasks: { lead_times_minutes: [3] } } })
    expect(out.ok).toBe(false)
    expect(out.errors['categories.tasks.lead_times_minutes']).toMatch(/Each lead time/)
  })
})

describe('formatLeadTime', () => {
  it.each([
    [30, '30m'],
    [60, '1h'],
    [90, '1h30m'],
    [120, '2h'],
    [1440, '1d'],
    [2880, '2d'],
    [10080, '7d'],
  ])('%i → %s', (input, expected) => {
    expect(formatLeadTime(input)).toBe(expected)
  })
})

describe('formatLeadTimes', () => {
  it('formats a list, sorted', () => {
    expect(formatLeadTimes([1440, 60])).toBe('1h, 1d')
  })
  it('returns em-dash for empty/missing', () => {
    expect(formatLeadTimes([])).toBe('—')
    expect(formatLeadTimes(null)).toBe('—')
    expect(formatLeadTimes(undefined)).toBe('—')
  })
})

describe('shape invariants', () => {
  it('DEFAULT_NOTIFICATION_CONFIG has both configurable categories', () => {
    expect(DEFAULT_NOTIFICATION_CONFIG.categories.tasks).toBeDefined()
    expect(DEFAULT_NOTIFICATION_CONFIG.categories.bookings).toBeDefined()
  })

  it('VALID_NOTIFY_ROLES contains the four canonical roles', () => {
    expect(VALID_NOTIFY_ROLES).toEqual(['owner', 'manager', 'head_coach', 'staff'])
  })

  it('getLeadTimes + getBookingNotifyRoles match getEffectiveConfig', () => {
    expect(getLeadTimes(null, 'tasks')).toEqual([60, 1440])
    expect(getLeadTimes(null, 'bookings')).toEqual([60, 1440])
    expect(getBookingNotifyRoles(null)).toEqual(['owner', 'manager', 'head_coach'])
  })
})
