// ADS-REPORT.3 — /dashboard/ads. Paid-ad performance: spend, cost per
// booked class, blended CTR, and a per-ad breakdown sorted by cost-
// efficiency. Gated on `dashboard_ads` (see shared/permissions.js —
// owner + manager by default; head_coach and staff off).
//
// v1 is provider-agnostic — loadAdsDashboard() doesn't distinguish
// Meta vs any future provider, so this page shows a single "Meta"
// label rather than provider-filter tabs. A TikTok tab is a later
// phase once a second provider actually lands rows in ad_entities.
//
// recharts (~150KB) must not ship in the server-rendered path, and
// Next 16 rejects `dynamic(..., { ssr: false })` inside a Server
// Component — so the lazy import lives in AdsTrendChartLazy.jsx (a
// 'use client' wrapper), same shape as MembershipPanel.jsx wrapping
// MembershipTrendChart.jsx.

import { redirect, notFound } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { loadAdsDashboard } from '@/lib/ads/read'
import { EmptyState } from '@/components/ui'
import AdsKpiStrip from '@/components/dashboard/AdsKpiStrip'
import AdsPerAdTable from '@/components/dashboard/AdsPerAdTable'
import AdsTrendChart from '@/components/dashboard/AdsTrendChartLazy'
import AdsRefreshButton from '@/components/dashboard/AdsRefreshButton'

export const dynamic = 'force-dynamic'

export default async function AdsDashboardPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // 404, not 403 — repo's IDOR convention (detail/gated routes don't
  // reveal their own existence to a user who lacks the permission).
  if (!hasPermission(user, 'dashboard_ads')) notFound()

  if (!user.activeLocation?.id) {
    return (
      <EmptyState
        title="Select a studio to view ads"
        description="Ad performance is scoped per location — choose an active studio to see spend and bookings."
      />
    )
  }

  const db = createServerClient()
  const locationId = user.activeLocation.id
  const dash = await loadAdsDashboard(db, locationId, 30)

  const { data: accounts } = await db
    .from('ad_accounts')
    .select('provider, last_sync_error, last_synced_at, is_active')
    .eq('location_id', locationId)

  const activeAccounts = (accounts || []).filter((a) => a.is_active)
  const providers = [...new Set(activeAccounts.map((a) => a.provider).filter(Boolean))]
  const erroringAccount = activeAccounts.find((a) => a.last_sync_error)
  const lastSynced = activeAccounts.map((a) => a.last_synced_at).filter(Boolean).sort().slice(-1)[0] || null

  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-1">
        <h2 className="text-xl font-bold text-un1t-text">
          Ads — {user.activeLocation.name || 'this location'}
        </h2>
        {providers.length > 0 && (
          <span className="inline-flex items-center rounded-full bg-blue-500/10 text-blue-700 text-xs font-medium px-2.5 py-1">
            {providers.map((p) => (p === 'meta' ? 'Meta' : p)).join(' · ')}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 mb-5">
        <p className="text-sm text-un1t-subtle">Last 30 days</p>
        <AdsRefreshButton locationId={locationId} lastSyncedAt={lastSynced} />
      </div>

      {erroringAccount && (
        <div className="rounded-lg bg-amber-500/10 text-amber-700 text-sm px-3 py-2 mb-5">
          Ad sync issue on {erroringAccount.provider === 'meta' ? 'Meta' : erroringAccount.provider}:{' '}
          {erroringAccount.last_sync_error}
        </div>
      )}

      <AdsKpiStrip kpis={dash.kpis} />

      {dash.perAd.length === 0 ? (
        <EmptyState
          title="No ad data yet"
          description="Connect a Meta ad account in Settings → Integrations → Ads to start seeing spend and bookings here."
        />
      ) : (
        <>
          <AdsTrendChart data={dash.trend} />
          <div className="mt-6">
            <AdsPerAdTable rows={dash.perAd} />
          </div>
        </>
      )}
    </>
  )
}
