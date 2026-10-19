// PIPEEXCL.1 — a studio's acquisition board leaves out people who are active
// members at ANOTHER studio of the same organisation (Richard, 19 Oct 2026:
// "in the pipeline remove people who have active memberships in Stillorgan").
//
// Contacts are per studio and one person can hold a contact at each, linked by
// a person group (person_group_members). So "active elsewhere" is asked of the
// PERSON: the active members of every other studio in the organisation, each
// read through that studio's own membership adapter (Glofox contact columns at
// Stillorgan, fresh un1t.online subscriptions at Hatch Street), widened to
// every contact in their person groups.
//
// The rule (leavesBoard) keeps today's placement for anyone the board's own
// classifier already shows as a customer THERE (converted / member /
// pack_member): a member of both studios is a member of both.
//
// Any failed read is { ok: false, reason }: never "nobody is a member there".
// The callers then leave the board as it is (no deal leaves, none is held).

import { radarReadsFor } from './membership/reads/index.js'
import { selectAllByKeys } from './select-all.js'

/** The board's own customer stages: a person placed in one keeps it. */
export const OWN_STUDIO_MEMBER_SLUGS = Object.freeze(['converted', 'member', 'pack_member'])

/**
 * Does this person leave the board? Pure.
 * @param {string} targetSlug         the board classifier's answer for them
 * @param {boolean} activeElsewhere   active member at another studio of the org
 */
export function leavesBoard(targetSlug, activeElsewhere) {
  return activeElsewhere === true && !OWN_STUDIO_MEMBER_SLUGS.includes(targetSlug)
}

const PAGE = 1000
// person_group_members.contact_id is unique, so a chunk of N ids reads <= N
// rows; groups are 2-6 contacts, so a chunk of N groups reads <= 6N.
const GROUP_CHUNK = 150
const ERR_MAX = 200
const bounded = (v) => String(v?.message || v || '').slice(0, ERR_MAX)

/**
 * The contact ids, across the organisation, of people who are ACTIVE members
 * at a studio other than `locationId`.
 *
 * @returns {Promise<
 *   { ok: true, contactIds: Set<string>, studios: Array<{ locationId: string, members: number }> }
 * | { ok: false, reason: 'no_location'|'location_unreadable'|'studios_unreadable'|'source_unreadable'
 *     |'read_unsupported'|'read_failed'|'groups_unreadable', studioId?: string, err?: string }>}
 */
export async function loadActiveElsewhere(db, locationId) {
  if (!locationId) return { ok: false, reason: 'no_location' }

  const { data: own, error: ownErr } = await db
    .from('locations')
    .select('id, organization_id')
    .eq('id', locationId)
  if (ownErr) return { ok: false, reason: 'location_unreadable', err: bounded(ownErr) }
  const orgId = own?.[0]?.organization_id ?? null
  if (!orgId) return { ok: true, contactIds: new Set(), studios: [] }

  const { data: others, error: othersErr } = await db
    .from('locations')
    .select('id')
    .eq('organization_id', orgId)
    .neq('id', locationId)
  if (othersErr) return { ok: false, reason: 'studios_unreadable', err: bounded(othersErr) }

  const active = new Set()
  const studios = []
  for (const studio of others || []) {
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
    for (const id of res.data.contactIds) if (id) active.add(id)
    studios.push({ locationId: studio.id, members: res.data.contactIds.length })
  }

  if (active.size === 0) return { ok: true, contactIds: active, studios }

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
      const siblings = await selectAllByKeys(groupIds, (keys, from, to) => db
        .from('person_group_members')
        .select('contact_id')
        .in('group_id', keys)
        .order('id', { ascending: true })
        .range(from, to), { chunkSize: GROUP_CHUNK, pageSize: PAGE })
      for (const s of siblings) if (s.contact_id) active.add(s.contact_id)
    }
  } catch (e) {
    return { ok: false, reason: 'groups_unreadable', err: bounded(e) }
  }

  return { ok: true, contactIds: active, studios }
}
