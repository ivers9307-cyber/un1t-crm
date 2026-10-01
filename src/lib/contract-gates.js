// C116 GATES-2 — who may manage a contract (or a contract template), and who
// may download a signed contract's PDF, judged at the RECORD's organisation.
//
// Contracts and contract templates are ORG-scoped (mig 106). Several routes,
// and their pages, first asked `user.role === 'owner'`: the role at the
// ACTIVE studio. These helpers are the one rule the routes and the pages
// share.
//
// C18 ORGROLE.1 (Richard, 1 Oct 2026): contracts are an organisation-level
// surface, so "manages contracts in an org" means an ORGANISATION ADMIN of
// it: a master or an org_admin grant (src/lib/org-admin.js). It used to be
// getOwnerOrganizationIds (an owner at ANY studio of the org counted); a
// studio owner is not an organisation admin. The recipient's own access to
// their contract is unchanged.
import { isOrgAdmin, isOrgAdminSomewhere } from './org-admin'

/**
 * Master, or an org admin of `organizationId`. A null org is master-only.
 *
 * @param {object|null} user           getCurrentUser() result
 * @param {string|null} organizationId the contract's / template's organization_id
 */
export function canManageContractsInOrg(user, organizationId) {
  return isOrgAdmin(user, organizationId)
}

/**
 * The coarse pre-check, before the row is read: master, or an org admin of
 * SOME organisation. Anyone else is refused without the id being looked up.
 */
export function canManageContractsSomewhere(user) {
  return isOrgAdminSomewhere(user)
}

/**
 * GET /api/contracts/[id]/pdf's rule, for the Download PDF link: a PDF is on
 * file, and the caller is the recipient, a master, or an org admin of the
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

/**
 * The /contracts/[id] action buttons, each shown exactly when its route would
 * act: Resend and Revoke (issued/viewed) and Send/Discard (draft) on
 * canManageContractsInOrg at the contract's org; Download PDF on the /pdf
 * route's rule. (Re-issue links to /contracts/issue, which with
 * POST /api/contracts still asks the active role; the page keeps that.)
 */
export function contractDetailActions(user, contract) {
  const manages = canManageContractsInOrg(user, contract?.organization_id)
  const status = contract?.status
  return {
    canResend: manages && (status === 'issued' || status === 'viewed'),
    canRevoke: manages && (status === 'issued' || status === 'viewed'),
    canManageDraft: manages && status === 'draft',
    canDownloadPdf: canDownloadContractPdf(user, contract),
  }
}
