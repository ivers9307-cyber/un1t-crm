// UN1TSYNC.4 — org-scoped resolution of un1t.online clients to CRM contacts.
//
// Identity is per ORGANISATION, not per location: Hatch Street and Stillorgan
// share the UN1T Group org, so a person who is already a Stillorgan contact is
// the same person on Hatch and must be attached, never duplicated. The org
// unique index (contacts_email_org_unique) is case-sensitive, so it cannot be
// relied on to catch `Jane@x.ie` vs `jane@x.ie`; the email lookup here is
// case-insensitive (`.ilike` with the value LIKE-escaped, because `_` and `%`
// are legal email characters) and scoped by organization_id only.
//
// On an EXISTING contact this writes only un1t_user_id, un1t_synced_at and
// first_name/last_name/phone when they are empty. It never writes location_id,
// email, glofox_* or any consent field. organization_id is set by a trigger
// from location_id (mig 712) and is never written here.

import { contactFieldsFromClient } from './un1t-online-map.js'
import { escapeLikePattern } from './like-escape.js'

const CHUNK = 200
const CONTACT_COLUMNS = 'id, location_id, un1t_user_id, first_name, last_name, phone'

function isEmpty(v) {
  return v === undefined || v === null || v === ''
}

/** Name/phone fields the client can fill on a contact where they are empty. */
function nullFills(contact, fields) {
  const fill = {}
  for (const key of ['first_name', 'last_name', 'phone']) {
    if (isEmpty(contact[key]) && !isEmpty(fields[key])) fill[key] = fields[key]
  }
  return fill
}

function reasonOf(error) {
  return String(error?.message || error?.code || error || 'unknown error')
}

/**
 * @param {object} db                supabase service-role client
 * @param {object} args
 * @param {string} args.locationId   the studio the client belongs to
 * @param {string} args.organizationId
 * @param {Array<object>} args.clients  raw un1t.online client rows
 * @param {string} args.now          ISO timestamp for un1t_synced_at
 * @returns {Promise<{contactIdByUserId: Map<string,string>, contactLocationByUserId: Map<string,string|null>, newlyLinked: Array<{userId: string, contactId: string, how: 'created'|'attached', homeLocationId: string|null, remoteCreatedAt: string|null}>, counts: object, errors: Array}>}
 *   contactLocationByUserId is the resolved contact's OWN location_id, which
 *   differs from `locationId` when the client was linked to another studio's contact.
 */
export async function resolveUn1tContacts(db, { locationId, organizationId, clients, now }) {
  const contactIdByUserId = new Map()
  const contactLocationByUserId = new Map()
  const counts = {
    linked: 0,
    attached_by_email: 0,
    created: 0,
    ambiguous_email: 0,
    conflict: 0,
    no_email: 0,
    failed: 0,
  }
  const errors = []
  // SHAREDCONTACT.1 — clients that became a contact of this studio on THIS
  // run: inserted (rule 3) or attached by email to an existing contact (rule
  // 2). The sync fires contact_created at this studio for the recent ones.
  const newlyLinked = []

  // `extra` carries the candidate contact(s) when the resolver knew them
  // (contact_id, or contact_ids for an ambiguous email), so the sync can
  // spare that contact's membership even when its un1t_user_id is not set.
  const fail = (userId, reason, extra = {}) => {
    counts.failed += 1
    errors.push({ un1t_user_id: userId, reason, ...extra })
  }

  // A client repeated across pages is processed once (first occurrence wins).
  const list = []
  const seenIds = new Set()
  for (const c of Array.isArray(clients) ? clients : []) {
    const id = c && c.id !== undefined && c.id !== null && c.id !== '' ? String(c.id) : null
    if (id) {
      if (seenIds.has(id)) continue
      seenIds.add(id)
    }
    list.push(c)
  }
  const userIds = []
  for (const c of list) {
    const id = c && c.id !== undefined && c.id !== null && c.id !== '' ? String(c.id) : null
    if (id) userIds.push(id)
  }

  // 1. Existing links, loaded in chunks. A failed chunk read is "unknown", not
  // "no links": falling through to the email/insert path on it could create a
  // duplicate of a contact we merely failed to read, so those clients fail.
  const byUserId = new Map()
  const unreadable = new Set()
  const unique = [...new Set(userIds)]
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK)
    const { data, error } = await db
      .from('contacts')
      .select(CONTACT_COLUMNS)
      .eq('organization_id', organizationId)
      .in('un1t_user_id', chunk)
    if (error) {
      for (const id of chunk) unreadable.add(id)
      continue
    }
    for (const row of data || []) byUserId.set(String(row.un1t_user_id), row)
  }

  for (const client of list) {
    const userId =
      client && client.id !== undefined && client.id !== null && client.id !== ''
        ? String(client.id)
        : null
    if (!userId) {
      fail(null, 'client has no id')
      continue
    }
    if (unreadable.has(userId)) {
      fail(userId, 'contacts lookup by un1t_user_id failed')
      continue
    }

    const fields = contactFieldsFromClient(client)

    // Rule 1 — already linked.
    const linked = byUserId.get(userId)
    if (linked) {
      // Write only when there is something to write: every UPDATE bumps
      // contacts.updated_at (a recency tiebreak in person-accounts.js), so
      // un1t_synced_at means "last time the sync wrote this contact".
      if (Object.keys(nullFills(linked, fields)).length > 0) {
        const ok = await updateContact(db, linked, fields, { now, attach: false, userId })
        if (ok.error) {
          fail(userId, ok.error, { contact_id: linked.id })
          continue
        }
      }
      counts.linked += 1
      contactIdByUserId.set(userId, linked.id)
      contactLocationByUserId.set(userId, linked.location_id ?? null)
      continue
    }

    // Rule 2 — same email anywhere in the organisation, any case.
    if (fields.email) {
      const { data, error } = await db
        .from('contacts')
        .select(CONTACT_COLUMNS)
        .eq('organization_id', organizationId)
        .ilike('email', escapeLikePattern(fields.email))
        .limit(2)
      if (error) {
        fail(userId, `contacts lookup by email failed: ${reasonOf(error)}`)
        continue
      }
      const matches = data || []
      if (matches.length > 1) {
        counts.ambiguous_email += 1
        errors.push({ un1t_user_id: userId, reason: 'ambiguous_email', contact_ids: matches.map((m) => m.id) })
        continue
      }
      if (matches.length === 1) {
        const match = matches[0]
        if (!isEmpty(match.un1t_user_id) && String(match.un1t_user_id) !== userId) {
          counts.conflict += 1
          errors.push({ un1t_user_id: userId, reason: 'conflict', contact_id: match.id })
          continue
        }
        const ok = await updateContact(db, match, fields, { now, attach: true, userId })
        if (ok.error) {
          fail(userId, ok.error, { contact_id: match.id })
          continue
        }
        counts.attached_by_email += 1
        newlyLinked.push({ userId, contactId: match.id, how: 'attached', homeLocationId: match.location_id ?? null, remoteCreatedAt: client?.created_at ?? null })
        contactIdByUserId.set(userId, match.id)
        contactLocationByUserId.set(userId, match.location_id ?? null)
        continue
      }
    }

    // Rule 3 — a new contact. Name-only (email null) contacts are allowed.
    // contacts.name is TEXT NOT NULL (mig 001), so a create must always carry one.
    const payload = {
      location_id: locationId,
      source: 'un1t_online',
      name: [fields.first_name, fields.last_name].filter(Boolean).join(' ') || fields.email || 'un1t.online member',
      email: fields.email,
      first_name: fields.first_name,
      last_name: fields.last_name,
      phone: fields.phone,
      un1t_user_id: userId,
      un1t_synced_at: now,
    }
    const { data, error } = await db.from('contacts').insert(payload).select('id')
    if (error) {
      fail(userId, `contact insert failed: ${reasonOf(error)}`)
      continue
    }
    const created = Array.isArray(data) ? data[0] : null
    if (!created || !created.id) {
      fail(userId, 'contact insert returned no row')
      continue
    }
    counts.created += 1
    if (!fields.email) counts.no_email += 1
    newlyLinked.push({ userId, contactId: created.id, how: 'created', homeLocationId: locationId, remoteCreatedAt: client?.created_at ?? null })
    contactIdByUserId.set(userId, created.id)
    contactLocationByUserId.set(userId, locationId)
  }

  return { contactIdByUserId, contactLocationByUserId, newlyLinked, counts, errors }
}

async function updateContact(db, contact, fields, { now, attach, userId }) {
  const patch = { ...nullFills(contact, fields), un1t_synced_at: now }
  if (attach) patch.un1t_user_id = userId
  const { data, error } = await db
    .from('contacts')
    .update(patch)
    .eq('id', contact.id)
    .select('id')
  if (error) return { error: `contact update failed: ${reasonOf(error)}` }
  // A zero-row UPDATE is not an error in PostgREST.
  if (!Array.isArray(data) || data.length === 0) return { error: 'contact update touched no row' }
  return { error: null }
}
