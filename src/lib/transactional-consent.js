// THE definition of "may we send this person a message they themselves
// triggered" — receipts, confirmations, reminders, payment links.
//
// WHY THIS IS A MODULE AND NOT THREE COPIES
// Three transactional senders each grew their own copy of this gate
// (booking-confirmations.js, event-attendee-reminders.js, event-reminders.js)
// and a fourth (race-confirmations.js) never grew one at all — 191 paid race
// receipts went out with no consent or suppression check of any kind. Copies
// drift; the family is the thing that must not.
//
// ─────────────────────────────────────────────────────────────────────────
// THE FAMILY: `_administrative`, NEVER `_marketing`
// ─────────────────────────────────────────────────────────────────────────
// `contact_preferences` carries two independent pairs:
//   email_marketing / sms_marketing            → broadcasts, campaigns, drips
//   email_administrative / sms_administrative  → the transaction itself
// A receipt for money someone just paid is administrative. Gating it on the
// MARKETING flag would be a strictly worse bug than the missing check: measured
// read-only against prod on 2026-08-20, of 193 completed race payments **47
// belong to contacts with `email_marketing = false`** while **0** have
// `email_administrative = false`. Copying the marketing family here would have
// silently deleted a quarter of all paid-registration receipts — and with them
// the per-person check-in QR the attendee needs on race day.
//
//   select count(*) filter (where cp.email_marketing is false)      as mkt,
//          count(*) filter (where cp.email_administrative is false) as admin
//   from race_payments p join contacts c on c.id = p.contact_id
//   left join contact_preferences cp on cp.contact_id = c.id
//   where p.status = 'completed';
//
// ─────────────────────────────────────────────────────────────────────────
// HARD SIGNALS
// ─────────────────────────────────────────────────────────────────────────
// Email: `bounced` / `complained` only. 'unsubscribed' is deliberately NOT in
// the list — LOCCOMMS.5 removed it, because leaving a marketing list must not
// cost you the confirmation for a class you booked.
// SMS: `sms_status` is a three-state ('active' / 'opted_out' / 'invalid'), so
// the gate is "anything set and not active", matching /api/contacts/[id]/sms.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT `email_administrative = false` ACTUALLY MEANS IN THIS DATABASE
// ─────────────────────────────────────────────────────────────────────────
// READ THIS BEFORE TIGHTENING ANY GATE ON THE ADMINISTRATIVE FAMILY.
//
// It does NOT mean "this person asked us not to send them receipts". Measured
// read-only against prod on 2026-08-20:
//
//   select count(*) from contact_preferences where email_administrative is false;
//   -- 1627
//   select count(*) from contact_preferences cp join contacts c on c.id = cp.contact_id
//    where cp.email_administrative is false and c.glofox_membership_status = 'classpass_payg';
//   -- 1626
//
// All 1627 carry all four flags false — the signature of
// `supabase/migrations/151_auto_unsubscribe_classpass.sql`, an AFTER trigger
// that fires on transition to `glofox_membership_status = 'classpass_payg'` and
// blanket-disables all six channel flags. Nobody was asked. And the audit trail
// agrees, with no ambiguity at all:
//
//   select source, count(*) from consent_log
//    where channel like '%administrative%' group by 1;
//   -- auto_classpass_backfill  4599   (1533 × 3 channels)
//   -- auto_classpass            282   (  94 × 3 channels)
//   -- …and nothing else.
//
// ZERO human-expressed administrative opt-outs exist in this database. Every
// single one on record was written by that trigger.
//
// The repo has already learned this once for the OTHER half of mig 151: it also
// flips `contacts.email_status` to 'unsubscribed', and LOCCOMMS.5 deliberately
// removed 'unsubscribed' from the transactional hard-signal list for exactly
// this reason. `honourMachineSetOptOut: false` below is the same lesson applied
// to the remaining half.
//
// ─────────────────────────────────────────────────────────────────────────
// A SUPPRESSION CHECK THAT CANNOT BE READ MUST NOT SUPPRESS
// ─────────────────────────────────────────────────────────────────────────
// `loadTransactionalConsent` NEVER throws and reports an unreadable row as
// `{ contact: null, unreadable: true }`. Callers must treat that as "send, and
// log loudly" — see the note on that function. Removing a silent failure must
// never create a louder one (CLAUDE.md): the cost of a wrongly-suppressed
// receipt is total and unrecoverable, the cost of a wrongly-sent one is one
// unwanted message the provider very likely drops anyway.

import { logError } from './log'

/** Email statuses that suppress even a transactional send. */
export const TRANSACTIONAL_EMAIL_HARD_STATUSES = Object.freeze(['bounced', 'complained'])

/** The columns every transactional gate needs off `contacts`. */
export const TRANSACTIONAL_CONSENT_SELECT =
  'id, email_status, sms_status, contact_preferences ( email_administrative, sms_administrative )'

/**
 * Read one preference flag off a contact whose `contact_preferences` may have
 * arrived as an embedded ARRAY (PostgREST one-to-many shape) or as an object.
 * Pure. Returns `undefined` when the contact has no preferences row at all —
 * which is NOT an opt-out: absence means "never expressed a preference".
 *
 * @param {object|null|undefined} contact
 * @param {'email_administrative'|'sms_administrative'|'email_marketing'|'sms_marketing'} key
 * @returns {boolean|undefined}
 */
export function readContactPreference(contact, key) {
  const prefs = contact?.contact_preferences
  if (Array.isArray(prefs)) return prefs[0]?.[key]
  return prefs?.[key]
}

/**
 * Why a TRANSACTIONAL email to this contact must not be sent, or null when it
 * may. Pure — the caller supplies the contact row (see
 * TRANSACTIONAL_CONSENT_SELECT).
 *
 * @param {object|null|undefined} contact
 * @returns {string|null} a short machine-readable reason, or null to send
 */
export function transactionalEmailSuppression(contact) {
  if (!contact) return null
  const status = contact.email_status
  if (status && TRANSACTIONAL_EMAIL_HARD_STATUSES.includes(status)) return `email_status=${status}`
  if (readContactPreference(contact, 'email_administrative') === false) {
    return 'opted_out_administrative_email'
  }
  return null
}

/**
 * Why a TRANSACTIONAL SMS to this contact must not be sent, or null when it
 * may. Pure.
 *
 * @param {object|null|undefined} contact
 * @returns {string|null}
 */
export function transactionalSmsSuppression(contact) {
  if (!contact) return null
  const status = contact.sms_status
  if (status && status !== 'active') return `sms_status=${status}`
  if (readContactPreference(contact, 'sms_administrative') === false) {
    return 'opted_out_administrative_sms'
  }
  return null
}

/**
 * Load the consent row for one contact, as its OWN query.
 *
 * DELIBERATELY NOT AN EMBED on the caller's primary select. race-confirmations
 * loads the payment with a `.single()` whose failure already aborts the send;
 * folding `contacts(...)` into that select would make an embed problem — a
 * renamed FK, a second FK to `contacts` arriving on `race_payments` and tripping
 * PGRST201, an RLS/grant change — abort EVERY receipt rather than just lose the
 * consent signal. One extra round-trip buys a failure mode that costs the
 * signal instead of the message.
 *
 * NEVER THROWS. Three outcomes:
 *   { contact, unreadable: false }        row read (or contactId was null → no
 *                                          contact to check; send)
 *   { contact: null, unreadable: true }   the read FAILED — the caller must
 *                                          SEND and log, never suppress
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db  service-role client
 * @param {string|null|undefined} contactId
 * @returns {Promise<{ contact: object|null, unreadable: boolean }>}
 */
export async function loadTransactionalConsent(db, contactId) {
  if (!db || !contactId) return { contact: null, unreadable: false }
  try {
    const { data, error } = await db
      .from('contacts')
      .select(TRANSACTIONAL_CONSENT_SELECT)
      .eq('id', contactId)
      .maybeSingle()
    if (error) return { contact: null, unreadable: true }
    return { contact: data || null, unreadable: false }
  } catch {
    return { contact: null, unreadable: true }
  }
}

/**
 * `consent_log.source` values written by machinery rather than by a person.
 * Both come from mig 151 (the trigger and its one-shot backfill). See the
 * header — today they are the ONLY sources of any administrative opt-out here.
 */
export const MACHINE_SET_CONSENT_SOURCES = Object.freeze(['auto_classpass', 'auto_classpass_backfill'])

/** @param {string|null|undefined} source */
export function isMachineSetConsentSource(source) {
  return typeof source === 'string' && MACHINE_SET_CONSENT_SOURCES.includes(source)
}

/**
 * Did a MACHINE set this contact's administrative opt-out on this channel, or
 * did a person? Reads the most recent `consent_log` row for the channel, so a
 * customer who later opts out through the preference centre outranks the
 * trigger that opted them out first — LATEST WINS, which is the whole reason
 * this reads the log rather than trusting the flag's mere presence.
 *
 * NEVER THROWS. An unreadable log reports `unreadable: true`, and the caller
 * treats that as machine-set — i.e. it SENDS. That direction is deliberate and
 * it is the measured one: every administrative opt-out in this database was
 * machine-written, so "we could not check" resolves toward the overwhelmingly
 * likely answer, and toward delivering the message either way.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {string|null|undefined} contactId
 * @param {'email'|'sms'} channel
 * @returns {Promise<{ machineSet: boolean, unreadable: boolean, source: string|null }>}
 */
export async function administrativeOptOutProvenance(db, contactId, channel) {
  if (!db || !contactId) return { machineSet: false, unreadable: false, source: null }
  const logChannel = channel === 'sms' ? 'sms_administrative' : 'email_administrative'
  try {
    const { data, error } = await db
      .from('consent_log')
      .select('source, action, created_at')
      .eq('contact_id', contactId)
      .eq('channel', logChannel)
      .order('created_at', { ascending: false })
      .limit(1)
    if (error) return { machineSet: false, unreadable: true, source: null }
    const row = Array.isArray(data) ? data[0] : null
    if (!row) return { machineSet: false, unreadable: false, source: null }
    return {
      machineSet: row.action === 'opt_out' && isMachineSetConsentSource(row.source),
      unreadable: false,
      source: row.source || null,
    }
  } catch {
    return { machineSet: false, unreadable: true, source: null }
  }
}

/**
 * The whole gate in one call: load the contact's consent state and answer
 * whether this channel may send.
 *
 * On an unreadable consent row this returns `{ allowed: true }` and emits a
 * structured `logError` under `module` — the visibility that replaces the
 * silent drop, without the drop. Callers should not add their own log.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * `unrecoverable: true` — FOR A MESSAGE NOTHING WILL EVER RE-SEND
 * ─────────────────────────────────────────────────────────────────────────
 * Pass it when a wrong suppression is permanent and the customer loses
 * something they paid for. It is one flag because it names ONE property, and
 * two consequences follow from that property:
 *
 *   1. A suppression is LOGGED at error level, always. CLAUDE.md's ordering
 *      puts "log loudly and structurally" first, and a silent, unretried,
 *      unrecoverable drop is the exact failure that ordering exists to prevent.
 *      The log is what lets an operator post the check-in QR by hand.
 *   2. A MACHINE-SET administrative opt-out does not suppress. See the header:
 *      in this database that flag means "ClassPass PAYG member" and nothing
 *      else — 1626 of 1627, with zero human opt-outs on record. Honouring a
 *      wish nobody expressed, at the price of a paid receipt, is not a trade
 *      worth making. HARD SIGNALS (bounced/complained) still suppress, and a
 *      genuine person-set opt-out still suppresses — it is only the trigger's
 *      blanket that is disregarded, and only here.
 *
 * Leave it off for anything an operator drives by hand or a cron re-runs:
 * there the skip is visible and repeatable, so the strict gate costs nothing.
 *
 * @param {object} args
 * @param {import('@supabase/supabase-js').SupabaseClient} args.db
 * @param {string|null|undefined} args.contactId
 * @param {'email'|'sms'} args.channel
 * @param {string} args.module   log module name, e.g. 'race-confirmations'
 * @param {object} [args.meta]   extra ids for the log line (no PII)
 * @param {boolean} [args.unrecoverable]  see above
 * @returns {Promise<{ allowed: boolean, reason: string|null, unreadable: boolean }>}
 */
export async function checkTransactionalConsent({
  db, contactId, channel, module: mod, meta = {}, unrecoverable = false,
}) {
  const { contact, unreadable } = await loadTransactionalConsent(db, contactId)
  if (unreadable) {
    logError(mod, 'consent lookup failed — SENDING ANYWAY rather than dropping a message the customer asked for', {
      channel, contactId: contactId || null, ...meta,
    })
    return { allowed: true, reason: null, unreadable: true }
  }
  let reason = channel === 'sms'
    ? transactionalSmsSuppression(contact)
    : transactionalEmailSuppression(contact)

  const optedOutAdministrative = reason === 'opted_out_administrative_email'
    || reason === 'opted_out_administrative_sms'
  if (reason && unrecoverable && optedOutAdministrative) {
    const { machineSet, unreadable: provUnreadable, source } =
      await administrativeOptOutProvenance(db, contactId, channel)
    if (machineSet || provUnreadable) {
      logError(mod, 'administrative opt-out DISREGARDED for an unrecoverable message — the flag was machine-set (mig 151 ClassPass blanket), not a customer request, and this message cannot be re-sent', {
        channel, contactId: contactId || null, consentSource: source, provenanceUnreadable: provUnreadable, ...meta,
      })
      reason = null
    }
  }

  if (reason && unrecoverable) {
    logError(mod, 'message SUPPRESSED by consent state and nothing will retry it — the customer will not receive it at all; deliver it by hand if it carried anything they need', {
      channel, contactId: contactId || null, reason, ...meta,
    })
  }
  return { allowed: !reason, reason, unreadable: false }
}
