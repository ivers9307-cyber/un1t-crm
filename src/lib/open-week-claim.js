// OPENWEEK.1 — the server side of an open week claim: judge the visitor's
// picks against the studio's own timetable read (the same read the picker
// lists, limited to the window), and record them on corp_promo_claim_classes.
// Server-only by use (service-role client).
import { readPublicClasses } from '@/lib/public-classes'
import { openWeekState, openWeekReadDays, openWeekStartMs, inOpenWeek, judgeOpenWeekPicks } from '@/lib/open-week'

/**
 * The window's classes the studio lists now (the picker's read), or an error.
 * @returns {Promise<{ ok: true, classes: object[] } | { ok: false, code: 'over'|'timetable_unavailable' }>}
 */
export async function readOpenWeekClasses(db, { locationId, blocks, promo, zone, now = new Date() }) {
  if (openWeekState(promo, zone, now) === 'over') return { ok: false, code: 'over' }
  let read
  try {
    read = await readPublicClasses(db, locationId, openWeekReadDays(promo, zone, now), { blocks, fromMs: openWeekStartMs(promo, zone) })
  } catch {
    return { ok: false, code: 'timetable_unavailable' }
  }
  if (!read || read.error) return { ok: false, code: 'timetable_unavailable' }
  return { ok: true, classes: (read.classes || []).filter((c) => inOpenWeek(c, promo)) }
}

/**
 * @returns {Promise<{ ok: true, picks: object[] } | { ok: false, code: string, eventId?: string }>}
 */
export async function resolveOpenWeekPicks(db, { locationId, blocks, promo, zone, eventIds, now = new Date() }) {
  const listed = await readOpenWeekClasses(db, { locationId, blocks, promo, zone, now })
  if (!listed.ok) return listed
  return judgeOpenWeekPicks(eventIds, listed.classes, promo)
}

/** One corp_promo_claim_classes row per pick, in one insert. The caller judges `error`. */
export async function insertClaimClasses(db, { claimId, locationId, picks }) {
  const rows = picks.map((p) => ({ claim_id: claimId, location_id: locationId, class_event_id: p.event_id, class_name: p.name || null, class_starts_at: p.starts_at || null }))
  const { error } = await db.from('corp_promo_claim_classes').insert(rows)
  return { error: error || null }
}
