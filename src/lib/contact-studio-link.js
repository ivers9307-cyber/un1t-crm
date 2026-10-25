// SHAREDCONTACT.1 — a contact is one person per ORGANISATION, and a studio
// may act on a sibling studio's contact once that person has joined it.
//
// Contacts are unique per organisation (mig 712: email unique on
// (organization_id, email)), so a Stillorgan member who signs up at Hatch
// Street is attached to their existing Stillorgan row, never copied
// (resolveUn1tContacts, findOrCreateRaceContact with restrictToOrg). The
// contact's location_id stays its HOME studio. Everything a studio does for
// that person is already keyed on the studio, not the home: its board (deals),
// its marketing consent (contact_location_preferences, row absent = never
// send), its WhatsApp thread, and a sequence's every step
// (sequence.location_id). What was missing is the door: the enrol route took
// only home contacts, so Hatch could not enrol the people on its own board.
//
// "Joined this studio" means the person holds a contact_studios row AT this
// studio (ORGCONTACTS.2, mig 764: a deal on one of its boards, a
// marketing-preference row, a provider account or a membership there, any
// status). Every one of those is written only by server code when the person
// signs up there, so a studio can never reach a sibling's contact it has no
// business with. Never across organisations: a contact whose organisation is
// not the studio's is refused whatever rows exist.

import { contactsAtStudio } from './contact-studios.js'

const CHUNK = 200
const ERR_MAX = 200
const bounded = (v) => String(v?.message || v?.code || v || '').slice(0, ERR_MAX)

function chunks(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * Which of `contactIds` may `locationId` act on: its own contacts, plus
 * contacts of a sibling studio in the same organisation who have joined it.
 *
 * @param {object} db  service-role client
 * @param {{ locationId: string, contactIds: string[] }} args
 * @returns {Promise<
 *   { ok: true, ids: string[], joined: string[] }
 * | { ok: false, reason: 'no_location'|'location_unreadable'|'contacts_unreadable'|'links_unreadable', err?: string }>}
 *   `ids` keeps the input order; `joined` is the subset whose home is another studio.
 */
export async function contactIdsLinkedToStudio(db, { locationId, contactIds }) {
  if (!locationId) return { ok: false, reason: 'no_location' }
  const wanted = [...new Set((contactIds || []).filter(Boolean))]
  if (wanted.length === 0) return { ok: true, ids: [], joined: [] }

  const { data: loc, error: locErr } = await db
    .from('locations')
    .select('id, organization_id')
    .eq('id', locationId)
    .maybeSingle()
  if (locErr) return { ok: false, reason: 'location_unreadable', err: bounded(locErr) }
  if (!loc) return { ok: false, reason: 'no_location' }

  const home = new Set()
  const sibling = new Set()
  for (const chunk of chunks(wanted, CHUNK)) {
    const { data, error } = await db
      .from('contacts')
      .select('id, location_id, organization_id')
      .in('id', chunk)
    if (error) return { ok: false, reason: 'contacts_unreadable', err: bounded(error) }
    for (const c of data || []) {
      if (c.location_id === locationId) home.add(c.id)
      else if (loc.organization_id && c.organization_id === loc.organization_id) sibling.add(c.id)
    }
  }

  const joined = new Set()
  if (sibling.size > 0) {
    const rel = await contactsAtStudio(db, locationId, { contactIds: [...sibling] })
    if (!rel.ok) return { ok: false, reason: 'links_unreadable', err: bounded(rel.error) }
    for (const r of rel.rows) if (r.contact_id) joined.add(r.contact_id)
  }

  const ids = wanted.filter((id) => home.has(id) || joined.has(id))
  return { ok: true, ids, joined: ids.filter((id) => joined.has(id)) }
}

/**
 * May `locationId` treat this contact as one of its people? Its own contact,
 * or a same-organisation contact (no link needed: the caller is the signup
 * itself, which is what creates the link).
 *
 * @returns {Promise<{ ok: true, sameStudio: boolean } | { ok: false, reason: string, err?: string }>}
 */
export async function contactInStudioOrganisation(db, { contact, locationId }) {
  if (!contact?.id || !locationId) return { ok: false, reason: 'missing_input' }
  if (contact.location_id === locationId) return { ok: true, sameStudio: true }
  const { data: loc, error } = await db
    .from('locations')
    .select('id, organization_id')
    .eq('id', locationId)
    .maybeSingle()
  if (error) return { ok: false, reason: 'location_unreadable', err: bounded(error) }
  if (!loc?.organization_id || loc.organization_id !== contact.organization_id) {
    return { ok: false, reason: 'cross_organisation' }
  }
  return { ok: true, sameStudio: false }
}
