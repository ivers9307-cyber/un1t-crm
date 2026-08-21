// HUBDOOR.1 — one definition of "who handles issues", shared by the
// /issues page and the six handler API routes.
//
// The defect these pin: `issues_inbox` is a registered, grantable key that
// the ⌘K palette gates its Issues command on, but every issues surface
// gated on roles alone. Granting the key to a manager produced a command
// that redirected them to '/'. The `honours the grantable key` cases below
// FAIL against the pre-HUBDOOR.1 role-only isHandler().

import { describe, it, expect } from 'vitest'
import { isIssueHandler } from './issues-access'
import { DEFAULT_WEB_PERMISSIONS_BY_ROLE } from '@shared/permissions'

// A user shaped the way getCurrentUser() returns one: `role` is the
// ACTIVE-LOCATION role, `profileRole` the canonical one.
const user = (role, { perms = {}, features = {}, profileRole } = {}) => ({
  role,
  profileRole: profileRole || role,
  activeLocation: { id: 'loc-1', features },
  activeAssignment: { role, permissions: perms },
  activeRoleTemplate: null,
})

describe('isIssueHandler — roles (unchanged behaviour)', () => {
  it('admits an owner', () => {
    expect(isIssueHandler(user('owner'))).toBe(true)
  })

  it('admits a master, including one whose active assignment is staff', () => {
    expect(isIssueHandler(user('master'))).toBe(true)
    expect(isIssueHandler(user('staff', { profileRole: 'master' }))).toBe(true)
    expect(isIssueHandler({ role: 'staff', isMaster: true })).toBe(true)
  })

  it('rejects nobody', () => {
    expect(isIssueHandler(null)).toBe(false)
    expect(isIssueHandler(undefined)).toBe(false)
  })
})

describe('isIssueHandler — honours the grantable issues_inbox key', () => {
  it('rejects a manager on role defaults (the key is off for them)', () => {
    expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE.manager.issues_inbox).toBe(false)
    expect(isIssueHandler(user('manager'))).toBe(false)
  })

  it('admits a manager granted the key per-user', () => {
    expect(isIssueHandler(user('manager', { perms: { issues_inbox: true } }))).toBe(true)
  })

  it('admits a head_coach granted the key by role template (mig 364 tier 2.5)', () => {
    const u = user('head_coach')
    u.activeRoleTemplate = { issues_inbox: true }
    expect(isIssueHandler(u)).toBe(true)
  })

  it('a per-user false still beats the role template (tier 2 wins)', () => {
    const u = user('head_coach', { perms: { issues_inbox: false } })
    u.activeRoleTemplate = { issues_inbox: true }
    expect(isIssueHandler(u)).toBe(false)
  })

  it('rejects a staff member with no grant', () => {
    expect(isIssueHandler(user('staff'))).toBe(false)
  })
})

describe('isIssueHandler — the two accepted asymmetries, stated not discovered', () => {
  // The fix is additive: roles keep working. Revoking the key from an
  // owner therefore still changes nothing — making the key authoritative
  // would mean dropping the role bypass, a tightening this branch does
  // not make.
  it('an owner with issues_inbox explicitly revoked is STILL a handler (role bypass)', () => {
    expect(isIssueHandler(user('owner', { perms: { issues_inbox: false } }))).toBe(true)
  })

  // hasPermission honours the per-location feature gate, so the KEY path
  // respects a studio that switched Issues off — while the ROLE path does
  // not. Prod has one such location.
  it('the location feature gate closes the KEY path but not the ROLE path', () => {
    const off = { issues_inbox: false }
    expect(isIssueHandler(user('manager', { perms: { issues_inbox: true }, features: off }))).toBe(false)
    expect(isIssueHandler(user('owner', { features: off }))).toBe(true)
  })
})
