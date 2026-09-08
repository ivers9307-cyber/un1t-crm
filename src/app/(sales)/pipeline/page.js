// FUNNEL.1 — read-only funnel board.
//
// PIPELINES.6 — the tabs come from the `pipelines` table (mig 594), not from a
// hardcoded list. The page resolves the location's enabled boards first, picks
// the active one from ?pipeline=<key> (first board otherwise), and scopes the
// stage query to that board's pipeline_id. `pipeline_stages.board` (mig 558) is
// no longer read anywhere — pipelines.key replaces it; the column stays on disk
// until a later migration drops it.
//
// Views within a DERIVED board: Funnel (default) vs Off funnel. The funnel view
// shows the classifier-derived journey stages (new_lead → first_class →
// second_class → trial_done → converted, is_dormant=false); the Off funnel view
// (?view=dormant) shows the parked piles (member / classpass / dormant,
// is_dormant=true). The param value stays `dormant` — operators have bookmarked
// it.
//
// A MANUAL board (pipelines.mode='manual') has no view split: nothing is "off
// funnel" when a human decides where each card sits, so every live column
// renders in one view and the toggle is not drawn.
//
// The derived board is read-only: every column is set by the classifier
// (webhook + nightly cron), so drag-drop was removed — a manual move would be
// silently overwritten on the next classify pass. `manual` is threaded down to
// KanbanBoard for the drag-drop that a manual board CAN have (PIPELINES.10).
//
// Funnel view only: each deal's contact ships a server-derived `next_class_at`
// badge (soonest future BOOKED class from contacts.recent_bookings), and the
// raw jsonb is stripped before the payload leaves the server.
//
// Still true from PIPELINE5.8:
//   - Server-side filtering on stages — only fetch deals belonging to the
//     selected view's stages.
//   - archived=false filter so retiring old stages needs no UI change.

import { createServerClient } from '@/lib/supabase'
import { pipelineDealSelect, toBoardDeal, PIPELINE_PAGE_SIZE } from '@/lib/pipeline-board'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { redirect } from 'next/navigation'
import KanbanBoard from '@/components/KanbanBoard'
import PipelineViewSwitcher from '@/components/PipelineViewSwitcher'
import { splitStagesByFunnel } from '@/lib/pipeline-classifier'

export const dynamic = 'force-dynamic'

export default async function PipelinePage(props) {
  const searchParams = await props.searchParams;
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'pipeline')) redirect('/')
  const locationId = user.activeLocation?.id

  // searchParams is async in Next 15; stays a sync object on 14. Defend
  // against both shapes — `await Promise.resolve(...)` is a no-op on a
  // plain object and unwraps the promise on 15.
  const sp = (await Promise.resolve(searchParams)) || {}
  // Anything unrecognised falls back to 'active', so an old bookmarked URL
  // behaves exactly as before.
  const requestedView = sp?.view === 'dormant' ? 'dormant' : 'active'
  const requestedPipeline = typeof sp?.pipeline === 'string' ? sp.pipeline : null

  const db = createServerClient()

  // 0. Boards. Only ENABLED rows render — CCF Autos, SourceIt and Test Studio
  //    hold a disabled row purely so their stray stage rows have a parent
  //    (mig 594), and Stillorgan's `returning` board is parked. display_order
  //    is the tab order.
  const { data: pipelineRows, error: pipelinesError } = await db
    .from('pipelines')
    .select('id, key, name, mode')
    .eq('location_id', locationId)
    .eq('enabled', true)
    .order('display_order', { ascending: true })
  if (pipelinesError) throw new Error(`pipeline load: ${pipelinesError.message}`)

  const pipelines = pipelineRows || []
  // ?pipeline=<key> picks the board; an unknown or absent key falls back to the
  // first, so a stale bookmark lands on a real board rather than an empty page.
  const activePipeline = pipelines.find((p) => p.key === requestedPipeline) || pipelines[0] || null

  if (!activePipeline) {
    return (
      <div className="p-6">
        <h2 className="text-2xl font-bold mb-4">Pipeline</h2>
        <p className="text-sm text-un1t-subtle">No pipeline is configured for this location.</p>
      </div>
    )
  }

  const manual = activePipeline.mode === 'manual'
  // A manual board draws no view toggle, so it can only ever be the one view —
  // otherwise a bookmarked ?view=dormant would strand the operator on a screen
  // with no way back.
  const view = manual ? 'active' : requestedView

  // 1. Stages — this BOARD's stages, split between active vs dormant. Always
  //    exclude archived. We need BOTH counts (for the tab badges) so do two
  //    queries: full stage list scoped to non-archived, then filter in-app.
  const { data: allStages } = await db
    .from('pipeline_stages')
    .select('*')
    .eq('pipeline_id', activePipeline.id)
    .eq('archived', false)
    .order('display_order')

  // splitStagesByFunnel owns the is_dormant partition so the page and the
  // mobile screen can never disagree about which stage sits on which tab.
  const { funnel: activeStages, offFunnel: dormantStages } = splitStagesByFunnel(allStages || [])
  // A manual board's rows all carry is_dormant=false, so the concat IS
  // activeStages in practice — it is there so a stray is_dormant row can never
  // make a column vanish on a board that has no second view to find it in.
  const visibleStages = manual
    ? [...activeStages, ...dormantStages]
    : (view === 'dormant' ? dormantStages : activeStages)

  // 2. Deals — ship only the FIRST page per column + a per-stage total count,
  //    instead of the whole open-deal set (was ≤10k shipped to the client and
  //    held in the Kanban). The board lazily fetches more per column via
  //    /api/pipeline/deals. Per stage: first page (created_at desc) + an exact
  //    HEAD count, in parallel. Empty visibleStages → no queries.
  const perStage = visibleStages.length > 0
    ? await Promise.all(visibleStages.map(async (stage) => {
        const [pageRes, countRes] = await Promise.all([
          db.from('deals')
            .select(pipelineDealSelect(view))
            .eq('status', 'open').eq('location_id', locationId).eq('stage_id', stage.id)
            .order('created_at', { ascending: false })
            .range(0, PIPELINE_PAGE_SIZE - 1),
          db.from('deals').select('id', { count: 'exact', head: true })
            .eq('status', 'open').eq('location_id', locationId).eq('stage_id', stage.id),
        ])
        return { stageId: stage.id, deals: (pageRes.data || []).map(toBoardDeal), count: countRes.count || 0 }
      }))
    : []
  const boardDeals = perStage.flatMap((sg) => sg.deals)
  const stageCounts = Object.fromEntries(perStage.map((sg) => [sg.stageId, sg.count]))
  const visibleTotal = perStage.reduce((n, sg) => n + sg.count, 0)

  // 3. Tab badges — total open-deal counts per view. Use HEAD count
  //    queries (no row payload) so this stays cheap.
  const tabCount = (stages) => (stages.length > 0
    ? db.from('deals').select('id', { count: 'exact', head: true })
        .eq('status', 'open').eq('location_id', locationId)
        .in('stage_id', stages.map((s) => s.id))
    : Promise.resolve({ count: 0 }))
  const [{ count: activeCount }, { count: dormantCount }] =
    await Promise.all([tabCount(activeStages), tabCount(dormantStages)])

  // "funnel" is the derived board's word for its live columns; a manual board
  // has no funnel, so it just counts deals.
  const totalLabel = manual ? 'deals'
    : view === 'dormant' ? 'off-funnel deals'
    : 'funnel deals'

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold">Pipeline</h2>
        <span className="text-sm text-un1t-subtle">
          {visibleTotal.toLocaleString()} {totalLabel}
        </span>
      </div>

      <PipelineViewSwitcher
        pipelines={pipelines}
        activePipelineKey={activePipeline.key}
        isManual={manual}
        view={view}
        activeCount={activeCount || 0}
        dormantCount={dormantCount || 0}
      />

      <KanbanBoard
        initialStages={visibleStages}
        initialDeals={boardDeals}
        stageCounts={stageCounts}
        view={view}
        manual={manual}
        locationId={locationId}
      />
    </div>
  )
}
