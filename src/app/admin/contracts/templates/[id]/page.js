// /admin/contracts/templates/[id] — edit an existing template.
// Same form as /new with an extra "Active" toggle (soft-delete).

import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import ContractTemplateForm from '@/components/ContractTemplateForm'

export const dynamic = 'force-dynamic'

function isOwnerOrMaster(user) {
  return user?.role === 'master' || user?.role === 'owner'
}

export default async function EditTemplatePage(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!isOwnerOrMaster(user)) redirect('/')

  const db = createServerClient()
  const { data: template } = await db
    .from('contract_templates')
    .select('*')
    .eq('id', params.id)
    .maybeSingle()
  if (!template) notFound()

  return (
    <div className="p-6 md:p-8 max-w-5xl">
      <Link href="/admin/contracts/templates" className="text-xs text-un1t-subtle hover:text-un1t-text">
        ← Templates
      </Link>
      <h2 className="text-2xl font-bold mt-1 mb-1">{template.name}</h2>
      <p className="text-xs text-un1t-subtle mb-6">Version {template.version}{template.active ? '' : ' · archived'}</p>
      <ContractTemplateForm initial={template} isEdit />
    </div>
  )
}
