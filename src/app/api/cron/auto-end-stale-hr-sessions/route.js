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
import { sendCustomerPush } from '@/lib/customer-push'
import { logInfo, logWarn } from '@/lib/log'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { shouldCloseStaleSession, STALE_AFTER_MS, MAX_SESSION_LENGTH_MS } from '@/lib/hr-session-lifecycle'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 5 minutes without samples → close. The buffer/flush cycle on the
// bridge is 3s; if we haven't heard for 5 min the strap is genuinely
// off. We also auto-close sessions whose started_at is >4 hours old
// regardless of last_sample_at (defensive — class never lasts 4hr).
// STALE_AFTER_MS / MAX_SESSION_LENGTH_MS now come from the shared
// hr-session-lifecycle helper (keeps the query bounds + the close
// decision in lockstep).

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

  // Three separate queries combined — Supabase's .or() is awkward to
  // mix with the partial index, so we just union in JS.
  //   1. silent: has a sample, but the last one is older than STALE_AFTER_MS.
  //   2. long:   open past the 4h backstop regardless of samples.
  //   3. neverSampled (item 4a): a strap that NEVER delivered a sample (bridge
  //      crashed right after create) has last_sample_at IS NULL, so query (1)
  //      skips it and it sits on the board for the full 4h. Close it once it's
  //      been open longer than STALE_AFTER_MS with still no sample.
  const [{ data: silentRows }, { data: longRows }, { data: neverSampledRows }] = await Promise.all([
    db.from('heart_rate_sessions')
      .select('id, last_sample_at, started_at, glofox_event_id')
      .is('ended_at', null)
      .not('last_sample_at', 'is', null)
      .lt('last_sample_at', staleCutoff),
    db.from('heart_rate_sessions')
      .select('id, last_sample_at, started_at, glofox_event_id')
      .is('ended_at', null)
      .lt('started_at', longCutoff),
    db.from('heart_rate_sessions')
      .select('id, last_sample_at, started_at, glofox_event_id')
      .is('ended_at', null)
      .is('last_sample_at', null)
      .lt('started_at', staleCutoff),
  ])

  const candidates = new Map()
  for (const r of silentRows || [])       candidates.set(r.id, r)
  for (const r of longRows || [])         candidates.set(r.id, candidates.get(r.id) || r)
  for (const r of neverSampledRows || []) candidates.set(r.id, candidates.get(r.id) || r)

  // Fetch ends_at for the class-linked candidates so we can defer closing a
  // session whose class is still running (mid-class drop-out is rejoinable).
  const eventIds = [...new Set([...candidates.values()].map((r) => r.glofox_event_id).filter(Boolean))]
  let occByEvent = new Map()
  if (eventIds.length) {
    const { data: occs } = await db
      .from('class_occurrences').select('glofox_event_id, ends_at').in('glofox_event_id', eventIds).is('cancelled_at', null)
    occByEvent = new Map((occs || []).map((o) => [o.glofox_event_id, o]))
  }

  const toEnd = new Map()
  for (const [id, r] of candidates) {
    const occ = r.glofox_event_id ? occByEvent.get(r.glofox_event_id) || null : null
    if (shouldCloseStaleSession({ session: r, occ, nowMs })) toEnd.set(id, r)
  }

  let endedCount = 0
  let endFailed = 0
  for (const [sessionId] of toEnd) {
    const out = await endSession(db, sessionId, { nowMs })
    if (out.ok && !out.alreadyEnded) endedCount++
    else if (!out.ok) endFailed++
  }

  // Phase 2 recency bound (item 4c): a session must have ended within the last
  // 48h to be a live email candidate. Anything older that STILL has a null
  // email_sent_at is a data artifact (a backfill, a column reset, a long-dead
  // pilot row) — emailing a member about a class from months ago is worse than
  // silence, so we stamp those processed (below) instead of sending.
  const EMAIL_RECENCY_MS = 48 * 3600 * 1000
  const recencyCutoff = new Date(nowMs - EMAIL_RECENCY_MS).toISOString()

  // Phase 2: send the post-class email for any session that's
  // ended_at = not null AND email_sent_at = null AND ended within 48h. That
  // includes the ones we just closed AND any that were closed via /end-class
  // where the inline trigger failed.
  // Exclude source IN ('participation','apple_health') — sessions that are
  // finalised once, out-of-band, and never stamp email_sent_at:
  //   - participation (attendance credits): no HR data, the post-class email
  //     always skips them.
  //   - apple_health (off-site wearable imports): finalised once by the webhook
  //     (IB5); non-class imports never email (finalizeSessionRewards gates the
  //     email to class sessions), so they never stamp email_sent_at.
  // Both would otherwise match this sweep forever and re-fire the "session
  // ready" push every 5-min tick. NULL source (item 4b) must ALSO be swept: a
  // bare `source NOT IN (…)` is UNKNOWN for a null source and silently EXCLUDES
  // it, so a null-source class session would never get its email. Use an
  // explicit OR so null passes.
  const { data: pendingEmails } = await db
    .from('heart_rate_sessions')
    .select('id, contact_id, effort_points, class_name')
    .not('ended_at', 'is', null)
    .is('email_sent_at', null)
    .gte('ended_at', recencyCutoff)
    .or('source.is.null,source.not.in.(participation,apple_health)')
    .order('ended_at', { ascending: true })
    .limit(50)

  // Item 4c — retire stale un-emailed rows without sending: stamp email_sent_at
  // so they leave this sweep permanently. Same source filter as the send sweep
  // (participation/apple_health already self-retire; NULL source must be caught).
  const { data: staleUnEmailed } = await db
    .from('heart_rate_sessions')
    .select('id')
    .not('ended_at', 'is', null)
    .is('email_sent_at', null)
    .lt('ended_at', recencyCutoff)
    .or('source.is.null,source.not.in.(participation,apple_health)')
    .limit(200)
  let staleRetired = 0
  for (const row of staleUnEmailed || []) {
    const { error } = await db
      .from('heart_rate_sessions')
      .update({ email_sent_at: new Date(nowMs).toISOString() })
      .eq('id', row.id)
      .is('email_sent_at', null)
    if (!error) staleRetired++
    else logWarn('cron-auto-end-hr', 'stale-retire stamp failed', { err: error, sessionId: row.id })
  }

  let emailsSent = 0
  let emailsSkipped = 0
  let emailsFailed = 0
  for (const row of pendingEmails || []) {
    const out = await sendPostClassEmail(db, row.id, { nowMs })
    if (out.ok && out.sent) emailsSent++
    else if (out.ok) emailsSkipped++
    else emailsFailed++

    // Best-effort "session report ready" push to champ-app native. Fire only
    // for a REAL session — emailed (out.sent), or skipped only because the
    // member has no email / opted out of EMAIL (push is a separate channel).
    // NOT for too-little-data junk sessions, already-sent, or transient errors.
    // sendPostClassEmail now stamps email_sent_at on permanent skips too, so the
    // row leaves this sweep after one tick → the push fires at most once.
    const pushWorthy = out.ok && (out.sent || out.skipped === 'no-email' || out.skipped === 'opted-out')
    if (row.contact_id && pushWorthy) {
      sendCustomerPush(db, row.contact_id, {
        title: 'Your session is ready',
        body: `${Number.isFinite(row.effort_points) ? row.effort_points + ' UN1T Points' : 'Tap to see your stats'}${row.class_name ? ' · ' + row.class_name : ''}`,
        data: { type: 'session_report', session_id: row.id },
      }).catch((err) => logWarn('cron-auto-end-hr', 'customer push threw', { err, sessionId: row.id }))
    }
  }

  if (toEnd.size > 0 || (pendingEmails || []).length > 0 || staleRetired > 0) {
    logInfo('cron-auto-end-hr', 'tick', {
      candidates: toEnd.size, ended: endedCount, end_failed: endFailed,
      email_candidates: pendingEmails?.length || 0,
      emails_sent: emailsSent, emails_skipped: emailsSkipped, emails_failed: emailsFailed,
      stale_retired: staleRetired,
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
    stale_retired: staleRetired,
  })
}
