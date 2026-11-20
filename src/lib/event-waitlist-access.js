// EVENT-WAITLIST.1 — what the staff and host waitlist routes need once the
// ROUTE has resolved the caller (getCurrentUser / getCurrentHost, called in the
// route file itself, where check:route-guards looks for it): the event, gated,
// and the list.
//
// Staff: `races` held somewhere (403), the event visible to the caller (404 so
// ids cannot be enumerated), then `races` AND a manager role at the EVENT's
// studio (403), the move routes' gate. Host: the event must be the session
// host's own (404 otherwise). Count and list are staff/host data, never public.

import { NextResponse } from 'next/server'
import { createServerClient } from './supabase'
import { assertLocationAccessOr404, hasRoleAtLocation } from './auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from './permissions'
import { MANAGER_ROLES, uuidLike } from './schemas'
import { ACTIVE_WAITLIST_STATUSES, WAITLIST_ROW_COLUMNS } from './event-waitlist'
import { logError } from './log'
import { staffActorName } from './staff-actor-name'

export { staffActorName }

const PAGE = 1000
const json = (status, body) => NextResponse.json(body, { status })
const notFound = () => json(404, { success: false, error: 'Not found' })
const forbidden = () => json(403, { success: false, error: 'Forbidden' })
const loadFailed = () => json(500, { success: false, error: 'load_failed', message: 'The event could not be read. Try again.' })

async function readEvent(db, eventId) {
  return db.from('race_events').select('id, name, location_id, host_id').eq('id', eventId).maybeSingle()
}

/**
 * @param {object|null} user  getCurrentUser()'s answer
 * @param {string} eventId
 * @returns {Promise<{ response: Response } | { db: object, race: object }>}
 */
export async function resolveStaffWaitlistEvent(user, eventId) {
  if (!user) return { response: json(401, { success: false, error: 'Unauthorised' }) }
  if (!hasPermissionAtAnyLocation(user, 'races')) return { response: forbidden() }
  if (!uuidLike.safeParse(eventId).success) return { response: notFound() }
  const db = createServerClient()
  const { data: race, error } = await readEvent(db, eventId)
  if (error) {
    logError('event-waitlist', 'staff: event read failed', { err: error, eventId })
    return { response: loadFailed() }
  }
  if (!race?.location_id) return { response: notFound() }
  const guard = assertLocationAccessOr404(user, race.location_id)
  if (guard) return { response: guard }
  if (!hasPermissionForLocation(user, race.location_id, 'races') || !hasRoleAtLocation(user, race.location_id, MANAGER_ROLES)) {
    return { response: forbidden() }
  }
  return { db, race }
}

/**
 * @param {object|null} session  getCurrentHost()'s answer
 * @param {string} eventId
 * @returns {Promise<{ response: Response } | { db: object, race: object }>}
 */
export async function resolveHostWaitlistEvent(session, eventId) {
  if (!session?.host?.id) return { response: json(401, { success: false, error: 'Unauthorized' }) }
  if (!uuidLike.safeParse(eventId).success) return { response: notFound() }
  const db = createServerClient()
  const { data: race, error } = await readEvent(db, eventId)
  if (error) {
    logError('event-waitlist', 'host: event read failed', { err: error, eventId, hostId: session.host.id })
    return { response: loadFailed() }
  }
  if (!race || race.host_id !== session.host.id) return { response: notFound() }
  return { db, race }
}

/**
 * Every row of an event's waitlist, oldest first, range-paginated, plus how
 * many are still on it.
 * @returns {Promise<{ rows: Array, waiting: number } | { error: object }>}
 */
export async function listEventWaitlist(db, race) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('event_waitlist')
      .select(WAITLIST_ROW_COLUMNS)
      .eq('race_event_id', race.id)
      .eq('location_id', race.location_id)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) return { error }
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return { rows, waiting: rows.filter((r) => ACTIVE_WAITLIST_STATUSES.includes(r.status)).length }
}

const ONE_OFFER_ANSWERS = {
  not_found: [404, 'Not found', 'They are no longer on the waitlist.'],
  past: [409, 'past', 'This event has already happened.'],
  not_bookable: [409, 'not_bookable', 'The event is not open for bookings, so no offer was sent.'],
  no_room: [409, 'no_room', 'Every time is still full. Free a place first, then offer it.'],
  already_booked: [409, 'already_booked', 'They have already booked a place.'],
  load_failed: [500, 'load_failed', 'The waitlist could not be read. Try again.'],
}

/**
 * WAITLISTONE.1 — the optional `{ row_id }` body of the staff and host
 * "Offer now" routes. No body (or no row_id): the whole-list round, as
 * before. Answers { rowId } (null for the round) or { response } (404 for a
 * row id that is not a uuid, 400 for a body that is not JSON).
 */
export async function readOfferRowId(request) {
  const text = await request.text().catch(() => '')
  if (!text.trim()) return { rowId: null }
  let body
  try { body = JSON.parse(text) } catch { return { response: json(400, { success: false, error: 'invalid_body' }) } }
  const rowId = body && typeof body === 'object' ? body.row_id : undefined
  if (rowId == null) return { rowId: null }
  if (!uuidLike.safeParse(rowId).success) return { response: notFound() }
  return { rowId }
}

/**
 * WAITLISTONE.1 — the staff and host "Offer space" (one row) share this: rate
 * limit per row (3 an hour), run offerWaitlistRow, answer in one shape.
 * `rowId` comes from readOfferRowId (uuid-checked).
 */
export async function offerOneWaitlistRow(ctx, rowId, { checkRateLimit, rateLimitResponse, offerWaitlistRow }) {
  const limit = await checkRateLimit(ctx.db, `waitlist-offer-row:${rowId}`, { max: 3, windowMs: 3_600_000 })
  if (!limit.allowed) return rateLimitResponse(limit, 'You can offer a space to the same person 3 times an hour. Try again later.')
  let out
  try {
    out = await offerWaitlistRow(ctx.db, { eventId: ctx.race.id, rowId })
  } catch (e) {
    logError('event-waitlist', 'single offer threw', { err: e, eventId: ctx.race.id, rowId })
    out = { result: 'load_failed' }
  }
  const refusal = ONE_OFFER_ANSWERS[out.result]
  if (refusal) return json(refusal[0], { success: false, error: refusal[1], message: refusal[2] })
  return json(200, { success: true, data: out })
}
