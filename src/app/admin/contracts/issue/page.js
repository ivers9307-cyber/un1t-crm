// /admin/contracts/issue — issue-a-contract wizard host page.

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import ContractIssueWizard from '@/components/ContractIssueWizard'

export const dynamic = 'force-dynamic'

function isOwnerOrMaster(user) {
  return user?.role === 'master' || user?.role === 'owner'
}

export default async function IssueContractPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!isOwnerOrMaster(user)) redirect('/')

  return (
    <div className="p-6 md:p-8 max-w-3xl">
      <Link href="/admin/contracts" className="text-xs text-un1t-light hover:text-un1t-white">
        ← Contracts
      </Link>
      <h2 className="text-2xl font-bold mt-1 mb-1">Issue a contract</h2>
      <p className="text-sm text-un1t-light mb-6">
        Pick a recipient and template, fill any custom variables, countersign, and send.
      </p>
      <ContractIssueWizard issuerName={user.full_name} />
    </div>
  )
}
