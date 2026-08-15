// /settings/glofox-import — interactive Glofox member import.
// ADMIN.2h Task 1 — moved out of /admin (was /admin/glofox-import);
// same page, gated standalone below (glofox_import permission), no
// dependency on the old /admin/layout.js relaxation.
//
// GLOFOX2.3 — operator-driven import page. Used for:
//   - Initial full pull (one-time backfill of every member).
//   - Filtered re-syncs ("re-pull every TRIAL member from yesterday").
//   - Diagnostic dry-runs (see what WOULD happen without committing).
//
// The daily cron (/api/cron/glofox-sync) handles ongoing syncing
// automatically. This page is for the human-in-the-loop case where
// the operator wants visibility on the data before applying.
//
// All the heavy lifting happens in /api/glofox/bulk-sync — this
// page is a thin orchestration layer over it. The status panel +
// run history reads from glofox_sync_runs (mig 141), which the cron
// already populates.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import GlofoxAdminTabs from '@/components/GlofoxAdminTabs'

export const dynamic = 'force-dynamic'

export default async function GlofoxImportPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // STUDIO-GROUP.1 — was master-only via profileRole; now uses
  // the `glofox_import` permission. Default still master-only via
  // role defaults; operators can grant per user from StaffForm.
  if (!hasPermission(user, 'glofox_import')) redirect('/')

  const db = createServerClient()

  // Status — counts of contacts already linked to Glofox at the
  // active location. Helps the operator see "how much is left to
  // pull" at a glance.
  const locationId = user.activeLocation?.id || null
  let crmContactsLinked = 0
  let crmContactsTotal = 0
  if (locationId) {
    const { count: linked } = await db
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .not('glofox_member_id', 'is', null)
    crmContactsLinked = linked || 0
    const { count: total } = await db
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
    crmContactsTotal = total || 0
  }

  // Recent runs — both cron-triggered nightly runs and any future
  // manual-import runs that elect to write here. Latest 10 across
  // all locations the master can see.
  const { data: recentRuns } = await db
    .from('glofox_sync_runs')
    .select('id, location_id, started_at, finished_at, duration_ms, pages_fetched, leads_processed, total_available, summary, first_error, status')
    .order('started_at', { ascending: false })
    .limit(10)

  return (
    <div className="p-8 max-w-7xl">
      <h2 className="text-2xl font-bold mb-1">Glofox sync</h2>
      <p className="text-sm text-un1t-subtle mb-6 max-w-3xl">
        Pull members from Glofox into the CRM, and review CRM → Glofox push events that
        need attention. Use the Import tab for backfills, ad-hoc re-syncs, and dry-run
        diagnostics; the Review tab surfaces any opt-in pushes (booking forms, event
        registrations, manual "Create in Glofox" button) that failed or need operator
        attention.
      </p>

      <GlofoxAdminTabs
        activeLocationId={locationId}
        activeLocationName={user.activeLocation?.name || ''}
        crmContactsLinked={crmContactsLinked}
        crmContactsTotal={crmContactsTotal}
        recentRuns={recentRuns || []}
      />
    </div>
  )
}
