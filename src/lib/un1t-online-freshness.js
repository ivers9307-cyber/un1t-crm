// HATCHPIPE.2 / UN1TBOOK.19 — which un1t_* mirror rows the latest pull saw.
//
// The un1t.online sync stamps every row it pulled with the run's start time
// (`synced_at`), and never deletes: a row the API stopped returning keeps its
// last values for ever. So a subscription cancelled upstream stays 'active',
// and a class deleted upstream stays 'scheduled' (UN1TBOOK.19, live 19 Oct
// 2026: un1t.online answered a funnel booking for one 404 "Event not found").
//
// A row absent from the latest pull lags the studio's newest `synced_at` by at
// least one sync interval (15 min), so only rows within STALE_WINDOW_MS
// (10 min) of the newest are fresh. The freshness is RELATIVE, never against
// the clock: if the sync itself stops, every row is equally old and all stay
// fresh (a dead sync is the sync health check's job, and must never empty the
// timetable or the member counts).
//
// A light module on purpose: the public class list, the staff class list and
// Mia's timetable read it without importing the membership read seam.

export const STALE_WINDOW_MS = 10 * 60 * 1000

export const FRESH_TABLES = Object.freeze(['un1t_subscriptions', 'un1t_invoices', 'un1t_clients', 'un1t_events'])

/**
 * The freshness cutoff for one studio's rows in `table`: its newest `synced_at`
 * minus STALE_WINDOW_MS, as an ISO string. A row below it was not in the latest
 * pull. `null` when the studio has no rows in the table (or no readable
 * `synced_at`). Throws on a read error; any table but the ones the sync stamps
 * with a run time is refused.
 */
export async function freshCutoff(db, table, locationId) {
  if (!FRESH_TABLES.includes(table)) {
    throw new Error(`freshCutoff: ${table} is not one of ${FRESH_TABLES.join(', ')}`)
  }
  const { data: newest, error } = await db
    .from(table)
    .select('synced_at')
    .eq('location_id', locationId)
    .order('synced_at', { ascending: false })
    .range(0, 0)
  if (error) throw new Error(error.message)
  const newestAt = Date.parse(newest?.[0]?.synced_at)
  if (!Number.isFinite(newestAt)) return null
  return new Date(newestAt - STALE_WINDOW_MS).toISOString()
}

/**
 * UN1TBOOK.19 — narrow a un1t_events query to the classes the latest pull
 * saw. `cutoffIso` is freshCutoff(db, 'un1t_events', locationId); null (the
 * studio has no events at all) leaves the query as it is.
 */
export function onlyFreshEvents(query, cutoffIso) {
  return cutoffIso ? query.gte('synced_at', cutoffIso) : query
}
