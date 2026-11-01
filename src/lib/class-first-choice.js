// CLASSFIRST.1 — the class a /trial buyer or a /corp claimant picked before
// their details, judged by the server. The public POST hands the body's
// `event_id` here with the studio and the page's blocks; the answer is the
// SERVER's class (its name and start, from the same read the picker used:
// readPublicClasses over 14 days, hidden keywords excluded, full classes
// left out), never the client's words. A read that failed is
// `timetable_unavailable` (the card keeps the details and says so in the
// operator's words), an id not in the list is `class_unavailable` (the card
// returns to the tiles). No event id is a legitimate answer (the visitor
// continued without a class): `chosen` null, nothing refused.
import { readPublicClasses } from '@/lib/public-classes'

export const CLASS_FIRST_DAYS = 14

/**
 * @param {object} db service-role client
 * @param {{ locationId: string, blocks: object[], eventId?: string|null }} args
 * @returns {Promise<{ ok: true, chosen: { event_id: string, name: string, starts_at: string }|null }
 *   | { ok: false, code: 'timetable_unavailable'|'class_unavailable' }>}
 */
export async function resolveChosenClass(db, { locationId, blocks, eventId = null }) {
  const id = typeof eventId === 'string' ? eventId.trim() : ''
  if (!id) return { ok: true, chosen: null }
  let read
  try {
    read = await readPublicClasses(db, locationId, CLASS_FIRST_DAYS, { blocks })
  } catch {
    return { ok: false, code: 'timetable_unavailable' }
  }
  if (read?.error) return { ok: false, code: 'timetable_unavailable' }
  const match = (read?.classes || []).find((c) => c && c.event_id === id)
  if (!match) return { ok: false, code: 'class_unavailable' }
  return { ok: true, chosen: { event_id: match.event_id, name: match.name, starts_at: match.starts_at } }
}

/** The row columns for a chosen class (mig 799), or nothing for none. */
export function classColumnsFor(chosen) {
  if (!chosen || typeof chosen !== 'object' || !chosen.event_id) return {}
  return { class_event_id: chosen.event_id, class_name: chosen.name || null, class_starts_at: chosen.starts_at || null }
}

// The refusal bodies, as the class-booking route words them (the card shows
// the operator's own text for timetable_unavailable when the block has one).
export const CLASS_UNAVAILABLE_TEXT = 'That class is no longer available. Please pick another.'
export const TIMETABLE_UNAVAILABLE_TEXT = 'We could not check the timetable just now. Please try again in a minute.'

/**
 * The HTTP answer for a refused choice: 400 class_unavailable, 503
 * timetable_unavailable (`texts` lets a route pass the block's words).
 * @returns {{ status: number, body: object }}
 */
export function chosenClassRefusal(code, texts = {}) {
  if (code === 'class_unavailable') return { status: 400, body: { success: false, code, error: texts.class_unavailable || CLASS_UNAVAILABLE_TEXT } }
  return { status: 503, body: { success: false, code: 'timetable_unavailable', error: texts.timetable_unavailable || TIMETABLE_UNAVAILABLE_TEXT } }
}
