// PIPEEXCL.1 — a studio's acquisition board leaves out people who are active
// members at ANOTHER studio of the same organisation (Richard, 19 Oct 2026:
// "in the pipeline remove people who have active memberships in Stillorgan";
// confirmed "yes hatch pipeline"). PIPEEXCL.2 (Richard, 22 Oct 2026: Hatch
// "customers and trialers" were on Stillorgan's cold-call list) widened it in
// both directions: the people who are TRAINING at another studio (a class
// booked or attended there in the last TRAINING_WINDOW_DAYS, or booked in the
// next TRAINING_LOOKAHEAD_DAYS) leave too, and the orchestrator now runs the
// rule on every derived acquisition board (pipeline-reclassify.js), Glofox and
// un1t.online alike. The read itself is org-generic.
//
// A person is ONE contact per organisation (mig 712), related to each of its
// studios through contact_studios (mig 764); a person group (person_groups,
// per organisation since mig 767) only links the extra accounts one person
// may still hold (a ClassPass placeholder, a pre-712 duplicate). So "active
// elsewhere" is asked of the PERSON: the active members of every other studio
// in the organisation, each read through that studio's own membership adapter
// (Glofox contact columns at Stillorgan, fresh un1t.online subscriptions at
// Hatch Street), plus everyone with a live class booking there
// (class_bookings, both platforms), widened to every contact in their person
// groups.
//
// The rule (leavesBoard) keeps today's placement for anyone the board's own
// classifier already shows as a customer THERE (converted / member /
// pack_member): a member of both studios is a member of both. And someone who
// trains at BOTH studios in the window (Shara, 22 Oct 2026: one Stillorgan
// class, three Hatch classes, a trial at each) is a prospect at both: a
// training reason never removes a person who also has a live booking here
// (trainingHere). A membership elsewhere still does.
//
// Any failed read is { ok: false, reason }: never "nobody is a member there".
// The callers then leave the board as it is (no deal leaves, none is held).

import { radarReadsFor } from './membership/reads/index.js'
import { selectAll, selectAllByKeys } from './select-all.js'

/** PIPEEXCL.2 — a class booked or attended this long ago still says "training there". */
export const TRAINING_WINDOW_DAYS = 60
/** PIPEEXCL.2 — a class booked this far ahead says it too. */
export const TRAINING_LOOKAHEAD_DAYS = 30
/** A cancelled booking is not training. A no-show or a waitlist place still is: they chose that studio. */
export const NOT_TRAINING_STATUSES = Object.freeze(['CANCELLED', 'LATE_CANCELLED'])
/** Why a person is "active elsewhere". A membership outranks a booking. */
export const ELSEWHERE_MEMBER = 'member'
export const ELSEWHERE_TRAINING = 'training'

/** The board's own customer stages: a person placed in one keeps it. */
// PIPE3.3 — the €39 Trial and Programmes boards' Converted columns are customer
// stages here too: a person who joined through either board stays.
export const OWN_STUDIO_MEMBER_SLUGS = Object.freeze(['converted', 'member', 'pack_member', 'paid_trial_converted', 'programme_converted'])

/**
 * Does this person leave the board? Pure.
 * @param {string} targetSlug         the board classifier's answer for them
 * @param {boolean} activeElsewhere   active member at, or training at, another studio of the org
 * @param {{ reason?: 'member'|'training', trainsHere?: boolean }} [why]
 *   PIPEEXCL.2 — why they are active elsewhere, and whether they also have a
 *   live class booking at THIS studio. Training at both studios keeps them.
 */
export function leavesBoard(targetSlug, activeElsewhere, { reason = ELSEWHERE_MEMBER, trainsHere = false } = {}) {
  if (activeElsewhere !== true) return false
  if (OWN_STUDIO_MEMBER_SLUGS.includes(targetSlug)) return false
  if (reason === ELSEWHERE_TRAINING && trainsHere === true) return false
  return true
}

const PAGE = 1000
// person_group_members.contact_id is unique, so a chunk of N ids reads <= N
// rows; groups are 2-6 contacts, so a chunk of N groups reads <= 6N.
const GROUP_CHUNK = 150
const ERR_MAX = 200
const bounded = (v) => String(v?.message || v || '').slice(0, ERR_MAX)

/**
 * The contact ids, across the organisation, of people who are ACTIVE members
 * at a studio other than `locationId`, or TRAINING there (PIPEEXCL.2).
 *
 * @param {object} db
 * @param {string} locationId
 * @param {{ now?: number }} [opts]  the instant the booking window is measured from
 * @returns {Promise<
 *   { ok: true, contactIds: Set<string>, reasons: Map<string, 'member'|'training'>,
 *     trainingHere: Set<string>, studios: Array<{ locationId: string, members: number, training: number }> }
 * | { ok: false, reason: 'no_location'|'location_unreadable'|'studios_unreadable'|'source_unreadable'
 *     |'read_unsupported'|'read_failed'|'bookings_unreadable'|'groups_unreadable', studioId?: string, err?: string }>}
 */
export async function loadActiveElsewhere(db, locationId, { now = Date.now() } = {}) {
  if (!locationId) return { ok: false, reason: 'no_location' }

  const { data: own, error: ownErr } = await db
    .from('locations')
    .select('id, organization_id')
    .eq('id', locationId)
  if (ownErr) return { ok: false, reason: 'location_unreadable', err: bounded(ownErr) }
  const orgId = own?.[0]?.organization_id ?? null
  if (!orgId) return { ok: true, contactIds: new Set(), reasons: new Map(), trainingHere: new Set(), studios: [] }

  const { data: others, error: othersErr } = await db
    .from('locations')
    .select('id')
    .eq('organization_id', orgId)
    .neq('id', locationId)
  if (othersErr) return { ok: false, reason: 'studios_unreadable', err: bounded(othersErr) }

  const active = new Set()
  const reasons = new Map()
  const studios = []
  const sinceIso = new Date(now - TRAINING_WINDOW_DAYS * 86_400_000).toISOString()
  const untilIso = new Date(now + TRAINING_LOOKAHEAD_DAYS * 86_400_000).toISOString()
  // PIPEEXCL.2 — the contact ids with a live class booking at a studio in the
  // window, whichever platform wrote it (Glofox at Stillorgan, un1t.online at
  // Hatch). A cancelled booking is not training.
  const trainersAt = async (studioId) => {
    const bookings = await selectAll((from, to) => db
      .from('class_bookings')
      .select('contact_id, status')
      .eq('location_id', studioId)
      .gte('starts_at', sinceIso)
      .lte('starts_at', untilIso)
      .order('id', { ascending: true })
      .range(from, to), { pageSize: PAGE })
    const ids = new Set()
    for (const b of bookings) {
      if (!b?.contact_id) continue
      if (NOT_TRAINING_STATUSES.includes(String(b.status || '').toUpperCase())) continue
      ids.add(b.contact_id)
    }
    return ids
  }

  // Who trains HERE: a training reason never removes them (leavesBoard).
  let trainingHere
  try {
    trainingHere = await trainersAt(locationId)
  } catch (e) {
    return { ok: false, reason: 'bookings_unreadable', studioId: locationId, err: bounded(e) }
  }

  for (const studio of others || []) {
    // A trialer who booked or attended at the studio in the window is that
    // studio's prospect, not this one's. Read first so a membership (below)
    // outranks it.
    let trainers
    try {
      trainers = await trainersAt(studio.id)
    } catch (e) {
      return { ok: false, reason: 'bookings_unreadable', studioId: studio.id, err: bounded(e) }
    }
    let training = 0
    for (const id of trainers) {
      if (!active.has(id)) training++
      active.add(id)
      if (!reasons.has(id)) reasons.set(id, ELSEWHERE_TRAINING)
    }
    // Resolved by source KEY in any state, as the radar does: both reads are of
    // stored rows, so a credential glitch at the other studio does not hide its
    // members. A source key that cannot be read throws.
    let r
    try {
      r = await radarReadsFor(db, studio.id)
    } catch (e) {
      return { ok: false, reason: 'source_unreadable', studioId: studio.id, err: bounded(e) }
    }
    // No membership source (Test Studio is 'none'): nobody is a member there.
    if (!r?.providesMemberships) continue
    if (typeof r.reads?.activeMemberContactIds !== 'function') {
      return { ok: false, reason: 'read_unsupported', studioId: studio.id }
    }
    let res
    try {
      res = await r.reads.activeMemberContactIds(db, studio.id)
    } catch (e) {
      res = { success: false, error: e?.message || String(e) }
    }
    if (!res?.success || !Array.isArray(res.data?.contactIds)) {
      return { ok: false, reason: 'read_failed', studioId: studio.id, err: bounded(res?.error || 'malformed answer') }
    }
    for (const id of res.data.contactIds) {
      if (!id) continue
      active.add(id)
      reasons.set(id, ELSEWHERE_MEMBER)
    }
    studios.push({ locationId: studio.id, members: res.data.contactIds.length, training })
  }

  if (active.size === 0) return { ok: true, contactIds: active, reasons, trainingHere, studios }

  // The same person under another studio's contact row.
  try {
    const memberRows = await selectAllByKeys([...active], (keys, from, to) => db
      .from('person_group_members')
      .select('group_id, contact_id')
      .in('contact_id', keys)
      .order('id', { ascending: true })
      .range(from, to), { chunkSize: GROUP_CHUNK, pageSize: PAGE })
    const groupIds = [...new Set(memberRows.map((m) => m.group_id).filter(Boolean))]
    if (groupIds.length > 0) {
      // A group's reason is its strongest member's: a membership outranks a booking.
      const groupReason = new Map()
      for (const m of memberRows) {
        if (!m.group_id) continue
        const r = reasons.get(m.contact_id) || ELSEWHERE_TRAINING
        if (r === ELSEWHERE_MEMBER || !groupReason.has(m.group_id)) groupReason.set(m.group_id, r)
      }
      const siblings = await selectAllByKeys(groupIds, (keys, from, to) => db
        .from('person_group_members')
        .select('group_id, contact_id')
        .in('group_id', keys)
        .order('id', { ascending: true })
        .range(from, to), { chunkSize: GROUP_CHUNK, pageSize: PAGE })
      for (const s of siblings) {
        if (!s.contact_id) continue
        active.add(s.contact_id)
        const r = groupReason.get(s.group_id) || ELSEWHERE_TRAINING
        if (r === ELSEWHERE_MEMBER || !reasons.has(s.contact_id)) reasons.set(s.contact_id, r)
      }
    }
  } catch (e) {
    return { ok: false, reason: 'groups_unreadable', err: bounded(e) }
  }

  return { ok: true, contactIds: active, reasons, trainingHere, studios }
}
