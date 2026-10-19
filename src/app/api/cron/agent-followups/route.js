import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { runAgentFollowups, runFirstClassCheckins } from '@/lib/agent/followups'
import { runHandoffSlaSweep, runHandoffAutoResolve } from '@/lib/agent/handoff-sla'
import { runApprovalsSlaSweep } from '@/lib/agent/approvals-sla'
import { rollupCheckinDay } from '@/lib/agent/checkin-day-rollup'
import { runTrialDoneOutreach } from '@/lib/agent/trial-done-runner'
import { TRIAL_DONE_HEARTBEAT, trialDoneArmHealthy } from '@/lib/cron-arm-health'
import { dayStrIn, PLATFORM_TZ } from '@/lib/location-time'
import { logError, logWarn } from '@/lib/log'

// AGENT-FOLLOWUP.1 — every 15 min (vercel.json): run Mia's proactive
// follow-up ladder for every location that enabled it. Stage 1 =
// in-window contextual nudge; stage 2 = one approved marketing
// template outside the window. Default OFF per location
// (settings.customer_agent.followups.enabled). Daytime on each studio's own
// clock only (09:00-19:59 in its locations.timezone, TZ.5): outside it the
// run is a cheap no-op for that studio (heartbeat still stamps).
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  let results = null
  let checkins = null
  try {
    results = await runAgentFollowups(db)
  } catch (e) {
    console.error('[radar-agent] followups tick failed:', e?.message || e)
    return NextResponse.json({ success: false, error: e?.message || 'tick failed' }, { status: 500 })
  }
  // AGENT-CHECKIN.1 — same tick, independent failure domain.
  try {
    checkins = await runFirstClassCheckins(db)
  } catch (e) {
    console.error('[radar-agent] checkins tick failed:', e?.message || e)
  }
  // TRIALDONE.4 — same tick, independent failure domain: the trial-done
  // opener at un1t.online studios that switched it on (default off).
  let trialDone = null
  try {
    trialDone = await runTrialDoneOutreach(db)
  } catch (e) {
    logError('cron-agent-followups', 'trial-done tick failed', { err: e })
  }
  // TRIALDONE.7 — the arm's OWN row, 'trial-done-outreach' (mig 757): stamped
  // only when it returned an outcome with no fault of its own
  // (cron-arm-health.js trialDoneArmHealthy), right here so no later arm can
  // cost it its stamp, under its own catch. A tick with nothing to send stamps.
  if (trialDoneArmHealthy(trialDone)) {
    await stampHeartbeat(TRIAL_DONE_HEARTBEAT, trialDone).catch((err) =>
      logWarn('cron-agent-followups', 'trial-done-outreach heartbeat failed', { err }))
  }
  // AGENT-HANDOFF-SLA.1 — same tick, independent failure domain: re-alert
  // managers about handed-off threads no human has picked up.
  let handoffSla = null
  try {
    handoffSla = await runHandoffSlaSweep(db)
  } catch (e) {
    console.error('[radar-agent] handoff-sla tick failed:', e?.message || e)
  }
  // MIA-BOARD.1 — same tick, independent failure domain: hand parked
  // handed-off threads back to Mia once the human engagement is over
  // (replied + quiet) or the thread is simply stale. The manual Resolve
  // this replaces was used exactly zero times in the feature's lifetime.
  let autoResolve = null
  try {
    autoResolve = await runHandoffAutoResolve(db)
  } catch (e) {
    console.error('[radar-agent] auto-resolve tick failed:', e?.message || e)
  }
  // MIA-BOARD.2 — same tick, independent failure domain: the approvals clock.
  // Re-escalate pending rows nobody decided in 24h; expire a booking whose
  // class already started (the Ciaran incident, 23 Aug).
  let approvalsSla = null
  try {
    approvalsSla = await runApprovalsSlaSweep(db)
  } catch (e) {
    console.error('[radar-agent] approvals-sla tick failed:', e?.message || e)
  }

  // Persist the tick summary on the heartbeat (last_outcome jsonb) — the
  // customer-agent settings card reads it to show WHY check-ins were
  // skipped, so a silent tick is diagnosable without server logs.
  // CHECKINSTALL.1 — `checkins` is only THIS tick and reads quiet_hours all
  // night, so a whole day of skips vanished (C98). Fold the tick into a
  // per-Dublin-day rollup carried on the same row. The previous row is READ
  // first; a failed read restarts the day flagged carry_failed, never a zero.
  // A failed read never stops the stamp: the heartbeat still says we ran.
  let prevDay = null
  let carryFailed = false
  try {
    const { data: hb, error: hbError } = await db.from('cron_heartbeats')
      .select('last_outcome')
      .eq('name', 'agent-followups')
      .maybeSingle()
    if (hbError) throw hbError
    prevDay = hb?.last_outcome?.checkins_day ?? null
  } catch (e) {
    carryFailed = true
    logError('cron-agent-followups', 'checkins_day read failed; today restarts flagged carry_failed', { err: e })
  }
  // TZ.18b — the check-in rollup is ONE platform-wide heartbeat row across every
  // studio, so its day key is the platform calendar's (PLATFORM_TZ, D4), not a studio's.
  const checkinsDay = rollupCheckinDay(prevDay, checkins, { day: dayStrIn(Date.now(), PLATFORM_TZ), carryFailed })
  await stampHeartbeat('agent-followups', { followups: results, checkins, checkins_day: checkinsDay, trial_done: trialDone, handoffSla, autoResolve, approvalsSla })
  return NextResponse.json({ success: true, results, checkins, trial_done: trialDone, handoffSla, autoResolve, approvalsSla })
}
