// C116 GATES-2 — who may manage a contract (or a contract template), and who
// may download a signed contract's PDF, judged at the RECORD's organisation.
//
// Contracts and contract templates are ORG-scoped (mig 106). The routes have
// always scoped the row with getOwnerOrganizationIds() (per-location owner
// roles mapped to their orgs, plus org-admin grants), but several of them,
// and their pages, first asked `user.role === 'owner'`: the role at the
// ACTIVE studio. That refused an owner of the contract's org who happened to
// be working from a studio where they are a manager, and an org admin whose
// own assignment at the active studio is not owner. These helpers are the one
// rule the routes and the pages now share. Server-only (auth.js).
import { getOwnerOrganizationIds } from './auth'

/**
 * Master, or an owner/org admin of `organizationId`. A null org is master-only.
 *
 * @param {object|null} user           getCurrentUser() result
 * @param {string|null} organizationId the contract's / template's organization_id
 */
export function canManageContractsInOrg(user, organizationId) {
  if (!user) return false
  if (user.isMaster) return true
  if (!organizationId) return false
  return getOwnerOrganizationIds(user).includes(organizationId)
}

/**
 * The coarse pre-check, before the row is read: master, or an owner/org admin
 * of SOME organisation. Anyone else is refused without the id being looked up.
 */
export function canManageContractsSomewhere(user) {
  if (!user) return false
  return Boolean(user.isMaster) || getOwnerOrganizationIds(user).length > 0
}

/**
 * GET /api/contracts/[id]/pdf's rule, for the Download PDF link: a PDF is on
 * file, and the caller is the recipient, a master, or an owner/admin of the
 * contract's org. A recipient-only caller never gets a draft (a draft never has
 * a PDF anyway; kept identical to the route).
 *
 * @param {object|null} user
 * @param {{ profile_id?: string, organization_id?: string, status?: string, signed_pdf_path?: string|null }|null} contract
 */
export function canDownloadContractPdf(user, contract) {
  if (!user || !contract?.signed_pdf_path) return false
  const isRecipient = contract.profile_id === user.id
  const manages = canManageContractsInOrg(user, contract.organization_id)
  if (!isRecipient && !manages) return false
  if (contract.status === 'draft' && !manages) return false
  return true
}
