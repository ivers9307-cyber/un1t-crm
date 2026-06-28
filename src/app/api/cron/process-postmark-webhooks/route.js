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
// Why a cron (not a Realtime subscription)? Operationally simpler:
// no long-lived connection to manage, no per-row lock contention,
// natural back-pressure if processing is slow (queue grows, no
// thundering herd of concurrent invocations). The 60s latency on
// the dashboard is fine — open / click stats aren't real-time
// SLAs.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { processPostmarkEvent } from '@/lib/postmark-webhook-processor'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BATCH_SIZE       = 100   // events processed per cron tick
const MAX_ATTEMPTS     = 5     // give up after this many failures per event

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
    // Claim the row BEFORE processing. Vercel cron does not skip an
    // overlapping invocation, so two ticks can fetch the same pending rows
    // (processed_at still NULL) and both run processPostmarkEvent — double-
    // counting opens/clicks and re-applying bounces/unsubscribes. This CAS
    // flips processed_at from NULL→now: only one tick wins; a concurrent
    // tick matches 0 rows and skips. On failure we roll processed_at back
    // to NULL (+ attempts++) so it retries within the MAX_ATTEMPTS budget.
    const { data: claimed } = await db
      .from('postmark_webhook_queue')
      .update({ processed_at: new Date().toISOString() })
      .eq('id', row.id)
      .is('processed_at', null)
      .select('id')
    if (!claimed || claimed.length === 0) {
      summary.skipped = (summary.skipped || 0) + 1
      continue
    }

    const result = await processPostmarkEvent(db, row.payload)
    if (result.ok) {
      summary.processed += 1
    } else {
      summary.failed += 1
      await db
        .from('postmark_webhook_queue')
        .update({
          processed_at: null,
          attempts: (row.attempts || 0) + 1,
          error: result.error || 'unknown',
        })
        .eq('id', row.id)
      console.warn(`[cron process-postmark-webhooks] event ${row.id} failed (attempt ${row.attempts + 1}): ${result.error}`)
    }
  }

  await stampHeartbeat('process-postmark-webhooks')

  return NextResponse.json({ ok: true, ...summary })
}
