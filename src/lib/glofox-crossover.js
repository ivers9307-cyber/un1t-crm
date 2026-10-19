// GLOFOXSIBLING.1 — a Glofox member whose one CRM contact lives at ANOTHER
// studio of the same organisation.
//
// contacts_email_org_unique (mig 712) holds one contact per email per
// organisation, while every Glofox lookup is scoped to the Glofox studio's
// location. A Stillorgan Glofox member whose email already belonged to a Hatch
// contact missed that lookup, the sync tried to INSERT a Stillorgan contact,
// the insert hit the unique index, and the member never reached the CRM.
//
// The fix (Richard, 19 Oct 2026) mirrors the un1t.online sync in the other
// direction (un1t-online-contacts.js): attach the Glofox account to the
// existing contact, never move it, and make it readable at the Glofox studio:
//   - findGlofoxCrossoverContact: after the location-scoped lookups miss, look
//     across the organisation (the studio's link row, then glofox_member_id,
//     then email). Two candidates, or an email holder already linked to a
//     different Glofox member, is a conflict for a person to resolve, never a
//     guess.
//   - recordGlofoxCrossover: the glofox_crossover_members row (mig 758) that
//     makes the contact readable by staff holding Contacts at the studio, and
//     the studio's marketing-preferences row, as the un1t sync gives Hatch.
//
// Service-role only. Never throws: every failure comes back as `error`.

import { escapeLikePattern } from './like-escape.js'
import { ensureStudioPreferences } from './un1t-online-studio-preferences.js'

export const GLOFOX_CROSSOVER_TABLE = 'glofox_crossover_members'
const MAX_ERROR_LEN = 300
// PostgREST's "table not in the schema cache" and Postgres' undefined_table.
const TABLE_MISSING = new Set(['PGRST205', '42P01'])

function message(err) {
  const s = String(err?.message || err?.code || err || 'unknown error')
  return s.length > MAX_ERROR_LEN ? `${s.slice(0, MAX_ERROR_LEN)}…` : s
}

/** The organisation a location belongs to; `error` when it cannot be read. */
export async function organisationOfLocation(db, locationId) {
  const { data, error } = await db.from('locations').select('organization_id').eq('id', locationId).maybeSingle()
  if (error) return { error: `locations read: ${message(error)}` }
  if (!data?.organization_id) return { error: 'location has no organisation' }
  return { organizationId: data.organization_id }
}

/**
 * Find the organisation's contact for a Glofox member when the studio's own
 * (location-scoped) lookups found nothing. Call it only after those miss: a
 * contact AT the studio is never a crossover.
 *
 * @param {object} db  service-role client
 * @param {string} locationId  the Glofox studio
 * @param {{ glofoxMemberId?: string|null, email?: string|null, select?: string }} who
 *   select: the contact columns the caller needs (id and location_id are always added).
 * @returns {Promise<{ contact: object|null, how?: 'link'|'glofox_member_id'|'email',
 *   conflict?: { reason: string, contact_ids: string[] }, error?: string }>}
 */
export async function findGlofoxCrossoverContact(db, locationId, { glofoxMemberId = null, email = null, select = 'id' } = {}) {
  try {
    if (!db || !locationId || (!glofoxMemberId && !email)) return { contact: null }
    const cols = [...new Set(['id', 'location_id', 'glofox_member_id', ...String(select).split(',').map((c) => c.trim()).filter(Boolean)])].join(', ')

    // 1. The studio's own link row: the answer a previous sync already gave.
    if (glofoxMemberId) {
      const link = await db.from(GLOFOX_CROSSOVER_TABLE).select('contact_id')
        .eq('location_id', locationId).eq('glofox_member_id', glofoxMemberId).maybeSingle()
      // The table not existing yet (code deployed before mig 758) means no
      // link rows, not an outage: steps 2 and 3 still find the contact.
      // Any other read failure is an error.
      if (link.error && !TABLE_MISSING.has(link.error.code)) {
        return { contact: null, error: `${GLOFOX_CROSSOVER_TABLE} read: ${message(link.error)}` }
      }
      if (link.data?.contact_id) {
        const c = await db.from('contacts').select(cols).eq('id', link.data.contact_id).maybeSingle()
        if (c.error) return { contact: null, error: `contacts read: ${message(c.error)}` }
        if (c.data) return { contact: c.data, how: 'link' }
      }
    }

    const org = await organisationOfLocation(db, locationId)
    if (org.error) return { contact: null, error: org.error }

    // 2. The Glofox member id anywhere in the organisation (Glofox ids are
    //    global, so a match is the same account).
    let byId = null
    if (glofoxMemberId) {
      const r = await db.from('contacts').select(cols)
        .eq('organization_id', org.organizationId).eq('glofox_member_id', glofoxMemberId).limit(2)
      if (r.error) return { contact: null, error: `contacts by glofox_member_id: ${message(r.error)}` }
      if ((r.data || []).length > 1) {
        return { contact: null, conflict: { reason: 'Two contacts in the organisation carry this Glofox member id', contact_ids: r.data.map((x) => x.id) } }
      }
      byId = r.data?.[0] || null
    }

    // 3. The email anywhere in the organisation (one holder per org, mig 712;
    //    escaped so `_` and `%` match only themselves).
    let byEmail = null
    if (email) {
      const r = await db.from('contacts').select(cols)
        .eq('organization_id', org.organizationId).ilike('email', escapeLikePattern(email)).limit(2)
      if (r.error) return { contact: null, error: `contacts by email: ${message(r.error)}` }
      if ((r.data || []).length > 1) {
        return { contact: null, conflict: { reason: 'Two contacts in the organisation hold this email', contact_ids: r.data.map((x) => x.id) } }
      }
      byEmail = r.data?.[0] || null
    }

    if (byId && byEmail && byId.id !== byEmail.id) {
      return { contact: null, conflict: { reason: 'One contact carries this Glofox member id and another holds its email', contact_ids: [byId.id, byEmail.id] } }
    }
    if (byId) return { contact: byId, how: 'glofox_member_id' }
    if (byEmail) {
      if (glofoxMemberId && byEmail.glofox_member_id && byEmail.glofox_member_id !== glofoxMemberId) {
        return { contact: null, conflict: { reason: 'The contact holding this email is linked to a different Glofox member', contact_ids: [byEmail.id] } }
      }
      return { contact: byEmail, how: 'email' }
    }
    return { contact: null }
  } catch (err) {
    return { contact: null, error: message(err) }
  }
}

/**
 * Record that a Glofox member of `locationId` is the contact `contactId`, who
 * lives at another studio: the glofox_crossover_members row (readability at
 * the studio, mig 758) and the studio's marketing-preferences row
 * (insert-if-missing; an existing row, an unsubscribe included, is never
 * touched). A contact who lives AT the studio needs neither and is skipped.
 *
 * @returns {Promise<{ linked: boolean, preferences_created: number, skipped?: string, error?: string }>}
 */
export async function recordGlofoxCrossover(db, { locationId, glofoxMemberId, contactId, contactLocationId = undefined }) {
  const out = { linked: false, preferences_created: 0 }
  try {
    if (!db || !locationId || !glofoxMemberId || !contactId) return { ...out, skipped: 'missing arguments' }
    let home = contactLocationId
    if (home === undefined) {
      const c = await db.from('contacts').select('location_id').eq('id', contactId).maybeSingle()
      if (c.error) return { ...out, error: `contacts read: ${message(c.error)}` }
      if (!c.data) return { ...out, skipped: 'contact not found' }
      home = c.data.location_id
    }
    if (home === locationId) return { ...out, skipped: 'contact lives at this studio' }

    const now = new Date().toISOString()
    const { data, error } = await db.from(GLOFOX_CROSSOVER_TABLE)
      .upsert({ location_id: locationId, glofox_member_id: glofoxMemberId, contact_id: contactId, updated_at: now },
        { onConflict: 'location_id,glofox_member_id' })
      .select('id')
    if (error) return { ...out, error: `${GLOFOX_CROSSOVER_TABLE} write: ${message(error)}` }
    if (!data || data.length === 0) return { ...out, error: `${GLOFOX_CROSSOVER_TABLE} write returned no row` }
    out.linked = true

    const prefs = await ensureStudioPreferences(db, { locationId, contactIds: [contactId], origin: 'glofox' })
    out.preferences_created = prefs.created || 0
    if (prefs.error) return { ...out, error: `studio preferences: ${prefs.error.message}` }
    return out
  } catch (err) {
    return { ...out, error: message(err) }
  }
}

// ─────────────────────────────────────────────────────────────
// Readers (GLOFOXREADERS.1)
// ─────────────────────────────────────────────────────────────
//
// A crossover contact keeps its home location_id (Hatch), so every reader that
// selects `contacts WHERE location_id = <Glofox studio> AND glofox_member_id`
// skipped it: no attendance refresh, no detail backfill, and Mia not counting
// it as a member of the Glofox studio. These helpers let a reader widen
// "lives at the studio" to "lives at the studio, or is linked there".

const READ_PAGE = 1000
const IN_CHUNK = 150

/**
 * The contact ids linked at `locationId` by glofox_crossover_members, paged
 * past the 1,000-row cap. The table not existing yet is an empty list; any
 * other failure is `error` (the caller decides; never read it as "none").
 *
 * @returns {Promise<{ ids: string[], error?: string }>}
 */
export async function glofoxCrossoverContactIds(db, locationId) {
  const ids = []
  try {
    for (let from = 0; ; from += READ_PAGE) {
      const { data, error } = await db.from(GLOFOX_CROSSOVER_TABLE).select('contact_id')
        .eq('location_id', locationId)
        .order('contact_id', { ascending: true })
        .range(from, from + READ_PAGE - 1)
      if (error) {
        if (TABLE_MISSING.has(error.code)) return { ids: [] }
        return { ids: [], error: `${GLOFOX_CROSSOVER_TABLE} read: ${message(error)}` }
      }
      ids.push(...(data || []).map((r) => r.contact_id).filter(Boolean))
      if (!data || data.length < READ_PAGE) break
    }
    return { ids: [...new Set(ids)] }
  } catch (err) {
    return { ids: [], error: message(err) }
  }
}

/**
 * The PostgREST or() filter for "the studio's own contacts, or its crossover
 * contacts", or null when there are no crossover contacts (the caller then
 * keeps its plain `.eq('location_id', …)`). Ids are uuids from our own table.
 */
export function glofoxStudioOrCrossoverFilter(locationId, crossoverIds) {
  const ids = (crossoverIds || []).filter(Boolean)
  if (!ids.length) return null
  return `location_id.eq.${locationId},id.in.(${ids.join(',')})`
}

/** Apply the studio scope to a contacts query builder (see the filter above). */
export function scopeToGlofoxStudio(query, locationId, crossoverIds) {
  const f = glofoxStudioOrCrossoverFilter(locationId, crossoverIds)
  return f ? query.or(f) : query.eq('location_id', locationId)
}

/**
 * For each contact id, the Glofox studios it is linked at by a crossover row
 * (not its home studio). The table not existing yet is an empty map; any other
 * failure is `error`.
 *
 * @returns {Promise<{ byContact: Map<string, string[]>, error?: string }>}
 */
export async function glofoxLinkLocationsByContact(db, contactIds) {
  const byContact = new Map()
  const ids = [...new Set((contactIds || []).filter(Boolean))]
  try {
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const { data, error } = await db.from(GLOFOX_CROSSOVER_TABLE).select('contact_id, location_id')
        .in('contact_id', ids.slice(i, i + IN_CHUNK))
      if (error) {
        if (TABLE_MISSING.has(error.code)) return { byContact: new Map() }
        return { byContact: new Map(), error: `${GLOFOX_CROSSOVER_TABLE} read: ${message(error)}` }
      }
      for (const r of data || []) {
        const list = byContact.get(r.contact_id) || []
        if (!list.includes(r.location_id)) list.push(r.location_id)
        byContact.set(r.contact_id, list)
      }
    }
    return { byContact }
  } catch (err) {
    return { byContact: new Map(), error: message(err) }
  }
}

/** Does this contact row belong to the Glofox studio: home there, or linked there? Pure. */
export function contactAtGlofoxStudio(contact, locationId) {
  if (!contact || !locationId) return false
  if (contact.location_id === locationId) return true
  return Array.isArray(contact.glofox_link_location_ids) && contact.glofox_link_location_ids.includes(locationId)
}
