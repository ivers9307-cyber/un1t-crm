// /admin/tenant-domains — master-only manager for the DB tier of the
// multi-brand hostname registry (SAAS-8, mig 415). One row = one
// tenant domain live on the shared deployment, no deploy needed.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getLegacyBrandRows } from '@/lib/brands'
import TenantDomainsAdmin from '@/components/TenantDomainsAdmin'

export const dynamic = 'force-dynamic'

export default async function AdminTenantDomainsPage() {
  // Page-level master gate (the /admin layout is relaxed — STUDIO-GROUP.1).
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') redirect('/')

  const db = createServerClient()
  const [{ data: domains }, { data: organizations }, { data: locations }] = await Promise.all([
    db.from('tenant_domains')
      .select('id, hostname, organization_id, location_id, brand, active, created_at, organizations:organization_id (name, slug), locations:location_id (name)')
      .order('hostname'),
    db.from('organizations').select('id, name, slug').order('name'),
    // Org-locations source for the optional per-location dropdown
    // (mig 432). Master reads every org's real studios; the form
    // filters to the picked org client-side. Host-anchor placeholders
    // excluded (they aren't real studios).
    db.from('locations')
      .select('id, name, organization_id')
      .eq('active', true)
      .eq('is_host_anchor', false)
      .order('name'),
  ])

  return (
    <div className="p-8 max-w-5xl">
      <h2 className="text-2xl font-bold mb-1">Tenant domains</h2>
      <p className="text-sm text-un1t-subtle mb-8 max-w-3xl">
        Map a custom domain to a tenant organization — and, optionally, to a
        single studio inside it. Point the domain&apos;s DNS at this deployment,
        add it here, and it goes live within ~5 minutes — no deploy. The legacy
        hostnames (CRM, UN1T marketing, CCF pay, host portal) stay in code and
        can&apos;t be added here; they&apos;re shown below for reference.
      </p>
      <TenantDomainsAdmin
        initialDomains={domains || []}
        organizations={organizations || []}
        locations={locations || []}
        legacyDomains={getLegacyBrandRows()}
      />
    </div>
  )
}
