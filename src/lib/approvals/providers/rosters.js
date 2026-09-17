// APPROVALS.1 provider — over-budget rosters awaiting owner sign-off.
//
// Source: rosters.status='draft' (the existing /schedule/approvals
// queue). A manager publishes a draft that's over the location's
// monthly contractor budget → owner needs to approve before it
// goes live. Owner + master only.
//
// APPROVALS-LOCATION-SCOPE — scoped to user.activeLocation only.
// TENANT.8 (item 4) — every row this provider returns is eq('location_id',
// activeId)-filtered to the VIEWER'S OWN active location, so the registry's
// bundlesDenyCategory(user.activeLocation.features, key) check already
// covers every row here. No per-row location-features query needed —
// unlike host_events (org-scoped, can return rows from OTHER locations).

// ROSTERPROV.1 — the overrun has to be RE-PROJECTED, not derived from the two
// stored columns. `projected_contractor_eur` is the WHOLE period's cost and
// `budget_at_publish_eur` is a MONTHLY budget, so `projected - budget`
// compared a period against a month: it over-reported a draft crossing a
// month boundary and ignored every other period already published into the
// same month. Since #1704 the projection is per month, and only the
// projection knows which month is over. /schedule/approvals already
// re-projects per draft for exactly this reason; this is the same read,
// bounded by the same limit below.
import { projectPublishImpact } from '@/lib/roster-publish'
import { logWarn } from '@/lib/log'
import { viewerActiveLocationId } from '../registry'

function eur(n) {
  return `€${Math.round(Number(n) || 0).toLocaleString('en-IE')}`
}

/**
 * ROSTERPROV.1 — the cost/budget/overrun sentence for one draft.
 * Exported for the test; pure, so it can be pinned without a database.
 *
 * `impact` null means the re-projection failed. The stored snapshot still
 * gives an honest projected figure and budget, but NOT an overrun — the old
 * subtraction is exactly what is wrong here — so the line says the overrun
 * could not be re-checked rather than printing a number nobody can trust.
 */
export function rosterApprovalSubtitle({ publisher, impact, storedProjectedEur, storedBudgetEur }) {
  const projected = impact ? impact.periodProjectedEur : storedProjectedEur
  const budget = impact ? impact.monthlyBudgetEur : storedBudgetEur
  const head = `Published by ${publisher} · ${eur(projected)} projected vs ${eur(budget)} monthly budget`
  if (!impact) return `${head} (overrun could not be re-checked)`
  if (!(impact.overrunEur > 0)) return `${head} (within budget)`
  const overMonths = (impact.months || []).filter((m) => m.overrunEur > 0)
  if (overMonths.length > 1) {
    const per = overMonths.map((m) => `${eur(m.overrunEur)} in ${m.monthStart.slice(0, 7)}`).join(', ')
    return `${head} (+${eur(impact.overrunEur)} over: ${per})`
  }
  return `${head} (+${eur(impact.overrunEur)} over)`
}

export const rostersProvider = {
  key: 'rosters',
  permissionKey: 'approvals_rosters',
  label: 'Roster approvals',
  reviewBase: '/schedule/approvals',

  async fetchPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return { count: 0, items: [] }

    const q = db
      .from('rosters')
      .select(`
        id, period_start, period_end, projected_contractor_eur,
        budget_at_publish_eur, created_at, location_id,
        published_by_profile:published_by ( id, full_name ),
        location:location_id ( id, name )
      `)
      .eq('status', 'draft')
      .eq('location_id', activeId)
      .order('created_at', { ascending: false })
      .limit(50)

    const { data, error } = await q
    if (error) throw new Error(`rosters: ${error.message}`)

    // Bounded by the .limit(50) above. A failed projection never fails the
    // queue: the row still has to appear, or a draft nobody can see is a
    // draft nobody approves.
    const items = await Promise.all((data || []).map(async (r) => {
      let impact = null
      try {
        impact = await projectPublishImpact(db, {
          locationId: r.location_id,
          periodStart: r.period_start,
          periodEnd: r.period_end,
        })
      } catch (e) {
        logWarn('approvals/rosters', 'live impact failed; using the stored snapshot', { roster_id: r.id, err: e?.message })
      }
      const publisher = r.published_by_profile?.full_name || 'Manager'
      const overrun = impact?.overrunEur > 0 ? impact.overrunEur : null
      return {
        id: r.id,
        title: `${r.period_start} → ${r.period_end}`,
        subtitle: rosterApprovalSubtitle({
          publisher,
          impact,
          storedProjectedEur: Number(r.projected_contractor_eur) || 0,
          storedBudgetEur: Number(r.budget_at_publish_eur) || 0,
        }),
        meta: r.location?.name || null,
        submittedAt: r.created_at,
        amount: overrun,
        currency: 'EUR',
        reviewUrl: `/schedule/approvals?focus=${r.id}`,
      }
    }))
    return { count: items.length, items }
  },

  async countPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return 0
    const q = db
      .from('rosters')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'draft')
      .eq('location_id', activeId)
    const { count, error } = await q
    if (error) throw new Error(`rosters count: ${error.message}`)
    return count || 0
  },
}
