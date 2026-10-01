// src/lib/whatsapp-schedule.js
// Pure helpers for WHATSAPP BROADCAST SCHEDULING (WA-SCHEDULE, comms audit
// 2026-07-10). No IO — unit-tested in whatsapp-schedule.test.js. The cron
// (run-whatsapp-broadcasts) composes these; the send engines stay in
// whatsapp.js so every scheduled path funnels through sendBroadcast /
// sendDripChunk and inherits the quality preflight (WA-QUALITY.2), the tier
// budget gates (WA-BUDGET.1/.2) and the circuit breakers for free.

// Per-tick recipient cap for a CRON-driven blast (a scheduled blast the
// run-whatsapp-broadcasts cron promotes and drives). Sized so one tick
// finishes comfortably inside the route's 300s maxDuration: the blast loop
// sleeps ~1s per 50 sends and each Meta call runs a few hundred ms, so 500
// recipients ≈ 2–3 min — headroom left for the drip arm and the heartbeat.
// A bigger audience simply spans ticks (15 min apart): sendBroadcast leaves
// the row 'sending' with the remainder unclaimed and the cron resumes it.
// Operator-fired blasts (the /send route) pass no cap and are unchanged.
export const SCHEDULED_BLAST_MAX_PER_TICK = 500

// C127 LATEBLAST.1 (DECIDED by Richard, 30 Sep) — a scheduled BLAST more than
// this many hours past its scheduled_at is never sent: it returns to draft and
// the studio's managers are told, so they re-schedule. The realistic way a
// blast gets that late is its studio's WhatsApp feature being off when it fell
// due (C122 holds such rows untouched until the feature is back on); a cron
// outage would be the other, and gets the same treatment. The cron runs every
// 15 minutes, so 3 hours is never a slow tick. Drips are exempt: they pace
// themselves inside their own daily window.
export const LATE_SCHEDULED_BLAST_HOURS = 3
export const LATE_SCHEDULED_BLAST_REASON =
  `it was more than ${LATE_SCHEDULED_BLAST_HOURS} hours late by the time it could be sent ` +
  '(for example, WhatsApp was switched off at the studio when it fell due), so it was not sent late'

// How the cron promotes a due scheduled broadcast, or null when the row is
// not promotable (already claimed by a concurrent tick, cancelled, …).
//
//  - drip  → flip scheduled→sending: the state /send starts a drip in
//    (GATES-3 e), so the existing drip machinery (window gate, daily cap,
//    tier budget, auto-pause, the template and number checks each tick)
//    takes over untouched.
//  - blast → flip scheduled→draft: 'draft' is the ONE entry state the blast
//    engine owns end-to-end — sendBroadcast performs its own draft→sending
//    CAS, and every refusal path lands back there (quality preflight throws
//    before the flip; the budget gate reverts sending→draft; the circuit
//    breaker parks at draft via blastAbortPatch). A refused scheduled blast
//    is therefore always a re-sendable draft, never a stranded row.
//  - stale → (C127, needs `now`) a blast more than LATE_SCHEDULED_BLAST_HOURS
//    past scheduled_at: flip scheduled→draft with scheduled_at cleared and
//    send NOTHING; the cron tells the managers. No `now`, or an unreadable
//    scheduled_at, keeps the blast plan.
export function promotionPlan(broadcast, now) {
  if (!broadcast || broadcast.status !== 'scheduled') return null
  if (broadcast.delivery_mode === 'drip') return { mode: 'drip', flipTo: 'sending' }
  const due = Date.parse(broadcast.scheduled_at ?? '')
  const at = now instanceof Date ? now.getTime() : NaN
  if (Number.isFinite(due) && Number.isFinite(at) && at - due > LATE_SCHEDULED_BLAST_HOURS * 3600 * 1000) {
    return { mode: 'stale', flipTo: 'draft' }
  }
  return { mode: 'blast', flipTo: 'draft' }
}

// Cap one tick's blast batch. No/zero cap → the whole pending set (the
// operator-fired path). `deferred` is what the next tick will resume.
export function sliceBlastChunk(pending, maxRecipients) {
  const all = pending || []
  if (!maxRecipients || maxRecipients <= 0 || all.length <= maxRecipients) {
    return { batch: all, deferred: 0 }
  }
  return { batch: all.slice(0, maxRecipients), deferred: all.length - maxRecipients }
}

// Manager push when a scheduled broadcast's start is refused (quality gate,
// tier budget, missing/unapproved template …). Without this the refusal is
// silent — the operator scheduled a send and it quietly became a draft.
// Mirrors blastAbortNotification. Pure.
export function scheduledStartFailureNotification(broadcast = {}, errorMessage) {
  const name = broadcast.name ? `"${broadcast.name}"` : 'A scheduled WhatsApp broadcast'
  return {
    title: 'Scheduled WhatsApp broadcast did not start',
    body: `⏰ ${name} could not start at its scheduled time` +
      `${errorMessage ? `: ${errorMessage}` : '.'} ` +
      'It has been returned to draft — fix the issue, then send or re-schedule it from the broadcast page.',
  }
}
