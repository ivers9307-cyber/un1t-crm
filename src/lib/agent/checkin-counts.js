// CHECKINRISKS.1 (C106 c) — how many first-class check-ins were SENT.
//
// contacts.first_class_checkin_at is the once-ever marker, and it is stamped
// for non-sends too ('skipped — already discussed', 'skipped — no marketing
// consent'), so counting stamps counts decisions, not messages. Every stamped
// outcome also writes one `agent_checkin` activity whose note carries the via
// label ('in-window' / 'template' for a send, 'skipped — …' for a non-send);
// the counts below read those.
//
// One module for the runner's daily cap (src/lib/agent/followups.js) and the
// settings card (GET /api/settings/customer-agent), so "Sent today" on the
// card is the number the cap is judged on. Both readers return
// { count, error }: a failed read is `count: null`, never 0.

/**
 * How many of these check-in activity rows were actual SENDS. Pure.
 * @param {Array<{note?: string|null}>|null|undefined} rows
 */
export function countCheckinSends(rows) {
  return (rows || []).filter((r) => !/skipped/i.test(String(r?.note || ''))).length
}

/** Midnight UTC of nowMs's UTC day, as ISO. The cap has always used the UTC day. */
export function checkinDayStartIso(nowMs = Date.now()) {
  const d = new Date(nowMs)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString()
}

/**
 * Check-ins SENT at a location since the start of today (UTC).
 * @returns {Promise<{ count: number|null, error: object|null }>}
 */
export async function readCheckinSendsToday(db, locationId, nowMs = Date.now()) {
  const { data, error } = await db.from('activities')
    .select('note')
    .eq('location_id', locationId)
    .eq('type', 'agent_checkin')
    .gte('created_at', checkinDayStartIso(nowMs))
    .limit(500)
  if (error || !Array.isArray(data)) return { count: null, error: error || { message: 'no rows returned' } }
  return { count: countCheckinSends(data), error: null }
}

/**
 * Check-ins SENT at a location, all time. A head count (the rows can pass the
 * 1,000-row cap). Same rule as countCheckinSends, in SQL: a note containing
 * "skipped" is not a send. (A NULL note would count as a send above and not
 * here; the runner always writes one.)
 * @returns {Promise<{ count: number|null, error: object|null }>}
 */
export async function readCheckinSendsAllTime(db, locationId) {
  const { count, error } = await db.from('activities')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .eq('type', 'agent_checkin')
    .not('note', 'ilike', '%skipped%')
  if (error || typeof count !== 'number') return { count: null, error: error || { message: 'no count returned' } }
  return { count, error: null }
}
