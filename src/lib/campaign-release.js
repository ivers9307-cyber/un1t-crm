// MCPEMAIL.1 — the one copy of the rules that release a marketing email
// campaign (send now, or schedule) and that stop one.
//
// These rules used to live inline in /api/campaigns/[id]/send,
// /api/communications/campaigns/[id]/schedule and …/[id]/stop. They live here
// so the CRM's own buttons and the Claude approve route can never drift apart.
// Only routes call releaseCampaign: no MCP tool moves a campaign to 'queued'
// or 'scheduled'.
//
// Every function answers a plain result, never a Response: each route maps
// the result onto its own status codes and messages.

import { getEmailCapStatus } from '@/lib/usage-caps'
import { checkSpend } from '@/lib/wallet-enforcement'
import { STATUS_CHANGED, currentStatus } from '@/lib/campaign-session-access'

// Only draft / scheduled / failed campaigns can be sent. 'sending' / 'sent' /
// 'cancelled' all reject: the operator should clone the campaign if they want
// to send it again.
//
// COMMSFIX.C.5 — 'failed' is re-sendable by design: it is the terminal state
// the cron assigns to a campaign whose populate kept erroring, and the whole
// point of surfacing it is that the operator fixes the cause (usually the
// audience filter) and sends again. Re-queueing clears last_error.
export const RELEASABLE_STATUSES = ['draft', 'scheduled', 'failed']

const IN_FLIGHT = ['queued', 'sending']

const refuse = (code, message) => ({ ok: false, code, message })

/**
 * The status and content rules alone (no reads): status, then subject, then
 * body. Answers { ok: true } or { ok: false, code, message }.
 */
export function releaseContentCheck(campaign, { statuses = RELEASABLE_STATUSES } = {}) {
  if (!statuses.includes(campaign.status)) {
    return refuse('status', `Campaign is '${campaign.status}', cannot send`)
  }
  // COMMSFIX.D.2e — a campaign with no body (or no subject) must never reach
  // 'queued'. Postmark permanently rejects HtmlBody null, so the entire
  // audience records as bounced and the run looks like a deliverability
  // catastrophe rather than an empty draft. This is the same guard the
  // email-draft route (D.2d) and the cron promote step apply — every path to
  // 'queued' is covered. Audit 2026-08-09 composer-ux, CONFIRMED high.
  if (!campaign.subject || !String(campaign.subject).trim()) {
    return refuse('no_subject', 'This campaign has no subject — add one before sending.')
  }
  if (!campaign.html_content || !String(campaign.html_content).trim()) {
    return refuse('no_body', 'This campaign has no email body — nothing was queued. Open it in the editor and add content.')
  }
  return { ok: true }
}

/**
 * Everything checked before a campaign may be released: status, subject,
 * body, the org's email hard cap, the studio's prepaid wallet. `campaign`
 * needs id, location_id, status, subject, html_content.
 */
export async function releasePreflight(db, campaign, { statuses = RELEASABLE_STATUSES } = {}) {
  const content = releaseContentCheck(campaign, { statuses })
  if (!content.ok) return content

  // SAAS4-M2 — optional per-org HARD email-send cap. Mirrors the
  // WhatsApp blast preflight (blastBudgetBlockError): refuse to START
  // at cap, with a message that says exactly how to proceed. Sequences
  // and transactional sends are never capped. Fails OPEN — inside the
  // helper, and here too if it throws — a metering failure must never
  // block a campaign.
  let emailCap = { capped: false }
  try {
    emailCap = await getEmailCapStatus({ locationId: campaign.location_id }, { db })
  } catch { /* fail open */ }
  if (emailCap?.capped) {
    return refuse('email_hard_cap',
      `Monthly email hard cap reached (${emailCap.monthSends.toLocaleString()} of ${emailCap.capSends.toLocaleString()} sends this month). Raise or clear the cap in org settings to send this campaign.`)
  }

  // INTEG-C3 — per-LOCATION prepaid wallet gate, beside (composing
  // with, never replacing) the per-ORG hard cap above: a tier-pinned
  // location whose monthly email allowance is used up AND whose wallet
  // is empty pauses marketing starts. Unpinned locations (every UN1T
  // location today) answer 'unpinned' and behave exactly as before.
  // Fail-open on any error — a billing bug must never block a send.
  try {
    const spend = await checkSpend(db, campaign.location_id, 'email_send', 'marketing')
    if (!spend.allow) {
      return refuse('wallet_empty',
        'Monthly email allowance is used up and the prepaid wallet is empty — marketing sends are paused. Top up the wallet to send this campaign.')
    }
  } catch { /* fail open — checkSpend already never throws */ }

  return { ok: true }
}

/**
 * Release the campaign: queue it now (`sendAt` null) or schedule it for
 * `sendAt` (an already-validated future Date). One compare-and-set update,
 * narrowed to `statuses`; zero rows means the status moved under us
 * (conflict, carrying the status as it is now).
 *
 * `expectUpdatedAt` (optional, the `updated_at` string of the row the caller
 * checked) pins the row version too. The campaigns_updated_at trigger (mig
 * 005) bumps updated_at on every update, so an edit that lands after the
 * caller's check makes this touch zero rows: the same conflict. The approve
 * route uses it so content edited after its content-key check is never
 * released untested. Omitted, nothing changes for the other callers.
 */
export async function releaseCampaign(db, campaign, { sendAt = null, statuses = RELEASABLE_STATUSES, expectUpdatedAt } = {}) {
  // Queued: the run-campaigns cron picks it up on its next tick (typically
  // within 60s) and starts the populate → send chunks state machine.
  // Scheduled: the same cron promotes it at scheduled_at.
  const scheduledAt = sendAt ? sendAt.toISOString() : null
  const patch = sendAt
    ? { status: 'scheduled', scheduled_at: scheduledAt, cancel_requested_at: null }
    : {
        status: 'queued',
        cancel_requested_at: null, // clear any stale cancel flag from a previous abort
        scheduled_at: null,        // send-now overrides any scheduled time
        last_error: null,          // COMMSFIX.C.5 — this attempt starts clean
      }

  // A pin asked for but unusable must never silently become no pin.
  if (expectUpdatedAt !== undefined && (typeof expectUpdatedAt !== 'string' || !expectUpdatedAt)) {
    return { ok: false, code: 'error', message: 'releaseCampaign: expectUpdatedAt must be a non-empty string' }
  }
  let write = db.from('campaigns')
    .update(patch)
    .eq('id', campaign.id)
    .in('status', statuses)
  if (expectUpdatedAt !== undefined) write = write.eq('updated_at', expectUpdatedAt)
  const { data, error } = await write.select('id')
  if (error) return { ok: false, code: 'error', message: error.message }
  if (!Array.isArray(data) || data.length === 0) {
    return {
      ok: false, code: 'conflict', message: STATUS_CHANGED,
      current_status: await currentStatus(db, campaign.id, campaign.status),
    }
  }
  return { ok: true, status: patch.status, scheduled_at: scheduledAt }
}

// Stamp cancel_requested_at on a campaign that is queued or sending.
// Resolves to { ok, error }.
async function requestCancel(db, id, at) {
  const { data, error } = await db.from('campaigns')
    .update({ cancel_requested_at: at })
    .eq('id', id)
    .in('status', IN_FLIGHT)
    .select('id')
  if (error) return { ok: false, error }
  return { ok: Array.isArray(data) && data.length > 0, error: null }
}

const notStoppable = (message, current_status) => ({ ok: false, code: 'not_stoppable', message, current_status })
const stopRequested = (status, at) => ({ ok: true, outcome: 'stop_requested', status, cancel_requested_at: at })

/**
 * Stop a campaign, judged on `campaign.status` (read just before) and
 * narrowed to it in the write:
 *   scheduled        → back to draft, scheduled_at cleared (no longer a
 *                      promotion candidate for the run-campaigns cron)
 *   queued | sending → cancel_requested_at stamped; the cron sees it between
 *                      chunks and moves the campaign to 'cancelled'
 *   anything else    → not_stoppable, nothing written
 * If the cron promotes a scheduled campaign to queued between the read and the
 * write, the unschedule touches nothing and the stop becomes a cancel request
 * on the send it turned into (never a "reload" while it goes out). Every
 * not_stoppable carries the status as it is now (`current_status`).
 */
export async function stopCampaign(db, campaign) {
  if (campaign.status === 'scheduled') {
    const { data, error } = await db.from('campaigns')
      .update({ status: 'draft', scheduled_at: null })
      .eq('id', campaign.id)
      .eq('status', 'scheduled')
      .select('id')
    if (error) return { ok: false, code: 'error', message: error.message }
    if (data && data.length > 0) {
      return { ok: true, outcome: 'back_to_draft', status: 'draft', cancel_requested_at: null }
    }
    // Zero rows: the run-campaigns cron promoted it (scheduled → queued)
    // between our read and our write. The operator asked to STOP, so stop the
    // send it has become rather than answer "reload" while it goes out.
    const now = await currentStatus(db, campaign.id, campaign.status)
    if (!IN_FLIGHT.includes(now)) return notStoppable(STATUS_CHANGED, now)
    const at = new Date().toISOString()
    const cancel = await requestCancel(db, campaign.id, at)
    if (cancel.error) return { ok: false, code: 'error', message: cancel.error.message }
    if (!cancel.ok) return notStoppable(STATUS_CHANGED, await currentStatus(db, campaign.id, now))
    return stopRequested(now, at)
  }

  if (IN_FLIGHT.includes(campaign.status)) {
    const at = new Date().toISOString()
    const cancel = await requestCancel(db, campaign.id, at)
    if (cancel.error) return { ok: false, code: 'error', message: cancel.error.message }
    if (!cancel.ok) return notStoppable(STATUS_CHANGED, await currentStatus(db, campaign.id, campaign.status))
    return stopRequested(campaign.status, at)
  }

  return notStoppable(`This campaign is ${campaign.status || 'in an unknown state'}, so there is nothing to stop.`, campaign.status)
}
