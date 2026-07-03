// PUSH.2 — duplicate-send protection for EVENT-triggered staff pushes.
//
// Cron reminders dedup via push_reminder_sends (mig 169), but event
// pushes (swap lifecycle, time-off, expenses, invoices, contracts,
// issues, new leads, inbound WhatsApp/Instagram) had nothing between a
// replayed Meta webhook / double-invoked route and a double push.
//
// Pattern: claim-before-send against push_event_sends (mig 348).
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
//      "sent=0, failed=0" (recipient has no tokens) KEEPS the claim:
//      there is nothing to retry against, and for notifyUsers callers
//      the email fallback already ran.
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
// All senders return the underlying result shape plus `deduped` — the
// number of recipients skipped because their claim already existed.

import { sendPush, resolveRoleRecipientIds } from './push'
import { notifyUsers } from './notify'
import { logWarn } from './log'

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
  try {
    result = await sendFn(claimedIds, payload)
  } catch (err) {
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
 * sendPushToRolesAtLocation(), deduped. The role set is resolved to
 * profile ids FIRST so each recipient gets their own claim row — a
 * manager added between webhook replays still gets exactly one push.
 */
export async function sendPushToRolesAtLocationOnce(db, eventKey, locationId, roles, payload) {
  const ids = await resolveRoleRecipientIds(db, locationId, roles)
  return sendOnce(db, eventKey, ids, payload, sendPush, 'sendPush')
}

/**
 * notifyUsersAtRoles(), deduped. Same id-resolution story as
 * sendPushToRolesAtLocationOnce.
 */
export async function notifyUsersAtRolesOnce(db, eventKey, locationId, roles, payload) {
  const ids = await resolveRoleRecipientIds(db, locationId, roles)
  return sendOnce(db, eventKey, ids, payload, notifyUsers, 'notifyUsers')
}
