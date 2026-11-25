import { defineCron } from '@/lib/define-cron'
import { runAgentFollowups, runFirstClassCheckins } from '@/lib/agent/followups'
import { runStaffThreadNudges } from '@/lib/agent/staff-nudges'
import { runHandoffSlaSweep, runHandoffAutoResolve } from '@/lib/agent/handoff-sla'
import { runApprovalsSlaSweep } from '@/lib/agent/approvals-sla'
import { rollupCheckinDay } from '@/lib/agent/checkin-day-rollup'
import { runTrialDoneOutreach } from '@/lib/agent/trial-done-runner'
import { TRIAL_DONE_HEARTBEAT, trialDoneArmHealthy } from '@/lib/cron-arm-health'
import { dayStrIn, PLATFORM_TZ } from '@/lib/location-time'
import { logError } from '@/lib/log'

// AGENT-FOLLOWUP.1 — every 15 min (vercel.json): run Mia's proactive
// follow-up ladder for every location that enabled it. Stage 1 =
// in-window contextual nudge; stage 2 = one approved marketing
// template outside the window. Default OFF per location
// (settings.customer_agent.followups.enabled). Daytime on each studio's own
// clock only (09:00-19:59 in its locations.timezone, TZ.5): outside it the
// run is a cheap no-op for that studio (heartbeat still stamps).
//
// ROUTEWRAP.C9 — on defineCron (src/lib/define-cron.js), which owns the
// fail-closed secret check (CRONSTAMP.1), with the same stamps as before: a
// follow-ups tick that throws answers 500 and stamps nothing; every other tick
// stamps 'agent-followups', an arm failure included (ok: false + stamp: true,
// still answered 200). The trial-done arm's own row goes in `arms` whenever it
// ran clean, even if a later step then throws.
export const maxDuration = 300

export const GET = defineCron({ heartbeat: 'agent-followups' }, async ({ db }) => {
  let results = null
  let checkins = null
  // CRONSTAMP.1 (audit 2026-11-15, item 12): the safety-net arms below
  // (handoff SLA, auto-resolve, approvals SLA) used to fail with a free-text
  // console line while the heartbeat stamped as if all was well. Each failure
  // is now a structured error and is named on the heartbeat's last_outcome
  // (arm_errors), which the customer-agent settings card already reads. The
  // stamp itself still goes: it carries the check-in day rollup.
  const armErrors = []
  try {
    results = await runAgentFollowups(db)
  } catch (e) {
    logError('cron-agent-followups', 'followups tick failed; not stamping', { err: e })
    return { ok: false, status: 500, body: { error: 'Follow-ups tick failed' } }
  }
  // AGENT-CHECKIN.1 — same tick, independent failure domain.
  try {
    checkins = await runFirstClassCheckins(db)
  } catch (e) {
    armErrors.push('checkins')
    logError('cron-agent-followups', 'checkins arm failed', { err: e })
  }
  // INBOXFOLLOW.3 — same tick, independent failure domain: the one nudge Mia may
  // send on a thread a coach took over (off per studio until staff_threads.nudge_enabled).
  let staffNudges = null
  try {
    staffNudges = await runStaffThreadNudges(db)
  } catch (e) {
    armErrors.push('staff_nudges')
    logError('cron-agent-followups', 'staff-thread nudges arm failed', { err: e })
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
  // (cron-arm-health.js trialDoneArmHealthy). Decided right here and handed to
  // defineCron on every path below, so no later arm can cost it its stamp;
  // defineCron stamps it under its own catch. A tick with nothing to send stamps.
  const arms = trialDoneArmHealthy(trialDone) ? [{ heartbeat: TRIAL_DONE_HEARTBEAT, outcome: trialDone }] : []
  try {
    return { ...(await runLaterArms(db, { results, checkins, staffNudges, trialDone, armErrors })), arms }
  } catch (err) {
    // A later step that throws answers 500 and stamps no 'agent-followups'
    // (as before); the trial-done arm keeps its stamp.
    logError('cron-agent-followups', 'tick failed after the trial-done arm', { err })
    return { ok: false, status: 500, body: { error: 'Follow-ups tick failed' }, arms }
  }
})

/** The SLA arms, the check-in day rollup and the tick's own result. */
async function runLaterArms(db, { results, checkins, staffNudges, trialDone, armErrors }) {
  // AGENT-HANDOFF-SLA.1 — same tick, independent failure domain: re-alert
  // managers about handed-off threads no human has picked up.
  let handoffSla = null
  try {
    handoffSla = await runHandoffSlaSweep(db)
  } catch (e) {
    armErrors.push('handoff_sla')
    logError('cron-agent-followups', 'handoff SLA arm failed: handed-off threads are not being re-escalated', { err: e })
  }
  // MIA-BOARD.1 — same tick, independent failure domain: hand parked
  // handed-off threads back to Mia once the human engagement is over
  // (replied + quiet) or the thread is simply stale. The manual Resolve
  // this replaces was used exactly zero times in the feature's lifetime.
  let autoResolve = null
  try {
    autoResolve = await runHandoffAutoResolve(db)
  } catch (e) {
    armErrors.push('auto_resolve')
    logError('cron-agent-followups', 'auto-resolve arm failed', { err: e })
  }
  // MIA-BOARD.2 — same tick, independent failure domain: the approvals clock.
  // Re-escalate pending rows nobody decided in 24h; expire a booking whose
  // class already started (the Ciaran incident, 23 Aug).
  let approvalsSla = null
  try {
    approvalsSla = await runApprovalsSlaSweep(db)
  } catch (e) {
    armErrors.push('approvals_sla')
    logError('cron-agent-followups', 'approvals SLA arm failed: pending approvals are not being re-escalated', { err: e })
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
  const failures = armErrors.length ? { arm_errors: armErrors } : {}
  // An arm that failed is a failed tick (success: false) whose stamp is still
  // recorded, answered 200, as before: it carries the check-in day rollup.
  return {
    ok: armErrors.length === 0,
    stamp: true,
    status: 200,
    outcome: { followups: results, checkins, staff_nudges: staffNudges, checkins_day: checkinsDay, trial_done: trialDone, handoffSla, autoResolve, approvalsSla, ...failures },
    body: { results, checkins, staff_nudges: staffNudges, trial_done: trialDone, handoffSla, autoResolve, approvalsSla, ...failures },
  }
}
