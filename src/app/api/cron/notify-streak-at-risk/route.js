// Vercel cron — daily 11:00 UTC (~midday Dublin).
// Pushes a loss-aversion nudge to members whose streak (>= MIN_STREAK days,
// ending YESTERDAY) will break unless they train today. Idempotent per member
// per day via customer_engagement_nudges. Reachable members only (push token).
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendCustomerPush } from '@/lib/customer-push'
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

  // 4. Keep only reachable (has a push token).
  const reachable = new Set()
  const atRiskIds = atRisk.map((a) => a.cid)
  for (let i = 0; i < atRiskIds.length; i += 200) {
    const chunk = atRiskIds.slice(i, i + 200)
    const { data: toks } = await db.from('champ_push_tokens').select('contact_id').in('contact_id', chunk)
    for (const t of toks || []) reachable.add(t.contact_id)
  }

  // 5. Record (idempotent) + push.
  let nudged = 0
  for (const { cid, streak } of atRisk) {
    if (!reachable.has(cid)) continue
    const { data: ins, error: insErr } = await db
      .from('customer_engagement_nudges')
      .insert({ contact_id: cid, type: 'streak_at_risk', dedup_key: dedupKey })
      .select('id')
    if (insErr || !ins || !ins.length) continue // already nudged today, or error
    try {
      await sendCustomerPush(db, cid, buildStreakAtRiskPush({ streak }))
      nudged++
    } catch (err) {
      logWarn('cron-streak-risk', 'push threw', { err, cid })
    }
  }

  logInfo('cron-streak-risk', 'tick', { candidates: ids.length, at_risk: atRisk.length, nudged })
  await stampHeartbeat('notify-streak-at-risk').catch((err) =>
    logWarn('cron-streak-risk', 'heartbeat failed', { err }))
  return NextResponse.json({ ok: true, candidates: ids.length, at_risk: atRisk.length, nudged })
}
