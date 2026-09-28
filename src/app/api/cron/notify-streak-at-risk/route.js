// Vercel cron — daily 11:00 UTC (~midday Dublin).
// Pushes a loss-aversion nudge to members whose streak (>= MIN_STREAK days,
// ending YESTERDAY) will break unless they train today. Idempotent per member
// per day via customer_engagement_nudges. Reachable members only (push token).
// C21 PUSHDONE.1b — claim, send and release through sendNudgeOnce: a nudge
// that reached nobody because something broke gives its claim back (the ledger
// row is member-readable, so it must not claim a push that never landed). The
// cron is daily and the key is the day, so the released nudge is not re-sent
// today; it is logged and counted in `failed`.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendNudgeOnce, readReachableContacts, nudgeFailed } from '@/lib/customer-nudge-claim'
import { streakAtRisk, buildStreakAtRiskPush } from '@/lib/customer-notifications'
import { logInfo, logWarn } from '@/lib/log'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MIN_STREAK = 3
const PAGE = 1000

export async function POST(request) { return GET(request) }

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  const db = createServerClient()
  const nowMs = Date.now()
  const DAY = 24 * 3600 * 1000
  const n = new Date(nowMs)
  const todayMs = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())
  const todayIso = new Date(todayMs).toISOString()
  const yestIso = new Date(todayMs - DAY).toISOString()
  const dedupKey = new Date(todayMs).toISOString().slice(0, 10) // YYYY-MM-DD

  // 1. Candidates = contacts who trained YESTERDAY (only they can have a streak
  //    "ending yesterday"). Paginate defensively.
  const candidateIds = new Set()
  for (let from = 0; ; from += PAGE) {
    const { data: rows, error } = await db
      .from('heart_rate_sessions')
      .select('contact_id')
      .not('contact_id', 'is', null)
      .not('ended_at', 'is', null)
      .gte('started_at', yestIso)
      .lt('started_at', todayIso)
      .order('contact_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) { logWarn('cron-streak-risk', 'candidate query failed', { err: error }); break }
    for (const r of rows || []) candidateIds.add(r.contact_id)
    if (!rows || rows.length < PAGE) break
  }
  if (candidateIds.size === 0) {
    await stampHeartbeat('notify-streak-at-risk').catch(() => {})
    return NextResponse.json({ ok: true, candidates: 0, nudged: 0 })
  }

  const ids = [...candidateIds]

  // 2. Their last-10-day sessions (for streak computation), batched.
  const sinceIso = new Date(todayMs - 10 * DAY).toISOString()
  const byContact = new Map()
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const { data: rows } = await db
      .from('heart_rate_sessions')
      .select('contact_id, started_at')
      .in('contact_id', chunk)
      .not('ended_at', 'is', null)
      .gte('started_at', sinceIso)
    for (const r of rows || []) {
      if (!byContact.has(r.contact_id)) byContact.set(r.contact_id, [])
      byContact.get(r.contact_id).push({ started_at: r.started_at })
    }
  }

  // 3. At-risk members.
  const atRisk = []
  for (const cid of ids) {
    const streak = streakAtRisk(byContact.get(cid) || [], nowMs, MIN_STREAK)
    if (streak > 0) atRisk.push({ cid, streak })
  }
  if (atRisk.length === 0) {
    await stampHeartbeat('notify-streak-at-risk').catch(() => {})
    return NextResponse.json({ ok: true, candidates: ids.length, at_risk: 0, nudged: 0 })
  }

  // 4. Keep only reachable (has a push token). A failed token read skips
  //    that chunk (counted), it is not "unreachable".
  const { reachable, failed: reachabilityFailed } =
    await readReachableContacts(db, atRisk.map((a) => a.cid), 'cron-streak-risk')

  // 5. Claim (idempotent) + push, released if nothing reached them.
  let nudged = 0
  let failed = 0
  for (const { cid, streak } of atRisk) {
    if (!reachable.has(cid)) continue
    const { status } = await sendNudgeOnce(db, {
      contactId: cid, type: 'streak_at_risk', dedupKey,
      payload: buildStreakAtRiskPush({ streak }), module: 'cron-streak-risk',
    })
    if (status === 'sent') nudged++
    else if (nudgeFailed(status)) failed++
  }

  const summary = { candidates: ids.length, at_risk: atRisk.length, nudged, failed, reachability_failed: reachabilityFailed }
  logInfo('cron-streak-risk', 'tick', summary)
  await stampHeartbeat('notify-streak-at-risk').catch((err) =>
    logWarn('cron-streak-risk', 'heartbeat failed', { err }))
  return NextResponse.json({ ok: true, ...summary })
}
