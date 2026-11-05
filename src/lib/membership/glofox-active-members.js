// PIPEEXCL.1 — a Glofox studio's ACTIVE members, as contact ids (the Glofox
// adapter's activeMemberContactIds read; the un1t.online adapter has its own).
//
// Active = a contact at THIS studio holding a membership that can book today
// (hasBookableMembership: member or credit_member, state active or unset; a
// paused, locked or ex member is not active), or an ACTIVE contact_studios row
// of kind member at this studio (ORGCONTACTS.2, mig 764: the relationship
// table that replaced contact_memberships here). Stored rows only, no Glofox
// call.
//
// PIPEEXCL.3 — `packOnlyContactIds` names the members whose live membership is
// only a pack of classes (Glofox type num_classes or payg). Glofox keeps such
// a pack "member" for as long as one credit is unused, with no expiry: 396 of
// Stillorgan's 481 pack members had not trained in six months (5 Nov 2026),
// and one 2023 pack with a credit left took a paying Hatch trialer off Hatch's
// board. The caller (pipeline-other-studio-members.js) counts a pack only
// while the person still trains at the studio. A member known only through
// contact_studios (a sibling studio's contact carrying this studio's Glofox
// account) is judged on the same Glofox columns, read by id.
//
// { success: true, data: { contactIds, packOnlyContactIds } } | { success: false, error }:
// a failed read is never an empty list.
import { selectAll, selectAllByKeys } from '@/lib/select-all'
import { MEMBER_STATUSES, hasBookableMembership } from '@/lib/person-accounts'
import { contactsAtStudio } from '@/lib/contact-studios'

const PAGE = 1000
// PostgREST URL-length cap on .in() (BUG-FIX #538).
const ID_CHUNK = 150
const COLUMNS = 'id, glofox_membership_status, glofox_membership_state, glofox_membership_type'

/** PIPEEXCL.3 — Glofox membership types that are a pack of classes, not a running membership. */
export const PACK_MEMBERSHIP_TYPES = Object.freeze(['num_classes', 'payg'])

const isPackOnly = (row) => hasBookableMembership(row) && PACK_MEMBERSHIP_TYPES.includes(row.glofox_membership_type)

export async function fetchGlofoxActiveMemberContactIds(db, locationId) {
  if (!locationId) return { success: false, error: 'No location' }
  try {
    const [contacts, memberships] = await Promise.all([
      selectAll((from, to) => db
        .from('contacts')
        .select(COLUMNS)
        .eq('location_id', locationId)
        .in('glofox_membership_status', MEMBER_STATUSES)
        .order('id', { ascending: true })
        .range(from, to), { pageSize: PAGE }),
      contactsAtStudio(db, locationId, { kinds: ['member'], status: 'active' }),
    ])
    if (!memberships.ok) return { success: false, error: memberships.error }
    const ids = new Set()
    const packOnly = new Set()
    const seen = new Set()
    for (const c of contacts) {
      seen.add(c.id)
      if (!hasBookableMembership(c)) continue
      ids.add(c.id)
      if (isPackOnly(c)) packOnly.add(c.id)
    }
    const unseen = []
    for (const m of memberships.rows) {
      if (!m.contact_id) continue
      ids.add(m.contact_id)
      if (!seen.has(m.contact_id)) unseen.push(m.contact_id)
    }
    if (unseen.length > 0) {
      const rows = await selectAllByKeys([...new Set(unseen)], (keys, from, to) => db
        .from('contacts')
        .select(COLUMNS)
        .in('id', keys)
        .order('id', { ascending: true })
        .range(from, to), { chunkSize: ID_CHUNK, pageSize: PAGE })
      for (const c of rows) if (isPackOnly(c)) packOnly.add(c.id)
    }
    return { success: true, data: { contactIds: [...ids], packOnlyContactIds: [...packOnly] } }
  } catch (e) {
    return { success: false, error: e?.message || String(e) }
  }
}
