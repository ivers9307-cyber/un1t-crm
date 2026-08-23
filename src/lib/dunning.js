// Reactive arrears dunning (GLOFOX-REACTIVE).
//
// The Churn Radar dunning sequence (locations.dunning_sequence_id)
// was, until now, enrolled ONLY by an operator clicking "Send payment
// reminder". This turns it into an event-driven flow keyed on Glofox
// INVOICE_UPDATED / SERVICE_* webhooks:
//
//   PAST_DUE  → maybeEnrolDunning(): opt-in per location
//               (dunning_auto_enroll, default off), MEMBERSHIP invoices
//               only (DUNNING.1 — the radar's Overdue category; a failed
//               fee / class pack / custom charge never starts "update your
//               card" reminders), never dun a paused member, re-derive
//               trouble server-side (same guard as the manual path), then
//               enrolContacts (idempotent, allowReenrol so a later failure
//               re-runs the reminders — see enrol.js).
//   PAID /    → exitDunningForContact(): stop any in-flight dunning —
//   FORGIVEN    the gap the manual flow never closed. MEMBERSHIP invoices
//               only (a paid €5 fee must not cancel the run).
//   paused    → exitDunningForContact(reason 'membership_paused').
//
// enrolContacts + setEnrollmentStatus each open their own service
// client; the reads here take the receiver's db. Every export is
// best-effort (never throws) — a dunning miss must not fail a webhook.

import { enrolContacts } from '@/lib/sequences'
import { setEnrollmentStatus } from '@/lib/sequences/scheduler'
import { paymentTroubleKind } from '@/lib/churn-radar'
import { logWarn } from '@/lib/log'

// Columns paymentTroubleKind() needs to confirm a member is genuinely
// behind. Kept in sync with the manual path's TROUBLE_COLUMNS in
// src/app/api/churn-radar/action/route.js — same guard, same inputs.
const TROUBLE_COLUMNS =
  'glofox_membership_status, glofox_membership_type, glofox_membership_state, ' +
  'glofox_billing_interval, last_payment_at, last_attended_at, last_booked_at, ' +
  'trial_credits_remaining, glofox_membership_expiry'

/**
 * DUNNING.1 — what the Glofox INVOICE_UPDATED webhook should do about
 * dunning for this invoice. Pure.
 *   PAST_DUE + membership         → 'enrol'
 *   PAID / FORGIVEN + membership  → 'exit'
 *   anything else                 → null (fees, class packs, custom charges,
 *                                   pending, cancelled — never touch the run)
 * @param {string|null|undefined} invoiceStatus
 * @param {boolean|undefined} isMembership  applyInvoiceWebhook().is_membership
 * @returns {'enrol'|'exit'|null}
 */
export function dunningActionFor(invoiceStatus, isMembership) {
  if (isMembership !== true) return null
  const st = String(invoiceStatus || '').toUpperCase()
  if (st === 'PAST_DUE') return 'enrol'
  if (st === 'PAID' || st === 'FORGIVEN') return 'exit'
  return null
}

async function resolveActiveDunningSequence(db, locationId) {
  const { data: loc } = await db
    .from('locations')
    .select('dunning_sequence_id, dunning_auto_enroll')
    .eq('id', locationId)
    .maybeSingle()
  const seqId = loc?.dunning_sequence_id || null
  const autoEnroll = !!loc?.dunning_auto_enroll
  if (!seqId) return { seqId: null, autoEnroll, seq: null }
  const { data: seq } = await db
    .from('email_sequences')
    .select('id, name, status, location_id, trigger_type')
    .eq('id', seqId)
    .maybeSingle()
  return { seqId, autoEnroll, seq: seq || null }
}

/**
 * Reactively enrol a contact into the location's dunning sequence on a
 * fresh PAST_DUE invoice. Best-effort — returns a structured result,
 * never throws.
 *
 * @param {object} db          receiver's service client (for reads)
 * @param {string} locationId
 * @param {string} contactId
 * @param {object} [opts]
 * @param {string} [opts.invoiceId]     the PAST_DUE invoice id (sourceRef)
 * @param {boolean} [opts.isMembership] DUNNING.1 — applyInvoiceWebhook().is_membership;
 *                                      anything but `true` never enrols
 */
export async function maybeEnrolDunning(db, locationId, contactId, { invoiceId, isMembership } = {}) {
  try {
    if (!contactId) return { enrolled: 0, reason: 'no_contact' }
    // DUNNING.1 — fail closed: only a MEMBERSHIP invoice (the Overdue
    // category) starts reminders; an absent flag is treated as "not".
    if (isMembership !== true) return { enrolled: 0, reason: 'not_membership_invoice' }
    const { seqId, autoEnroll, seq } = await resolveActiveDunningSequence(db, locationId)
    if (!autoEnroll) return { enrolled: 0, reason: 'auto_enroll_off' }
    if (!seqId) return { enrolled: 0, reason: 'no_dunning_sequence' }
    if (!seq || seq.location_id !== locationId || seq.status !== 'active') {
      return { enrolled: 0, reason: 'sequence_unavailable' }
    }
    // Re-derive trouble server-side (mirrors the manual guard). Reading
    // the trouble columns also gives us the pause state — never dun a
    // paused member.
    const { data: full } = await db
      .from('contacts')
      .select(TROUBLE_COLUMNS)
      .eq('id', contactId)
      .maybeSingle()
    if (full?.glofox_membership_state === 'paused') {
      return { enrolled: 0, reason: 'member_paused' }
    }
    // This event IS a just-written PAST_DUE invoice → the authoritative
    // "behind" signal (matches the manual path's pastDueIds check).
    const pastDueIds = new Set([contactId])
    const kind = paymentTroubleKind({ ...(full || {}), id: contactId }, Date.now(), { pastDueIds })
    if (!kind) return { enrolled: 0, reason: 'not_behind' }
    const res = await enrolContacts({
      sequenceId: seqId,
      contactIds: [contactId],
      sourceType: 'invoice_past_due',
      sourceRef: invoiceId || null,
      // DUNNING.2 — a member whose card fails again months later must be
      // reminded again; the full unique index would otherwise block them
      // forever. Dunning is the only automatic caller allowed to re-run.
      allowReenrol: true,
    })
    return { enrolled: res?.enrolled || 0, kind, sequence_id: seqId }
  } catch (e) {
    logWarn('dunning', 'maybeEnrolDunning threw', { err: e?.message, contact_id: contactId })
    return { enrolled: 0, reason: 'threw', error: e?.message }
  }
}

/**
 * Exit any in-flight dunning enrolments for a contact — used when the
 * invoice is paid/forgiven or the membership pauses. Idempotent: a
 * no-op when nothing is active. Best-effort, never throws.
 */
export async function exitDunningForContact(db, locationId, contactId, reason) {
  try {
    if (!contactId) return { exited: 0 }
    const { data: loc } = await db
      .from('locations')
      .select('dunning_sequence_id')
      .eq('id', locationId)
      .maybeSingle()
    const seqId = loc?.dunning_sequence_id
    if (!seqId) return { exited: 0 }
    const { data: active } = await db
      .from('sequence_enrollments')
      .select('id')
      .eq('sequence_id', seqId)
      .eq('contact_id', contactId)
      .eq('status', 'active')
    if (!active || active.length === 0) return { exited: 0 }
    let exited = 0
    for (const row of active) {
      try {
        await setEnrollmentStatus({ enrollmentId: row.id, status: 'exited', reason })
        exited++
      } catch (e) {
        logWarn('dunning', 'exit enrollment failed', { err: e?.message, enrollment_id: row.id })
      }
    }
    return { exited }
  } catch (e) {
    logWarn('dunning', 'exitDunningForContact threw', { err: e?.message, contact_id: contactId })
    return { exited: 0, error: e?.message }
  }
}
