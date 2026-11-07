// PIPE3.7 — place ONE contact on the studio's boards right now.
//
// Two moments want a card to move before tonight's run: a €39 trial grant
// (trial-purchase-processor) and a programme lead landing on /50plus
// (class-booking). Both read the contact fresh and hand it to
// ensureDealForContact, which routes through shared/pipelines/router.js like
// the nightly pass. Best-effort by contract: never throws, never reports a
// failure as success; the nightly run converges either way. An offer board's
// stage follow-up fires from here (PIPEBUILD.3e); no other board's does.

import { ensureDealForContact } from './glofox-sync.js'
import { logWarn } from './log.js'
import { allRequiredFields } from '../../shared/pipelines/index.js'

// Every column the router reads (PIPEBUILD.3e: the union of every registered
// board module's fields, the offer board's included) plus the studio the row
// lives at.
export const PLACE_NOW_COLUMNS = [...new Set([...allRequiredFields(), 'location_id'])].join(', ')

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
  let deal
  try {
    deal = await ensureDealForContact(db, locationId, contactId, contact, contact.name || null, { now })
  } catch (e) {
    logWarn('pipeline-place-now', 'placement threw', { locationId, contactId, err: e?.message })
    return { ok: false, reason: 'placement_threw' }
  }
  // PIPEBUILD.3e — an offer board's stage starts its follow-up the moment the
  // card lands (create or move). configuredBoardsOnly keeps every other board
  // exactly as before: place-now fired no sequence for them and still fires
  // none (the nightly pass and the webhook own those). Best-effort: the
  // placement is already written. PIPEBUILD.5m — a placement ensureDealForContact
  // marked silent (a claim older than the offer board's baseline) fires nothing.
  if ((deal?.action === 'create' || deal?.action === 'move') && deal?.silent !== true) {
    try {
      const { triggerSequencesForDealPlacement } = await import('./sequences/triggers.js')
      await triggerSequencesForDealPlacement(contactId, deal, {
        dealLocationId: deal.location_id ?? locationId,
        pipelineId: deal.pipeline_id,
        configuredBoardsOnly: true,
      })
    } catch (e) {
      logWarn('pipeline-place-now', 'stage trigger threw', { locationId, contactId, err: e?.message })
    }
  }
  return { ok: true, deal }
}
