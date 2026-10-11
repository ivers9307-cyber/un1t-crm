// CONTRACTS-REMIND.1 — Vercel cron, daily. Nudges contracts stuck at
// 'issued'/'viewed' with no signature: a reminder email + push at 3 days
// (1st) and 7 days (2nd, final) since issued_at, capped at 2 total. Mirrors
// the issue-time notification in POST /api/contracts (same email shell via
// contracts-email.js, same push shape via src/lib/push.js). PUSHDONE.1a: the
// 2nd also waits 4 days after the RECORDED 1st (last_reminded_at), so a 1st
// held back by retries is not followed by the 2nd the next day.
//
// Registration: mirrors the newest existing cron (expand-hyrox-weeks, mig
// 441 / HYROX-TC.3) — a plain vercel.json schedule entry with a Bearer
// CRON_SECRET guard, no QStash involved. QStash in this repo is reserved
// for queue-drain push acceleration (a queue TABLE gets a row, QStash
// pushes a worker to drain it immediately, with the cron as the delivery
// fallback — see src/lib/qstash.js); this cron has no backing queue table,
// it just polls `contracts` on a schedule like the majority of crons
// (glofox-arrears-reconcile, churn-radar-snapshot, notify-winback, etc.).
//
// The exact "is this due" predicate lives in reminderDue() (src/lib/
// contracts.js) so it's independently unit-tested. The SQL filters below
// are a coarse pre-filter only (status + not-yet-capped) — reminderDue()
// is still applied per-row as the authoritative client-side guard.
//
// RUNWAY.1 — also runs the daily roster-runway push (second arm, top of GET).
// HEARTBEAT.1 — that arm stamps its own heartbeat row, 'roster-runway' (mig
// 633), only when it ran clean; 'contract-reminders' is unchanged.
// QUALS.1 — also runs the weekly qualification digest (third arm), with its
// own heartbeat row 'qualification-digest' (mig 635).
//
// TZ.6 — the schedule is hourly. The contract half acts for each contract's
// location at its daily slot: 08:00 UTC for a Europe/Dublin studio (as before),
// 08:00 local for any other zone, at most once per local day
// (src/lib/cron-daily-slot.js).
//
// TZ follow-up (Richard, card 11 Oct: "08:00 local, Dublin unchanged") — the
// two arms have daily slots of their OWN, DAILY_SLOTS['roster-runway'] and
// DAILY_SLOTS['qualification-digest'] (rides: 'contract-reminders'), claimed
// independently of the contract half and of each other. The runway acts for
// each studio at that studio's slot; the digest for each organisation at its
// anchor studio's slot (the lowest id, qualification-digest.js
// digestAnchorsByOrg). A Europe/Dublin studio keeps the legacy 08:00 UTC
// instant with no catch-up, so UN1T is byte-identical: a failed or skipped
// slot pages (the arm's row goes stale), it is never sent late or twice. Each
// arm's heartbeat row stamps only on a tick that took one of ITS slots with no
// fault (slotTickStampable) and a clean arm outcome; the 'none' scope is due
// at 08:00 UTC, so both rows keep their daily clock.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { reminderDue } from '@/lib/contracts'
import { sendContractReminderEmail } from '@/lib/contracts-email'
import { sendPush } from '@/lib/push'
import { pushOutcome } from '@/lib/push-outcome'
import { logWarn, logError } from '@/lib/log'
import { gateDailySlot, slotFor, slotTickStampable } from '@/lib/cron-daily-slot'
import { runRosterRunwayAlerts } from '@/lib/roster-runway-notify'
import { runQualificationDigest } from '@/lib/qualification-digest'
import {
  ROSTER_RUNWAY_HEARTBEAT, runwayArmHealthy,
  QUALIFICATION_DIGEST_HEARTBEAT, qualificationDigestArmHealthy,
} from '@/lib/cron-arm-health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PAGE = 1000
const MAX_REMINDERS = 2
const MODULE = 'cron-contract-reminders'

/**
 * One arm on its own daily slot. Gate (claim this tick's due studios under the
 * arm's OWN slot key), run the arm for those studios only, then stamp the
 * arm's OWN heartbeat row, under its own .catch, only when the tick took a
 * slot with no gate fault AND the arm returned a clean outcome. Never throws.
 *
 * @returns {Promise<{ outcome: object, failed: 0|1, faulted: boolean }>}
 *   outcome: the arm's own, or { skipped } (no slot due: a quiet hourly tick),
 *   or { error } (the arm threw, or the gate could not read the zones).
 *   failed: 1 when the arm threw or its gate faulted (claim write or zone read).
 *   faulted: the gate faulted (the response answers 500, as every gated cron).
 */
async function runArmOnSlot(db, nowMs, { slotName, run, healthy, heartbeat, label, failMessage }) {
  const gate = await gateDailySlot(db, slotName, { nowMs, module: MODULE })
  if (!gate.ok) {
    return { outcome: { error: `${label}: studio zones unreadable, no studio acts this tick`, slot: gate.summary }, failed: 1, faulted: true }
  }
  if (gate.slots.size === 0) {
    // Nothing claimed: a quiet hourly tick (or a claim write that failed for
    // every due studio, which gate.faulted reports). Not a run: no stamp.
    return { outcome: { skipped: 'no studio at its daily slot', slot: gate.summary }, failed: gate.faulted ? 1 : 0, faulted: gate.faulted }
  }
  let outcome
  let failed = gate.faulted ? 1 : 0
  try {
    outcome = await run(db, { nowMs, isDue: (locationId) => !!slotFor(gate.slots, locationId) })
  } catch (err) {
    failed = 1
    logError(MODULE, `${label} arm threw`, { err })
    outcome = { error: err?.message || failMessage }
  }
  // Stamped HERE, before the contract half, so a contract crash (which
  // answers nothing and stamps nothing, as always) cannot cost a clean arm
  // its stamp; its own catch, so the stamp can never cost the contract half
  // anything. Only a tick that took one of this arm's slots with no gate
  // fault (slotTickStampable), and an outcome that is not a throw or an
  // { error } (src/lib/cron-arm-health.js): a day with nothing to say stamps.
  if (slotTickStampable(gate) && failed === 0 && healthy(outcome)) {
    await stampHeartbeat(heartbeat, outcome).catch((err) =>
      logWarn(MODULE, `${heartbeat} heartbeat failed`, { err }))
  }
  return { outcome, failed, faulted: gate.faulted }
}

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const now = new Date()
  const nowMs = now.getTime()

  // RUNWAY.1 — first arm: the daily roster-runway push (one per location per
  // week per severity; src/lib/roster-runway-notify.js), at each studio's own
  // 08:00 slot. It rides this cron because both are once-a-day staff nudges;
  // the roster cron (extend-roster-horizon) runs at 03:20 UTC, not a civil
  // hour. (The arm also refuses to send outside 07:00-22:00 studio time on
  // its own, so moving this cron cannot push at night.)
  //
  // Isolated BOTH ways. It runs FIRST, so nothing the contract half does can
  // cost it its run; and it is wrapped, so its own failure is logged, rides in
  // last_outcome.runway, is counted in runway_arm_failed, and never costs the
  // contract reminders their run or their heartbeat (the same partial-failure
  // posture as extend-roster-horizon). HEARTBEAT.1: its OWN row,
  // 'roster-runway' (mig 633); runway_arm_failed rides in the
  // contract-reminders row's last_outcome, which the health-check never reads,
  // so the arm's row goes STALE instead.
  const runwayArm = await runArmOnSlot(db, nowMs, {
    slotName: 'roster-runway', run: runRosterRunwayAlerts, healthy: runwayArmHealthy,
    heartbeat: ROSTER_RUNWAY_HEARTBEAT, label: 'roster runway', failMessage: 'runway arm failed',
  })
  const runway = runwayArm.outcome
  const runwayArmFailed = runwayArm.failed

  // QUALS.1 — second arm: the weekly qualification digest to owners
  // (src/lib/qualification-digest.js), at each organisation's anchor studio's
  // 08:00 slot. Each owner hears at most once per (the organisation's) week,
  // on the first run with something expired or expiring (a week stamp in
  // push_event_sends, written AFTER the send), inside 07:00-22:00 studio
  // time. Isolated both ways, like the runway arm, with its own heartbeat row
  // ('qualification-digest', mig 635).
  const qualificationArm = await runArmOnSlot(db, nowMs, {
    slotName: 'qualification-digest', run: runQualificationDigest, healthy: qualificationDigestArmHealthy,
    heartbeat: QUALIFICATION_DIGEST_HEARTBEAT, label: 'qualification digest', failMessage: 'qualification digest arm failed',
  })
  const qualifications = qualificationArm.outcome
  const qualificationArmFailed = qualificationArm.failed
  const armsFaulted = runwayArm.faulted || qualificationArm.faulted

  // TZ.6 — which locations are at their daily slot this tick (claimed, so
  // never twice in one local day). An unreadable zone acts for nobody; a tick
  // with no slot due reads no contracts.
  const gate = await gateDailySlot(db, 'contract-reminders', { nowMs, module: MODULE })
  if (!gate.ok) {
    return NextResponse.json({ success: false, slot: gate.summary, runway, qualifications }, { status: 500 })
  }

  // Candidate contracts — status in ('issued','viewed') and not yet at the
  // reminder cap. Paginated with an explicit .order() (1k-row cap
  // invariant): a busy org could plausibly exceed 1000 open contracts.
  const candidates = []
  for (let from = 0; gate.slots.size > 0; from += PAGE) {
    const { data, error } = await db
      .from('contracts')
      .select(`
        id, status, issued_at, reminder_count, last_reminded_at, location_id, profile_id,
        profile:profiles!profile_id (id, full_name, email),
        template:contract_templates!template_id (name)
      `)
      .in('status', ['issued', 'viewed'])
      .lt('reminder_count', MAX_REMINDERS)
      .order('issued_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      console.error('[cron-contract-reminders] candidate query failed', error)
      break
    }
    candidates.push(...(data || []))
    if (!data || data.length < PAGE) break
  }

  let sent = 0
  let emailFailed = 0
  let rowErrors = 0
  let undelivered = 0

  for (const contract of candidates) {
    if (!slotFor(gate.slots, contract.location_id)) continue // TZ.6: not this location's slot
    if (!reminderDue(contract, now)) continue

    try {
      const recipient = contract.profile
      const templateName = contract.template?.name

      const emailResult = await sendContractReminderEmail({
        contract,
        recipient: { full_name: recipient?.full_name, email: recipient?.email },
        templateName,
      })
      if (!emailResult.ok) emailFailed++

      // Push notification (best effort, never blocks) — mirrors the
      // issue-route's push block: category 'contract_issued', deep link
      // /contracts/<id>.
      let push = 'settled'
      try {
        if (recipient?.id) {
          push = pushOutcome(await sendPush([recipient.id], {
            title: 'Contract awaiting signature',
            body: templateName
              ? `Reminder: "${templateName}" is still awaiting your signature. Tap to review and sign.`
              : 'Reminder: a contract is still awaiting your signature. Tap to review and sign.',
            category: 'contract_issued',
            data: {
              type: 'contract_issued',
              contract_id: contract.id,
              path: `/contracts/${contract.id}`,
            },
          }))
        }
      } catch (err) {
        push = 'failed'
        logWarn('cron-contract-reminders', 'reminder push threw', { contract_id: contract.id, err: err?.message || String(err) })
      }

      // C21 PUSHDONE.1 — the stamp is the cadence ("reminder N went out").
      // It used to be written whatever happened, so a Postmark blip plus a
      // push failure recorded a reminder nobody received, and the second one
      // came four days later as if the first had landed. Hold it back only
      // when NOTHING reached them and something transient broke: tomorrow's
      // run (daily) sends it again, and it cannot duplicate what never went
      // out. Email delivered → recorded, whatever the push did (retrying
      // would repeat the email). No address (or a hard-bounced one, Postmark
      // 406/300 — PUSHDONE.1a) and no device → recorded: nothing to retry
      // against, and the contract still stops at the normal 2 reminders.
      const reached = emailResult.ok || push === 'delivered'
      const transient = (!emailResult.ok && !emailResult.permanent) || push === 'failed'
      if (!reached && transient) {
        undelivered++
        logWarn('cron-contract-reminders', 'reminder reached nobody; not recorded, tomorrow retries', {
          contract_id: contract.id, email_error: emailResult.error ?? null, push,
        })
        continue
      }

      const { error: updErr } = await db
        .from('contracts')
        .update({
          last_reminded_at: now.toISOString(),
          reminder_count: (contract.reminder_count || 0) + 1,
        })
        .eq('id', contract.id)
      if (updErr) {
        console.error('[cron-contract-reminders] failed to record reminder', contract.id, updErr)
        rowErrors++
        continue
      }

      sent++
    } catch (err) {
      // Row-level failure — log and move on, never abort the batch.
      console.error('[cron-contract-reminders] row failed', contract.id, err)
      rowErrors++
    }
  }

  const outcome = {
    checked: candidates.length, sent, emailFailed, rowErrors, undelivered,
    runway, runway_arm_failed: runwayArmFailed,
    qualifications, qualification_arm_failed: qualificationArmFailed,
  }
  // TZ.6: only a tick that took a slot, with no gate fault, stamps the row (it
  // keeps the legacy daily clock); a quiet hourly tick never does.
  if (slotTickStampable(gate)) {
    await stampHeartbeat('contract-reminders', outcome).catch((err) =>
      logWarn('cron-contract-reminders', 'heartbeat failed', { err }))
  }

  // A gate fault, the contract half's or an arm's, answers 500 (every gated
  // cron does). It costs no other half its run or its stamp.
  const faulted = gate.faulted || armsFaulted
  return NextResponse.json({ success: !faulted, ...outcome }, { status: faulted ? 500 : 200 })
}
