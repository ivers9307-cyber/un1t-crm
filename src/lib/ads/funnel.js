// ads/funnel.js — the /start booking-funnel drop-off for the Ads dashboard,
// read from funnel_events (captured by the /start funnel). `shapeFunnel` is
// pure and unit-tested; `loadFunnel` aggregates distinct sessions per step via
// the funnel_step_counts RPC (cap-safe — never pulls raw events).

// The four funnel stages, in order. Every completed funnel is a class booking
// (the consult is a post-booking upsell, not a funnel stage — see the spec), so
// `booked` counts `booked_class` only; summing in `booked_consult` would
// double-count a session that added a consult after its class.
// STARTCONV.1 — order follows the funnel, and the funnel changed: the class
// picker now comes BEFORE the details form. Left as view→details→slots, the
// dashboard would render a later stage holding more people than an earlier one,
// which reads as broken data rather than as a reordered flow.
export const FUNNEL_STAGES = [
  { key: 'view', label: 'Landed on page', steps: ['view'] },
  { key: 'slots', label: 'Saw the times', steps: ['slots_view'] },
  { key: 'details', label: 'Entered details', steps: ['details'] },
  { key: 'booked', label: 'Booked', steps: ['booked_class'] },
]

/**
 * counts: [{ step, sessions }] (distinct sessions per raw step) →
 * ordered stages with `sessions`, `pctOfTop` (conversion from landing) and
 * `dropFromPrev` (% lost at this step). Pure.
 */
export function shapeFunnel(counts) {
  const byStep = {}
  for (const c of counts || []) byStep[c.step] = Number(c.sessions || 0)
  const stages = FUNNEL_STAGES.map((s) => ({
    key: s.key,
    label: s.label,
    sessions: s.steps.reduce((n, step) => n + (byStep[step] || 0), 0),
  }))
  const top = stages[0]?.sessions || 0
  let prev = null
  return stages.map((st) => {
    const pctOfTop = top > 0 ? Math.round((st.sessions / top) * 100) : 0
    const dropFromPrev = prev != null && prev > 0 ? Math.round((1 - st.sessions / prev) * 100) : 0
    prev = st.sessions
    return { ...st, pctOfTop, dropFromPrev }
  })
}

/** Load the funnel for a location over the last `sinceDays`. */
export async function loadFunnel(db, locationId, sinceDays = 30) {
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString()
  let counts = []
  try {
    const { data } = await db.rpc('funnel_step_counts', { p_location: locationId, p_since: since })
    counts = data || []
  } catch { /* fail soft — an empty funnel is a valid state, never break the page */ }
  const stages = shapeFunnel(counts)
  return { stages, total: stages[0]?.sessions || 0 }
}
