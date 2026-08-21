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
//   - Opt-IN normalises contacts.email_status to 'active' (clearing a
//     legacy NULL; bounced/complained are never touched). Opt-OUT never
//     writes email_status: mig 492 retired 'unsubscribed' — the column is
//     reputation-only, and the opt-out lives in
//     contact_location_preferences (same convention as the
//     preference-centre and admin-panel paths, LOCCOMMS.5).
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
import { consentActionFor } from './consent-actions.js'
import { emailStatusNormaliseForOptIn } from './email-reputation.js'

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
 * @param {string}  [args.locationId]     LOCCOMMS.2 — the location the FORM belongs to,
 *        which is often NOT contacts.location_id. Supplying it records the decision in
 *        contact_location_preferences for that location AND on consent_log.location_id
 *        (CONSENTLOC.1, mig 487); omitting it writes only the global row, with a NULL
 *        on the audit rows. Every public form should pass it — a form that forgets records the
 *        consent globally and the location can never send to that person (row absent =
 *        never send). Host-list signups deliberately omit it: hosts have their own
 *        mechanism (host_contacts + host_email_suppressions).
 *
 * @returns {Promise<{
 *   ok:      boolean,
 *   skipped: 'classpass'|'no_contact'|null,
 *   changed: string[],
 *   error?:  string,
 * }>}
 */
export async function applyFormMarketingConsent(db, args) {
  const { contactId, consent, source, ipAddress = null, locationId = null } = args || {}
  if (!db || !contactId || typeof consent !== 'boolean' || !source) {
    return { ok: false, error: 'invalid args', skipped: null, changed: [] }
  }

  // 1. Pull the contact so we can:
  //    - skip ClassPass contacts (they're permanently opted out per
  //      mig 151 — form submissions don't override that)
  //    - decide whether email_status needs flipping
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, email, glofox_membership_status, email_status')
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

  // LOCCOMMS.2 — record the decision at the location the FORM belongs to, which
  // is frequently NOT contacts.location_id: a Stillorgan member joining the
  // Hatch Street waitlist needs a row at Hatch. The mig 489 sync triggers
  // deliberately never create that row, because a global preference change is
  // not evidence that someone joined a particular location's list. This is.
  //
  // MUST run before the "nothing changed" early return below. Someone already
  // opted in globally who joins a new location produces an empty `changed` set,
  // so anything written after that return would never run — the person would
  // join the list with nothing recording it, and row-absent means that location
  // may never send to them.
  if (locationId) {
    const locRow = {
      contact_id:      contactId,
      location_id:     locationId,
      source,
      updated_at:      new Date().toISOString(),
      unsubscribed_at: consent ? null : new Date().toISOString(),
    }
    for (const ch of MARKETING_CHANNELS) locRow[ch] = consent
    const { error: locErr } = await db
      .from('contact_location_preferences')
      .upsert(locRow, { onConflict: 'contact_id,location_id' })
    if (locErr) {
      logWarn('marketing-consent', 'location preference write failed', { err: locErr.message, locationId })
    }
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

  if (changed.length === 0) {
    // Nothing to do — preferences already match the consent intent.
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
    //
    // CONSENTLOC.1 — location_id (mig 487) is the location this decision was
    // made AT, and it is the same locationId the contact_location_preferences
    // row above was written for: those two rows describe one event and must
    // not disagree. NULL when the caller has none — see the note on the
    // locationId param. Never contacts.location_id as a stand-in: the whole
    // point of LOCCOMMS.2 is that the two routinely differ, so substituting
    // it would file a real consent decision against the wrong gym.
    const logRows = changed.map((ch) => ({
      contact_id:  contactId,
      channel:     ch,
      action:      consentActionFor(consent),
      source,
      ip_address:  ipAddress,
      location_id: locationId,
    }))
    await db.from('consent_log').insert(logRows)
  }

  // 6. Mirror to contacts.email_status ONLY on opt-in, normalising a
  //    legacy NULL (or deploy-gap 'unsubscribed' residue) to 'active'.
  //    LOCCOMMS.5 / mig 492 — reputation only; never stamp 'unsubscribed'
  //    (mig 501's CHECK would reject it). An opt-out is already recorded
  //    in contact_location_preferences + contact_preferences above.
  //    'bounced' / 'complained' are never cleared — reputation states a
  //    form submission must not reset.
  //    EMAILREP.2 — the rule itself now lives in email-reputation.js, shared
  //    with applyMarketingPreferencesBulk, the bulk-import route and the
  //    admin marketing-preferences PATCH (which had no guard at all).
  const emailFlipped = changed.includes('email_marketing')
  if (emailFlipped && consent) {
    const nextStatus = emailStatusNormaliseForOptIn(contact.email_status)
    if (nextStatus) {
      await db.from('contacts').update({ email_status: nextStatus }).eq('id', contactId)
    }
  }

  // 7. RESUB-SUPP.1 — an opt-in here must ALSO lift Postmark's own suppression.
  //
  // PMSUPP.1 made our opt-outs push a suppression to Postmark, and taught the
  // preference centre to lift it again on a resubscribe. This path — every
  // public form: the event form, the waitlist, the /start booking funnel —
  // never got the other half. So someone could opt out through a form, be
  // suppressed at Postmark by the drift cron, opt back IN through a form, and
  // be re-granted consent in our database while Postmark went on refusing
  // every send. Both systems then agree they are subscribed and no mail
  // arrives, which is invisible from either side.
  //
  // Not theoretical: measured 2026-08-21, four contacts sat in exactly that
  // state (colinmcreynolds@hotmail.com, dnlduffy@gmail.com, murphm53@tcd.ie,
  // jackoconnor1994@gmail.com). It only surfaced because a sequence step
  // THROWS on a Postmark rejection and burned five retries doing it.
  //
  // 🔴 The lift is safe ONLY because unsuppressAtPostmark reads the reason
  // first and deletes exclusively a ManualSuppression. It never touches a
  // HardBounce — Postmark describes deleting one as "reactivating the
  // associated bounce" — and a SpamComplaint cannot be deleted at all. Consent
  // is NOT evidence the mailbox works: the click can come from a copy
  // delivered before the bounce. Do not "simplify" this by deleting
  // unconditionally.
  //
  // Best-effort and last: this is a fire-and-forget side effect on a public
  // form submission, and the consent decision above is already durably
  // recorded. Losing the lift leaves someone missing mail they asked for,
  // which the next opt-in or a human can fix; failing the whole request would
  // lose the form submission itself.
  //
  // Gated on emailFlipped so the hot path (every /start booking arrives with
  // consent already true) does not make a Postmark round-trip per submission.
  // A contact who is already opted in has no suppression this call created,
  // and the daily consent-drift-check is what reconciles pre-existing residue.
  if (emailFlipped && consent && contact.email) {
    try {
      const { unsuppressAtPostmark } = await import('@/lib/postmark-suppressions')
      const result = await unsuppressAtPostmark(contact.email)
      if (result?.failed?.length) {
        logWarn('marketing-consent', 'Postmark suppression lift failed — the opt-in IS recorded, but mail stays blocked until it is lifted', {
          contactId, message: result.failed[0]?.message,
        })
      }
    } catch (e) {
      logWarn('marketing-consent', 'Postmark suppression lift threw', { contactId, err: e?.message || String(e) })
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
 * @param {string} [args.locationId]     CONSENTLOC.1 — the location this consent
 *        decision belongs to, recorded on consent_log.location_id (mig 487).
 *        Pass it whenever the triggering event names one: the Postmark
 *        webhook paths read it off the email_sends row the event refers to.
 *        Omit it (→ NULL) when the caller genuinely has none — a CSV import of
 *        somebody else's list carries no location, and a NULL that reads
 *        "unknown" is safer than contacts.location_id, which is a guess that
 *        is wrong for exactly the cross-location cases LOCCOMMS.2 exists for.
 *        This ONLY affects what is recorded; it never changes which channels
 *        flip or who ends up opted in.
 *
 * @returns {Promise<{
 *   ok: boolean, skipped: string|null,
 *   changed: string[], error?: string
 * }>}
 */
export async function applyMarketingPreferencesBulk(db, args) {
  const { contactId, prefs, source, ipAddress = null, locationId = null } = args || {}
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
  //    direction the channel went. CONSENTLOC.1 — location_id records WHERE
  //    the decision happened; NULL when the caller can't know (see the param
  //    doc), never a substituted contacts.location_id.
  const logRows = changed.map((ch) => ({
    contact_id:  contactId,
    channel:     ch,
    action:      consentActionFor(wantedPrefs[ch]),
    source,
    ip_address:  ipAddress,
    location_id: locationId,
  }))
  await db.from('consent_log').insert(logRows)

  // 6. Mirror email_status ONLY on opt-in — same rule as
  //    applyFormMarketingConsent: LOCCOMMS.5 / mig 492, reputation only;
  //    never stamp 'unsubscribed'. The opt-out lives in the preference
  //    rows written above.
  if (changed.includes('email_marketing') && wantedPrefs.email_marketing) {
    const nextStatus = emailStatusNormaliseForOptIn(contact.email_status)
    if (nextStatus) {
      await db.from('contacts').update({ email_status: nextStatus }).eq('id', contactId)
    }
  }

  return { ok: true, skipped: null, changed }
}

