// Canonical resolver tests. Locks the contract that web's
// hasPermission() and mobile's canMobile() / canDashboard() all
// depend on. Anything that changes 3-tier semantics breaks here
// first, before subtle UI-visibility regressions ship.

import { describe, it, expect } from 'vitest'
import {
  resolvePermission,
  hydratePermissions,
  sanitizePermissionsBlob,
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

// PR #754 Q1 — editor hydration. Both permission editors (web
// StaffForm.jsx + mobile staff/permissions/[id].jsx) hydrate stored
// blobs through this helper: role defaults merge UNDER stored values
// so a key added after the blob was saved renders at its effective
// (role-default) state instead of a phantom OFF. The hydrated blob is
// what saves write back, so these semantics ARE the save semantics.
describe('hydratePermissions — role defaults merged under the stored blob', () => {
  it('empty / null / undefined blob → the role full web+mobile default blob', () => {
    const expected = {
      ...DEFAULT_WEB_PERMISSIONS_BY_ROLE.staff,
      mobile: { ...DEFAULT_MOBILE_PERMISSIONS_BY_ROLE.staff },
    }
    expect(hydratePermissions({}, 'staff')).toEqual(expected)
    expect(hydratePermissions(null, 'staff')).toEqual(expected)
    expect(hydratePermissions(undefined, 'staff')).toEqual(expected)
  })

  it('missing keys hydrate to the role default; stored explicit values (true AND false) win', () => {
    const out = hydratePermissions(
      { email: true, pipeline: false, mobile: { notify_lead: true, schedule: false } },
      'staff'
    )
    expect(out.email).toBe(true)                 // explicit true beats staff default false
    expect(out.pipeline).toBe(false)             // explicit false beats staff default true
    expect(out.mobile.notify_lead).toBe(true)    // explicit true beats staff default false
    expect(out.mobile.schedule).toBe(false)      // explicit false beats staff default true
    expect(out.contacts).toBe(DEFAULT_WEB_PERMISSIONS_BY_ROLE.staff.contacts)
    expect(out.mobile.notify_time_off).toBe(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE.staff.notify_time_off)
  })

  it('role-default OFF + missing key hydrates to OFF', () => {
    expect(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE.staff.notify_checklist_compliance).toBe(false) // guard the premise
    const out = hydratePermissions({ mobile: { schedule: true } }, 'staff')
    expect(out.mobile.notify_checklist_compliance).toBe(false)
  })

  it('uses the role passed in, so the CURRENT role drives the defaults', () => {
    const owner = hydratePermissions({ mobile: {} }, 'owner')
    const staff = hydratePermissions({ mobile: {} }, 'staff')
    expect(owner.mobile.notify_issue_submitted).toBe(true)
    expect(staff.mobile.notify_issue_submitted).toBe(false)
  })

  it('never mutates the stored blob (fresh objects for blob + .mobile)', () => {
    const raw = { pipeline: false, mobile: { schedule: false } }
    const out = hydratePermissions(raw, 'staff')
    out.pipeline = true
    out.mobile.schedule = true
    expect(raw).toEqual({ pipeline: false, mobile: { schedule: false } })
  })
})

// PERM-AUDIT.1 — the save-path whitelist. Both staff-save routes run
// incoming blobs through this (via permissionsSchema.transform), so
// junk keys can no longer land in profile_locations.permissions and
// stale keys self-heal on the next save.
describe('sanitizePermissionsBlob — save-path whitelist', () => {
  it('keeps known web + mobile boolean keys and drops unknown keys', () => {
    const out = sanitizePermissionsBlob({
      pipeline: true,
      dashboard: true,            // stale pre-split key seen in prod
      typo_feature: false,
      mobile: { schedule: false, bad_key: true },
    })
    expect(out).toEqual({ pipeline: true, mobile: { schedule: false } })
  })

  it('drops non-boolean values for permission keys', () => {
    const out = sanitizePermissionsBlob({ pipeline: 'yes', mobile: { schedule: 1 } })
    expect(out).toEqual({ mobile: {} })
  })

  it('preserves the named non-boolean mobile extras (layout, lead_time_overrides)', () => {
    const layout = { bar: ['schedule'], allowed: ['schedule', 'studio'] }
    const overrides = { tasks: 120 }
    const out = sanitizePermissionsBlob({
      mobile: { schedule: true, layout, lead_time_overrides: overrides, rogue_extra: {} },
    })
    expect(out.mobile.layout).toEqual(layout)
    expect(out.mobile.lead_time_overrides).toEqual(overrides)
    expect(out.mobile.rogue_extra).toBeUndefined()
  })

  it('non-object / null / array input → empty blob', () => {
    expect(sanitizePermissionsBlob(null)).toEqual({})
    expect(sanitizePermissionsBlob(undefined)).toEqual({})
    expect(sanitizePermissionsBlob('junk')).toEqual({})
    expect(sanitizePermissionsBlob([1, 2])).toEqual({})
  })

  it('round-trips a full hydrated blob unchanged (editor save path)', () => {
    const full = hydratePermissions(null, 'manager')
    expect(sanitizePermissionsBlob(full)).toEqual(full)
  })
})
