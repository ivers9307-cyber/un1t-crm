// src/app/api/cron/run-whatsapp-broadcasts/route.js
// Vercel cron — every 15 min. Three arms, all funnelling through the gated
// send engines in @/lib/whatsapp (quality preflight WA-QUALITY.2, tier budget
// WA-BUDGET.1/.2, circuit breakers — nothing here re-implements a send):
//
//  1. SCHEDULED promotion (WA-SCHEDULE): status='scheduled' AND
//     scheduled_at <= now. CAS on the status flip makes overlap safe — only
//     the tick that wins the flip proceeds (the 15-min cadence + 300s
//     maxDuration also means two ticks never truly overlap; the CAS is the
//     belt-and-braces, same posture as sendDripChunk's concurrency note).
//       - drip  → flip to 'sending'; the existing drip machinery owns it
//         (first chunk goes out this tick if inside the send window).
//       - blast → flip to 'draft' and invoke sendBroadcast with a per-tick
//         recipient cap: sendBroadcast performs its own draft→sending CAS and
//         every refusal (quality gate, tier budget, breaker) lands the row
//         back at 'draft' — recoverable, never stranded. A refusal pushes a
//         manager notification so the missed schedule isn't silent.
//  2. Blast RESUME: a scheduled blast bigger than one tick's cap was left at
//     'sending' with the remainder unclaimed — send the next chunk. Scoped to
//     scheduled_at IS NOT NULL so operator-fired blasts are untouched. The
//     per-recipient claim-first insert (mig 331) de-dupes any concurrent pass.
//  3. In-flight DRIPS: unchanged — one chunk each, inside the send window.
//
// Auth via Authorization: Bearer ${CRON_SECRET}.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendDripChunk, sendBroadcast } from '@/lib/whatsapp'
import { isWithinSendWindow } from '@/lib/whatsapp-drip'
import { promotionPlan, SCHEDULED_BLAST_MAX_PER_TICK, scheduledStartFailureNotification } from '@/lib/whatsapp-schedule'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { MANAGER_ROLES } from '@/lib/schemas'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // Pro ceiling

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const now = new Date()
  const nowIso = now.toISOString()

  // All three arms' rows in parallel. The resume query runs alongside the
  // scheduled one, so a blast promoted THIS tick isn't double-picked here.
  const [scheduledQ, resumeQ, dripQ] = await Promise.all([
    db.from('whatsapp_broadcasts')
      .select('id, name, status, location_id, delivery_mode, scheduled_at, send_window_start, send_window_end, send_window_tz')
      .eq('status', 'scheduled')
      .lte('scheduled_at', nowIso)
      .order('scheduled_at', { ascending: true })
      .limit(5),
    db.from('whatsapp_broadcasts')
      .select('id, name, location_id')
      .eq('delivery_mode', 'blast')
      .eq('status', 'sending')
      .not('scheduled_at', 'is', null)
      .is('paused_at', null)
      .order('updated_at', { ascending: true })
      .limit(5),
    db.from('whatsapp_broadcasts')
      .select('id, name, location_id, send_window_start, send_window_end, send_window_tz')
      .eq('delivery_mode', 'drip')
      .eq('status', 'sending')
      .is('paused_at', null)
      .order('updated_at', { ascending: true })
      .limit(20),
  ])
  for (const q of [scheduledQ, resumeQ, dripQ]) {
    if (q.error) return NextResponse.json({ success: false, error: q.error.message }, { status: 500 })
  }

  const stats = {
    scheduled_found: scheduledQ.data.length, promoted: 0, refused: 0,
    resume_found: resumeQ.data.length,
    found: dripQ.data.length,
    sent: 0, failed: 0, finished: 0, in_progress: 0, outside_window: 0, errors: [],
  }

  // ── 1. Promote due scheduled broadcasts ─────────────────────────────────
  for (const row of scheduledQ.data) {
    const plan = promotionPlan(row)
    if (!plan) continue
    try {
      // CAS the flip — a concurrent tick that already claimed it gets 0 rows.
      const { data: claimed } = await db.from('whatsapp_broadcasts')
        .update({ status: plan.flipTo })
        .eq('id', row.id)
        .eq('status', 'scheduled')
        .select('id')
      if (!claimed?.length) continue
      stats.promoted++

      if (plan.mode === 'drip') {
        // The drip engine owns it from here; start the first chunk now if the
        // send window is open (otherwise the next in-window tick will).
        const inWindow = isWithinSendWindow(now, {
          start: row.send_window_start, end: row.send_window_end, tz: row.send_window_tz,
        })
        if (!inWindow) { stats.outside_window++; continue }
        const r = await sendDripChunk(row.id)
        stats.sent += r.sent || 0
        stats.failed += r.failed || 0
        if (r.status === 'sent') stats.finished++
        else stats.in_progress++
      } else {
        const r = await sendBroadcast(row.id, { maxRecipients: SCHEDULED_BLAST_MAX_PER_TICK })
        stats.sent += r.sent || 0
        stats.failed += r.failed || 0
        if (r.status === 'sent') stats.finished++
        else stats.in_progress++
      }
    } catch (e) {
      const msg = e?.message || String(e)
      stats.refused++
      stats.errors.push({ broadcast_id: row.id, error: msg })
      console.warn(`[cron run-whatsapp-broadcasts] scheduled ${row.id} (${row.name}) refused: ${msg}`)
      // A BLAST refusal (quality gate / tier budget) threw out of
      // sendBroadcast and left the row at 'draft' (its own state machine
      // guarantees that) — tell the managers, a silently missed schedule is
      // worse than the refusal itself. Best-effort push, never re-throws.
      // A promoted DRIP that errors is already 'sending' and the next tick
      // retries it, so no push (the wording wouldn't fit and a transient
      // error would page every 15 min).
      if (plan.mode === 'blast') {
        try {
          const notify = scheduledStartFailureNotification(row, msg)
          await sendPushToRolesAtLocation(row.location_id, MANAGER_ROLES, {
            title: notify.title,
            body: notify.body,
            category: 'whatsapp',
            data: { type: 'broadcast_schedule_failed', broadcast_id: row.id },
          })
        } catch (pushErr) {
          console.error(`[cron run-whatsapp-broadcasts] refusal push failed:`, pushErr?.message || pushErr)
        }
      }
    }
  }

  // ── 2. Resume chunked scheduled blasts ──────────────────────────────────
  for (const row of resumeQ.data) {
    try {
      const r = await sendBroadcast(row.id, { maxRecipients: SCHEDULED_BLAST_MAX_PER_TICK })
      stats.sent += r.sent || 0
      stats.failed += r.failed || 0
      if (r.status === 'sent') stats.finished++
      else stats.in_progress++
    } catch (e) {
      // Transient refusal (e.g. tier budget until earlier sends age out of
      // the rolling 24h window): the row stays 'sending' and the next tick
      // retries — log only, no push spam every 15 min.
      const msg = e?.message || String(e)
      console.warn(`[cron run-whatsapp-broadcasts] resume ${row.id} (${row.name}) failed: ${msg}`)
      stats.errors.push({ broadcast_id: row.id, error: msg })
    }
  }

  // ── 3. In-flight drips (unchanged) ──────────────────────────────────────
  for (const row of dripQ.data) {
    try {
      const inWindow = isWithinSendWindow(now, {
        start: row.send_window_start, end: row.send_window_end, tz: row.send_window_tz,
      })
      if (!inWindow) { stats.outside_window++; continue }

      const r = await sendDripChunk(row.id)
      stats.sent += r.sent || 0
      stats.failed += r.failed || 0
      if (r.status === 'sent') stats.finished++
      else stats.in_progress++
    } catch (e) {
      const msg = e?.message || String(e)
      console.warn(`[cron run-whatsapp-broadcasts] drip ${row.id} (${row.name}) failed: ${msg}`)
      stats.errors.push({ broadcast_id: row.id, error: msg })
    }
  }

  await stampHeartbeat('run-whatsapp-broadcasts')
  return NextResponse.json({ success: true, stats })
}
