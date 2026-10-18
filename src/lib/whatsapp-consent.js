// WhatsApp inbound consent keywords (STOP / START).
//
// The broadcast footer promises "Reply STOP to Unsubscribe" — this is
// what honours it. The webhook calls applyWhatsappConsentKeyword when an
// inbound TEXT message is an exact keyword match (parseConsentKeyword in
// whatsapp.js: UNSUBSCRIBE / STOP / STOP ALL / STOPALL out, START / UNSTOP /
// SUBSCRIBE back in; CANCEL/END/QUIT dropped in STOPWORDS.1). Nothing here throws: a consent write must never fail the
// webhook (which always 200s so Meta doesn't disable the subscription). That
// is NOT the same as best-effort — every write is ATTEMPTED regardless of what
// the others did, the failures are collected, and the result says whether the
// change took effect (`applied`) and whether anything was lost on the way
// (`partial` / `failures`), so the caller can log it and no acknowledgement is
// sent for a change that did not happen at all. A failure in one write must
// never prevent another suppression signal being written — see
// applyConsentWrites.
//
// STOP:
//   - contact_preferences.whatsapp_marketing → false (the broadcast /
//     drip / audience gate: buildWhatsAppAudience filters on it)
//   - contacts.wa_status → 'opted_out' (the hard signal every WA send
//     path checks — broadcasts exclude blocked/opted_out)
//   - consent_log row (channel whatsapp_marketing, action opt_out,
//     source whatsapp_keyword) — the audit trail
//   - best-effort acknowledgement text (their keyword just opened the
//     24h window, so a plain text reply is allowed)
// START reverses it (opt_in / wa_status 'active').
//
// WAORGNUMBER.3 (R6) — A KEYWORD ACTS AT THE STUDIO WHOSE THREAD IT ARRIVES IN.
// One number can be switched on at two studios, so "STOP" in a Hatch Street
// thread means "stop Hatch Street's marketing", not "stop everything". With a
// locationId the keyword writes ONLY that studio's contact_location_preferences
// row (+ a consent_log row naming the studio) and NOT contact_preferences or
// contacts.wa_status: both are contact-wide, and the mig 489/543 DEFINER
// trigger fans a contact-wide whatsapp_marketing=false out to EVERY studio's
// row. Historic wa_status='opted_out' rows from earlier contact-wide STOPs are
// left as they are by a STOP; a studio START lifts 'opted_out' (only that
// value) back to 'active', because the member asked to resume. Mig 747 makes
// the trigger act only on channels that changed, so an unrelated
// contact_preferences write no longer undoes a studio STOP or START at the
// home studio. Without a locationId the three contact-wide writes below
// run exactly as before (scope 'contact'). Meta's own user_preferences control
// stays contact-wide (applyMetaUserPreference).
//
// The STOP/START description above is that contact-wide path.
//
// GAPS-P6 — the consent_log rows written here used to say 'opted_out' /
// 'opted_in', which is the `contacts.wa_status` vocabulary, not the
// `consent_log.action` one. 83 real opt-outs were invisible to every report
// filtering `action = 'opt_out'`. The two columns are adjacent in this file
// and mean different things: wa_status KEEPS 'opted_out' (it is correct
// there), the log action moves to the canonical CONSENT_ACTIONS.

import { sendTextMessage } from './whatsapp'
import { consentActionFor } from './consent-actions'
import { logError, logWarn } from './log'
import { consentAckText } from './whatsapp-consent-copy'
import { orgLocationIdsFor, scopeFor } from './inbound-contact-match'

export { consentAckText }

// The contact-wide path's acknowledgement (no studio to name). The studio path
// uses consentAckText (operator-editable per studio).
const ACK_STOP =
  "You've been unsubscribed from WhatsApp marketing messages. Reply START at any time to opt back in."
const ACK_START =
  "You're opted back in to WhatsApp messages. Reply STOP at any time to unsubscribe."

/**
 * Apply BOTH authoritative consent writes, independently, and report what
 * landed. Never throws.
 *
 * BAREWRITE.4 — this exists because the shape of the fix matters more than the
 * fix. BAREWRITE.1 correctly stopped the function claiming `applied: true` on a
 * write it never checked, but it implemented that by RETURNING EARLY on the
 * first failure — so a failed `contact_preferences` upsert now also skipped the
 * `contacts.wa_status` write that used to run regardless. On main a partial
 * failure still left ONE suppression signal standing; on that branch it left
 * ZERO. A STOP that half-failed suppressed nothing at all, which is strictly
 * worse than the silent bug it replaced.
 *
 * The rule this file now follows: **removing a silent failure must never create
 * a louder one.** Every suppression signal is ATTEMPTED, whatever the others
 * did; only then is the outcome judged. Where an opt-out partially fails the
 * resting state is MORE suppression plus a loud, structured error — never less.
 *
 * The two writes are genuinely independent gates, not two halves of one:
 *   • `contact_preferences.whatsapp_marketing` — the AUDIENCE gate
 *     (buildWhatsAppAudience filters on it; the broadcast/drip/sequence
 *     selectors never see a contact whose flag is false).
 *   • `contacts.wa_status` — the HARD per-send signal (every WA send path
 *     excludes 'opted_out'/'blocked').
 * Either one alone suppresses real traffic. So for a STOP, "took effect" means
 * at least one of them landed — the same floor main achieved — not both.
 *
 * WAORGNUMBER.3 (R6) — with a `locationId` the keyword acts at that studio
 * only: see applyStudioConsentWrites. Without one, the three contact-wide writes
 * below run exactly as before (Review Focus 3).
 *
 * @param {object} db
 * @param {{ contactId: string, locationId?: string|null, optingOut: boolean, source: string }} args
 * @returns {Promise<{prefOk: boolean, statusOk: boolean, failures: string[], scope: 'studio'|'contact'}>}
 */
async function applyConsentWrites(db, { contactId, locationId = null, optingOut, source }) {
  if (locationId) return applyStudioConsentWrites(db, { contactId, locationId, optingOut, source })

  const failures = []

  // 1. The marketing consent flag (source of truth for audiences).
  //    UPSERT by contact_id (same convention as marketing-consent.js):
  //    a contact without a preferences row matched zero rows under the
  //    old .update(), so STOP flipped wa_status but never the flag —
  //    the contact stayed in marketing audiences.
  const { error: prefError } = await db
    .from('contact_preferences')
    .upsert(
      { contact_id: contactId, whatsapp_marketing: !optingOut, updated_at: new Date().toISOString() },
      { onConflict: 'contact_id' },
    )
  if (prefError) failures.push(`contact_preferences.whatsapp_marketing: ${prefError.message}`)

  // 1b. WAORGNUMBER.3 (R17) — a contact-wide opt-OUT also closes every studio
  //     row of the contact. Mig 747 fans contact_preferences out to the studio
  //     rows only on a CHANGE, so a studio row re-opened by a studio START would
  //     otherwise survive a later contact-wide STOP (contact_preferences already
  //     false = no change = no fan-out). Only rows that are currently true are
  //     written. Checked and counted in `failures`; it is NOT part of the
  //     verdict (the two gates below still decide it), and a contact with no
  //     studio rows is the ordinary zero-row answer. An opt-IN contact-wide
  //     never re-opens a studio row: opting back in is per studio.
  if (optingOut) {
    const { error: studioRowsError } = await db
      .from('contact_location_preferences')
      .update({ whatsapp_marketing: false, updated_at: new Date().toISOString() })
      .eq('contact_id', contactId)
      .eq('whatsapp_marketing', true)
    if (studioRowsError) failures.push(`contact_location_preferences.whatsapp_marketing (all studios): ${studioRowsError.message}`)
  }

  // 2. The hard wa_status signal on the contact row. ATTEMPTED WHATEVER
  //    STEP 1 DID — see the header. This is the write whose loss the early
  //    return used to cause.
  const { error: statusError } = await db
    .from('contacts')
    .update({ wa_status: optingOut ? 'opted_out' : 'active' })
    .eq('id', contactId)
  if (statusError) failures.push(`contacts.wa_status: ${statusError.message}`)

  // 3. Audit trail. Best-effort ON PURPOSE and never part of the verdict:
  //    refusing to acknowledge over a lost log line would leave the customer
  //    un-answered on a change that did take effect.
  const { error: logRowError } = await db.from('consent_log').insert({
    contact_id: contactId,
    channel: 'whatsapp_marketing',
    action: consentActionFor(!optingOut),
    source,
  })
  if (logRowError) failures.push(`consent_log (audit only): ${logRowError.message}`)

  const prefOk = !prefError
  const statusOk = !statusError

  if (failures.length > 0) {
    // Loud and STRUCTURED — Sentinel keys on module+event, not on prose.
    // `suppressed` is the honest summary of where the contact actually stands.
    logError('wa-consent', 'consent write(s) failed', {
      contactId,
      source,
      direction: optingOut ? 'opt_out' : 'opt_in',
      prefOk,
      statusOk,
      // For a STOP: is the contact suppressed on ANY path at all?
      suppressed: optingOut ? (prefOk || statusOk) : null,
      failures,
    })
  }

  return { prefOk, statusOk, failures, scope: 'contact' }
}

/**
 * WAORGNUMBER.3 (R6) — the keyword at ONE studio: that studio's
 * contact_location_preferences row and a consent_log row naming it. Nothing
 * else contact-wide is written (no contact_preferences, so the mig 489/543/747
 * fan-out never runs for it), except that a START lifts a historic wa_status
 * 'opted_out' (see below). Never throws.
 *
 * WHY NOT ONE UPSERT. The row's channels default TRUE (mig 487: creating the
 * row IS the opt-in act), so an upsert naming only whatsapp_marketing would, for
 * a contact with no row here, OPEN email and SMS marketing at this studio. And
 * an upsert naming all three would overwrite the email/SMS choices of a contact
 * who already has a row. So:
 *   1. create-if-missing (`ignoreDuplicates`, the un1t-online-studio-preferences
 *      pattern; `.select` says whether it created): WhatsApp as asked, email and
 *      SMS OFF, source 'whatsapp_keyword'. A WhatsApp keyword is not consent to
 *      email or SMS.
 *   2. otherwise flip ONLY whatsapp_marketing on the existing row, judged on the
 *      rows it touched (a zero-row UPDATE is not an error in PostgREST).
 * Step 2 is attempted even when step 1 errored (louder-failure rule: a failed
 * write never costs another suppression write); the row may well exist.
 *
 * unsubscribed_at tracks EMAIL (mig 543: stamped when email_marketing goes
 * false, cleared when it goes true; consent-propagation.js stamps it only for
 * email on this table). So a WhatsApp STOP stamps it only on a row it CREATES
 * (all three channels off there); on an existing row it is left alone, or every
 * "when did they leave the email list" answer would read a WhatsApp STOP as an
 * email unsubscribe.
 *
 * There is ONE suppression gate here, not two: a STOP is judged on `prefOk`
 * alone. `statusOk` is about the START-only lift of a historic wa_status
 * 'opted_out' (below); it is true whenever there was nothing to lift.
 */
async function applyStudioConsentWrites(db, { contactId, locationId, optingOut, source }) {
  const failures = []
  const nowIso = new Date().toISOString()
  const wa = !optingOut

  let created = false
  const { data: createdRows, error: createError } = await db
    .from('contact_location_preferences')
    .upsert(
      {
        contact_id: contactId,
        location_id: locationId,
        email_marketing: false,
        sms_marketing: false,
        whatsapp_marketing: wa,
        // Literal, not a variable: consent-sources.test.js scans for `source:` literals.
        source: 'whatsapp_keyword',
        subscribed_at: nowIso,
        unsubscribed_at: optingOut ? nowIso : null,
        updated_at: nowIso,
      },
      { onConflict: 'contact_id,location_id', ignoreDuplicates: true },
    )
    .select('contact_id')
  // A create error is held, not yet counted: the row may exist already, and if
  // the update below lands the end state is correct, so the error is not a
  // failure of this keyword (it is logged as a warning in that case).
  if (!createError) created = (createdRows || []).length > 0

  let updated = false
  if (!created) {
    const { data: updatedRows, error: updateError } = await db
      .from('contact_location_preferences')
      .update({ whatsapp_marketing: wa, updated_at: nowIso })
      .eq('contact_id', contactId)
      .eq('location_id', locationId)
      .select('contact_id')
    if (updateError) failures.push(`contact_location_preferences.whatsapp_marketing: ${updateError.message}`)
    else if ((updatedRows || []).length === 0) failures.push('contact_location_preferences.whatsapp_marketing: no row at this studio was changed')
    else updated = true
  }
  if (createError) {
    if (updated) {
      logWarn('wa-consent', 'studio row create errored but the update landed; end state is correct', { contactId, locationId, err: createError.message })
    } else {
      failures.push(`contact_location_preferences (create): ${createError.message}`)
    }
  }

  // Audit trail, naming the studio. Best-effort and never part of the verdict
  // (same reasoning as the contact-wide path).
  const { error: logRowError } = await db.from('consent_log').insert({
    contact_id: contactId,
    channel: 'whatsapp_marketing',
    action: consentActionFor(wa),
    source,
    location_id: locationId,
  })
  if (logRowError) failures.push(`consent_log (audit only): ${logRowError.message}`)

  const prefOk = created || updated

  // START lifts a HISTORIC contact-wide STOP (WAORGNUMBER.3 ruling). A contact
  // whose wa_status is 'opted_out' from an earlier contact-wide STOP is
  // excluded by every WhatsApp send path, so a studio START alone would be
  // acknowledged and still change nothing. The member explicitly asked to
  // resume, so 'opted_out' goes back to 'active' (and ONLY 'opted_out':
  // 'blocked' and 'undeliverable' are never touched). The other studios stay
  // opted out through their own rows, which that historic STOP set false.
  // Only once the studio row landed: an opt-in never widens on a failed write.
  // A failed lift fails the START (the contact is still blocked everywhere, so
  // "you're back on" would be a promise not kept); zero rows is the ordinary
  // answer for a contact that was never opted out.
  let statusOk = true
  if (!optingOut && prefOk) {
    const { error: liftError } = await db
      .from('contacts')
      .update({ wa_status: 'active' })
      .eq('id', contactId)
      .eq('wa_status', 'opted_out')
    if (liftError) {
      statusOk = false
      failures.push(`contacts.wa_status (lift opted_out): ${liftError.message}`)
    }
  }

  if (failures.length > 0) {
    logError('wa-consent', 'consent write(s) failed', {
      contactId,
      locationId,
      scope: 'studio',
      source,
      direction: optingOut ? 'opt_out' : 'opt_in',
      prefOk,
      // For a STOP: is the contact suppressed at this studio?
      suppressed: optingOut ? prefOk : null,
      failures,
    })
  }

  return { prefOk, statusOk, failures, scope: 'studio' }
}

/**
 * Did the consent change take effect to at least the degree main achieved?
 *
 * STOP  — true when EITHER suppression signal landed. One gate alone keeps the
 *         contact out of real traffic, and refusing the acknowledgement over
 *         the other one buys no extra suppression while leaving a customer who
 *         asked to stop with no answer at all (and no prompt to retry).
 * START — true only when BOTH landed. The failure direction is reversed here:
 *         a partial opt-in leaves the contact still suppressed on one gate, so
 *         "You're opted back in" would be a promise we have not kept, and the
 *         safe resting state (still suppressed) costs the customer nothing but
 *         marketing they asked for. Under-claiming is the safe error here;
 *         over-claiming is not.
 * Both rules are for the contact-wide path's two gates.
 */
function consentTookEffect(optingOut, { prefOk, statusOk, scope }) {
  // WAORGNUMBER.3 — at a studio, STOP has one gate, the studio's row (with it
  // unwritten nothing new is suppressed). START needs the row AND the lift of a
  // historic wa_status 'opted_out' (statusOk), for the same under-claiming
  // reason as below.
  if (scope === 'studio') return optingOut ? prefOk : (prefOk && statusOk)
  return optingOut ? (prefOk || statusOk) : (prefOk && statusOk)
}

/**
 * The studio's name and settings for the acknowledgement. A failed read is
 * logged and answers null, so the default copy goes out naming no studio: the
 * consent change already landed, and a customer who said STOP is still owed
 * the answer.
 */
async function loadAckLocation(db, locationId) {
  const { data, error } = await db.from('locations').select('name, settings').eq('id', locationId).maybeSingle()
  if (error) {
    logWarn('wa-consent', 'studio read for the acknowledgement failed; default copy used', { locationId, err: error.message })
    return null
  }
  return data || null
}

/**
 * Apply a parsed consent keyword for a contact. Never throws.
 *
 * @param {object} args
 * @param {object} args.db            service-role client
 * @param {{id: string, wa_phone?: string}} args.contact  must have id
 * @param {string|null} [args.waPhone]  the sender's number — pass this
 *   explicitly from the webhook (its contact lookup is a minimal
 *   `select('id, location_id')`, so contact.wa_phone is usually absent;
 *   relying on it silently skipped the ack on the first live STOP).
 * @param {string|null} args.locationId  the thread's studio. The keyword acts
 *   there only (WAORGNUMBER.3, R6) and the ack names it; null = contact-wide.
 * @param {string|null} args.conversationId  thread to attribute the ack to
 * @param {'stop'|'start'} args.keyword
 * @returns {Promise<{applied: boolean, action?: string, reason?: string,
 *   failures?: string[], partial?: boolean}>}
 *   `applied: false` means the consent change did NOT land at all and no
 *   acknowledgement was sent. `applied: true` with a non-empty `failures`
 *   means it landed on at least one gate but not every one — still loud, and
 *   still the caller's business to report.
 */
export async function applyWhatsappConsentKeyword({ db, contact, waPhone, locationId, conversationId, keyword }) {
  if (!contact?.id || !['stop', 'start'].includes(keyword)) return { applied: false }

  const optingOut = keyword === 'stop'
  const action = consentActionFor(!optingOut)

  // BAREWRITE.1 found these three writes as BARE awaits inside a try/catch,
  // which is the most dangerous member of the class because it READS as
  // handled: supabase builders resolve with `{ data, error }` instead of
  // throwing, so that catch could never fire for any of them. The function then
  // returned `applied: true` unconditionally and sent the customer "You've been
  // unsubscribed from WhatsApp marketing messages" while they were still in
  // every marketing audience.
  //
  // BAREWRITE.4 keeps that verdict but fixes its shape: see applyConsentWrites
  // above. Every write is attempted; the early return that could leave a STOP
  // with ZERO suppression is gone.
  //
  // WAORGNUMBER.3 (R6) — with the thread's locationId this acts at that studio
  // only; with none, contact-wide exactly as before.
  const outcome = await applyConsentWrites(db, { contactId: contact.id, locationId, optingOut, source: 'whatsapp_keyword' })
  if (!consentTookEffect(optingOut, outcome)) {
    return {
      applied: false,
      reason: optingOut ? 'no_suppression_signal_landed' : 'opt_in_incomplete',
      failures: outcome.failures,
    }
  }

  // 4. Acknowledge — best-effort, and recorded in the thread so the
  //    inbox shows the exchange. Their keyword message opened the 24h
  //    window, so a plain text send is permitted.
  //
  //    THIS try/catch is real: sendTextMessage genuinely throws. The two
  //    supabase writes inside it do not, so they carry their own error checks
  //    — losing them costs an inbox line, not the consent change, so they log
  //    rather than fail.
  try {
    const ack = outcome.scope === 'studio'
      ? consentAckText(await loadAckLocation(db, locationId), optingOut)
      : (optingOut ? ACK_STOP : ACK_START)
    const to = waPhone || contact.wa_phone
    if (!to) {
      console.warn(`[wa-consent] no phone for contact ${contact.id} — consent applied but ack skipped`)
    }
    if (to) {
      // WAHOMESTUDIO.1 — through the thread's number (a number-less studio's thread replies through its sibling's).
      const result = await sendTextMessage(to, ack, { locationId, ...(conversationId ? { replyInConversation: conversationId } : {}) })
      if (conversationId) {
        const { error: msgError } = await db.from('whatsapp_messages').insert({
          conversation_id: conversationId,
          contact_id: contact.id,
          location_id: locationId,
          wa_message_id: result.messageId,
          direction: 'outbound',
          message_type: 'text',
          body: ack,
          status: 'sent',
          sent_at: new Date().toISOString(),
        })
        if (msgError) console.error(`[wa-consent] ack sent but not recorded in the thread for contact ${contact.id}:`, msgError.message)
        const { error: convError } = await db.from('whatsapp_conversations').update({
          last_message_at: new Date().toISOString(),
          last_message_direction: 'outbound',
          last_message_preview: ack.substring(0, 100),
        }).eq('id', conversationId)
        if (convError) console.error(`[wa-consent] ack sent but the conversation preview was not updated for contact ${contact.id}:`, convError.message)
      }
    }
  } catch (e) {
    // The consent change stands even if the ack couldn't send.
    console.warn(`[wa-consent] ack send failed for contact ${contact.id}:`, e?.message || e)
  }

  return outcome.failures.length > 0
    ? { applied: true, action, partial: true, failures: outcome.failures }
    : { applied: true, action }
}

/**
 * Meta's user_preferences webhook — the in-app "stop marketing messages" /
 * "resume" control (a SEPARATE signal from STOP/START keywords). Applies the
 * same three writes as the keyword path (preference flag + wa_status +
 * consent_log) but sends NO ack: Meta shows its own confirmation UX.
 * pref = { wa_id, category, value: 'stop'|'resume' }.
 */
export async function applyMetaUserPreference(db, pref = {}, receivingLocationId = null) {
  if (pref.category && pref.category !== 'marketing_messages') return { applied: false, reason: 'unknown_category' }
  if (!['stop', 'resume'].includes(pref.value)) return { applied: false, reason: 'unknown_value' }
  const waId = String(pref.wa_id || '').replace(/\D/g, '')
  if (!waId) return { applied: false, reason: 'no_wa_id' }

  const optingOut = pref.value === 'stop'

  // WAORGNUMBER.3 (R6) — the lookup is scoped to the RECEIVING number's
  // organisation. It used to be unscoped (`.limit(1)` across every contact), so
  // a person who is a contact at two tenants could have the OTHER tenant's row
  // opted out by a preference they set on this tenant's number.
  //
  // Suppression is the safe direction, so the two directions differ when the
  // receiving studio cannot be resolved:
  //   • opt-OUT: applies to EVERY contact with that number (unscoped), logged
  //     structurally. Dropping a person's "stop marketing" is worse than
  //     over-reaching into another tenant's marketing list.
  //   • opt-IN: not applied (logged by the route). Never widen on a guess.
  let orgLocationIds = null
  if (receivingLocationId) {
    orgLocationIds = await orgLocationIdsFor(db, receivingLocationId)
  } else if (!optingOut) {
    return { applied: false, reason: 'no_receiving_studio' }
  } else {
    logError('wa-consent', 'Meta opt-out arrived with an unresolved receiving studio; applying it to every contact with the number', { waId })
  }

  // EVERY matching contact in scope, not the first: the same person is often a
  // contact at more than one studio of the organisation, and Meta's control is
  // the person's, not a studio's. Paginated (1,000-row cap) with an explicit order.
  const PAGE = 1000
  const contacts = []
  const failures = []
  for (let from = 0; ; from += PAGE) {
    let q = db.from('contacts')
      .select('id')
      .or(`wa_phone.eq.${waId},wa_phone.eq.+${waId},phone.eq.${waId},phone.eq.+${waId}`)
    if (orgLocationIds) q = q.in('location_id', scopeFor(orgLocationIds))
    const { data: page, error: contactError } = await q.order('id').range(from, from + PAGE - 1)
    if (contactError) {
      // Suppress what was read; report the rest. Never drop an opt-out over a failed page.
      failures.push(`contacts: ${contactError.message}`)
      break
    }
    contacts.push(...(page || []))
    if ((page || []).length < PAGE) break
  }
  if (contacts.length === 0) {
    return failures.length > 0
      ? { applied: false, reason: 'contact_read_failed', failures }
      : { applied: false, reason: 'no_contact' }
  }

  // Exactly the same writes and the same BAREWRITE.4 shape as the keyword path
  // above, through one helper, per contact. (See the history note there: the two
  // paths must make the same partial-failure judgement, STOP needs EITHER gate,
  // START needs BOTH, and one copy of that is how it stays right.)
  // No locationId: Meta's control is number-level, so it stays contact-wide (R6).
  const tookEffect = []
  for (const contact of contacts) {
    const outcome = await applyConsentWrites(db, { contactId: contact.id, optingOut, source: 'meta_user_preferences' })
    failures.push(...outcome.failures)
    if (consentTookEffect(optingOut, outcome)) tookEffect.push(contact.id)
  }
  if (tookEffect.length === 0) {
    return {
      applied: false,
      reason: optingOut ? 'no_suppression_signal_landed' : 'opt_in_incomplete',
      failures,
      contactId: contacts[0].id,
    }
  }
  const partial = failures.length > 0 || tookEffect.length < contacts.length
  return {
    applied: true,
    action: consentActionFor(!optingOut),
    contactId: tookEffect[0],
    contactIds: tookEffect,
    ...(partial ? { partial: true, failures } : {}),
  }
}
