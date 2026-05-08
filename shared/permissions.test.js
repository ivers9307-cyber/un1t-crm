// Canonical resolver tests. Locks the contract that web's
// hasPermission() and mobile's canMobile() / canDashboard() all
// depend on. Anything that changes 3-tier semantics breaks here
// first, before subtle UI-visibility regressions ship.

import { describe, it, expect } from 'vitest'
import {
  resolvePermission,
  DEFAULT_WEB_PERMISSIONS_BY_ROLE,
  DEFAULT_MOBILE_PERMISSIONS_BY_ROLE,
} from './permissions.js'

// A few keys we know exist in the defaults maps. Values inferred
// from the file rather than hard-coded so the test stays in sync
// when the defaults evolve.
const STAFF_DEFAULT_PIPELINE = !!DEFAULT_WEB_PERMISSIONS_BY_ROLE.staff?.pipeline
const STAFF_DEFAULT_SCHEDULE = !!DEFAULT_MOBILE_PERMISSIONS_BY_ROLE.staff?.schedule

describe('resolvePermission — tier 1 (location gate)', () => {
  it('returns false when the location explicitly disables the feature, even for master', () => {
    expect(resolvePermission({
      role: 'master',
      location: { features: { pipeline: false } },
      permissions: null,
      defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
      key: 'pipeline',
    })).toBe(false)
  })

  it('lets the resolver continue when location.features omits the key', () => {
    // Omitted key → not denied at tier 1. Master then bypasses 2+3 → true.
    expect(resolvePermission({
      role: 'master',
      location: { features: {} },
      permissions: null,
      defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
      key: 'pipeline',
    })).toBe(true)
  })

  it('does NOT location-gate notification keys (notify_*)', () => {
    // notify_* are exempt — per-user comms toggles are personal.
    // Even if the location says off, the resolver moves on to
    // tier 2/3 instead of returning false at tier 1.
    expect(resolvePermission({
      role: 'staff',
      location: { features: { notify_swap: false } },
      permissions: { notify_swap: true },
      defaults: DEFAULT_MOBILE_PERMISSIONS_BY_ROLE,
      key: 'notify_swap',
    })).toBe(true)
  })

  it('handles a null/undefined location object gracefully', () => {
    // Defensive default — no location info means "don't block at
    // tier 1". Master bypasses 2+3 → true.
    expect(resolvePermission({
      role: 'master',
      location: null,
      permissions: null,
      defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
      key: 'pipeline',
    })).toBe(true)
  })
})

describe('resolvePermission — tier 2 (per-user override)', () => {
  it('explicit true in the bag wins over the role default', () => {
    expect(resolvePermission({
      role: 'staff',
      location: { features: { pipeline: true } },
      permissions: { pipeline: true },
      defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
      key: 'pipeline',
    })).toBe(true)
  })

  it('explicit false in the bag wins over the role default', () => {
    // owner has many keys true by default; an explicit false on
    // a single key for this user denies them.
    expect(resolvePermission({
      role: 'owner',
      location: { features: {} },
      permissions: { pipeline: false },
      defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
      key: 'pipeline',
    })).toBe(false)
  })

  it('a missing key in a non-empty bag falls through to tier 3', () => {
    // Only `whatsapp` is in the bag; the `pipeline` answer comes
    // from the role default (whatever staff's default is).
    expect(resolvePermission({
      role: 'staff',
      location: { features: {} },
      permissions: { whatsapp: true },
      defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
      key: 'pipeline',
    })).toBe(STAFF_DEFAULT_PIPELINE)
  })

  it('master bypasses tier 2 (does not even look at the override bag)', () => {
    // A master with permissions: { pipeline: false } still gets
    // pipeline because tier 1 passed and master short-circuits.
    expect(resolvePermission({
      role: 'master',
      location: { features: {} },
      permissions: { pipeline: false },
      defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
      key: 'pipeline',
    })).toBe(true)
  })
})

describe('resolvePermission — tier 3 (role default)', () => {
  it('returns the role default when there is no location override and no user override', () => {
    expect(resolvePermission({
      role: 'staff',
      location: { features: {} },
      permissions: null,
      defaults: DEFAULT_MOBILE_PERMISSIONS_BY_ROLE,
      key: 'schedule',
    })).toBe(STAFF_DEFAULT_SCHEDULE)
  })

  it('returns false for an unknown role', () => {
    expect(resolvePermission({
      role: 'visitor',
      location: { features: {} },
      permissions: null,
      defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
      key: 'pipeline',
    })).toBe(false)
  })

  it('returns false for an unknown key', () => {
    expect(resolvePermission({
      role: 'staff',
      location: { features: {} },
      permissions: null,
      defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
      key: 'imaginary_feature',
    })).toBe(false)
  })

  it('handles a null defaults map without throwing', () => {
    expect(resolvePermission({
      role: 'staff',
      location: { features: {} },
      permissions: null,
      defaults: null,
      key: 'pipeline',
    })).toBe(false)
  })
})

describe('resolvePermission — order of resolution', () => {
  it('tier 1 (deny) wins over tier 2 (allow)', () => {
    expect(resolvePermission({
      role: 'staff',
      location: { features: { pipeline: false } },
      permissions: { pipeline: true },
      defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
      key: 'pipeline',
    })).toBe(false)
  })

  it('tier 2 (deny) wins over tier 3 (allow)', () => {
    expect(resolvePermission({
      role: 'owner',
      location: { features: {} },
      permissions: { pipeline: false },
      defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
      key: 'pipeline',
    })).toBe(false)
  })

  it('tier 2 (allow) wins over tier 3 (deny)', () => {
    // staff's mobile default for pipeline is undefined / false;
    // an explicit override flips it to true.
    expect(resolvePermission({
      role: 'staff',
      location: { features: {} },
      permissions: { schedule: true },
      defaults: DEFAULT_MOBILE_PERMISSIONS_BY_ROLE,
      key: 'schedule',
    })).toBe(true)
  })
})
