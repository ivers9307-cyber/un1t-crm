// host-move-session — what both host move routes need once the ROUTE has
// resolved the host session with getCurrentHost() (called in the route file
// itself, where check:route-guards looks for it): the entry, which must sit on
// one of the host's events (404 otherwise, so entry ids cannot be enumerated
// across hosts), the host's own event ids (the allowedEventIds fence for the
// lib, so the same-payee rule is enforced twice), and the actor to record.
// EVENT-MOVE.2.
import { NextResponse } from 'next/server'
import { createServerClient } from './supabase'
import { uuidLike } from './schemas'
import { readRegistrationForMove, MOVE_ERRORS, MOVE_ERROR_MESSAGES } from './registration-move'
import { logError } from './log'
import { dublinTodayStr } from './dublin-time'

const OWN_EVENTS_LOAD_FAILED_MESSAGE = 'Your events could not be read. Try again.'

function json(status, body) { return NextResponse.json(body, { status }) }
const notFound = () => json(404, { success: false, error: 'Not found' })

/**
 * Who moved it: the host entity. Under admin view-as the admin is named
 * ("<admin email> as <host name>") and the id stays the host's.
 */
export function hostMoveActor(session) {
  const hostName = session.host.name || 'host'
  return {
    type: 'host',
    id: session.host.id,
    name: session.impersonatedBy ? `${session.email || 'admin'} as ${hostName}` : hostName,
  }
}

/**
 * @param {object|null} session  getCurrentHost()'s answer, resolved by the route
 * @param {string} registrationId
 * @returns {Promise<{ response: Response } | { db: object, registration: object, allowedEventIds: Set<string>, actor: { type: 'host', id: string, name: string } }>}
 */
export async function resolveHostMoveContext(session, registrationId) {
  if (!session?.host?.id) return { response: json(401, { success: false, error: 'Unauthorized' }) }
  // A malformed id cannot name a row; reading it would only fail as 22P02.
  if (!uuidLike.safeParse(registrationId).success) return { response: notFound() }

  const db = createServerClient()
  const { registration, error } = await readRegistrationForMove(db, registrationId)
  if (error) {
    return { response: json(500, { success: false, error: MOVE_ERRORS.LOAD_FAILED, message: MOVE_ERROR_MESSAGES[MOVE_ERRORS.LOAD_FAILED] }) }
  }
  if (!registration || !registration.race?.host_id || registration.race.host_id !== session.host.id) {
    return { response: notFound() }
  }

  // The TARGET fence: the host's own events a move could land on (active,
  // published, today or later; anything else fails target_unavailable in the
  // lib anyway), which keeps a prolific host under the 1,000-row cap. It
  // never judges the SOURCE: the entry's own event may be past or
  // unpublished, and is fenced by host_id above; the lib applies
  // allowedEventIds to the target only.
  const { data: events, error: evErr } = await db
    .from('race_events')
    .select('id')
    .eq('host_id', session.host.id)
    .eq('active', true)
    .eq('status', 'published')
    .gte('race_date', dublinTodayStr())
  if (evErr) {
    logError('host-move', 'own events read failed', { err: evErr, hostId: session.host.id, registrationId })
    return { response: json(500, { success: false, error: MOVE_ERRORS.LOAD_FAILED, message: OWN_EVENTS_LOAD_FAILED_MESSAGE }) }
  }
  const allowedEventIds = new Set((events || []).map((e) => e.id))
  return { db, registration, allowedEventIds, actor: hostMoveActor(session) }
}
