// GET /api/cron/webhook-replay
//
// Auto-retry cron for replayable webhook dead-letter rows.
//
// Runs every 5 minutes. Fetches 'pending' rows for REPLAYABLE providers whose
// last_attempt_at is null (never retried) or beyond the exponential-backoff
// window (min(60 * 2^attempts, 3600) seconds). Processes oldest first, capped
// at BATCH_SIZE. Calls stampHeartbeat on completion.
//
// QSTASH.3: this cron is now the SWEEPER, not the only consumer — the
// dead-letter capture (deadLetterWebhook) also publishes each replayable
// row to QStash, whose worker (/api/webhooks/qstash/webhook-replay)
// replays it ~60s after capture via the same claim CAS in
// src/lib/webhook-replay-queue.js. With QStash healthy this loop mostly
// finds an empty batch; it remains the delivery guarantee for publish
// failures, QStash outages, and rows whose QStash retries were exhausted.
//
// Provider eligibility: inbody + postmark only (idempotency-verified) —
// REPLAYABLE_PROVIDERS derives from the re-driver registry in
// src/lib/webhook-replay.js. Glofox is intentionally absent because
// action-replay is not safe (partial-completion risk).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { claimAndReplayDeadLetterRow, REPLAYABLE_PROVIDERS } from '@/lib/webhook-replay-queue'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BATCH_SIZE = 100

function unauthorized() {
  return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
}

/**
 * Exponential backoff window in seconds.
 * min(60 * 2^attempts, 3600) — so:
 *   attempts=1 → 120s, attempts=2 → 240s, …, attempts=6+ → 3600s
 */
function backoffSeconds(attempts) {
  return Math.min(60 * Math.pow(2, attempts || 1), 3600)
}

export async function GET(request) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    console.error('[cron webhook-replay] CRON_SECRET is not set')
    return NextResponse.json({ ok: false, error: 'cron_secret_missing' }, { status: 500 })
  }
  const got = request.headers.get('authorization') || ''
  if (got !== `Bearer ${expected}`) return unauthorized()

  const db = createServerClient()
  const now = new Date()

  // Build a cutoff timestamp: rows where last_attempt_at IS NULL or is older
  // than the per-row backoff. Because each row has its own backoff we can't
  // express that cleanly as a single query filter — instead, fetch candidates
  // and filter in JS. We use a conservative cutoff of the minimum backoff (2
  // minutes for attempts=1) to avoid unnecessary data transfer, then filter
  // precisely per-row.
  const minBackoffCutoff = new Date(now.getTime() - 60 * 1000) // 60s minimum gate

  const { data: rows, error: fetchErr } = await db
    .from('webhook_dead_letter')
    .select('id, provider, payload, status, attempts, last_attempt_at')
    .eq('status', 'pending')
    .in('provider', REPLAYABLE_PROVIDERS)
    .or(`last_attempt_at.is.null,last_attempt_at.lt.${minBackoffCutoff.toISOString()}`)
    .order('received_at', { ascending: true })
    .limit(BATCH_SIZE)

  if (fetchErr) {
    console.error('[cron webhook-replay] fetch failed:', fetchErr.message)
    return NextResponse.json({ ok: false, error: fetchErr.message }, { status: 500 })
  }

  const summary = { replayed: 0, failed: 0, skipped: 0 }

  for (const row of rows || []) {
    // Per-row backoff check.
    if (row.last_attempt_at) {
      const lastAt = new Date(row.last_attempt_at)
      const backoff = backoffSeconds(row.attempts || 1)
      const eligibleAt = new Date(lastAt.getTime() + backoff * 1000)
      if (now < eligibleAt) {
        summary.skipped += 1
        continue
      }
    }

    // Claim-before-replay CAS, shared with the QStash worker route
    // (src/lib/webhook-replay-queue.js). Vercel cron does not skip an
    // overlapping invocation, and the QStash push consumer races this
    // loop by design — the CAS means exactly one claimant replays each
    // row; everyone else sees `skipped` (which also covers the old
    // belt-and-suspenders isReplayable check — the lib skips
    // non-replayable rows without touching them).
    const outcome = await claimAndReplayDeadLetterRow(db, row)
    if (outcome.status === 'processed') {
      summary.replayed += 1
    } else if (outcome.status === 'skipped') {
      summary.skipped += 1
    } else {
      summary.failed += 1
      console.warn(`[cron webhook-replay] row ${row.id} (${row.provider}) failed (attempt ${(row.attempts || 1) + 1}): ${outcome.error}`)
    }
  }

  await stampHeartbeat('webhook-replay', summary)

  return NextResponse.json({ ok: true, ...summary })
}
