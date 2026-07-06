// APPROVALS-PERCAT.1 — approvals_inbox becomes a DERIVED check in the
// web adapter: visible iff the Approvals feature is enabled at the
// user's active location AND the user holds >=1 of the six per-category
// approval grants. Every consumer (nav, /approvals page guard, command
// palette, today-feed badge) calls hasPermission(), so this one
// definition covers them all. See shared/permissions.js for the
// canonical per-category keys + isFeatureEnabledAtLocation.

import { describe, it, expect } from 'vitest'
import { hasPermission } from './permissions.js'

function user({ role = 'staff', features = {}, perms = {} } = {}) {
  return {
    role,
    activeLocation: { id: 'loc1', features },
    activeAssignment: { permissions: perms },
    activeRoleTemplate: null,
  }
}

describe('derived approvals_inbox', () => {
  it('true when feature on and the user holds >=1 category (role default)', () => {
    expect(hasPermission(user({ role: 'manager' }), 'approvals_inbox')).toBe(true)
  })

  it('false when the user holds no category', () => {
    expect(hasPermission(user({ role: 'staff' }), 'approvals_inbox')).toBe(false)
  })

  it('true for staff granted a single category via per-user override', () => {
    const u = user({ role: 'staff', perms: { approvals_time_off: true } })
    expect(hasPermission(u, 'approvals_inbox')).toBe(true)
    expect(hasPermission(u, 'approvals_time_off')).toBe(true)
    expect(hasPermission(u, 'approvals_contractor_invoices')).toBe(false)
  })

  it('false when the approvals feature is disabled at the location, even for owner', () => {
    const u = user({ role: 'owner', features: { approvals_inbox: false } })
    expect(hasPermission(u, 'approvals_inbox')).toBe(false)
  })
})
