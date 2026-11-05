// MOBILEFUNNEL.1 — the marketing-consent rule of the public offer forms
// (/api/public/corp-claims, /api/public/class-booking,
// /api/public/trial-purchases), where the box now starts unticked and is
// optional (Richard's decision, 5 Nov 2026; controller ruling: option A).
//
//   ticked                                → opt in (consent: true), as before
//   unticked, contact created by this POST → opt out (consent: false)
//   unticked, contact already existed      → nothing: their earlier choice stands
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
// Administrative consent (confirmations, reminders) is never touched here:
// applyFormMarketingConsent writes only the three *_marketing channels.

import { applyFormMarketingConsent } from './marketing-consent.js'

/**
 * @param {SupabaseClient} db
 * @param {{ contactId: string, created: boolean, consent?: boolean, source: string,
 *   ipAddress?: string|null, locationId?: string|null }} args
 * @returns {Promise<{ applied: 'opt_in'|'opt_out'|null, result?: object }>}
 */
export async function applyOfferFormConsent(db, { contactId, created, consent, source, ipAddress = null, locationId = null }) {
  if (consent === true) {
    return { applied: 'opt_in', result: await applyFormMarketingConsent(db, { contactId, consent: true, source, ipAddress, locationId }) }
  }
  if (created === true) {
    return { applied: 'opt_out', result: await applyFormMarketingConsent(db, { contactId, consent: false, source, ipAddress, locationId }) }
  }
  return { applied: null }
}
