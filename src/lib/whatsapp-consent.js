// WhatsApp inbound consent keywords (STOP / START).
//
// The broadcast footer promises "Reply STOP to Unsubscribe" — this is
// what honours it. The webhook calls applyWhatsappConsentKeyword when an
// inbound TEXT message is an exact keyword match (parseConsentKeyword in
// whatsapp.js). Nothing here throws: a consent write must never fail the
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
// GAPS-P6 — the consent_log rows written here used to say 'opted_out' /
// 'opted_in', which is the `contacts.wa_status` vocabulary, not the
// `consent_log.action` one. 83 real opt-outs were invisible to every report
// filtering `action = 'opt_out'`. The two columns are adjacent in this file
// and mean different things: wa_status KEEPS 'opted_out' (it is correct
// there), the log action moves to the canonical CONSENT_ACTIONS.

import { sendTextMessage } from './whatsapp'
import { consentActionFor } from './consent-actions'
import { logError } from './log'

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
 * @returns {Promise<{prefOk: boolean, statusOk: boolean, failures: string[]}>}
 */
async function applyConsentWrites(db, contactId, optingOut, source) {
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

  return { prefOk, statusOk, failures }
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
 */
function consentTookEffect(optingOut, { prefOk, statusOk }) {
  return optingOut ? (prefOk || statusOk) : (prefOk && statusOk)
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
 * @param {string|null} args.locationId
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
  const outcome = await applyConsentWrites(db, contact.id, optingOut, 'whatsapp_keyword')
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
    const ack = optingOut ? ACK_STOP : ACK_START
    const to = waPhone || contact.wa_phone
    if (!to) {
      console.warn(`[wa-consent] no phone for contact ${contact.id} — consent applied but ack skipped`)
    }
    if (to) {
      const result = await sendTextMessage(to, ack, { locationId })
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
export async function applyMetaUserPreference(db, pref = {}) {
  if (pref.category && pref.category !== 'marketing_messages') return { applied: false, reason: 'unknown_category' }
  if (!['stop', 'resume'].includes(pref.value)) return { applied: false, reason: 'unknown_value' }
  const waId = String(pref.wa_id || '').replace(/\D/g, '')
  if (!waId) return { applied: false, reason: 'no_wa_id' }

  const { data: contacts } = await db.from('contacts')
    .select('id')
    .or(`wa_phone.eq.${waId},wa_phone.eq.+${waId},phone.eq.${waId},phone.eq.+${waId}`)
    .limit(1)
  const contact = contacts?.[0]
  if (!contact) return { applied: false, reason: 'no_contact' }

  const optingOut = pref.value === 'stop'
  // Exactly the same writes and the same BAREWRITE.4 shape as the keyword path
  // above, through one helper.
  //
  // AN EARLIER VERSION OF THIS COMMENT SAID THE TWO PATHS HAD ALREADY DRIFTED —
  // "the keyword path grew an upsert while this one kept an update". That is
  // false, and the history says so: 85afb1c0 (COMMS-AUDIT 2026-07-10) changed
  // BOTH from `.update` to `.upsert` in the same commit, and no revision of this
  // file has ever had one shape in one path and the other shape in the other.
  // The real reason for the helper is smaller and true: the two paths must make
  // the same partial-failure judgement (attempt every write, then decide), and
  // that judgement is subtle enough — STOP needs EITHER gate, START needs BOTH —
  // that maintaining it twice is how it would come apart. One copy, one test.
  const outcome = await applyConsentWrites(db, contact.id, optingOut, 'meta_user_preferences')
  if (!consentTookEffect(optingOut, outcome)) {
    return {
      applied: false,
      reason: optingOut ? 'no_suppression_signal_landed' : 'opt_in_incomplete',
      failures: outcome.failures,
      contactId: contact.id,
    }
  }
  return {
    applied: true,
    action: consentActionFor(!optingOut),
    contactId: contact.id,
    ...(outcome.failures.length > 0 ? { partial: true, failures: outcome.failures } : {}),
  }
}
