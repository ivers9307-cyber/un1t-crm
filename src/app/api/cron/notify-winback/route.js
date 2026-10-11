// Vercel cron — hourly (TZ.6); acts for each member's home studio at its daily
// slot: 10:00 UTC for a Europe/Dublin studio (as before, ~midday Dublin), 10:00
// local for any other zone (src/lib/cron-daily-slot.js, at most once per studio
// per local day). The month key is the studio's local month.
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
import { gateDailySlot, slotFor, readContactHomes, slotTickStampable } from '@/lib/cron-daily-slot'

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

  // TZ.6 — which home studios are at their daily slot this tick (claimed, so
  // never twice in one local day). An unreadable zone acts for nobody.
  const gate = await gateDailySlot(db, 'notify-winback', { nowMs, module: 'cron-winback' })
  if (!gate.ok) return NextResponse.json({ ok: false, slot: gate.summary }, { status: 500 })
  if (gate.slots.size === 0) {
    // A quiet tick (no slot taken) never stamps; the row keeps the legacy clock.
    // A faulted one (claim write failed) answers 500: the slot is skipped and pages.
    return NextResponse.json({ ok: !gate.faulted, slot: gate.summary, candidates: 0, dropping: 0, nudged: 0 }, { status: gate.faulted ? 500 : 200 })
  }
  // Stamp only a slot tick with no fault of the gate's or the body's own.
  const stamp = async (outcome, status = 200) => {
    if (status === 200 && slotTickStampable(gate)) {
      await stampHeartbeat('notify-winback').catch((err) => logWarn('cron-winback', 'heartbeat failed', { err }))
      return NextResponse.json({ ok: true, ...outcome })
    }
    return NextResponse.json({ ok: false, ...outcome, slot: gate.summary }, { status: 500 })
  }

  const DAY = 24 * 3600 * 1000
  // The read floor is attendanceDrop's own: its windows are rolling multiples
  // of 24h back from nowMs, not calendar days, so no zone moves them. TZ.17:
  // it was 84 days before UTC midnight, a calendar floor that only ever read a
  // few hours more than attendanceDrop looks at (who is picked is unchanged).
  const since84Iso = new Date(nowMs - 84 * DAY).toISOString()

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
    return stamp({ candidates: 0, dropping: 0, nudged: 0 })
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
    return stamp({ candidates: ids.length, dropping: 0, nudged: 0 })
  }

  // 4. TZ.6 — only members whose home studio is at its slot this tick. The
  //    monthly dedup key is that studio's local month (for Dublin at 10:00
  //    UTC, the same month as the UTC one it used to be).
  const { homes, unread: homesUnread } = await readContactHomes(db, dropping, 'cron-winback')
  const due = []
  for (const cid of dropping) {
    if (!homes.has(cid)) continue
    const slot = slotFor(gate.slots, homes.get(cid))
    if (slot) due.push({ cid, dedupKey: slot.day.slice(0, 7) }) // YYYY-MM (monthly)
  }

  // 5. Keep only reachable (has a push token). A failed token read skips
  //    that chunk (counted), it is not "unreachable".
  const { reachable, failed: reachabilityFailed } = await readReachableContacts(db, due.map((d) => d.cid), 'cron-winback')

  // 6. Claim (idempotent, monthly dedup_key) + push, released if nothing reached them.
  let nudged = 0
  let failed = 0
  for (const { cid, dedupKey } of due) {
    if (!reachable.has(cid)) continue
    const { status } = await sendNudgeOnce(db, {
      contactId: cid, type: 'winback', dedupKey, payload: buildWinbackPush(), module: 'cron-winback',
    })
    if (status === 'sent') nudged++
    else if (nudgeFailed(status)) failed++
  }

  const summary = {
    candidates: ids.length, dropping: dropping.length, due: due.length, nudged, failed,
    reachability_failed: reachabilityFailed, homes_unread: homesUnread, slot: gate.summary,
  }
  logInfo('cron-winback', 'tick', summary)
  // An unreadable home is a member not seen this slot (they were skipped, not
  // guessed): no stamp, so the run reads as failed.
  return stamp(summary, homesUnread > 0 ? 500 : 200)
}
