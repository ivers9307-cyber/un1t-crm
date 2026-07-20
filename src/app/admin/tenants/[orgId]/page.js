// /admin/tenants/[orgId] — tenant drill-in (INTEG-D2).
//
// Org header + one block per location: pinned plan + version/price,
// wallet balance + period + last-50 ledger, MTD meters vs allowance
// (with the allowance-EXEMPT staff-assistant line shown separately),
// integrations health (reused from the hub assembler) and stale
// tenant heartbeats. The console's ONE write action — the master-only
// goodwill wallet adjustment — lives here, in the client component's
// modal (POST /api/admin/tenants/wallet-adjust).
//
// No org-level notes card: organizations has no notes/jsonb column
// today and D2 ships without a migration (see the PR body).
//
// Permissions: master-only page gate (profileRole), exactly like
// /admin/plans. The static /admin/tenants/new segment (the tenant
// wizard) takes precedence over this dynamic one.

import { redirect, notFound } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getTenantDetail } from '@/lib/admin-tenants'
import TenantDetailView from '@/components/admin/TenantDetailView'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export default async function AdminTenantDetailPage(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') redirect('/')

  if (!UUID_RE.test(params.orgId || '')) notFound()

  const db = createServerClient()
  const detail = await getTenantDetail(db, params.orgId)
  if (!detail) notFound()

  return (
    <div className="p-6 md:p-8 max-w-6xl">
      <TenantDetailView detail={detail} />
    </div>
  )
}
