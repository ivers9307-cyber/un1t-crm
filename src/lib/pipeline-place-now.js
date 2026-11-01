// PIPE3.7 — place ONE contact on the studio's boards right now.
//
// Two moments want a card to move before tonight's run: a €39 trial grant
// (trial-purchase-processor) and a programme lead landing on /50plus
// (class-booking). Both read the contact fresh and hand it to
// ensureDealForContact, which routes through shared/pipelines/router.js like
// the nightly pass. Best-effort by contract: never throws, never reports a
// failure as success; the nightly run converges either way.

import { ensureDealForContact } from './glofox-sync.js'
import { logWarn } from './log.js'
import { getBoardModule } from '../../shared/pipelines/index.js'

// Every column the router reads (the Programmes module's list is the widest
// contacts-input set) plus the studio the row lives at.
export const PLACE_NOW_COLUMNS = [...new Set([...getBoardModule('programmes').requiredFields, 'location_id'])].join(', ')

/**
 * @param {object} db  service-role client
 * @param {{ locationId: string, contactId: string, now?: number }} args
 * @returns {Promise<{ ok: true, deal: object } | { ok: false, reason: string }>}
 */
export async function placeContactNow(db, { locationId, contactId, now = Date.now() } = {}) {
  if (!db || !locationId || !contactId) return { ok: false, reason: 'missing_arguments' }
  let contact
  try {
    const { data, error } = await db
      .from('contacts')
      .select(PLACE_NOW_COLUMNS)
      .eq('id', contactId)
      .maybeSingle()                       // primary key; 0 rows = gone
    if (error) {
      logWarn('pipeline-place-now', 'contact read failed', { locationId, contactId, err: error.message })
      return { ok: false, reason: 'contact_unreadable' }
    }
    contact = data
  } catch (e) {
    logWarn('pipeline-place-now', 'contact read threw', { locationId, contactId, err: e?.message })
    return { ok: false, reason: 'contact_unreadable' }
  }
  if (!contact) return { ok: false, reason: 'contact_missing' }
  try {
    const deal = await ensureDealForContact(db, locationId, contactId, contact, contact.name || null, { now })
    return { ok: true, deal }
  } catch (e) {
    logWarn('pipeline-place-now', 'placement threw', { locationId, contactId, err: e?.message })
    return { ok: false, reason: 'placement_threw' }
  }
}
