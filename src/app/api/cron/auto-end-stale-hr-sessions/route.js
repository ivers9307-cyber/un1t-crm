// Vercel cron — every 5 minutes.
// Auto-closes heart_rate_sessions whose strap has gone silent for
// more than STALE_THRESHOLD_MS, then triggers the post-class email
// path on each. Two reasons we need this:
//
//   1. Members forget to "end class" or walk out without the coach
//      hitting end-all. Without the sweep, sessions sit open
//      forever and the post-class email never fires.
//
//   2. Bridge → Pi can crash mid-class. The strap stops broadcasting,
//      we can't tell from the bridge alone, so the auto-close is
//      our backstop.
//
// Auth: CRON_SECRET bearer, same as every other cron.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { endSession } from '@/lib/live-class'
import { sendPostClassEmail } from '@/lib/hr-post-class-email'
import { logInfo, logWarn } from '@/lib/log'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 5 minutes without samples → close. The buffer/flush cycle on the
// bridge is 3s; if we haven't heard for 5 min the strap is genuinely
// off. We also auto-close sessions whose started_at is >4 hours old
// regardless of last_sample_at (defensive — class never lasts 4hr).
const STALE_AFTER_MS = 5 * 60 * 1000
const MAX_SESSION_LENGTH_MS = 4 * 3600 * 1000

export async function POST(request) {
  return GET(request)
}

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const nowMs = Date.now()

  // Phase 1: auto-close sessions where the strap is silent OR the
  // session has been open too long.
  const staleCutoff = new Date(nowMs - STALE_AFTER_MS).toISOString()
  const longCutoff  = new Date(nowMs - MAX_SESSION_LENGTH_MS).toISOString()

  // Two separate queries combined — Supabase's .or() is awkward to
  // mix with the partial index, so we just union in JS.
  const [{ data: silentRows }, { data: longRows }] = await Promise.all([
    db.from('heart_rate_sessions')
      .select('id, last_sample_at, started_at')
      .is('ended_at', null)
      .not('last_sample_at', 'is', null)
      .lt('last_sample_at', staleCutoff),
    db.from('heart_rate_sessions')
      .select('id, last_sample_at, started_at')
      .is('ended_at', null)
      .lt('started_at', longCutoff),
  ])

  const toEnd = new Map()
  for (const r of silentRows || []) toEnd.set(r.id, { reason: 'strap_silent', ...r })
  for (const r of longRows || [])   toEnd.set(r.id, toEnd.get(r.id) || { reason: 'too_long', ...r })

  let endedCount = 0
  let endFailed = 0
  for (const [sessionId] of toEnd) {
    const out = await endSession(db, sessionId, { nowMs })
    if (out.ok && !out.alreadyEnded) endedCount++
    else if (!out.ok) endFailed++
  }

  // Phase 2: send the post-class email for any session that's
  // ended_at = not null AND email_sent_at = null. That includes the
  // ones we just closed AND any that were closed via /end-class
  // where the inline trigger failed.
  const { data: pendingEmails } = await db
    .from('heart_rate_sessions')
    .select('id')
    .not('ended_at', 'is', null)
    .is('email_sent_at', null)
    .order('ended_at', { ascending: true })
    .limit(50)

  let emailsSent = 0
  let emailsSkipped = 0
  let emailsFailed = 0
  for (const row of pendingEmails || []) {
    const out = await sendPostClassEmail(db, row.id, { nowMs })
    if (out.ok && out.sent) emailsSent++
    else if (out.ok) emailsSkipped++
    else emailsFailed++
  }

  if (toEnd.size > 0 || (pendingEmails || []).length > 0) {
    logInfo('cron-auto-end-hr', 'tick', {
      candidates: toEnd.size, ended: endedCount, end_failed: endFailed,
      email_candidates: pendingEmails?.length || 0,
      emails_sent: emailsSent, emails_skipped: emailsSkipped, emails_failed: emailsFailed,
    })
  }

  await stampHeartbeat('auto-end-stale-hr-sessions').catch((err) =>
    logWarn('cron-auto-end-hr', 'heartbeat failed', { err }))

  return NextResponse.json({
    ok: true,
    ended: endedCount,
    end_failed: endFailed,
    emails_sent: emailsSent,
    emails_skipped: emailsSkipped,
    emails_failed: emailsFailed,
  })
}
