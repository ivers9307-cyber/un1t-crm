// PULSEUN1T.1 — the first-90-days journey lane at a un1t.online studio (Hatch
// Street), for the /pulse staff screen; PULSEUN1T.2 adds one member's journey
// for the staff contact page. Staff screens only.
//
// loadJourneyLane (onboarding-journey-data.js) reads Glofox: members by
// contacts.glofox_membership_status + joined_at at the location, attendance
// from Glofox class_bookings. A un1t.online studio has neither, so its lane
// listed almost nobody. This lane reads what the un1t.online sync writes:
//
//   • members  — contact_studios.membership_status = 'active' at the studio
//                (the membership facts, ORGCONTACTS.7 / mig 770);
//   • joined   — the EARLIEST un1t_subscriptions.remote_created_at for that
//                contact at the studio. Not contact_studios.membership_since:
//                that is the day the sync first SAW the membership (26 of
//                Hatch's 29 read 16 Oct 2026, the connect day);
//   • attended — attended, non-cancelled un1t.online class_bookings at the
//                studio (UN1TBOOK projection, explicit ATTENDED/NO_SHOW).
//
// DISPLAY ONLY. Decision 1 (2026-10-17): the CRM never reminds, rewards or
// pushes for un1t.online classes; the un1t.online app does. The pace push
// (notify-onboarding-pace) calls loadJourneyLane at Glofox studios only and
// must never import this module; the member app's journey
// (loadContactJourney) stays Glofox-only too. This file is listed as
// `display` in tests/class-bookings-readers-guard.test.js.

import { selectAll, selectAllByKeys } from '@/lib/select-all'
import { journeyStatus, daysBetweenIn } from '@/lib/onboarding-journey'
import {
  fetchJourneyConfig,
  fetchLastTouch,
  buildJourneyLane,
  laneSinceIso,
  inWindowAttendance,
  LANE_TAIL_DAYS,
} from '@/lib/onboarding-journey-data'

const UN1T_ONLINE_PLATFORM = 'un1t_online'

/** Earliest subscription start per contact at the studio: Map<contactId, iso>. */
async function fetchJoinedAt(db, locationId, contactIds) {
  const rows = await selectAllByKeys(contactIds, (keys, from, to) => db
    .from('un1t_subscriptions')
    .select('contact_id, remote_created_at')
    .eq('location_id', locationId)
    .in('contact_id', keys)
    .order('id', { ascending: true })
    .range(from, to))
  const joined = new Map()
  for (const r of rows) {
    const ms = Date.parse(r?.remote_created_at ?? '')
    if (!Number.isFinite(ms)) continue
    const prev = joined.get(r.contact_id)
    if (!prev || ms < Date.parse(prev)) joined.set(r.contact_id, r.remote_created_at)
  }
  return joined
}

/**
 * The /pulse lane at a un1t.online studio. Same shape and ordering as
 * loadJourneyLane. Every read but the touch overlay throws on a DB error.
 *
 * @param {object} db          service-role client
 * @param {string} locationId  a un1t.online studio
 * @param {number} [nowMs]
 * @returns {Promise<{ config: {windowDays: number, targetClasses: number}, lane: Array<object> }>}
 */
export async function loadUn1tOnlineJourneyLane(db, locationId, nowMs = Date.now()) {
  const { config, zone } = await fetchJourneyConfig(db, locationId)
  const sinceIso = laneSinceIso(config, nowMs)
  const sinceMs = Date.parse(sinceIso)

  const studioRows = await selectAll((from, to) => db
    .from('contact_studios')
    .select('contact_id')
    .eq('location_id', locationId)
    .eq('membership_status', 'active')
    .order('contact_id', { ascending: true })
    .range(from, to))
  const activeIds = [...new Set(studioRows.map((r) => r.contact_id).filter(Boolean))]

  const joinedAt = await fetchJoinedAt(db, locationId, activeIds)
  const laneIds = activeIds.filter((id) => joinedAt.has(id) && Date.parse(joinedAt.get(id)) >= sinceMs)

  const [contacts, bookings, lastTouch] = await Promise.all([
    selectAllByKeys(laneIds, (keys, from, to) => db
      .from('contacts')
      .select('id, name')
      .in('id', keys)
      .order('id', { ascending: true })
      .range(from, to)),
    selectAllByKeys(laneIds, (keys, from, to) => db
      .from('class_bookings')
      .select('contact_id, starts_at')
      .eq('location_id', locationId)
      .eq('source_platform', UN1T_ONLINE_PLATFORM)
      .eq('attended', true)
      .not('status', 'eq', 'CANCELLED')
      .gte('starts_at', sinceIso)
      .in('contact_id', keys)
      .order('id', { ascending: true })
      .range(from, to)),
    fetchLastTouch(db, locationId, nowMs),
  ])

  const nameById = new Map(contacts.map((c) => [c.id, c.name]))
  const members = laneIds.map((id) => ({ id, name: nameById.get(id) ?? null, joined_at: joinedAt.get(id) }))
  const attendance = new Map()
  for (const r of bookings) {
    const list = attendance.get(r.contact_id)
    if (list) list.push(r)
    else attendance.set(r.contact_id, [r])
  }

  return { config, lane: buildJourneyLane({ members, attendance, lastTouch, config, zone, nowMs }) }
}

/**
 * PULSEUN1T.2 — one member's journey for the staff contact page, at the
 * un1t.online studio the viewer is on (one person can be a member at two
 * studios, so the studio is the caller's, never guessed). Same reads and the
 * same null rules as loadContactJourney: null when the contact is not an
 * active member there, has no subscription there, is past the tail, or their
 * window expired without completing. Staff display only: /api/me/journey
 * keeps loadContactJourney.
 *
 * @param {object} db          service-role client
 * @param {string} contactId
 * @param {string} locationId  a un1t.online studio
 * @param {number} [nowMs]
 * @returns {Promise<object|null>}  { contactId, name, joinedAt, ...journeyStatus fields } | null
 */
export async function loadUn1tContactJourney(db, contactId, locationId, nowMs = Date.now()) {
  if (!contactId || !locationId) return null

  const { data: membership, error: msErr } = await db
    .from('contact_studios')
    .select('contact_id')
    .eq('contact_id', contactId)
    .eq('location_id', locationId)
    .eq('membership_status', 'active')
    .maybeSingle() // (contact_id, location_id) is the row's key: at most one
  if (msErr) throw new Error(msErr.message)
  if (!membership) return null

  const joined = (await fetchJoinedAt(db, locationId, [contactId])).get(contactId)
  if (!joined) return null
  const joinedMs = Date.parse(joined)

  const { config, zone } = await fetchJourneyConfig(db, locationId)
  if (daysBetweenIn(joinedMs, nowMs, zone) > config.windowDays + LANE_TAIL_DAYS) return null

  const [{ data: contact, error: cErr }, bookings] = await Promise.all([
    db.from('contacts').select('id, name').eq('id', contactId).maybeSingle(),
    selectAll((from, to) => db
      .from('class_bookings')
      .select('contact_id, starts_at')
      .eq('contact_id', contactId)
      .eq('location_id', locationId)
      .eq('source_platform', UN1T_ONLINE_PLATFORM)
      .eq('attended', true)
      .not('status', 'eq', 'CANCELLED')
      .order('id', { ascending: true })
      .range(from, to)),
  ])
  if (cErr) throw new Error(cErr.message)
  if (!contact) return null

  const attendedAt = inWindowAttendance(joined, bookings, config.windowDays, zone)
  const row = journeyStatus({ joinedAt: joined, attendedAt, now: nowMs, config }, zone)
  if (!row) return null
  if (!row.inWindow && row.status !== 'completed') return null

  return { contactId: contact.id, name: contact.name || 'Member', joinedAt: joined, ...row }
}
