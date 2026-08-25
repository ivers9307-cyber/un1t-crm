// FUNNEL.1 — read-only funnel board.
//
// Tabs: Funnel (default) vs Off funnel. The funnel view shows the
// classifier-derived journey stages (new_lead → first_class →
// second_class → trial_done → converted, is_dormant=false); the
// Off funnel view (?view=dormant) shows the parked piles
// (member / classpass / dormant, is_dormant=true).
//
// The board is read-only: every column is derived by the classifier
// (webhook + nightly cron), so drag-drop was removed — a manual move
// would be silently overwritten on the next classify pass.
//
// Funnel view only: each deal's contact ships a server-derived
// `next_class_at` badge (soonest future BOOKED class from
// contacts.recent_bookings), and the raw jsonb is stripped before
// the payload leaves the server.
//
// Still true from PIPELINE5.8:
//   - Server-side filtering on stages — only fetch deals belonging
//     to the selected view's stages.
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
  // RETURNPIPE.1 — three boards now. Anything unrecognised still falls back to
  // 'active', so an old bookmarked URL behaves exactly as before.
  const view = sp?.view === 'dormant' ? 'dormant'
    : sp?.view === 'returning' ? 'returning'
    : 'active'

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

  // RETURNPIPE.1 — splitStagesByFunnel owns the board/is_dormant partition so
  // the page and the mobile screen can never disagree about which stage sits
  // on which tab. A row with no `board` reads as 'acquisition', so every stage
  // predating mig 558 lands exactly where it did before.
  const { funnel: activeStages, offFunnel: dormantStages, returning: returningStages } =
    splitStagesByFunnel(allStages || [])
  const visibleStages = view === 'dormant' ? dormantStages
    : view === 'returning' ? returningStages
    : activeStages

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
  const [{ count: activeCount }, { count: dormantCount }, { count: returningCount }] =
    await Promise.all([tabCount(activeStages), tabCount(dormantStages), tabCount(returningStages)])

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold">Pipeline</h2>
        <span className="text-sm text-un1t-subtle">
          {visibleTotal.toLocaleString()}{' '}
          {view === 'dormant' ? 'off-funnel' : view === 'returning' ? 'returning' : 'funnel'} deals
        </span>
      </div>

      <PipelineViewSwitcher
        view={view}
        activeCount={activeCount || 0}
        dormantCount={dormantCount || 0}
        returningCount={returningCount || 0}
      />

      <KanbanBoard
        initialStages={visibleStages}
        initialDeals={boardDeals}
        stageCounts={stageCounts}
        view={view}
        locationId={locationId}
      />
    </div>
  )
}
