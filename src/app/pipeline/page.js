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
import { nextBookedClass } from '@/lib/pipeline-classifier'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import KanbanBoard from '@/components/KanbanBoard'
import PipelineViewSwitcher from '@/components/PipelineViewSwitcher'

export const dynamic = 'force-dynamic'

const DEALS_HARD_LIMIT = 10_000

export default async function PipelinePage(props) {
  const searchParams = await props.searchParams;
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

    // FUNNEL.1 — recent_bookings only ships on the funnel view (it
    // feeds the next-class badge). The off-funnel view has thousands
    // of deals and no badge, so it keeps the lean field list.
    const contactFields = view === 'dormant'
      ? 'id, name, lead_source, pipeline_stage_slug, trial_credits_remaining'
      : 'id, name, lead_source, pipeline_stage_slug, trial_credits_remaining, recent_bookings'

    while (true) {
      const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, DEALS_HARD_LIMIT - 1)
      // PERF.2 — narrow the SELECT to fields actually rendered by
      // KanbanBoard + DealCard. The previous `*, contacts(*)` shipped
      // every column on every deal AND every nested contact, blowing
      // the response to ~9 MB at 8k deals when the card only renders
      // 5 contact fields. Field list mirrors DealCard.jsx exactly.
      const { data: page, error } = await db
        .from('deals')
        .select(`
          id, title, stage_id, created_at,
          contacts ( ${contactFields} )
        `)
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

  // FUNNEL.1 — derive the badge server-side and strip recent_bookings
  // so the client payload stays card-sized (PERF.2 discipline).
  //
  // Only funnel columns 1–4 carry the badge (DealCard has a matching
  // BADGE_SLUGS set). Converted/off-funnel contacts get null so the
  // KanbanBoard's badge-first sort never re-orders those columns by a
  // criterion the card doesn't render.
  const BADGE_SLUGS = new Set(['new_lead', 'first_class', 'second_class', 'trial_done'])
  const boardDeals = deals.map((d) => {
    const { recent_bookings, ...contact } = d.contacts || {}
    return {
      ...d,
      contacts: {
        ...contact,
        next_class_at: BADGE_SLUGS.has(contact.pipeline_stage_slug)
          ? nextBookedClass(recent_bookings)
          : null,
      },
    }
  })

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
        <span className="text-sm text-un1t-subtle">
          {deals.length.toLocaleString()} {view === 'dormant' ? 'off-funnel' : 'funnel'} deals
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
        initialDeals={boardDeals}
        locationId={locationId}
      />
    </div>
  )
}
