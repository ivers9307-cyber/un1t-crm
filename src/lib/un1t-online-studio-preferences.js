// UN1TDUAL.3 — give a un1t.online client who is linked to ANOTHER studio's
// contact their marketing-preferences row at this studio.
//
// Hatch Street's clients that match a Stillorgan contact by email are linked to
// that contact, not duplicated (un1t-online-contacts.js). The contact has a
// contact_location_preferences row only for its own studio (mig 489's insert
// trigger), and row-absent means no send, so Hatch's marketing would skip them.
//
// Product decision: marketing stays ON for a sync-linked contact (the table's
// defaults: creating the row is the opt-in act, and the person is a member of
// this studio). Rules, all pinned by un1t-online-studio-preferences.test.js:
//   - INSERT-IF-MISSING only. An existing row is never updated: someone who
//     unsubscribed at this studio stays unsubscribed. (upsert with
//     ignoreDuplicates; .select('contact_id') says which rows it created.)
//   - unsubscribed_at stays NULL even when email starts OFF: the sync did not
//     unsubscribe anyone and holds no moment of the person's global opt-out
//     (mig 543 allows null; no CHECK pairs it with email_marketing).
//   - A channel the person has ALREADY withdrawn globally (contact_preferences
//     false, or contacts.email_status 'unsubscribed' for email) starts OFF, the
//     same derivation mig 488 used. A row born ON would re-subscribe them.
//     A failed read of that evidence creates nothing (unknown is not "ON").
//   - One consent_log opt_in row per channel actually switched on, naming this
//     location and source 'un1t_online_sync' (the mig 489 trigger logs nothing
//     for a default row; the sync records the opt-in it performs).
//   - NEVER throws. The sync records the result in counts.studio_preferences
//     and does not let it change the run's status.

import { CONSENT_ACTIONS } from './consent-actions.js'

const CHUNK = 200
// Reads put every id in the URL's IN-list, so they take smaller chunks.
const READ_CHUNK = 100
const MAX_ERROR_LEN = 500
const CHANNELS = ['email_marketing', 'sms_marketing', 'whatsapp_marketing']

/** Only code and message ever leave this file (never details / hint). */
function safeError(err) {
  const raw = err?.message || err?.code || (typeof err === 'string' ? err : '') || 'unknown error'
  const s = String(raw)
  return { code: err?.code ?? null, message: s.length > MAX_ERROR_LEN ? `${s.slice(0, MAX_ERROR_LEN)}…` : s }
}

function chunks(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * Pure: the row a contact starts with at this studio. Table defaults (all ON),
 * minus any channel the contact has already withdrawn globally.
 *
 * @param {{ prefs?: object|null, emailStatus?: string|null }} evidence
 */
export function initialChannels({ prefs = null, emailStatus = null } = {}) {
  const on = {}
  for (const ch of CHANNELS) on[ch] = prefs ? prefs[ch] !== false : true
  if (emailStatus === 'unsubscribed') on.email_marketing = false
  return on
}

/**
 * @param {object} db  supabase service-role client
 * @param {{ locationId: string, contactIds: string[], nowIso?: string }} args
 *   contactIds: contacts linked at this studio whose own location is another.
 * @returns {Promise<{ created: number, error?: { code: string|null, message: string } }>}
 */
export async function ensureStudioPreferences(db, { locationId, contactIds, nowIso = new Date().toISOString() }) {
  let created = 0
  try {
    const ids = [...new Set((Array.isArray(contactIds) ? contactIds : []).filter(Boolean))]
    if (!locationId || ids.length === 0) return { created }

    // 1. Who already has a row here (any state: it is never touched).
    const have = new Set()
    for (const idChunk of chunks(ids, READ_CHUNK)) {
      const { data, error } = await db
        .from('contact_location_preferences')
        .select('contact_id')
        .eq('location_id', locationId)
        .in('contact_id', idChunk)
      if (error) return { created, error: safeError(error) }
      for (const r of data || []) have.add(r.contact_id)
    }
    const missing = ids.filter((id) => !have.has(id))
    if (missing.length === 0) return { created }

    // 2. Their global consent evidence.
    const prefsById = new Map()
    const emailStatusById = new Map()
    for (const idChunk of chunks(missing, READ_CHUNK)) {
      const prefs = await db
        .from('contact_preferences')
        .select('contact_id, email_marketing, sms_marketing, whatsapp_marketing')
        .in('contact_id', idChunk)
      if (prefs.error) return { created, error: safeError(prefs.error) }
      for (const r of prefs.data || []) prefsById.set(r.contact_id, r)
      const contacts = await db.from('contacts').select('id, email_status').in('id', idChunk)
      if (contacts.error) return { created, error: safeError(contacts.error) }
      for (const r of contacts.data || []) emailStatusById.set(r.id, r.email_status ?? null)
    }

    // 3. Insert-if-missing, then log an opt_in for each channel it switched on.
    for (const idChunk of chunks(missing, CHUNK)) {
      const rows = idChunk.map((contactId) => {
        const on = initialChannels({ prefs: prefsById.get(contactId), emailStatus: emailStatusById.get(contactId) })
        return {
          contact_id: contactId,
          location_id: locationId,
          ...on,
          // Literal, not a constant: consent-sources.test.js scans for `source:` literals.
          source: 'un1t_online_sync',
          subscribed_at: nowIso,
          unsubscribed_at: null,
        }
      })
      const { data, error } = await db
        .from('contact_location_preferences')
        .upsert(rows, { onConflict: 'contact_id,location_id', ignoreDuplicates: true })
        .select('contact_id')
      if (error) return { created, error: safeError(error) }

      const made = new Set((data || []).map((r) => r.contact_id))
      created += made.size
      const log = []
      for (const row of rows) {
        if (!made.has(row.contact_id)) continue
        for (const ch of CHANNELS) {
          if (!row[ch]) continue
          log.push({
            contact_id: row.contact_id,
            channel: ch,
            action: CONSENT_ACTIONS.OPT_IN,
            source: 'un1t_online_sync',
            location_id: locationId,
          })
        }
      }
      if (log.length > 0) {
        const { error: logError } = await db.from('consent_log').insert(log)
        if (logError) return { created, error: safeError(logError) }
      }
    }
    return { created }
  } catch (err) {
    return { created, error: safeError(err) }
  }
}
