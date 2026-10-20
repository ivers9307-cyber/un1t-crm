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
import { upsertContactStudio, contactsAtStudio, studiosOfContacts } from './contact-studios.js'
import { hasBookableMembership } from './person-accounts.js'

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
 * the studio, mig 758), the studio's marketing-preferences row
 * (insert-if-missing; an existing row, an unsubscribe included, is never
 * touched) and, since ORGCONTACTS.1, the contact_studios row at the Glofox
 * studio (mig 764: kind member when `contactRow`'s Glofox columns say the
 * membership is bookable, else client; source glofox; first_seen_at from
 * `contactRow.joined_at`). A contact who lives AT the studio needs none and is
 * skipped. The relationship write is reported as `contact_studio` and never
 * fails the link.
 *
 * @returns {Promise<{ linked: boolean, preferences_created: number, skipped?: string, error?: string,
 *   contact_studio?: { ok: true } | { ok: false, error: string } }>}
 */
export async function recordGlofoxCrossover(db, { locationId, glofoxMemberId, contactId, contactLocationId = undefined, contactRow = null }) {
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

    const studio = await upsertContactStudio(db, {
      contactId, locationId, source: 'glofox', status: 'active',
      kind: hasBookableMembership(contactRow) ? 'member' : 'client',
      firstSeenAt: contactRow?.joined_at || null,
    })
    out.contact_studio = studio.ok ? { ok: true } : { ok: false, error: studio.error }

    const prefs = await ensureStudioPreferences(db, { locationId, contactIds: [contactId], origin: 'glofox' })
    out.preferences_created = prefs.created || 0
    if (prefs.error) return { ...out, error: `studio preferences: ${prefs.error.message}` }
    return out
  } catch (err) {
    return { ...out, error: message(err) }
  }
}

// ─────────────────────────────────────────────────────────────
// Readers (GLOFOXREADERS.1, re-backed on contact_studios by ORGCONTACTS.2)
// ─────────────────────────────────────────────────────────────
//
// A crossover contact keeps its primary location_id (Hatch), so every reader
// that selects `contacts WHERE location_id = <Glofox studio> AND
// glofox_member_id` skipped it: no attendance refresh, no detail backfill, and
// Mia not counting it as a member of the Glofox studio. These helpers let a
// reader widen "lives at the studio" to "has a Glofox relationship at the
// studio": a contact_studios row there with source glofox (mig 764), any
// status. The names stay until Phase 5's sweep; the data source is the
// relationship table.

/**
 * The contact ids with a Glofox relationship at `locationId` (any status),
 * paged past the 1,000-row cap. Any failure is `error` (the caller decides;
 * never read it as "none").
 *
 * @returns {Promise<{ ids: string[], error?: string }>}
 */
export async function glofoxCrossoverContactIds(db, locationId) {
  try {
    const r = await contactsAtStudio(db, locationId)
    if (!r.ok) return { ids: [], error: `contact_studios read: ${r.error}` }
    return { ids: [...new Set(r.rows.filter((row) => row.source === 'glofox').map((row) => row.contact_id).filter(Boolean))] }
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
 * For each contact id, the studios it has a Glofox relationship at (source
 * glofox, any status; the home Glofox studio included). Any failure is `error`.
 *
 * @returns {Promise<{ byContact: Map<string, string[]>, error?: string }>}
 */
export async function glofoxLinkLocationsByContact(db, contactIds) {
  const byContact = new Map()
  try {
    const r = await studiosOfContacts(db, contactIds)
    if (!r.ok) return { byContact: new Map(), error: `contact_studios read: ${r.error}` }
    for (const [contactId, rows] of r.byContact) {
      const list = [...new Set(rows.filter((row) => row.source === 'glofox').map((row) => row.location_id).filter(Boolean))]
      if (list.length) byContact.set(contactId, list)
    }
    return { byContact }
  } catch (err) {
    return { byContact: new Map(), error: message(err) }
  }
}

/** Does this contact row belong to the Glofox studio: home there, or a relationship there? Pure. */
export function contactAtGlofoxStudio(contact, locationId) {
  if (!contact || !locationId) return false
  if (contact.location_id === locationId) return true
  return Array.isArray(contact.studio_location_ids) && contact.studio_location_ids.includes(locationId)
}
