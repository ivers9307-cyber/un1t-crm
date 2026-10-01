import { describe, it, expect } from 'vitest'
import {
  isOrgAdmin, isOrgAdminSomewhere, adminOrganizationIds,
  activeOrganizationId, isActiveOrgAdmin, resolveAdminOrgId,
} from './org-admin'

const ORG = 'org-1'
const OTHER = 'org-2'
const MASTER = { isMaster: true, role: 'master', orgAdminOrgIds: [], activeOrganization: { id: ORG } }
const ADMIN = { isMaster: false, role: 'staff', orgAdminOrgIds: [ORG], activeOrganization: { id: ORG } }
// An owner at every studio of the org, with no org_admin grant: NOT an org admin.
const OWNER_EVERYWHERE = {
  isMaster: false, role: 'owner', orgAdminOrgIds: [],
  rolesByLocation: { a: 'owner', b: 'owner' },
  locations: [{ id: 'a', organization_id: ORG }, { id: 'b', organization_id: ORG }],
  activeOrganization: { id: ORG },
}
const ADMIN_ELSEWHERE = { isMaster: false, role: 'owner', orgAdminOrgIds: [OTHER], activeOrganization: { id: ORG } }

describe('isOrgAdmin', () => {
  it('a master manages every organisation (an org-less resource too)', () => {
    expect(isOrgAdmin(MASTER, ORG)).toBe(true)
    expect(isOrgAdmin(MASTER, null)).toBe(true)
    expect(isOrgAdmin({ role: 'master' }, ORG)).toBe(true)
  })
  it('an org_admin grant manages that organisation only, whatever the role at the active studio', () => {
    expect(isOrgAdmin(ADMIN, ORG)).toBe(true)
    expect(isOrgAdmin(ADMIN, OTHER)).toBe(false)
    expect(isOrgAdmin(ADMIN, null)).toBe(false)
  })
  it('a studio owner (even of every studio) is not an organisation admin', () => {
    expect(isOrgAdmin(OWNER_EVERYWHERE, ORG)).toBe(false)
  })
  it('no user is nobody', () => {
    expect(isOrgAdmin(null, ORG)).toBe(false)
    expect(isOrgAdminSomewhere(null)).toBe(false)
    expect(adminOrganizationIds(null)).toEqual([])
  })
})

describe('isOrgAdminSomewhere / adminOrganizationIds', () => {
  it('counts grants only', () => {
    expect(isOrgAdminSomewhere(MASTER)).toBe(true)
    expect(isOrgAdminSomewhere(ADMIN)).toBe(true)
    expect(isOrgAdminSomewhere(OWNER_EVERYWHERE)).toBe(false)
    expect(adminOrganizationIds({ orgAdminOrgIds: [ORG, ORG, OTHER] })).toEqual([ORG, OTHER])
    expect(adminOrganizationIds(OWNER_EVERYWHERE)).toEqual([])
  })
})

describe('active organisation', () => {
  it('reads activeOrganization, else the active studio\'s organisation', () => {
    expect(activeOrganizationId({ activeOrganization: { id: ORG } })).toBe(ORG)
    expect(activeOrganizationId({ activeLocation: { organization_id: OTHER } })).toBe(OTHER)
    expect(activeOrganizationId({})).toBe(null)
  })
  it('isActiveOrgAdmin judges the active organisation', () => {
    expect(isActiveOrgAdmin(ADMIN)).toBe(true)
    expect(isActiveOrgAdmin(ADMIN_ELSEWHERE)).toBe(false)
    expect(isActiveOrgAdmin(OWNER_EVERYWHERE)).toBe(false)
    expect(isActiveOrgAdmin(MASTER)).toBe(true)
  })
})

describe('resolveAdminOrgId', () => {
  it('a master: the requested org, else the active one', () => {
    expect(resolveAdminOrgId(MASTER, OTHER)).toEqual({ orgId: OTHER })
    expect(resolveAdminOrgId(MASTER, null)).toEqual({ orgId: ORG })
    expect(resolveAdminOrgId({ ...MASTER, activeOrganization: null }, null)).toEqual({ orgId: null })
  })
  it('an org admin: their org; a foreign org is not found (no existence probe)', () => {
    expect(resolveAdminOrgId(ADMIN, null)).toEqual({ orgId: ORG })
    expect(resolveAdminOrgId(ADMIN, ORG)).toEqual({ orgId: ORG })
    expect(resolveAdminOrgId(ADMIN, OTHER)).toEqual({ notFound: true })
  })
  it('falls back to the first admin org only when there is no active one', () => {
    expect(resolveAdminOrgId({ ...ADMIN_ELSEWHERE, activeOrganization: null }, null)).toEqual({ orgId: OTHER })
    // Working in an org they do not administer: no access (403), not a 404.
    expect(resolveAdminOrgId(ADMIN_ELSEWHERE, null)).toEqual({ orgId: null })
    expect(resolveAdminOrgId(ADMIN_ELSEWHERE, OTHER)).toEqual({ orgId: OTHER })
  })
  it('a studio owner with no grant resolves nothing', () => {
    expect(resolveAdminOrgId(OWNER_EVERYWHERE, null)).toEqual({ orgId: null })
    expect(resolveAdminOrgId(OWNER_EVERYWHERE, ORG)).toEqual({ notFound: true })
    expect(resolveAdminOrgId({ ...OWNER_EVERYWHERE, activeOrganization: null }, null)).toEqual({ orgId: null })
  })
})
