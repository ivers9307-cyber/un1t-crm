// C116 GATES-2 — contract decisions judged at the contract's (or template's)
// organisation, never at the active studio's role.
import { describe, it, expect } from 'vitest'
import { canManageContractsInOrg, canManageContractsSomewhere, canDownloadContractPdf } from './contract-gates'

const ORG_X = 'org-x'
const ORG_Y = 'org-y'
const master = { id: 'm', isMaster: true, role: 'master', rolesByLocation: {}, locations: [] }
const managerXOwnerY = {
  id: 'u1', isMaster: false, role: 'manager',
  rolesByLocation: { 'loc-x': 'manager', 'loc-y': 'owner' },
  locations: [{ id: 'loc-x', organization_id: ORG_X }, { id: 'loc-y', organization_id: ORG_Y }],
}
const adminX = { id: 'u2', isMaster: false, role: 'staff', rolesByLocation: { 'loc-x': 'staff' }, locations: [{ id: 'loc-x', organization_id: ORG_X }], orgAdminOrgIds: [ORG_X] }
const managerX = { id: 'u3', isMaster: false, role: 'manager', rolesByLocation: { 'loc-x': 'manager' }, locations: [{ id: 'loc-x', organization_id: ORG_X }] }

describe('canManageContractsInOrg', () => {
  it('master everywhere, including no org', () => {
    expect(canManageContractsInOrg(master, ORG_X)).toBe(true)
    expect(canManageContractsInOrg(master, null)).toBe(true)
  })
  it('an owner of the org, whatever the active studio', () => {
    expect(canManageContractsInOrg(managerXOwnerY, ORG_Y)).toBe(true)
    expect(canManageContractsInOrg(managerXOwnerY, ORG_X)).toBe(false)
  })
  it('an org admin of the org', () => expect(canManageContractsInOrg(adminX, ORG_X)).toBe(true))
  it('a manager is not enough, and a missing org or user is no', () => {
    expect(canManageContractsInOrg(managerX, ORG_X)).toBe(false)
    expect(canManageContractsInOrg(managerXOwnerY, null)).toBe(false)
    expect(canManageContractsInOrg(null, ORG_X)).toBe(false)
  })
})

describe('canManageContractsSomewhere', () => {
  it('master, an owner or an org admin anywhere', () => {
    expect(canManageContractsSomewhere(master)).toBe(true)
    expect(canManageContractsSomewhere(managerXOwnerY)).toBe(true)
    expect(canManageContractsSomewhere(adminX)).toBe(true)
  })
  it('nobody else', () => {
    expect(canManageContractsSomewhere(managerX)).toBe(false)
    expect(canManageContractsSomewhere(null)).toBe(false)
  })
})

describe('canDownloadContractPdf (the /pdf route\'s rule)', () => {
  const signed = { profile_id: 'p1', organization_id: ORG_X, status: 'signed', signed_pdf_path: 'contracts/c1/signed.pdf' }
  it('no PDF on file: nobody', () => expect(canDownloadContractPdf(master, { ...signed, signed_pdf_path: null })).toBe(false))
  it('the recipient, a master, an owner or admin of the org', () => {
    expect(canDownloadContractPdf({ ...managerX, id: 'p1' }, signed)).toBe(true)
    expect(canDownloadContractPdf(master, signed)).toBe(true)
    expect(canDownloadContractPdf(adminX, signed)).toBe(true)
  })
  it('a manager with the contracts permission who is none of those (the page showed it; the route 404s)', () => {
    expect(canDownloadContractPdf(managerX, signed)).toBe(false)
  })
  it('a recipient-only caller never gets a draft', () => {
    expect(canDownloadContractPdf({ ...managerX, id: 'p1' }, { ...signed, status: 'draft' })).toBe(false)
  })
})
