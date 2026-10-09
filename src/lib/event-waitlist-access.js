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

/** Who removed a row: the staff member, or "<master> as <user>" under impersonation. */
export function staffActorName(user) {
  const userName = user?.full_name || user?.email || 'staff'
  const imp = user?.impersonatingFrom
  if (imp?.masterId) return `${imp.masterName || imp.masterEmail || 'master'} as ${userName}`
  return userName
}
