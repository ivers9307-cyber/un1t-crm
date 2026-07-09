import { describe, it, expect } from 'vitest'
import { canImpersonateHost, impersonationHostQueryAllowed, HOST_IMPERSONATE_COOKIE } from './host-impersonation'

describe('canImpersonateHost', () => {
  it('allows owner/manager/master', () => {
    for (const role of ['owner', 'manager', 'master']) {
      expect(canImpersonateHost({ id: 'u1', role })).toBe(true)
    }
  })
  it('denies staff/head_coach and null', () => {
    expect(canImpersonateHost({ id: 'u1', role: 'staff' })).toBe(false)
    expect(canImpersonateHost({ id: 'u1', role: 'head_coach' })).toBe(false)
    expect(canImpersonateHost(null)).toBe(false)
    expect(canImpersonateHost(undefined)).toBe(false)
  })
})

describe('impersonationHostQueryAllowed', () => {
  it('needs an admin AND a resolvable org', () => {
    expect(impersonationHostQueryAllowed({ role: 'owner', activeOrganization: { id: 'o1' } })).toBe(true)
    expect(impersonationHostQueryAllowed({ role: 'owner', activeLocation: { organization_id: 'o1' } })).toBe(true)
    expect(impersonationHostQueryAllowed({ role: 'owner' })).toBe(false)
    expect(impersonationHostQueryAllowed({ role: 'staff', activeOrganization: { id: 'o1' } })).toBe(false)
    expect(impersonationHostQueryAllowed(null)).toBe(false)
  })
})

describe('HOST_IMPERSONATE_COOKIE', () => {
  it('is the host view-as cookie name', () => {
    expect(HOST_IMPERSONATE_COOKIE).toBe('un1t_host_impersonate')
  })
})
