// GET /api/cron/webhook-replay
//
// Auto-retry cron for replayable webhook dead-letter rows.
//
// Runs every 5 minutes. Fetches 'pending' rows for REPLAYABLE providers whose
// last_attempt_at is null (never retried) or beyond the exponential-backoff
// window (min(60 * 2^attempts, 3600) seconds). Processes oldest first, capped
// at BATCH_SIZE. Calls stampHeartbeat on completion.
//
// Provider eligibility: inbody + postmark only (idempotency-verified).
// Glofox is excluded from the REPLAYABLE_PROVIDERS list because action-replay
// is not safe (partial-completion risk).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { isReplayable, replayDeadLetter } from '@/lib/webhook-replay'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BATCH_SIZE = 100
const REPLAYABLE_PROVIDERS = ['inbody', 'postmark']

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

    // Safety: verify the provider is still in the registry (belt + suspenders).
    if (!isReplayable(row.provider)) {
      summary.skipped += 1
      continue
    }

    const result = await replayDeadLetter(db, row)
    if (result.ok) {
      summary.replayed += 1
    } else {
      summary.failed += 1
    }
  }

  await stampHeartbeat('webhook-replay', summary)

  return NextResponse.json({ ok: true, ...summary })
}
