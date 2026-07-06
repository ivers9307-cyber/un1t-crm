// Canonical resolver tests. Locks the contract that web's
// hasPermission() and mobile's canMobile() / canDashboard() all
// depend on. Anything that changes 3-tier semantics breaks here
// first, before subtle UI-visibility regressions ship.

import { describe, it, expect } from 'vitest'
import {
  resolvePermission,
  hydratePermissions,
  sanitizePermissionsBlob,
  diffPermissionsBlob,
  mergeTemplates,
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

// PERM-AUDIT.2 — tier 2.5: operator-edited role templates (mig 364).
describe('resolvePermission — tier 2.5 (role template)', () => {
  const base = {
    role: 'staff',
    location: { features: {} },
    defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
  }

  it('template explicit true beats a code default of false', () => {
    expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE.staff.email).toBe(false) // guard the premise
    expect(resolvePermission({
      ...base, permissions: null, roleTemplate: { email: true }, key: 'email',
    })).toBe(true)
  })

  it('template explicit false beats a code default of true', () => {
    expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE.staff.pipeline).toBe(true)
    expect(resolvePermission({
      ...base, permissions: null, roleTemplate: { pipeline: false }, key: 'pipeline',
    })).toBe(false)
  })

  it('per-user override (tier 2) still beats the template', () => {
    expect(resolvePermission({
      ...base, permissions: { email: false }, roleTemplate: { email: true }, key: 'email',
    })).toBe(false)
    expect(resolvePermission({
      ...base, permissions: { pipeline: true }, roleTemplate: { pipeline: false }, key: 'pipeline',
    })).toBe(true)
  })

  it('missing key in the template falls through to the code default', () => {
    expect(resolvePermission({
      ...base, permissions: null, roleTemplate: { email: true }, key: 'pipeline',
    })).toBe(true) // staff code default
  })

  it('location gate (tier 1) still beats the template', () => {
    expect(resolvePermission({
      ...base,
      location: { features: { email: false } },
      permissions: null, roleTemplate: { email: true }, key: 'email',
    })).toBe(false)
  })

  it('master ignores the template entirely', () => {
    expect(resolvePermission({
      role: 'master', location: { features: {} },
      permissions: null, roleTemplate: { pipeline: false },
      defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE, key: 'pipeline',
    })).toBe(true)
  })
})

describe('hydratePermissions — with a role template', () => {
  it('merges template between code defaults and stored values', () => {
    const out = hydratePermissions(
      { pipeline: false },                                   // user override
      'staff',
      { pipeline: true, email: true, mobile: { whatsapp: true } }  // template
    )
    expect(out.pipeline).toBe(false)   // user override wins over template
    expect(out.email).toBe(true)       // template wins over code default (false)
    expect(out.mobile.whatsapp).toBe(true) // template mobile wins over code default (false)
    expect(out.contacts).toBe(DEFAULT_WEB_PERMISSIONS_BY_ROLE.staff.contacts) // untouched keys = code default
  })

  it('a template mobile section does not clobber the top-level web merge', () => {
    const out = hydratePermissions(null, 'staff', { mobile: { whatsapp: true } })
    expect(out.mobile.whatsapp).toBe(true)
    expect(out.mobile.schedule).toBe(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE.staff.schedule)
    expect(out.pipeline).toBe(DEFAULT_WEB_PERMISSIONS_BY_ROLE.staff.pipeline)
  })
})

describe('diffPermissionsBlob — sparse diff vs a base blob', () => {
  it('stores only keys that differ from the base', () => {
    const base = hydratePermissions(null, 'staff')
    const full = { ...base, email: true, mobile: { ...base.mobile, whatsapp: true } }
    expect(diffPermissionsBlob(full, base)).toEqual({ email: true, mobile: { whatsapp: true } })
  })

  it('identical blobs diff to an empty object', () => {
    const base = hydratePermissions(null, 'manager')
    expect(diffPermissionsBlob({ ...base, mobile: { ...base.mobile } }, base)).toEqual({})
  })

  it('carries mobile extras when includeExtras is true, strips when false', () => {
    const base = hydratePermissions(null, 'staff')
    const layout = { bar: ['studio'] }
    const full = { ...base, mobile: { ...base.mobile, layout } }
    expect(diffPermissionsBlob(full, base).mobile.layout).toEqual(layout)
    expect(diffPermissionsBlob(full, base, { includeExtras: false })).toEqual({})
  })

  it('an explicit false differing from a base true is stored', () => {
    const base = hydratePermissions(null, 'owner')
    const full = { ...base, pipeline: false, mobile: { ...base.mobile } }
    expect(diffPermissionsBlob(full, base)).toEqual({ pipeline: false })
  })
})

// RECEPTION.1 — new front-of-house role (2026-07). Guard that the
// defaults maps are COMPLETE for it (a missing key would render as a
// phantom OFF in the editors and resolve false at tier 3), and pin
// the intent: staff-tier access plus the WhatsApp inbox + bookings desk.
describe('reception role defaults', () => {
  it('covers every web + mobile permission key (no gaps, no orphans)', async () => {
    const { WEB_PERMISSIONS, WEB_PERMISSION_KEYS, MOBILE_PERMISSION_KEYS } = await import('./permissions.js')
    // locationGateOnly keys (e.g. approvals_inbox — APPROVALS-PERCAT.1) are
    // derived-visibility aggregator cards, not directly-granted role perms,
    // so they're deliberately absent from every role default map.
    const directWebKeys = WEB_PERMISSIONS.filter(p => !p.locationGateOnly).map(p => p.key)
    const web = DEFAULT_WEB_PERMISSIONS_BY_ROLE.reception
    const mob = DEFAULT_MOBILE_PERMISSIONS_BY_ROLE.reception
    expect(directWebKeys.filter(k => !(k in web))).toEqual([])
    expect(Object.keys(web).filter(k => !WEB_PERMISSION_KEYS.includes(k))).toEqual([])
    expect(MOBILE_PERMISSION_KEYS.filter(k => !(k in mob))).toEqual([])
    expect(Object.keys(mob).filter(k => !MOBILE_PERMISSION_KEYS.includes(k))).toEqual([])
  })

  it('is staff-tier plus the front-desk surfaces', () => {
    const web = DEFAULT_WEB_PERMISSIONS_BY_ROLE.reception
    expect(web.whatsapp).toBe(true)            // the front-desk channel
    expect(web.bookings).toBe(true)
    expect(web.settings).toBe(false)           // no admin surfaces
    // approvals_inbox is now locationGateOnly (APPROVALS-PERCAT.1) — no
    // direct role grant; reception holds none of the six sub-permissions.
    expect(web.approvals_contractor_invoices).toBe(false)
    expect(web.approvals_fte_expenses).toBe(false)
    expect(web.approvals_agent_requests).toBe(false)
    expect(web.approvals_time_off).toBe(false)
    expect(web.approvals_shift_swaps).toBe(false)
    expect(web.approvals_rosters).toBe(false)
    const mob = DEFAULT_MOBILE_PERMISSIONS_BY_ROLE.reception
    expect(mob.whatsapp).toBe(true)
    expect(mob.bookings).toBe(true)
    expect(mob.notify_whatsapp).toBe(true)
    expect(mob.notify_bookings).toBe(true)
    expect(mob.approvals).toBe(false)
  })

  it('resolves through all tiers like any other role', () => {
    // Tier 3 default, tier 2.5 template flip, tier 2 user override.
    const args = { role: 'reception', location: { features: {} }, defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE }
    expect(resolvePermission({ ...args, permissions: null, key: 'email' })).toBe(false)
    expect(resolvePermission({ ...args, permissions: null, roleTemplate: { email: true }, key: 'email' })).toBe(true)
    expect(resolvePermission({ ...args, permissions: { email: false }, roleTemplate: { email: true }, key: 'email' })).toBe(false)
  })
})

// RECEPTION.2 (mig 367) — employment-type variant merging.
describe('mergeTemplates — variant over base', () => {
  it('merging two nulls yields null (no template)', () => {
    expect(mergeTemplates(null, null)).toBe(null)
    expect(mergeTemplates(undefined, undefined)).toBe(null)
  })

  it('variant keys win over base; mobile sub-objects merge not clobber', () => {
    const out = mergeTemplates(
      { email: true, pipeline: false, mobile: { whatsapp: true, schedule: false } },
      { pipeline: true, mobile: { schedule: true } }
    )
    expect(out).toEqual({
      email: true, pipeline: true,
      mobile: { whatsapp: true, schedule: true },
    })
  })

  it('base-only or variant-only passes through', () => {
    expect(mergeTemplates({ email: true }, null)).toEqual({ email: true })
    expect(mergeTemplates(null, { email: false })).toEqual({ email: false })
  })

  it('result feeds hydratePermissions like any single template', () => {
    const merged = mergeTemplates({ email: true }, { mobile: { tv_displays: true } })
    const out = hydratePermissions(null, 'staff', merged)
    expect(out.email).toBe(true)
    expect(out.mobile.tv_displays).toBe(true)
    expect(out.pipeline).toBe(DEFAULT_WEB_PERMISSIONS_BY_ROLE.staff.pipeline)
  })
})
