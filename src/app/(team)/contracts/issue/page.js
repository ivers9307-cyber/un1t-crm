// /contracts/issue — issue-a-contract wizard host page (moved from
// /admin/contracts/issue, HUBS.2d).
//
// CONTRACTS-DRAFT.1 — accepts ?from=<contractId> (re-issue prefill,
// linked from a revoked/declined contract's detail page, or from
// "Revoke & re-issue" on an issued/viewed one). Read here via
// searchParams (server component) and passed down as a plain prop —
// the wizard itself is a client component and can't call
// useSearchParams without also being wrapped in its own Suspense
// boundary, so threading it through the host page is simpler.

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { canManageContractsSomewhere } from '@/lib/contract-gates'
import ContractIssueWizard from '@/components/ContractIssueWizard'

export const dynamic = 'force-dynamic'

export default async function IssueContractPage(props) {
  const searchParams = await props.searchParams
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // GATES-3 (c) — POST /api/contracts' coarse rule (master, or an owner/admin
  // of SOME org; the submit is judged at the template's org), not the ACTIVE
  // studio's role, which refused an owner of another org working from a studio
  // where they are a manager, and an org admin whose own role there is not owner.
  if (!canManageContractsSomewhere(user)) redirect('/')

  const fromContractId = searchParams?.from || null
  // C140 — the issuer's own studios → their org, so the wizard lists only the
  // chosen template's org's people (POST /api/contracts refuses anyone else).
  const locationOrgs = Object.fromEntries(
    (user.locations || []).filter((l) => l?.id && l.organization_id).map((l) => [l.id, l.organization_id]),
  )

  return (
    <div className="p-6 md:p-8 max-w-3xl">
      <Link href="/contracts" className="text-xs text-un1t-subtle hover:text-un1t-text">
        ← Contracts
      </Link>
      <h2 className="text-2xl font-bold mt-1 mb-1">Issue a contract</h2>
      <p className="text-sm text-un1t-subtle mb-6">
        Pick a recipient and template, fill any custom variables, countersign, and send.
      </p>
      <ContractIssueWizard issuerName={user.full_name} fromContractId={fromContractId} locationOrgs={locationOrgs} />
    </div>
  )
}
