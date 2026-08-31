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

import { sendPushToRolesAtLocation } from '@/lib/push'
import { MANAGER_ROLES } from '@/lib/schemas'

export const APPROVAL_ESCALATE_AFTER_HOURS = 24
const HOUR_MS = 3_600_000

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

/**
 * One cron tick over pending approvals. Never throws. Expiry claims
 * atomically on status='pending' (same claim-before-side-effect shape as the
 * PATCH route), so a staff decision racing the sweep can't double-run.
 */
export async function runApprovalsSlaSweep(db, { nowMs = Date.now() } = {}) {
  const results = { expired: 0, escalated: 0, skipped: 0 }
  const nowIso = new Date(nowMs).toISOString()

  const { data: rows, error } = await db.from('agent_membership_requests')
    .select('id, location_id, kind, status, channel, conversation_id, created_at, sla_escalated_at, details')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(200)
  if (error) {
    console.error('[radar-agent] approvals-sla candidate query failed:', error.message)
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
        // the predicate race and this row simply drops out.
        const details = {
          ...(row.details || {}),
          result: { ok: false, reason: 'CLASS_ALREADY_STARTED' },
          expired_at: nowIso,
        }
        const { data: claimed } = await db.from('agent_membership_requests')
          .update({ status: 'expired', details, updated_at: nowIso })
          .eq('id', row.id)
          .eq('status', 'pending')
          .select('id')
          .maybeSingle()
        if (!claimed) { results.skipped++; continue }

        // Funnel bookings keep their queue row honest too. Best-effort.
        if (row.details?.source === 'start_funnel') {
          try {
            await db.from('class_booking_requests')
              .update({ status: 'failed', last_error: 'expired_before_review' })
              .eq('approval_request_id', row.id)
          } catch (e) { console.warn(`[radar-agent] approvals-sla cbr sync error: ${e?.message || e}`) }
        }

        // MIA-EXPIRY-QUIET.1 — no customer-bound send here, by design.
        try {
          await sendPushToRolesAtLocation(row.location_id, MANAGER_ROLES, {
            title: 'Booking request expired unactioned',
            body: `A pending ${KIND_LABELS[row.kind] || row.kind} (${row.details?.class_name || 'class'}, ${row.details?.class_time || 'time unknown'}) outlived its class. The member has NOT been messaged; please follow up with them.`,
            data: { type: 'agent_request_expired', request_id: row.id },
          })
        } catch (e) { console.error(`[radar-agent] approvals-sla expire push failed: ${e?.message || e}`) }

        console.warn('[radar-agent] approval expired', JSON.stringify({ id: row.id, kind: row.kind }))
        results.expired++
        continue
      }

      // ESCALATE — stamp first so a push hiccup can't re-alert every tick.
      await db.from('agent_membership_requests')
        .update({ sla_escalated_at: nowIso, updated_at: nowIso })
        .eq('id', row.id)
      try {
        const ageHours = Math.floor((nowMs - Date.parse(row.created_at)) / HOUR_MS)
        await sendPushToRolesAtLocation(row.location_id, MANAGER_ROLES, {
          title: 'Approval still waiting',
          body: `A ${KIND_LABELS[row.kind] || row.kind} request has been pending ${ageHours}h with no decision.`,
          data: { type: 'agent_request_stale', request_id: row.id },
        })
      } catch (e) { console.error(`[radar-agent] approvals-sla escalate push failed: ${e?.message || e}`) }
      results.escalated++
    } catch (e) {
      results.skipped++
      console.error('[radar-agent] approvals-sla row error:', e?.message || e)
    }
  }
  return results
}
