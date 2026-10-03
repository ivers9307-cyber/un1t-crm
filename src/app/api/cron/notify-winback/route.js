// Vercel cron — daily 10:00 UTC (~midday Dublin).
// Pushes a re-engagement nudge to members whose HR-class attendance dropped
// below their personal baseline but who are still visiting occasionally.
// Idempotent per member per calendar month via customer_engagement_nudges.
// Reachable members only (push token).
// C21 PUSHDONE.1b — claim, send and release through sendNudgeOnce: a nudge
// that reached nobody because something broke gives its claim back, so the
// next daily run (same month key) tries again while the member still
// qualifies. It used to keep the claim, and the month's nudge was gone.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendNudgeOnce, readReachableContacts, nudgeFailed } from '@/lib/customer-nudge-claim'
import { attendanceDrop, buildWinbackPush } from '@/lib/customer-notifications'
import { logInfo, logWarn } from '@/lib/log'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

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
  const dedupKey = new Date(todayMs).toISOString().slice(0, 7) // YYYY-MM (monthly)
  const since84Iso = new Date(todayMs - 84 * DAY).toISOString()

  // 1. Candidates = contacts with >= 1 ended session in the last 84 days.
  const candidateIds = new Set()
  for (let from = 0; ; from += PAGE) {
    const { data: rows, error } = await db
      .from('heart_rate_sessions')
      .select('contact_id')
      .not('contact_id', 'is', null)
      .not('ended_at', 'is', null)
      .gte('started_at', since84Iso)
      .order('contact_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) { logWarn('cron-winback', 'candidate query failed', { err: error }); break }
    for (const r of rows || []) candidateIds.add(r.contact_id)
    if (!rows || rows.length < PAGE) break
  }
  if (candidateIds.size === 0) {
    await stampHeartbeat('notify-winback').catch(() => {})
    return NextResponse.json({ ok: true, candidates: 0, dropping: 0, nudged: 0 })
  }

  const ids = [...candidateIds]

  // 2. Their ended sessions over the last 84 days, batched in chunks of 200.
  const byContact = new Map()
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const { data: rows } = await db
      .from('heart_rate_sessions')
      .select('contact_id, started_at')
      .in('contact_id', chunk)
      .not('ended_at', 'is', null)
      .gte('started_at', since84Iso)
    for (const r of rows || []) {
      if (!byContact.has(r.contact_id)) byContact.set(r.contact_id, [])
      byContact.get(r.contact_id).push({ started_at: r.started_at })
    }
  }

  // 3. Dropping members.
  const dropping = []
  for (const cid of ids) {
    const { dropping: isDrop } = attendanceDrop(byContact.get(cid) || [], nowMs)
    if (isDrop) dropping.push(cid)
  }
  if (dropping.length === 0) {
    await stampHeartbeat('notify-winback').catch(() => {})
    return NextResponse.json({ ok: true, candidates: ids.length, dropping: 0, nudged: 0 })
  }

  // 4. Keep only reachable (has a push token). A failed token read skips
  //    that chunk (counted), it is not "unreachable".
  const { reachable, failed: reachabilityFailed } = await readReachableContacts(db, dropping, 'cron-winback')

  // 5. Claim (idempotent, monthly dedup_key) + push, released if nothing reached them.
  let nudged = 0
  let failed = 0
  for (const cid of dropping) {
    if (!reachable.has(cid)) continue
    const { status } = await sendNudgeOnce(db, {
      contactId: cid, type: 'winback', dedupKey, payload: buildWinbackPush(), module: 'cron-winback',
    })
    if (status === 'sent') nudged++
    else if (nudgeFailed(status)) failed++
  }

  const summary = { candidates: ids.length, dropping: dropping.length, nudged, failed, reachability_failed: reachabilityFailed }
  logInfo('cron-winback', 'tick', summary)
  await stampHeartbeat('notify-winback').catch((err) =>
    logWarn('cron-winback', 'heartbeat failed', { err }))
  return NextResponse.json({ ok: true, ...summary })
}
