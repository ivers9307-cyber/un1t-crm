// /admin/contracts/templates/new — create a new contract template.

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import ContractTemplateForm from '@/components/ContractTemplateForm'

export const dynamic = 'force-dynamic'

function isOwnerOrMaster(user) {
  return user?.role === 'master' || user?.role === 'owner'
}

export default async function NewTemplatePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!isOwnerOrMaster(user)) redirect('/')

  return (
    <div className="p-6 md:p-8 max-w-5xl">
      <Link href="/admin/contracts/templates" className="text-xs text-un1t-subtle hover:text-un1t-text">
        ← Templates
      </Link>
      <h2 className="text-2xl font-bold mt-1 mb-6">New template</h2>
      <ContractTemplateForm />
    </div>
  )
}
