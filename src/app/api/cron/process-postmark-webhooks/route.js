// CAMPAIGN.13 — drain the postmark_webhook_queue.
//
// Runs every TEN minutes (vercel.json is the truth — this header once said
// "every minute" and INTEGRATIONS.md said */2, three answers to one
// question; EMAIL-MONITOR.3 aligned all three). QStash push delivers most
// rows within seconds of arrival, so this cron is the SWEEPER: it pulls a
// batch of unprocessed events, runs each through processPostmarkEvent, and
// marks them processed. If a row errors, the error is stashed on the row and
// attempts++; the cron tries again next tick up to a small retry budget.
//
// POSTMARK-DLQ.1: the batch filter below (`attempts < MAX_ATTEMPTS`) is what
// makes an exhausted row invisible, so the shared helper dead-letters it at
// the transition — a bounce / spam complaint / unsubscribe that runs out of
// retries is now captured in webhook_dead_letter instead of vanishing.
// The count is surfaced in the response AND in the heartbeat's last_outcome.
//
// Pattern matches run-sms-broadcasts / run-sequences — uses
// CRON_SECRET bearer auth, stamps a heartbeat, returns a small
// JSON summary.
//
// QSTASH.1: this cron is now the SWEEPER, not the only consumer — the
// webhook route also publishes each queued row to QStash, whose worker
// (/api/webhooks/qstash/postmark) processes it within ~seconds via the
// same claim CAS in src/lib/postmark-queue.js. With QStash healthy this
// loop mostly finds an empty batch; it remains the delivery guarantee
// for publish failures, QStash outages, and rows whose QStash retries
// were exhausted.
//
// Why a cron (not a Realtime subscription)? Operationally simpler:
// no long-lived connection to manage, no per-row lock contention,
// natural back-pressure if processing is slow (queue grows, no
// thundering herd of concurrent invocations). The 60s latency on
// the dashboard is fine — open / click stats aren't real-time
// SLAs.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { claimAndProcessQueueRow, reclaimStaleQueueClaims, MAX_ATTEMPTS } from '@/lib/postmark-queue'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// POSTMARK-RACE.2 — the batch below can now be three times the size, so the
// invocation gets the headroom explicitly rather than inheriting a default.
export const maxDuration = 300

// POSTMARK-RACE.2 — was 100, which with a */10 schedule is a hard ceiling of
// 600 rows/hour on the sweeper. Measured on prod 2026-08-10: this cron ran at
// EXACTLY 100 rows per tick from 18:10 until past 21:40 — the ceiling, not the
// backlog, was setting the drain rate, and max queue lag over 60 days is
// 4h15m. A single campaign burst produces ~1,000 events in one 10-minute
// window (peak 1,038), so 100 could never absorb one. A 100-row batch measures
// ~24s wall clock; 300 keeps well inside maxDuration and the TIME_BUDGET_MS
// guard below stops a slow tick overrunning regardless.
const BATCH_SIZE = 300 // events processed per cron tick

// Stop claiming new rows once the invocation has spent this long. The rows we
// did not reach stay pending (nothing is claimed until claimAndProcessQueueRow
// runs), so the next tick picks them up in the same received_at order — the
// batch getting larger must never turn into a timeout that strands a claim.
const TIME_BUDGET_MS = 240_000

function unauthorized() {
  return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
}

export async function GET(request) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    console.error('[cron process-postmark-webhooks] CRON_SECRET is not set')
    return NextResponse.json({ ok: false, error: 'cron_secret_missing' }, { status: 500 })
  }
  const got = request.headers.get('authorization') || ''
  if (got !== `Bearer ${expected}`) return unauthorized()

  const db = createServerClient()

  // POSTMARK-QUEUE-RECLAIM.1 — give back claims whose owners died (consumer
  // killed mid-processing, or a release UPDATE that failed twice). Runs here,
  // in the sweeper, not in the QStash worker: this cron is the delivery
  // guarantee, and once a minute is the right cadence for a 10-minute
  // staleness window. Never throws; a reclaimed row re-enters the batch below
  // on a later tick as an ordinary pending event.
  const reclaim = await reclaimStaleQueueClaims(db)

  // Pull a batch of pending events. Oldest first so we don't
  // starve stragglers behind newly-arriving bursts.
  const { data: rows, error: fetchErr } = await db
    .from('postmark_webhook_queue')
    .select('id, payload, attempts')
    .is('processed_at', null)
    .lt('attempts', MAX_ATTEMPTS)
    .order('received_at', { ascending: true })
    .limit(BATCH_SIZE)

  if (fetchErr) {
    console.error('[cron process-postmark-webhooks] fetch failed:', fetchErr.message)
    return NextResponse.json({ ok: false, error: fetchErr.message }, { status: 500 })
  }

  const summary = {
    processed: 0, failed: 0, dead_lettered: 0, batch_size: rows?.length || 0,
    // Stranded-claim recoveries, visible in the heartbeat's last_outcome — a
    // non-zero here means an attempt died holding its claim since last tick.
    reclaimed: reclaim.reclaimed,
    // Reclaims that spent the retry budget also dead-letter (counted with the
    // in-batch ones below so the heartbeat shows one total).
    dead_lettered_on_reclaim: reclaim.deadLettered,
  }

  const startedAt = Date.now()
  for (const row of rows || []) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      summary.time_budget_exhausted = true
      summary.unreached = (summary.batch_size || 0) - (
        summary.processed + summary.failed + (summary.deferred || 0) + (summary.skipped || 0)
      )
      console.warn(
        `[cron process-postmark-webhooks] time budget spent after ${summary.processed} processed — ` +
        `${summary.unreached} rows left pending for the next tick`
      )
      break
    }
    // Claim-before-process CAS, shared with the QStash worker route
    // (src/lib/postmark-queue.js). Vercel cron does not skip an
    // overlapping invocation, and the QStash push consumer races this
    // loop by design — the CAS means exactly one claimant processes
    // each row; everyone else sees `skipped`. On failure the claim is
    // released with attempts++ so the row retries within MAX_ATTEMPTS —
    // and the attempt that spends the budget dead-letters the payload
    // first, since the row is about to stop matching the select above.
    const outcome = await claimAndProcessQueueRow(db, row)
    if (outcome.status === 'skipped') {
      summary.skipped = (summary.skipped || 0) + 1
    } else if (outcome.status === 'processed') {
      summary.processed += 1
    } else if (outcome.status === 'deferred') {
      // POSTMARK-RACE.1 — the send row had not committed when we looked. The
      // row is pending again with attempts+1. Its FAST recovery path is the
      // QStash worker's delayed re-publish (+60s); this cron is the guarantee
      // behind that, so a deferral seen here lands in a later tick's
      // `processed` at the latest. Counted separately
      // rather than as `failed`: a steady trickle here is the race being
      // absorbed as designed, whereas a rising count that never converts to
      // processed means sends are being made whose email_sends insert is
      // failing — a genuinely different incident, and the heartbeat's
      // last_outcome is where an operator would see the difference.
      summary.deferred = (summary.deferred || 0) + 1
    } else {
      summary.failed += 1
      const attempt = outcome.attempts ?? (row.attempts || 0) + 1
      if (outcome.deadLettered) {
        summary.dead_lettered += 1
        console.error(
          `[cron process-postmark-webhooks] event ${row.id} EXHAUSTED after ${attempt} attempts ` +
          `— dead-lettered to webhook_dead_letter (provider postmark_queue): ${outcome.error}`
        )
      } else {
        console.warn(`[cron process-postmark-webhooks] event ${row.id} failed (attempt ${attempt}): ${outcome.error}`)
      }
    }
  }

  // Pass the summary as the heartbeat outcome (mig 315's last_outcome) so a
  // tick that dead-lettered an unsubscribe is distinguishable from an idle
  // one without reading Vercel logs.
  await stampHeartbeat('process-postmark-webhooks', summary)

  return NextResponse.json({ ok: true, ...summary })
}
