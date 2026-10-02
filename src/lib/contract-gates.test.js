// C116 GATES-2 — contract decisions judged at the contract's (or template's)
// organisation, never at the active studio's role.
import { describe, it, expect } from 'vitest'
import { canManageContractsInOrg, canManageContractsSomewhere, canDownloadContractPdf, contractDetailActions } from './contract-gates'

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

describe('contractDetailActions (/contracts/[id]\'s buttons, each its route\'s rule)', () => {
  const c = (status, extra = {}) => ({ id: 'c1', profile_id: 'p1', organization_id: ORG_Y, status, signed_pdf_path: null, ...extra })
  it('an owner of the contract\'s org whose ACTIVE role is manager gets the actions (main: none)', () => {
    expect(contractDetailActions(managerXOwnerY, c('issued'))).toMatchObject({ canResend: true, canRevoke: true, canManageDraft: false })
    expect(contractDetailActions(managerXOwnerY, c('draft')).canManageDraft).toBe(true)
  })
  it('an owner of ANOTHER org gets none, whatever the active role', () => {
    const ownerXActive = { ...managerXOwnerY, role: 'owner', rolesByLocation: { 'loc-x': 'owner', 'loc-y': 'manager' } }
    expect(contractDetailActions(ownerXActive, c('issued'))).toEqual({ canResend: false, canRevoke: false, canManageDraft: false, canDownloadPdf: false, canReissue: false })
    expect(contractDetailActions(ownerXActive, c('revoked')).canReissue).toBe(false)
  })
  it('status still decides which action applies', () => {
    expect(contractDetailActions(master, c('signed'))).toMatchObject({ canResend: false, canRevoke: false, canManageDraft: false })
  })
  it('Download PDF follows the /pdf route: not for a contracts-permission manager (main: shown, then 404)', () => {
    const signed = c('signed', { signed_pdf_path: 'contracts/c1/signed.pdf' })
    expect(contractDetailActions(managerX, { ...signed, organization_id: ORG_X }).canDownloadPdf).toBe(false)
    expect(contractDetailActions(adminX, { ...signed, organization_id: ORG_X }).canDownloadPdf).toBe(true)
  })
})

// C120 GATES-3 (c) — Re-issue opens /contracts/issue?from=<id>, whose prefill
// GET /api/contracts/[id] and POST /api/contracts decide at the contract's
// (template's) org: an owner/admin of it, or a master. Not the active role.
describe('contractDetailActions.canReissue (GATES-3)', () => {
  const c = (status) => ({ id: 'c1', profile_id: 'p1', organization_id: ORG_Y, status, signed_pdf_path: null })
  it('a revoked or declined contract, for an owner of its org whose ACTIVE role is manager (main: none)', () => {
    expect(contractDetailActions(managerXOwnerY, c('revoked')).canReissue).toBe(true)
    expect(contractDetailActions(managerXOwnerY, c('declined')).canReissue).toBe(true)
    expect(contractDetailActions(master, c('declined')).canReissue).toBe(true)
  })
  it('never for another status', () => {
    for (const s of ['draft', 'issued', 'viewed', 'signed']) expect(contractDetailActions(master, c(s)).canReissue).toBe(false)
  })
  it('never for a caller who does not manage the contract\'s org, even an owner at the active studio', () => {
    const ownerXActive = { ...managerXOwnerY, role: 'owner', rolesByLocation: { 'loc-x': 'owner', 'loc-y': 'manager' } }
    expect(contractDetailActions(ownerXActive, c('revoked')).canReissue).toBe(false)
    expect(contractDetailActions(managerX, c('revoked')).canReissue).toBe(false)
  })
})
