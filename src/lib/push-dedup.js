// PUSH.2 — duplicate-send protection for EVENT-triggered staff pushes.
//
// Cron reminders dedup via push_reminder_sends (mig 169), but event
// pushes (swap lifecycle, time-off, expenses, invoices, contracts,
// issues, new leads, inbound WhatsApp/Instagram) had nothing between a
// replayed Meta webhook / double-invoked route and a double push.
//
// Pattern: claim-before-send against push_event_sends (mig 349).
//   1. Insert one ledger row per (event_key, recipient) with
//      ON CONFLICT DO NOTHING semantics (upsert + ignoreDuplicates —
//      Postgres serialises concurrent claimers via the unique index,
//      same race-safety story as webhook-events.js).
//   2. Send ONLY to recipients whose claim insert succeeded (the
//      upsert's RETURNING only includes newly inserted rows).
//   3. If the send pipeline then fails OUTRIGHT (threw, or failed>0
//      with nothing delivered), RELEASE the claims so a later retry
//      (webhook redelivery, client retry) can still notify — mirrors
//      the nudge-claim release in send-class-booking-reminders (#755).
//      That includes a READ that failed inside sendPush/notifyUsers:
//      since C16 PUSHREADERR.1 it comes back as failed>0 + read_failed,
//      not as zeros. "sent=0, failed=0" (recipient has no tokens, or
//      opted out) KEEPS the claim: there is nothing to retry against,
//      and for notifyUsers callers the email fallback already ran.
//
// event_key must be stable + replay-safe: derived from the entity that
// caused the notification, never from timestamps or invocation state.
//   swap_claimed:<swap_id>:<actor_id>   whatsapp_inbound:<wamid>
//   contract_issued:<contract_id>       lead_new:<contact_id>   …
//
// Failure posture: if the CLAIM insert itself errors (ledger table
// unreachable), we log and fall back to a plain send — the ledger is
// dupe protection, not a delivery gate, and pushes are best-effort;
// losing a "shift claimed" push outright is worse than a rare double.
// Same call as webhook-events.js takes on an unexpected insert error.
//
// C1 RECIPIENTS.1 — the ROLE variants read "who holds these roles here"
// first. A FAILED read is not "nobody": it is logged once with logError,
// nothing is claimed and nothing is sent, and the result carries
// `recipients_failed: 1` beside the EMPTY counts. Because nothing was
// claimed, the next call with the same key (a retry, tomorrow's cron run)
// still sends. Never throws, like everything here.
//
// All senders return the underlying result shape plus `deduped` — the
// number of recipients skipped because their claim already existed.

import { sendPush, readRoleRecipientIds } from './push'
import { notifyUsers } from './notify'
import { logWarn, logError } from './log'

const EMPTY = Object.freeze({ sent: 0, skipped: 0, invalidated: 0, failed: 0, deduped: 0 })

/**
 * Claim (event_key, recipient) rows. Returns the recipients whose claim
 * was newly inserted (safe to send to) and whether the ledger actually
 * recorded the claim (drives whether a failed send may release).
 */
async function claimEventSends(db, eventKey, recipientIds) {
  const rows = recipientIds.map((id) => ({ event_key: eventKey, recipient_id: id }))
  const { data, error } = await db
    .from('push_event_sends')
    .upsert(rows, { onConflict: 'event_key,recipient_id', ignoreDuplicates: true })
    .select('recipient_id')
  if (error) {
    // Fail open: send without dedup rather than dropping the push.
    logWarn('push-dedup', 'claim insert failed — sending WITHOUT dedup', {
      event_key: eventKey, err: error.message,
    })
    return { claimedIds: recipientIds, claimTracked: false }
  }
  return { claimedIds: (data || []).map((r) => r.recipient_id), claimTracked: true }
}

async function releaseEventSends(db, eventKey, recipientIds) {
  const { error } = await db
    .from('push_event_sends')
    .delete()
    .eq('event_key', eventKey)
    .in('recipient_id', recipientIds)
  if (error) {
    logWarn('push-dedup', 'failed-send claim release failed — will NOT retry', {
      event_key: eventKey, err: error.message,
    })
  }
}

/**
 * Core claim-before-send wrapper. `sendFn(ids, payload)` is sendPush or
 * notifyUsers — both return counts and never throw on partial failure.
 * Never throws; callers keep their existing best-effort posture.
 */
async function sendOnce(db, eventKey, userIds, payload, sendFn, label) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean))]
  if (!ids.length) return { ...EMPTY }

  if (!eventKey || typeof eventKey !== 'string') {
    // No stable key available at this call site (e.g. a Meta event
    // without a message id) — plain send is better than no send.
    logWarn('push-dedup', `${label} called without an event key — sending WITHOUT dedup`, {})
    const plain = await sendFn(ids, payload)
    return { ...plain, deduped: 0 }
  }

  const { claimedIds, claimTracked } = await claimEventSends(db, eventKey, ids)
  const deduped = ids.length - claimedIds.length
  if (!claimedIds.length) return { ...EMPTY, deduped }

  let result = null
  let threw = false
  try {
    result = await sendFn(claimedIds, payload)
  } catch (err) {
    threw = true
    logWarn('push-dedup', `${label} threw`, { event_key: eventKey, err: err?.message })
  }

  // Total pipeline failure (threw, or Expo failed every message with
  // nothing delivered by push OR email fallback) → release the claims
  // so a retry can occur. Partial delivery keeps the claim: re-sending
  // would double-notify the recipients who already got it.
  const delivered = !!result && ((result.sent || 0) > 0 || (result.emailed || 0) > 0)
  const pipelineFailed = !result || ((result.failed || 0) > 0 && !delivered)
  if (pipelineFailed && claimTracked) {
    await releaseEventSends(db, eventKey, claimedIds)
  }

  // QUALS.1 review — a throw is a FAILED send for every claimed recipient.
  // Reporting it as EMPTY (sent 0, failed 0) read as a quiet "no device" to
  // callers, which treat that as settled and never retry.
  if (threw) return { ...EMPTY, failed: claimedIds.length, deduped }
  return { ...(result || EMPTY), deduped }
}

/**
 * sendPush(), at most once per (eventKey, recipient).
 *
 * @param {object} db              service-role supabase client
 * @param {string} eventKey        stable replay-safe key, e.g. 'contract_issued:<id>'
 * @param {string|string[]} userIds  profile id(s)
 * @param {object} payload         same shape as sendPush()
 * @returns {Promise<{sent:number, skipped:number, invalidated:number, failed:number, deduped:number}>}
 */
export async function sendPushOnce(db, eventKey, userIds, payload) {
  return sendOnce(db, eventKey, userIds, payload, sendPush, 'sendPush')
}

/**
 * notifyUsers() (push + registry-gated email fallback), at most once per
 * (eventKey, recipient). An email fallback counts as delivered.
 */
export async function notifyUsersOnce(db, eventKey, userIds, payload) {
  return sendOnce(db, eventKey, userIds, payload, notifyUsers, 'notifyUsers')
}

/**
 * Resolve the role set to profile ids, keeping a failed read apart from
 * "nobody holds the role". `failure` is the result the caller returns as-is.
 */
async function roleRecipients(db, eventKey, locationId, roles) {
  const { ids, error } = await readRoleRecipientIds(db, locationId, roles)
  if (!error) return { ids, failure: null }
  logError('push-dedup', 'role recipients read failed; nothing claimed, nobody told on this call', {
    event_key: eventKey, locationId, roles, err: error?.message ?? String(error),
  })
  return { ids: [], failure: { ...EMPTY, recipients_failed: 1 } }
}

/**
 * sendPushToRolesAtLocation(), deduped. The role set is resolved to
 * profile ids FIRST so each recipient gets their own claim row — a
 * manager added between webhook replays still gets exactly one push.
 * A failed read returns `recipients_failed: 1` and claims nothing.
 */
export async function sendPushToRolesAtLocationOnce(db, eventKey, locationId, roles, payload) {
  const { ids, failure } = await roleRecipients(db, eventKey, locationId, roles)
  if (failure) return failure
  return sendOnce(db, eventKey, ids, payload, sendPush, 'sendPush')
}

/**
 * The role fan-out through notifyUsers (push + registry-gated email
 * fallback), deduped. Same id-resolution story, and the same failed-read
 * result, as sendPushToRolesAtLocationOnce.
 */
export async function notifyUsersAtRolesOnce(db, eventKey, locationId, roles, payload) {
  const { ids, failure } = await roleRecipients(db, eventKey, locationId, roles)
  if (failure) return failure
  return sendOnce(db, eventKey, ids, payload, notifyUsers, 'notifyUsers')
}
