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
//       - drip  → C138 (b): flip to 'draft' and start it through
//         sendBroadcast, which runs a drip's start checks (template, URL
//         value, own number, quality, wallet) and CAS-flips draft→sending
//         without sending. A refusal stays a draft and pushes the managers
//         (as a blast's does); once started the drip machinery owns it (first
//         chunk goes out this tick if inside the send window).
//       - blast → flip to 'draft' and invoke sendBroadcast with a per-tick
//         recipient cap: sendBroadcast performs its own draft→sending CAS and
//         every refusal (quality gate, tier budget, breaker) lands the row
//         back at 'draft' — recoverable, never stranded. A refusal pushes a
//         manager notification so the missed schedule isn't silent.
//     - C127 LATEBLAST.1: a blast more than LATE_SCHEDULED_BLAST_HOURS (3)
//       late (in practice: it fell due while the studio's WhatsApp was off,
//       see C122 below) is NOT sent. The CAS flips it to 'draft' with
//       scheduled_at cleared and the managers get the same push as a refused
//       start, so they re-schedule. Drips are exempt (window-paced).
//  2. Blast RESUME: a scheduled blast bigger than one tick's cap was left at
//     'sending' with the remainder unclaimed — send the next chunk. Scoped to
//     scheduled_at IS NOT NULL so operator-fired blasts are untouched. The
//     per-recipient claim-first insert (mig 331) de-dupes any concurrent pass.
//     - C139 LATERESUME.1: if the last send (the newest recipient claim; with
//       none, scheduled_at) is more than LATE_SCHEDULED_BLAST_HOURS (3) old,
//       the rest is NOT sent late: CAS sending→draft with paused_at set and
//       scheduled_at cleared (the breaker's parked state; Send delivers only
//       the remainder) and the managers get the scheduled-send push. A failed
//       read sends nothing this tick.
//  3. In-flight DRIPS: unchanged — one chunk each, inside the send window.
//
// C122 WABROADCASTKILL.1 — every arm runs only at studios where the
// `whatsapp` FEATURE is on (tier 1 of resolvePermission, which refuses even
// masters: switching WhatsApp off at a studio used to leave its drip sending,
// with nobody able to open the page to pause it). The studios are read FIRST
// and each arm's query is filtered to them, so a skipped row is never
// touched (no status flip, no updated_at bump: it resumes on the first tick
// after the feature is back on; a due scheduled row then starts late, except a blast that is by then
// more than 3 hours late or a part-sent one whose last send is: C127, C139) and
// never takes a per-tick slot from another studio. The skipped rows are
// counted (`skipped_whatsapp_off`). An unreadable `locations` read sends
// NOTHING (fail closed: a 500, like the broadcast reads below), and a
// broadcast with no studio or at a studio missing from the read is skipped.
//
// Auth via Authorization: Bearer ${CRON_SECRET}.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendDripChunk, sendBroadcast } from '@/lib/whatsapp'
import { isWithinSendWindow } from '@/lib/whatsapp-drip'
import { promotionPlan, SCHEDULED_BLAST_MAX_PER_TICK, scheduledStartFailureNotification, LATE_SCHEDULED_BLAST_REASON, LATE_RESUME_REASON, resumeIsStale } from '@/lib/whatsapp-schedule'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { MANAGER_ROLES } from '@/lib/schemas'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logInfo, logWarn } from '@/lib/log'
import { whatsappEnabledLocationIds, notEnabledLocationFilter } from '@/lib/whatsapp-broadcast-feature-gate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // Pro ceiling

// Tell the studio's managers a scheduled broadcast did not go out (a refused
// start, or C127 a stale one). Best-effort: a failed push is logged, never
// thrown into the tick.
async function notifyScheduledStartFailure(row, reason, opts) {
  try {
    const notify = scheduledStartFailureNotification(row, reason, opts)
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

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const now = new Date()
  const nowIso = now.toISOString()

  // C122 — the studios where WhatsApp is on. `locations` is a handful of
  // rows (far under the 1,000-row cap); a studio past the cap would only be
  // skipped, never sent at wrongly.
  const locQ = await db.from('locations').select('id, features').order('id', { ascending: true })
  if (locQ.error) {
    logError('cron:run-whatsapp-broadcasts', 'locations read failed; no broadcast sent this tick (the WhatsApp feature flag is unreadable)', { code: locQ.error.code || null })
    return NextResponse.json({ success: false, error: 'Could not read the studios\' WhatsApp setting' }, { status: 500 })
  }
  const enabledIds = whatsappEnabledLocationIds(locQ.data)
  const skippedFilter = notEnabledLocationFilter(enabledIds)

  // Each arm's row filter, shared by its work query and its skipped count.
  const arms = {
    scheduled: (q) => q.eq('status', 'scheduled').lte('scheduled_at', nowIso),
    resume: (q) => q.eq('delivery_mode', 'blast').eq('status', 'sending')
      .not('scheduled_at', 'is', null).is('paused_at', null),
    drip: (q) => q.eq('delivery_mode', 'drip').eq('status', 'sending').is('paused_at', null),
  }
  const none = Promise.resolve({ data: [], error: null })
  const atEnabled = (q) => (enabledIds.length ? q.in('location_id', enabledIds) : null)
  const skippedCount = (arm) => {
    const q = arm(db.from('whatsapp_broadcasts').select('id', { count: 'exact', head: true }))
    return skippedFilter ? q.or(skippedFilter) : q
  }

  // All three arms' rows in parallel. The resume query runs alongside the
  // scheduled one, so a blast promoted THIS tick isn't double-picked here.
  const scheduledWork = atEnabled(arms.scheduled(db.from('whatsapp_broadcasts')
    .select('id, name, status, location_id, delivery_mode, scheduled_at, send_window_start, send_window_end, send_window_tz')))
  const resumeWork = atEnabled(arms.resume(db.from('whatsapp_broadcasts')
    .select('id, name, location_id, scheduled_at')))
  const dripWork = atEnabled(arms.drip(db.from('whatsapp_broadcasts')
    .select('id, name, location_id, send_window_start, send_window_end, send_window_tz')))
  const [scheduledQ, resumeQ, dripQ, ...skippedQs] = await Promise.all([
    scheduledWork ? scheduledWork.order('scheduled_at', { ascending: true }).limit(5) : none,
    resumeWork ? resumeWork.order('updated_at', { ascending: true }).limit(5) : none,
    dripWork ? dripWork.order('updated_at', { ascending: true }).limit(20) : none,
    skippedCount(arms.scheduled),
    skippedCount(arms.resume),
    skippedCount(arms.drip),
  ])
  for (const q of [scheduledQ, resumeQ, dripQ]) {
    if (q.error) return NextResponse.json({ success: false, error: q.error.message }, { status: 500 })
  }
  // The skipped count is reporting only: a failed count is logged and reads
  // null, it never stops the sends.
  const countFailed = skippedQs.find((q) => q.error)
  if (countFailed) {
    logWarn('cron:run-whatsapp-broadcasts', 'skipped-broadcast count failed', { code: countFailed.error.code || null })
  }
  const skippedWhatsappOff = countFailed ? null : skippedQs.reduce((n, q) => n + (q.count || 0), 0)
  if (skippedWhatsappOff) {
    logInfo('cron:run-whatsapp-broadcasts', 'broadcasts skipped at studios where WhatsApp is off', { skipped: skippedWhatsappOff })
  }

  const stats = {
    scheduled_found: scheduledQ.data.length, promoted: 0, refused: 0, returned_late: 0,
    resume_found: resumeQ.data.length, paused_late: 0,
    found: dripQ.data.length,
    sent: 0, failed: 0, finished: 0, in_progress: 0, outside_window: 0, errors: [],
    skipped_whatsapp_off: skippedWhatsappOff,
  }

  // ── 1. Promote due scheduled broadcasts ─────────────────────────────────
  for (const row of scheduledQ.data) {
    const plan = promotionPlan(row, now)
    if (!plan) continue
    // C138 (b) — true once the row is past its start (a blast's or a drip's
    // sendBroadcast returned): a later throw (a drip chunk) is not a refused
    // start and gets no push.
    let started = false
    try {
      // CAS the flip — a concurrent tick that already claimed it gets 0 rows.
      // C127 — a stale blast also loses its schedule: it is a plain draft now,
      // and the resume arm (scheduled_at IS NOT NULL) must never pick it up.
      const patch = plan.mode === 'stale' ? { status: plan.flipTo, scheduled_at: null } : { status: plan.flipTo }
      const { data: claimed, error: claimErr } = await db.from('whatsapp_broadcasts')
        .update(patch)
        .eq('id', row.id)
        .eq('status', 'scheduled')
        .select('id')
      // A failed flip is not a claim: the row stays 'scheduled' and the next
      // tick tries again (it was read as "someone else claimed it", silently).
      if (claimErr) {
        logWarn('cron:run-whatsapp-broadcasts', 'scheduled flip failed; retried next tick', { broadcastId: row.id, code: claimErr.code || null })
        stats.errors.push({ broadcast_id: row.id, error: `status flip failed: ${claimErr.message}` })
        continue
      }
      if (!claimed?.length) continue

      if (plan.mode === 'stale') {
        // C127 — returned, not sent; the managers re-schedule it.
        stats.returned_late++
        logWarn('cron:run-whatsapp-broadcasts', 'scheduled blast more than the late limit past due; returned to draft, not sent', { broadcastId: row.id })
        await notifyScheduledStartFailure(row, LATE_SCHEDULED_BLAST_REASON)
        continue
      }
      stats.promoted++

      if (plan.mode === 'drip') {
        // C138 (b) — the start checks, then draft→sending (nothing sent). A
        // refusal throws with the row at draft: the catch pushes the managers.
        const start = await sendBroadcast(row.id)
        started = true
        // Lost the CAS (someone started it in between): the drip arm owns it.
        if (start?.mode !== 'drip' || start?.skipped) continue
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
      // A refused START (quality gate / tier budget / wallet / template /
      // own number) threw out of sendBroadcast and left the row at 'draft'
      // (its own state machine guarantees that) — tell the managers, a
      // silently missed schedule is worse than the refusal itself. Since
      // C138 (b) that holds for a drip's start too. Best-effort push, never
      // re-throws. A drip whose first CHUNK errors after a good start is
      // already 'sending' and the next tick retries it, so no push (the
      // wording wouldn't fit and a transient error would page every 15 min).
      if (plan.mode === 'blast' || (plan.mode === 'drip' && !started)) await notifyScheduledStartFailure(row, msg)
    }
  }

  // ── 2. Resume chunked scheduled blasts ──────────────────────────────────
  for (const row of resumeQ.data) {
    // C139 — never resume stale. The last send is the newest recipient claim
    // (inserted right before each send); updated_at is no clock for it, the
    // delivery and read webhooks bump it. No claim yet → scheduled_at.
    const lastQ = await db.from('whatsapp_broadcast_recipients')
      .select('created_at')
      .eq('broadcast_id', row.id)
      .order('created_at', { ascending: false })
      .limit(1)
    if (lastQ.error) {
      logWarn('cron:run-whatsapp-broadcasts', 'last-send read failed; resume skipped this tick', { broadcastId: row.id, code: lastQ.error.code || null })
      stats.errors.push({ broadcast_id: row.id, error: `last-send read failed: ${lastQ.error.message}` })
      continue
    }
    const lastSendAt = lastQ.data?.[0]?.created_at ?? row.scheduled_at
    if (resumeIsStale(lastSendAt, now)) {
      const { data: parked, error: parkErr } = await db.from('whatsapp_broadcasts')
        .update({ status: 'draft', paused_at: nowIso, scheduled_at: null })
        .eq('id', row.id)
        .eq('status', 'sending')
        .is('paused_at', null)
        .select('id')
      if (parkErr) {
        logWarn('cron:run-whatsapp-broadcasts', 'stale resume park failed; retried next tick', { broadcastId: row.id, code: parkErr.code || null })
        stats.errors.push({ broadcast_id: row.id, error: `pause failed: ${parkErr.message}` })
        continue
      }
      if (!parked?.length) continue // someone else moved it (a Cancel, a pause)
      stats.paused_late++
      logWarn('cron:run-whatsapp-broadcasts', 'part-sent blast past the late limit; paused at draft, rest not sent', { broadcastId: row.id })
      await notifyScheduledStartFailure(row, LATE_RESUME_REASON, { partSent: true })
      continue
    }
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
