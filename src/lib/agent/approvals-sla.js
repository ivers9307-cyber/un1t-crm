// MIA-BOARD.2 — the approvals clock.
//
// agent_membership_requests had no aging and no expiry, and the two failure
// shapes both went live before this sweep existed: a member's cancellation
// sat pending for 13 days (12 Aug), and on 23 Aug two funnel bookings were
// approved at 8:26pm for classes that had run that MORNING — the executor
// booked them into Glofox anyway and sent confirmations (the Ciaran
// incident). Two behaviours, one sweep, riding the same 15-minute
// agent-followups cron as its own failure domain:
//
//   ESCALATE — any pending row older than APPROVAL_ESCALATE_AFTER_HOURS
//     re-alerts managers, once (sla_escalated_at stamps it — mig 568).
//   EXPIRE — a pending class_booking whose details.starts_at has passed
//     flips to 'expired' (mig 568 extends the status CHECK) and alerts
//     STAFF ONLY.
//
// MIA-EXPIRY-QUIET.1 (Richard, 2026-08-31) — expiry is SILENT to the member.
// The sweep used to send an operator-editable apology into the thread; an
// automated "sorry we missed your booking" is a second failure on top of the
// first, and it lands hours later with nobody behind it. The team gets the
// push and follows up as a human, on their own words and timing. The
// booking_expired_text setting went with it.
//
// Cancellations, pauses and every non-booking kind NEVER expire — a stale
// cancellation is still live intent; it only escalates harder.
//
// starts_at coverage is honest, not assumed: funnel rows carry it (the class
// the incident proved); Mia-thread rows created before this change do not,
// and those can only escalate. The PATCH route carries a matching hard guard
// so a past-start row that dodges the 15-minute sweep still cannot execute.
//
// C21 PUSHDONE.1 — "done" is recorded AFTER the push, never before it.
//   ESCALATE used to stamp sla_escalated_at first "so a push hiccup can't
//     re-alert every tick", which made any failed push a permanent, silent
//     loss. It now sends, then stamps unless the push reached nobody because
//     something broke (pushOutcome 'failed'); that row is retried every tick
//     for SLA_ALERT_RETRY_HOURS and then stamped with a logError. A failed
//     push reached nobody, so the retry can never re-alert anyone.
//   EXPIRE cannot un-claim (pending → expired is the business write that stops
//     the executor), so the claim carries a lease: it writes
//     details.expire_notice = 'owed' in the same UPDATE, and the notice is
//     settled to 'sent' / 'settled' after the push. A row left 'owed' (a
//     failed push, or a process killed between claim and send) is re-sent by
//     retryOwedExpireNotices at the top of the next tick, for
//     SLA_ALERT_RETRY_HOURS, then marked 'gave_up' with a logError.
// Both err toward a duplicate staff push (a lost stamp, a kill after the
// send), never toward a lost one: CLAUDE.md "never create a louder failure".

import { sendPushToRolesAtLocation } from '@/lib/push'
import { MANAGER_ROLES } from '@/lib/schemas'
import { pushOutcome } from '@/lib/push-outcome'
import { logWarn, logError } from '@/lib/log'

export const APPROVAL_ESCALATE_AFTER_HOURS = 24
// C21 PUSHDONE.1 — how long an alert that reached nobody keeps being retried
// (every 15-minute tick) before the sweep records it and gives up, loudly.
export const SLA_ALERT_RETRY_HOURS = 24
const HOUR_MS = 3_600_000
// PUSHDONE.1a — in-flight lease on the owed pass. The expire claim stamps
// updated_at and then sends; an owed row touched this recently may be
// mid-send in an overlapping tick, so it waits. Well under the 15-minute
// cadence, so a genuinely owed row is still picked up by the very next tick.
const OWED_NOTICE_LEASE_MS = 5 * 60_000

/**
 * What, if anything, does this approval row need? Pure.
 * @returns {'expire'|'escalate'|null}
 */
export function classifyApprovalAging({ kind, status, createdAtMs, slaEscalatedAt, startsAtMs, nowMs } = {}) {
  if (status !== 'pending') return null
  if (kind === 'class_booking' && Number.isFinite(startsAtMs) && startsAtMs !== null && startsAtMs < nowMs) {
    return 'expire'
  }
  if (!slaEscalatedAt && Number.isFinite(createdAtMs) && nowMs - createdAtMs >= APPROVAL_ESCALATE_AFTER_HOURS * HOUR_MS) {
    return 'escalate'
  }
  return null
}

const KIND_LABELS = {
  class_booking: 'class booking',
  class_cancellation: 'class cancellation',
  cancellation: 'membership cancellation',
  pause: 'membership pause',
  consultation: 'consultation',
  event_booking: 'event booking',
  event_cancellation: 'event cancellation',
  membership_purchase: 'membership purchase',
}

function expiredNoticePayload(row) {
  return {
    title: 'Booking request expired unactioned',
    body: `A pending ${KIND_LABELS[row.kind] || row.kind} (${row.details?.class_name || 'class'}, ${row.details?.class_time || 'time unknown'}) outlived its class. The member has NOT been messaged; please follow up with them.`,
    data: { type: 'agent_request_expired', request_id: row.id },
  }
}

// The push, read as one outcome. A throw is 'failed' (pushOutcome(null)).
async function sendManagerAlert(locationId, payload) {
  let result = null
  try {
    result = await sendPushToRolesAtLocation(locationId, MANAGER_ROLES, payload)
  } catch (e) {
    logWarn('approvals-sla', 'manager push threw', { err: e?.message || String(e) })
  }
  return pushOutcome(result)
}

// Record how an expiry notice ended. Best effort: a lost write leaves the row
// 'owed', so the next tick sends it again (a duplicate staff push, never a loss).
async function settleExpireNotice(db, id, details, notice, nowIso) {
  const { error } = await db.from('agent_membership_requests')
    .update({ details: { ...(details || {}), expire_notice: notice }, updated_at: nowIso })
    .eq('id', id)
    .eq('status', 'expired')
  if (error) {
    logWarn('approvals-sla', 'expiry notice state write failed; it may be sent again', { id, notice, err: error.message })
  }
}

/**
 * C21 PUSHDONE.1 — re-send every expiry notice still 'owed' (a push that
 * reached nobody, or a tick killed between the claim and the send). Runs
 * BEFORE the pending loop, so a notice that fails this tick waits for the next.
 */
async function retryOwedExpireNotices(db, { nowMs, nowIso, results }) {
  // The lease reads updated_at, so a failed retry below must write NOTHING
  // (it only `continue`s); touching updated_at would hold the row back.
  const { data: owed, error } = await db.from('agent_membership_requests')
    .select('id, location_id, kind, details')
    .eq('status', 'expired')
    .eq('details->>expire_notice', 'owed')
    .lt('updated_at', new Date(nowMs - OWED_NOTICE_LEASE_MS).toISOString())
    .order('updated_at', { ascending: true })
    .limit(50)
  if (error) {
    logError('approvals-sla', 'owed expiry notices read failed; retried next tick', { err: error.message })
    return
  }
  for (const row of owed || []) {
    const expiredAtMs = Date.parse(row.details?.expired_at || '')
    if (!Number.isFinite(expiredAtMs) || nowMs - expiredAtMs > SLA_ALERT_RETRY_HOURS * HOUR_MS) {
      logError('approvals-sla', 'expiry notice never reached a manager; gave up', { id: row.id, location_id: row.location_id })
      await settleExpireNotice(db, row.id, row.details, 'gave_up', nowIso)
      results.gave_up++
      continue
    }
    const outcome = await sendManagerAlert(row.location_id, expiredNoticePayload(row))
    if (outcome === 'failed') {
      results.notice_failed++
      logWarn('approvals-sla', 'expiry notice reached nobody again; still owed, retried next tick', { id: row.id, location_id: row.location_id })
      continue
    }
    await settleExpireNotice(db, row.id, row.details, outcome === 'delivered' ? 'sent' : 'settled', nowIso)
    results.notices_retried++
  }
}

/**
 * One cron tick over pending approvals. Never throws. Expiry claims
 * atomically on status='pending' (same claim-before-side-effect shape as the
 * PATCH route), so a staff decision racing the sweep can't double-run.
 */
export async function runApprovalsSlaSweep(db, { nowMs = Date.now() } = {}) {
  const results = { expired: 0, escalated: 0, skipped: 0, notice_failed: 0, notices_retried: 0, gave_up: 0, candidates_unread: 0 }
  const nowIso = new Date(nowMs).toISOString()

  try {
    await retryOwedExpireNotices(db, { nowMs, nowIso, results })
  } catch (e) {
    logError('approvals-sla', 'owed expiry notice pass threw', { err: e?.message || String(e) })
  }

  const { data: rows, error } = await db.from('agent_membership_requests')
    .select('id, location_id, kind, status, channel, conversation_id, created_at, sla_escalated_at, details')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(200)
  if (error) {
    // C31 PUSHNITS.1 — structured, never free text; counted, never a quiet run.
    results.candidates_unread = 1
    logError('approvals-sla', 'candidate read failed; retried next tick', { err: error.message || String(error) })
    return results
  }

  for (const row of rows || []) {
    try {
      const startsAtMs = Date.parse(row.details?.starts_at || '')
      const action = classifyApprovalAging({
        kind: row.kind,
        status: row.status,
        createdAtMs: Date.parse(row.created_at || '') || null,
        slaEscalatedAt: row.sla_escalated_at,
        startsAtMs: Number.isFinite(startsAtMs) ? startsAtMs : null,
        nowMs,
      })
      if (!action) { results.skipped++; continue }

      if (action === 'expire') {
        // Atomic claim: pending → expired. A concurrent staff decision wins
        // the predicate race and this row simply drops out. C21: the claim
        // carries its own lease, expire_notice 'owed', so a notice that never
        // went out is re-sent by retryOwedExpireNotices.
        const details = {
          ...(row.details || {}),
          result: { ok: false, reason: 'CLASS_ALREADY_STARTED' },
          expired_at: nowIso,
          expire_notice: 'owed',
        }
        const { data: claimed, error: claimErr } = await db.from('agent_membership_requests')
          .update({ status: 'expired', details, updated_at: nowIso })
          .eq('id', row.id)
          .eq('status', 'pending')
          .select('id')
          .maybeSingle()
        if (claimErr) {
          logWarn('approvals-sla', 'expire claim failed; retried next tick', { id: row.id, err: claimErr.message })
          results.skipped++
          continue
        }
        if (!claimed) { results.skipped++; continue }

        // Funnel bookings keep their queue row honest too. Best-effort.
        if (row.details?.source === 'start_funnel') {
          const { error: cbrErr } = await db.from('class_booking_requests')
            .update({ status: 'failed', last_error: 'expired_before_review' })
            .eq('approval_request_id', row.id)
          if (cbrErr) logWarn('approvals-sla', 'funnel queue row sync failed', { id: row.id, err: cbrErr.message })
        }

        // MIA-EXPIRY-QUIET.1 — no customer-bound send here, by design.
        const outcome = await sendManagerAlert(row.location_id, expiredNoticePayload(row))
        if (outcome === 'failed') {
          results.notice_failed++
          logWarn('approvals-sla', 'expiry notice reached nobody; left owed, retried next tick', { id: row.id, location_id: row.location_id })
        } else {
          await settleExpireNotice(db, row.id, details, outcome === 'delivered' ? 'sent' : 'settled', nowIso)
        }

        console.warn('[radar-agent] approval expired', JSON.stringify({ id: row.id, kind: row.kind }))
        results.expired++
        continue
      }

      // ESCALATE — C21 PUSHDONE.1: send FIRST, stamp after (see the header).
      const ageMs = nowMs - Date.parse(row.created_at)
      const outcome = await sendManagerAlert(row.location_id, {
        title: 'Approval still waiting',
        body: `A ${KIND_LABELS[row.kind] || row.kind} request has been pending ${Math.floor(ageMs / HOUR_MS)}h with no decision.`,
        data: { type: 'agent_request_stale', request_id: row.id },
      })
      if (outcome === 'failed') {
        if (ageMs - APPROVAL_ESCALATE_AFTER_HOURS * HOUR_MS <= SLA_ALERT_RETRY_HOURS * HOUR_MS) {
          results.notice_failed++
          logWarn('approvals-sla', 'escalation reached nobody; not stamped, retried next tick', { id: row.id, location_id: row.location_id })
          continue
        }
        logError('approvals-sla', 'escalation never reached a manager; gave up', { id: row.id, location_id: row.location_id })
        results.gave_up++
      }
      // CAS on the null stamp: two overlapping ticks stamp once.
      const { error: stampErr } = await db.from('agent_membership_requests')
        .update({ sla_escalated_at: nowIso, updated_at: nowIso })
        .eq('id', row.id)
        .is('sla_escalated_at', null)
      if (stampErr) {
        logError('approvals-sla', 'escalation stamp failed; managers may be alerted again next tick', { id: row.id, err: stampErr.message })
      }
      if (outcome !== 'failed') results.escalated++
    } catch (e) {
      results.skipped++
      logError('approvals-sla', 'row threw; retried next tick', { id: row?.id, err: e?.message || String(e) })
    }
  }
  return results
}
