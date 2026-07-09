import { describe, it, expect } from 'vitest'
import { linkStaffDecision } from './host-staff-link'

describe('linkStaffDecision', () => {
  const staff = { id: 'u1', full_name: 'Sam', email: 's@x.ie' }
  it('ok: staff, same org, no existing link', () => {
    expect(linkStaffDecision({ staffProfile: staff, sameOrg: true, existingLink: null, hostId: 'h1' })).toBe('ok')
  })
  it('not_staff: no profiles row', () => {
    expect(linkStaffDecision({ staffProfile: null, sameOrg: true, existingLink: null, hostId: 'h1' })).toBe('not_staff')
  })
  it('cross_org: staff not in the admin org', () => {
    expect(linkStaffDecision({ staffProfile: staff, sameOrg: false, existingLink: null, hostId: 'h1' })).toBe('cross_org')
  })
  it('already: already linked to THIS host', () => {
    expect(linkStaffDecision({ staffProfile: staff, sameOrg: true, existingLink: { host_id: 'h1' }, hostId: 'h1' })).toBe('already')
  })
  it('other_host: linked to a different host', () => {
    expect(linkStaffDecision({ staffProfile: staff, sameOrg: true, existingLink: { host_id: 'h2' }, hostId: 'h1' })).toBe('other_host')
  })
  it('not_staff takes precedence', () => {
    expect(linkStaffDecision({ staffProfile: null, sameOrg: false, existingLink: { host_id: 'h2' }, hostId: 'h1' })).toBe('not_staff')
  })
})
