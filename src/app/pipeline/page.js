// PIPELINE5.8 — Kanban for the new engagement-aware taxonomy.
//
// What changed vs pre-5.8:
//   1. Tabs: Active (default) vs Dormant. The dormant view surfaces
//      stages flagged is_dormant=true (mig 147 — currently
//      `dormant` and `dormant_classpass`). Operator can still target
//      these via audience filters; the tab gives a one-click view.
//   2. Server-side filtering on stages — only fetch deals belonging
//      to the selected view's stages. Cuts the payload after the
//      Glofox import roughly in half because most ghost deals end
//      up in dormant.
//   3. Limit raised from Supabase's implicit 1000 to 10_000. UN1T
//      currently has ~8.1k open deals; this gives headroom without
//      switching to per-stage pagination yet.
//   4. archived=false filter so the future cleanup migration that
//      retires the OLD 1:1-Glofox-status stages doesn't need a UI
//      change — flipping archived=true on those rows hides them.

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import KanbanBoard from '@/components/KanbanBoard'
import PipelineViewSwitcher from '@/components/PipelineViewSwitcher'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const DEALS_HARD_LIMIT = 10_000

export default async function PipelinePage({ searchParams }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const locationId = user.activeLocation?.id

  // searchParams is async in Next 15; stays a sync object on 14. Defend
  // against both shapes — `await Promise.resolve(...)` is a no-op on a
  // plain object and unwraps the promise on 15.
  const sp = (await Promise.resolve(searchParams)) || {}
  const view = sp?.view === 'dormant' ? 'dormant' : 'active'

  const db = createServerClient()

  // 1. Stages — split between active vs dormant. Always exclude
  //    archived. We need BOTH counts (for the tab badges) so do two
  //    queries: full stage list scoped to non-archived, then filter
  //    in-app.
  const { data: allStages } = await db
    .from('pipeline_stages')
    .select('*')
    .eq('location_id', locationId)
    .eq('archived', false)
    .order('display_order')

  const activeStages = (allStages || []).filter((s) => !s.is_dormant)
  const dormantStages = (allStages || []).filter((s) => s.is_dormant)
  const visibleStages = view === 'dormant' ? dormantStages : activeStages
  const visibleStageIds = visibleStages.map((s) => s.id)

  // 2. Deals — limit to the visible stages only so the dormant ghosts
  //    don't get loaded on the active view (and vice versa). Empty
  //    visibleStageIds → return zero deals (avoids a degenerate
  //    .in('stage_id', []) which Supabase rejects).
  //
  //    PIPELINE5.11 fix: same PostgREST 1k cap that bit reclassify
  //    contacts read, reclassify deals read, and invoice-backfill
  //    contact lookup. .limit(10_000) was silently capped at 1000,
  //    and with .order('created_at', desc) the visible 1000 were
  //    the newest deals — which is mostly New Lead, so older Active
  //    Members got truncated and the column read 82 instead of 258.
  //    Page through with .range() up to DEALS_HARD_LIMIT.
  const PAGE_SIZE = 1000
  const deals = []
  if (visibleStageIds.length > 0) {
    let pageStart = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, DEALS_HARD_LIMIT - 1)
      const { data: page, error } = await db
        .from('deals')
        .select('*, contacts(*)')
        .eq('status', 'open')
        .eq('location_id', locationId)
        .in('stage_id', visibleStageIds)
        .order('created_at', { ascending: false })
        .range(pageStart, pageEnd)
      if (error) break
      if (!Array.isArray(page) || page.length === 0) break
      deals.push(...page)
      if (page.length < PAGE_SIZE) break
      if (deals.length >= DEALS_HARD_LIMIT) break
      pageStart += PAGE_SIZE
    }
  }

  // 3. Tab badges — total open-deal counts per view. Use HEAD count
  //    queries (no row payload) so this stays cheap.
  const [{ count: activeCount }, { count: dormantCount }] = await Promise.all([
    activeStages.length > 0
      ? db.from('deals').select('id', { count: 'exact', head: true })
          .eq('status', 'open').eq('location_id', locationId)
          .in('stage_id', activeStages.map((s) => s.id))
      : Promise.resolve({ count: 0 }),
    dormantStages.length > 0
      ? db.from('deals').select('id', { count: 'exact', head: true })
          .eq('status', 'open').eq('location_id', locationId)
          .in('stage_id', dormantStages.map((s) => s.id))
      : Promise.resolve({ count: 0 }),
  ])

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold">Pipeline</h2>
        <span className="text-sm text-un1t-light">
          {deals.length.toLocaleString()} {view === 'dormant' ? 'dormant' : 'active'} deals
          {deals.length === DEALS_HARD_LIMIT && (
            <span className="ml-2 text-amber-400">(showing first {DEALS_HARD_LIMIT.toLocaleString()})</span>
          )}
        </span>
      </div>

      <PipelineViewSwitcher
        view={view}
        activeCount={activeCount || 0}
        dormantCount={dormantCount || 0}
      />

      <KanbanBoard
        initialStages={visibleStages}
        initialDeals={deals}
        locationId={locationId}
      />
    </div>
  )
}
