// CAMPAIGN.13 — drain the postmark_webhook_queue.
//
// Runs every minute. Pulls a batch of unprocessed events, runs
// each through processPostmarkEvent, marks them processed. If a
// row errors, the error is stashed on the row and attempts++; the
// cron tries again next tick up to a small retry budget.
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
import { claimAndProcessQueueRow, MAX_ATTEMPTS } from '@/lib/postmark-queue'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BATCH_SIZE = 100 // events processed per cron tick

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

  const summary = { processed: 0, failed: 0, batch_size: rows?.length || 0 }

  for (const row of rows || []) {
    // Claim-before-process CAS, shared with the QStash worker route
    // (src/lib/postmark-queue.js). Vercel cron does not skip an
    // overlapping invocation, and the QStash push consumer races this
    // loop by design — the CAS means exactly one claimant processes
    // each row; everyone else sees `skipped`. On failure the claim is
    // released with attempts++ so the row retries within MAX_ATTEMPTS.
    const outcome = await claimAndProcessQueueRow(db, row)
    if (outcome.status === 'skipped') {
      summary.skipped = (summary.skipped || 0) + 1
    } else if (outcome.status === 'processed') {
      summary.processed += 1
    } else {
      summary.failed += 1
      console.warn(`[cron process-postmark-webhooks] event ${row.id} failed (attempt ${(row.attempts || 0) + 1}): ${outcome.error}`)
    }
  }

  await stampHeartbeat('process-postmark-webhooks')

  return NextResponse.json({ ok: true, ...summary })
}
