// CONSENT.4 — shared helper for form-time marketing consent capture.
//
// Used by:
//   - /api/public/book           (booking form submissions)
//   - /api/public/events/[slug]/register  (event/race registrations)
//   - any future public-facing form where a contact opts in/out
//     of marketing as part of the same submission
//
// Behaviour:
//   - ClassPass contacts (glofox_membership_status='classpass_payg')
//     are EXCLUDED — the CONSENT.2 trigger explicitly blanket-disables
//     all sends to ClassPass users to protect deliverability.
//     Form submissions don't override that. The operator can still
//     manually opt them back in via the contact profile if needed.
//
//   - Otherwise, sets all three marketing channels (email_marketing,
//     sms_marketing, whatsapp_marketing) on contact_preferences:
//       consent === true  → all three flags set to TRUE
//       consent === false → all three flags set to FALSE
//
//   - Mirrors contacts.email_status to keep broadcast audience
//     builders aligned (same convention as the preference-centre
//     and admin-panel paths).
//
//   - Diffs against current values so a no-op submission writes no
//     consent_log entries, and re-submissions don't spam the audit
//     trail with redundant rows.
//
//   - Writes one consent_log row per channel that actually changed,
//     tagged with the supplied source string ('booking_form',
//     'event_form', etc) so reporting can attribute opt-ins back to
//     the funnel they came from.

import { logWarn } from './log.js'

const MARKETING_CHANNELS = ['email_marketing', 'sms_marketing', 'whatsapp_marketing']

/**
 * Apply form-submission marketing consent to a contact.
 *
 * @param {SupabaseClient} db
 * @param {object} args
 * @param {string}  args.contactId
 * @param {boolean} args.consent          true = enroll in marketing, false = opt out
 * @param {string}  args.source           consent_log.source ('booking_form', 'event_form', etc.)
 * @param {string}  [args.ipAddress]      caller IP for the audit row
 *
 * @returns {Promise<{
 *   ok:      boolean,
 *   skipped: 'classpass'|'no_contact'|null,
 *   changed: string[],
 *   error?:  string,
 * }>}
 */
export async function applyFormMarketingConsent(db, args) {
  const { contactId, consent, source, ipAddress = null } = args || {}
  if (!db || !contactId || typeof consent !== 'boolean' || !source) {
    return { ok: false, error: 'invalid args', skipped: null, changed: [] }
  }

  // 1. Pull the contact so we can:
  //    - skip ClassPass contacts (they're permanently opted out per
  //      mig 151 — form submissions don't override that)
  //    - decide whether email_status needs flipping
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, glofox_membership_status, email_status')
    .eq('id', contactId)
    .maybeSingle()
  if (contactErr) {
    logWarn('marketing-consent', 'contact load failed', { err: contactErr.message })
    return { ok: false, error: contactErr.message, skipped: null, changed: [] }
  }
  if (!contact) {
    return { ok: false, error: 'contact not found', skipped: 'no_contact', changed: [] }
  }
  if (contact.glofox_membership_status === 'classpass_payg') {
    return { ok: true, skipped: 'classpass', changed: [] }
  }

  // 2. Load current preferences (if any). Mig 005 trigger creates a
  //    row on contact insert; defensive in case an older contact
  //    predates that.
  const { data: pref } = await db
    .from('contact_preferences')
    .select('email_marketing, sms_marketing, whatsapp_marketing')
    .eq('contact_id', contactId)
    .maybeSingle()

  // 3. Diff: only changed channels go into the update + consent_log.
  const changed = []
  for (const ch of MARKETING_CHANNELS) {
    // Default for a contact without a preferences row yet is TRUE
    // (mig 005 default). For a contact with a row, use its current
    // value.
    const current = pref ? !!pref[ch] : true
    if (current !== consent) changed.push(ch)
  }

  if (changed.length === 0 && contact.email_status !== (consent ? 'unsubscribed' : 'active')) {
    // Nothing to do — preferences already match the consent intent
    // AND email_status is consistent.
    return { ok: true, skipped: null, changed: [] }
  }

  // 4. Upsert preferences. Use upsert by contact_id to handle the
  //    "no row yet" case in one round-trip.
  if (changed.length > 0) {
    const upsertRow = { contact_id: contactId, updated_at: new Date().toISOString() }
    for (const ch of changed) upsertRow[ch] = consent
    const { error: upsertErr } = await db
      .from('contact_preferences')
      .upsert(upsertRow, { onConflict: 'contact_id' })
    if (upsertErr) {
      return { ok: false, error: upsertErr.message, skipped: null, changed: [] }
    }

    // 5. Audit one row per channel that flipped.
    const logRows = changed.map((ch) => ({
      contact_id: contactId,
      channel:    ch,
      action:     consent ? 'opt_in' : 'opt_out',
      source,
      ip_address: ipAddress,
    }))
    await db.from('consent_log').insert(logRows)
  }

  // 6. Mirror to contacts.email_status when email_marketing was in
  //    the changed set. Only flip between 'active' and 'unsubscribed'
  //    — leave 'bounced' / 'complained' alone (those are reputation
  //    states the operator shouldn't accidentally clear).
  const emailFlipped = changed.includes('email_marketing')
  const flipReputationOk = (
    contact.email_status === 'active' || contact.email_status === 'unsubscribed' || contact.email_status === null
  )
  if (emailFlipped && flipReputationOk) {
    const targetStatus = consent ? 'active' : 'unsubscribed'
    if (contact.email_status !== targetStatus) {
      await db.from('contacts').update({ email_status: targetStatus }).eq('id', contactId)
    }
  }

  return { ok: true, skipped: null, changed }
}

/**
 * CONSENT.5 — bulk-import variant. Accepts a partial preferences
 * object and only flips the channels actually present. Used by the
 * marketing-preferences-import route to migrate consent data from
 * external platforms (Mailchimp, Klaviyo, ActiveCampaign, etc.)
 * where the export may only carry one or two channels.
 *
 * Same ClassPass safety + audit + email_status mirror as the
 * applyFormMarketingConsent path.
 *
 * @param {SupabaseClient} db
 * @param {object} args
 * @param {string} args.contactId
 * @param {object} args.prefs            partial channel map:
 *   { email_marketing?: bool, sms_marketing?: bool,
 *     whatsapp_marketing?: bool }
 *   omitted channels are LEFT UNCHANGED.
 * @param {string} args.source           consent_log.source string
 * @param {string} [args.ipAddress]
 *
 * @returns {Promise<{
 *   ok: boolean, skipped: string|null,
 *   changed: string[], error?: string
 * }>}
 */
export async function applyMarketingPreferencesBulk(db, args) {
  const { contactId, prefs, source, ipAddress = null } = args || {}
  if (!db || !contactId || !prefs || typeof prefs !== 'object' || !source) {
    return { ok: false, error: 'invalid args', skipped: null, changed: [] }
  }

  // Filter to known channels with explicit boolean values. Anything
  // else (undefined / null / strings) is silently dropped — caller
  // is responsible for parsing CSV cells into booleans.
  const wantedPrefs = {}
  for (const ch of MARKETING_CHANNELS) {
    if (typeof prefs[ch] === 'boolean') wantedPrefs[ch] = prefs[ch]
  }
  if (Object.keys(wantedPrefs).length === 0) {
    return { ok: true, skipped: null, changed: [] }
  }

  // 1. Load contact for ClassPass check + email_status mirror.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, glofox_membership_status, email_status')
    .eq('id', contactId)
    .maybeSingle()
  if (contactErr) {
    return { ok: false, error: contactErr.message, skipped: null, changed: [] }
  }
  if (!contact) {
    return { ok: false, error: 'contact not found', skipped: 'no_contact', changed: [] }
  }
  if (contact.glofox_membership_status === 'classpass_payg') {
    return { ok: true, skipped: 'classpass', changed: [] }
  }

  // 2. Load current preferences row.
  const { data: pref } = await db
    .from('contact_preferences')
    .select('email_marketing, sms_marketing, whatsapp_marketing')
    .eq('contact_id', contactId)
    .maybeSingle()

  // 3. Diff each requested channel.
  const changed = []
  for (const ch of Object.keys(wantedPrefs)) {
    const current = pref ? !!pref[ch] : true
    if (current !== wantedPrefs[ch]) changed.push(ch)
  }
  if (changed.length === 0) {
    return { ok: true, skipped: null, changed: [] }
  }

  // 4. Upsert preferences (only the changed columns + updated_at).
  const upsertRow = { contact_id: contactId, updated_at: new Date().toISOString() }
  for (const ch of changed) upsertRow[ch] = wantedPrefs[ch]
  const { error: upsertErr } = await db
    .from('contact_preferences')
    .upsert(upsertRow, { onConflict: 'contact_id' })
  if (upsertErr) {
    return { ok: false, error: upsertErr.message, skipped: null, changed: [] }
  }

  // 5. Audit one row per channel that flipped — action mirrors the
  //    direction the channel went.
  const logRows = changed.map((ch) => ({
    contact_id: contactId,
    channel:    ch,
    action:     wantedPrefs[ch] ? 'opt_in' : 'opt_out',
    source,
    ip_address: ipAddress,
  }))
  await db.from('consent_log').insert(logRows)

  // 6. Mirror email_status when email_marketing was in the changed
  //    set. Same reputation-state guard as applyFormMarketingConsent.
  if (changed.includes('email_marketing')) {
    const flipReputationOk = (
      contact.email_status === 'active'
      || contact.email_status === 'unsubscribed'
      || contact.email_status === null
    )
    if (flipReputationOk) {
      const targetStatus = wantedPrefs.email_marketing ? 'active' : 'unsubscribed'
      if (contact.email_status !== targetStatus) {
        await db.from('contacts').update({ email_status: targetStatus }).eq('id', contactId)
      }
    }
  }

  return { ok: true, skipped: null, changed }
}

