// /admin/tenant-domains — master-only manager for the DB tier of the
// multi-brand hostname registry (SAAS-8, mig 415). One row = one
// tenant domain live on the shared deployment, no deploy needed.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import TenantDomainsAdmin from '@/components/TenantDomainsAdmin'

export const dynamic = 'force-dynamic'

export default async function AdminTenantDomainsPage() {
  // Page-level master gate (the /admin layout is relaxed — STUDIO-GROUP.1).
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') redirect('/')

  const db = createServerClient()
  const [{ data: domains }, { data: organizations }] = await Promise.all([
    db.from('tenant_domains')
      .select('id, hostname, organization_id, brand, active, created_at, organizations:organization_id (name, slug)')
      .order('hostname'),
    db.from('organizations').select('id, name, slug').order('name'),
  ])

  return (
    <div className="p-8 max-w-4xl">
      <h2 className="text-2xl font-bold mb-1">Tenant domains</h2>
      <p className="text-sm text-un1t-subtle mb-8 max-w-3xl">
        Map a custom domain to a tenant organization. Point the domain&apos;s
        DNS at this deployment, add it here, and it goes live within ~5
        minutes — no deploy. The three legacy hostnames (CRM, UN1T
        marketing, CCF pay) stay in code and can&apos;t be added here.
      </p>
      <TenantDomainsAdmin
        initialDomains={domains || []}
        organizations={organizations || []}
      />
    </div>
  )
}
