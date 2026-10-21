// ORGCONTACTS.1 — src/lib/contact-studios.js: the one reader and writer of
// public.contact_studios from app code (mig 764; spec
// docs/superpowers/specs/2026-10-20-org-shared-contacts-whatsapp-design.md §2.1-2.2).
//
// contact_studios holds one row per (contact, studio) that has ever had a
// relationship, and is THE answer to "which studios is this person at".
// Richard's standing rule (decision 1, 20 Oct 2026): people belong to the
// organisation, studios hold relationships; every source writes a row here
// and nothing else. Decision 2: ANY row, active or ended, makes the person
// visible to staff holding Contacts at that studio; kind and status matter
// only to Mia, routing and pricing.
//
// The lifecycle rules (spec §2.1, verbatim; derive_contact_studio() in mig
// 764 is their SQL twin, change both):
//   * status = 'active' while ANY of these holds at that studio: a live
//     membership, a provider account (un1t_clients row, Glofox link), an open
//     deal, or a marketing-preferences row (and, by ruling, the contact's
//     primary studio). Otherwise 'ended' with ended_at. Rows are never deleted.
//   * kind is the strongest current relationship: member (live membership) >
//     client (provider account, lapsed or not) > lead (deal or preferences
//     only). It moves down when a membership ends and up when one starts.
//   * last_seen_at is LAST ACTIVITY, never a sync tick: attendance, a booking,
//     a deal touch, a message in that studio's thread. Syncs stamp
//     first_seen_at and status only (upsertContactStudio never carries
//     last_seen_at; touchContactStudio is the only writer of it here).
//
// Service-role `db` only (the table has no client privilege). Nothing here
// throws: every read or write failure comes back as { ok: false, error }.
// Reads page under the 1,000-row cap in a total order; id lists go in
// chunks of IN_CHUNK (PostgREST sends them as a GET URL).

export const KINDS = Object.freeze(['member', 'client', 'lead'])
export const STATUSES = Object.freeze(['active', 'ended'])
export const SOURCES = Object.freeze(['glofox', 'un1t_online', 'lead_form', 'deal', 'manual', 'import'])
export const IN_CHUNK = 150

const TABLE = 'contact_studios'
const PAGE = 1000
const ROW_COLUMNS = 'contact_id, location_id, kind, status, source, stage_slug, first_seen_at, last_seen_at'
const LOCATION_COLUMNS = 'id, name, active, is_host_anchor, organization_id, membership_source'
const ERR_MAX = 300

const message = (e) => String(e?.message || e?.code || e || 'unknown error').slice(0, ERR_MAX)
const fail = (error) => ({ ok: false, error })

function chunks(list, size = IN_CHUNK) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** Read every row of `build(from, to)` under the 1,000-row cap. Throws on a read error. */
async function readAll(build) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw error
    const page = Array.isArray(data) ? data : []
    rows.push(...page)
    if (page.length < PAGE) return rows
  }
}

/**
 * Write the relationship a source knows about (a sync, a form, a link).
 * Upserts on (contact_id, location_id). Never lowers first_seen_at (it is
 * written only through a guarded second update that moves it EARLIER), never
 * touches last_seen_at, sets ended_at with status, writes stage_slug only when
 * given (null clears it).
 *
 * @returns {Promise<{ ok: true, row: object } | { ok: false, error: string }>}
 */
export async function upsertContactStudio(db, {
  contactId, locationId, kind, source, status = 'active', firstSeenAt = null, stageSlug = undefined,
  nowIso = new Date().toISOString(),
} = {}) {
  if (!db || !contactId || !locationId) return fail('contact_studios: contactId and locationId are required')
  if (!KINDS.includes(kind)) return fail(`contact_studios: kind must be one of ${KINDS.join(', ')}`)
  if (!STATUSES.includes(status)) return fail(`contact_studios: status must be one of ${STATUSES.join(', ')}`)
  if (!SOURCES.includes(source)) return fail(`contact_studios: source must be one of ${SOURCES.join(', ')}`)
  try {
    const payload = {
      contact_id: contactId, location_id: locationId, kind, status, source,
      ended_at: status === 'ended' ? nowIso : null,
      updated_at: nowIso,
    }
    if (stageSlug !== undefined) payload.stage_slug = stageSlug
    const { data, error } = await db
      .from(TABLE)
      .upsert(payload, { onConflict: 'contact_id,location_id' })
      .select(ROW_COLUMNS)
    if (error) return fail(`contact_studios upsert: ${message(error)}`)
    const row = Array.isArray(data) ? data[0] : null
    if (!row) return fail('contact_studios upsert returned no row')
    if (firstSeenAt) {
      const { error: seenErr } = await db
        .from(TABLE)
        .update({ first_seen_at: firstSeenAt })
        .eq('contact_id', contactId)
        .eq('location_id', locationId)
        .gt('first_seen_at', firstSeenAt)
      if (seenErr) return fail(`contact_studios first_seen_at: ${message(seenErr)}`)
    }
    return { ok: true, row }
  } catch (e) {
    return fail(message(e))
  }
}

/**
 * Record activity at a studio: last_seen_at moves FORWARD only (a null or
 * earlier value is overwritten; a later one stays). No row yet is not an
 * error: { ok: true, touched: false }.
 *
 * @returns {Promise<{ ok: true, touched: boolean } | { ok: false, error: string }>}
 */
export async function touchContactStudio(db, { contactId, locationId, at = new Date().toISOString() } = {}) {
  if (!db || !contactId || !locationId) return fail('contact_studios: contactId and locationId are required')
  try {
    const { data, error } = await db
      .from(TABLE)
      .update({ last_seen_at: at })
      .eq('contact_id', contactId)
      .eq('location_id', locationId)
      .or(`last_seen_at.is.null,last_seen_at.lt.${at}`)
      .select('contact_id')
    if (error) return fail(`contact_studios touch: ${message(error)}`)
    return { ok: true, touched: Array.isArray(data) && data.length > 0 }
  } catch (e) {
    return fail(message(e))
  }
}

/**
 * The relationships AT one studio: every row (any status) unless narrowed.
 * `contactIds` restricts to those contacts (chunked). Paged in contact_id order.
 *
 * @returns {Promise<{ ok: true, rows: object[] } | { ok: false, error: string }>}
 */
export async function contactsAtStudio(db, locationId, { kinds = null, status = null, contactIds = null } = {}) {
  if (!db || !locationId) return fail('contact_studios: locationId is required')
  const ids = contactIds == null ? null : [...new Set(contactIds.filter(Boolean))]
  if (ids && ids.length === 0) return { ok: true, rows: [] }
  try {
    const rows = []
    for (const chunk of ids ? chunks(ids) : [null]) {
      rows.push(...await readAll((from, to) => {
        let q = db.from(TABLE).select(ROW_COLUMNS).eq('location_id', locationId)
        if (kinds) q = q.in('kind', kinds)
        if (status) q = q.eq('status', status)
        if (chunk) q = q.in('contact_id', chunk)
        return q.order('contact_id', { ascending: true }).range(from, to)
      }))
    }
    return { ok: true, rows }
  } catch (e) {
    return fail(`contact_studios read: ${message(e)}`)
  }
}

/**
 * One contact's studios, each row with its location ({ id, name, active,
 * is_host_anchor, organization_id, membership_source }, or null when the
 * locations read did not name it). `activeOnly` keeps only active rows at
 * active, non-host-anchor studios (a picker's list; Review Focus 1).
 *
 * @returns {Promise<{ ok: true, rows: object[] } | { ok: false, error: string }>}
 */
export async function studiosOfContact(db, contactId, { activeOnly = false } = {}) {
  if (!db || !contactId) return fail('contact_studios: contactId is required')
  try {
    const rows = await readAll((from, to) => db
      .from(TABLE).select(ROW_COLUMNS).eq('contact_id', contactId)
      .order('location_id', { ascending: true }).range(from, to))
    const locIds = [...new Set(rows.map((r) => r.location_id).filter(Boolean))]
    const locById = new Map()
    for (const chunk of chunks(locIds)) {
      const { data, error } = await db.from('locations').select(LOCATION_COLUMNS).in('id', chunk)
      if (error) throw error
      for (const l of data || []) locById.set(l.id, l)
    }
    let out = rows.map((r) => ({ ...r, location: locById.get(r.location_id) || null }))
    if (activeOnly) {
      out = out.filter((r) => r.status === 'active' && r.location && r.location.active !== false && r.location.is_host_anchor !== true)
    }
    return { ok: true, rows: out }
  } catch (e) {
    return fail(`contact_studios read: ${message(e)}`)
  }
}

/**
 * Several contacts' rows, grouped by contact (no location join). Chunked.
 *
 * @returns {Promise<{ ok: true, byContact: Map<string, object[]> } | { ok: false, error: string }>}
 */
export async function studiosOfContacts(db, contactIds) {
  if (!db) return fail('contact_studios: db is required')
  const ids = [...new Set((contactIds || []).filter(Boolean))]
  const byContact = new Map()
  if (ids.length === 0) return { ok: true, byContact }
  try {
    for (const chunk of chunks(ids)) {
      const rows = await readAll((from, to) => db
        .from(TABLE).select(ROW_COLUMNS).in('contact_id', chunk)
        .order('contact_id', { ascending: true }).order('location_id', { ascending: true }).range(from, to))
      for (const r of rows) {
        const list = byContact.get(r.contact_id) || []
        list.push(r)
        byContact.set(r.contact_id, list)
      }
    }
    return { ok: true, byContact }
  } catch (e) {
    return fail(`contact_studios read: ${message(e)}`)
  }
}

/**
 * The studios among `locationIds` where the contact has ANY row, ended
 * included (decision 2: visibility is any relationship).
 *
 * @returns {Promise<{ ok: true, at: Set<string> } | { ok: false, error: string }>}
 */
export async function hasRelationshipAt(db, contactId, locationIds) {
  if (!db || !contactId) return fail('contact_studios: contactId is required')
  const ids = [...new Set((locationIds || []).filter(Boolean))]
  if (ids.length === 0) return { ok: true, at: new Set() }
  try {
    const at = new Set()
    for (const chunk of chunks(ids)) {
      const { data, error } = await db
        .from(TABLE).select('location_id, status').eq('contact_id', contactId).in('location_id', chunk)
      if (error) throw error
      for (const r of data || []) if (r.location_id) at.add(r.location_id)
    }
    return { ok: true, at }
  } catch (e) {
    return fail(`contact_studios read: ${message(e)}`)
  }
}

/** The contact's PRIMARY studio (contacts.location_id). Pure. */
export function primaryStudioOf(contact) {
  return contact?.location_id ?? null
}

const time = (v) => (v ? Date.parse(v) || 0 : 0)

/**
 * The studio to act at among a contact's rows: the ACTIVE row with the
 * latest activity; a tie goes to the primary studio when it is one of them,
 * else the lowest location_id (deterministic; Review Focus 3); no active row
 * → the primary studio, else null. Pure.
 */
export function pickStudioByActivity(rows, { primaryLocationId = null } = {}) {
  const active = (Array.isArray(rows) ? rows : []).filter((r) => r && r.status === 'active' && r.location_id)
  if (active.length === 0) return primaryLocationId ?? null
  const best = Math.max(...active.map((r) => time(r.last_seen_at)))
  const tied = active.filter((r) => time(r.last_seen_at) === best).map((r) => r.location_id)
  if (primaryLocationId && tied.includes(primaryLocationId)) return primaryLocationId
  return [...tied].sort()[0]
}
