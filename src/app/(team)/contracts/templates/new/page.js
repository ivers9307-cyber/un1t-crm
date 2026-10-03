// /contracts/templates/new — create a new contract template (moved
// from /admin/contracts/templates/new, HUBS.2d).

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { canManageContractsInOrg } from '@/lib/contract-gates'
import ContractTemplateForm from '@/components/ContractTemplateForm'

export const dynamic = 'force-dynamic'

export default async function NewTemplatePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // GATES-2 — POST /api/contract-templates creates in the ACTIVE org and asks
  // exactly this.
  if (!canManageContractsInOrg(user, user.activeOrganization?.id || null)) redirect('/')

  return (
    <div className="p-6 md:p-8 max-w-5xl">
      <Link href="/contracts/templates" className="text-xs text-un1t-subtle hover:text-un1t-text">
        ← Templates
      </Link>
      <h2 className="text-2xl font-bold mt-1 mb-6">New template</h2>
      <ContractTemplateForm />
    </div>
  )
}
