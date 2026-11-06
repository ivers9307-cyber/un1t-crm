// MOBILEFUNNEL.1 — the marketing-consent rule of the public offer forms
// (/api/public/corp-claims, /api/public/class-booking), where the box now
// starts unticked and is optional (Richard's decision, 5 Nov 2026; controller
// ruling: option A). NOT /api/public/trial-purchases: the €39 checkout keeps
// its required, pre-ticked box (Richard, 5 Nov 2026: the purchase's follow-up
// sequences run on the marketing lane).
//
//   ticked                                → opt in (consent: true), as before
//   unticked, contact created by this POST → opt out (consent: false)
//   unticked, contact already existed      → their earlier choice stands; only
//                                            if they have NO row at this
//                                            studio, one is inserted with the
//                                            marketing channels off (review fix)
//
// Why the middle line: a NEW contact is marketable by default. The contacts
// INSERT trigger (mig 489) creates the home-studio contact_location_preferences
// row with every marketing channel TRUE (mig 487), contact_preferences defaults
// TRUE too (mig 005), and the sender reads that studio row (mig 491). Writing
// nothing would leave someone who did not tick on that studio's marketing lists
// with no consent recorded. Writing false for an EXISTING contact would revoke
// an opt-in they gave before, at every studio (the mig 489/747 fan-out), so
// that case writes nothing.
//
// Why the studio row for a returning contact: row ABSENT means the studio may
// never send to them (mig 487), and the sequence runner reads it for EVERY
// step, transactional ones included (locationConsent in
// src/lib/sequences/steps.js), so a Stillorgan contact on a Hatch page with no
// Hatch row would never get, say, their account-created email. The row is
// inserted only when none exists (ignoreDuplicates: an existing row, and with
// it any earlier opt-in, is never touched) with all three marketing channels
// false (joined, not opted in to marketing), plus one consent_log row per
// channel naming the studio, as the studio-scoped WhatsApp STOP records it.
// applyFormMarketingConsent(false) is never called for an existing contact:
// it flips the organisation-wide contact_preferences.
//
// Administrative consent (confirmations, reminders) is never touched here:
// applyFormMarketingConsent writes only the three *_marketing channels.

import { applyFormMarketingConsent } from './marketing-consent.js'
import { consentActionFor } from './consent-actions.js'
import { logError } from './log.js'

const MARKETING_CHANNELS = ['email_marketing', 'sms_marketing', 'whatsapp_marketing']

/**
 * Insert this studio's contact_location_preferences row, marketing off, only
 * when the contact has none there. Never updates an existing row.
 * @returns {Promise<{ ok: boolean, inserted: boolean, error?: string }>}
 */
export async function ensureStudioRowMarketingOff(db, { contactId, locationId, source, ipAddress = null }) {
  if (!contactId || !locationId) return { ok: true, inserted: false }
  const now = new Date().toISOString()
  const row = { contact_id: contactId, location_id: locationId, source, unsubscribed_at: now, updated_at: now }
  for (const ch of MARKETING_CHANNELS) row[ch] = false
  const { data, error } = await db
    .from('contact_location_preferences')
    .upsert(row, { onConflict: 'contact_id,location_id', ignoreDuplicates: true })
    .select('contact_id')
  if (error) {
    logError('offer-form-consent', 'studio preference row insert failed', { contactId, locationId, code: error.code ?? null })
    return { ok: false, inserted: false, error: error.message || 'insert failed' }
  }
  const inserted = Array.isArray(data) && data.length > 0
  if (!inserted) return { ok: true, inserted: false }
  const logRows = MARKETING_CHANNELS.map((channel) => ({
    contact_id: contactId, channel, action: consentActionFor(false), source, ip_address: ipAddress, location_id: locationId,
  }))
  const { error: logErr } = await db.from('consent_log').insert(logRows)
  if (logErr) {
    // The row (marketing off) is written; only its audit line is missing.
    logError('offer-form-consent', 'consent_log insert failed', { contactId, locationId, code: logErr.code ?? null })
    return { ok: false, inserted: true, error: logErr.message || 'consent_log insert failed' }
  }
  return { ok: true, inserted: true }
}

/**
 * @param {SupabaseClient} db
 * @param {{ contactId: string, created: boolean, consent?: boolean, source: string,
 *   ipAddress?: string|null, locationId?: string|null }} args
 * @returns {Promise<{ applied: 'opt_in'|'opt_out'|'studio_row'|null, result?: { ok: boolean, error?: string } }>}
 *   `result.ok === false` is a failed write the caller logs (never the form's failure).
 */
export async function applyOfferFormConsent(db, { contactId, created, consent, source, ipAddress = null, locationId = null }) {
  if (consent === true) {
    return { applied: 'opt_in', result: await applyFormMarketingConsent(db, { contactId, consent: true, source, ipAddress, locationId }) }
  }
  if (created === true) {
    return { applied: 'opt_out', result: await applyFormMarketingConsent(db, { contactId, consent: false, source, ipAddress, locationId }) }
  }
  const result = await ensureStudioRowMarketingOff(db, { contactId, locationId, source, ipAddress })
  return { applied: result.inserted ? 'studio_row' : null, result }
}
