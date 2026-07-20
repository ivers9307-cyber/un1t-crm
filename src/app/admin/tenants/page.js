// /admin/tenants — master tenant-management console roster (INTEG-D2).
//
// Stat tiles (MRR / trials stub / past-due / top-ups MTD) + one row
// per ORGANIZATION: locations, pinned-plan summary, combined wallet
// balance, MTD usage snapshot, health (integrations attention + stale
// tenant heartbeats), drill-in link. Read-only — the console's single
// write (wallet adjustment) lives on the drill-in page.
//
// Today's two orgs (UN1T Group + CCF Autos) are both unpinned, so most
// money columns render "—" by design.
//
// Permissions: master-only page gate (profileRole), exactly like
// /admin/plans — no WEB_PERMISSIONS key, so no mobile-parity entry is
// needed (the parity linter only walks WEB_PERMISSIONS). The /admin
// layout is relaxed (STUDIO-GROUP.1), so the gate lives here.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getTenantsRoster } from '@/lib/admin-tenants'
import TenantsConsole from '@/components/admin/TenantsConsole'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function AdminTenantsPage() {
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') redirect('/')

  const db = createServerClient()
  const roster = await getTenantsRoster(db)

  return (
    <div className="p-6 md:p-8 max-w-6xl">
      <h2 className="text-2xl font-bold mb-1">Tenants</h2>
      <p className="text-sm text-un1t-subtle mb-6 max-w-3xl">
        Every organization on the platform: plan, wallet, month-to-date
        usage and health at a glance. Open a tenant for per-location
        detail and the wallet ledger.
      </p>
      <TenantsConsole roster={roster} />
    </div>
  )
}
