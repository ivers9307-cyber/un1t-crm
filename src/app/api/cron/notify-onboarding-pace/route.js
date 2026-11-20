// PULSE-90.3 — Vercel cron, daily ~10:30 UTC (offset from the streak 11:00 /
// winback 10:00 crons so the three engagement pushes don't stack).
// TZ.6 — the schedule is hourly (30 * * * *); each location acts at its daily
// slot: 10:30 UTC for a Europe/Dublin studio (as before), 10:30 local for any
// other zone, at most once per local day (src/lib/cron-daily-slot.js).
//
// Pushes a purely motivational first-90-days pace nudge to new members who are
// falling off the 9-classes-in-6-weeks track. Selection is compute-on-read via
// loadJourneyLane (onboarding-journey-data.js) per Glofox-connected location:
// keep only journeys with status 'behind' or 'at_risk' that ALSO have a
// registered champ push token (a token = opted in). Idempotent at most once per
// member per journey week via customer_engagement_nudges
// (type='onboarding_pace', dedup_key '<contact_id>:wk<weekIndex>') — the nudge
// insert is the claim-before-send.
//
// C21 PUSHDONE.1b — through sendNudgeOnce: a nudge that reached nobody because
// something broke gives its claim back, so the next daily run (same journey
// week key) tries again. It used to keep the claim and lose the week's nudge.
//
// HARD CONSTRAINT (pulse-scope-no-booking): the push copy from
// buildOnboardingPacePush is motivational only — never any booking language.
// Pulse never books, pauses or cancels.
//
// defineCron owns the CRON_SECRET check, the error boundary and the stamp. The
// answer keeps its own `ok` field beside the wrapper's `success`. A quiet tick
// answers ok with `stamp: false`; a failed gate or seam read answers 500
// unstamped (fixed text; the detail is logged). A slot tick stamps with its
// counts unless the gate faulted, or every location it paced failed to load
// its lane (then nothing was paced: 500, no stamp).
import { defineCron } from '@/lib/define-cron'
import { sendNudgeOnce, readReachableContacts, nudgeFailed } from '@/lib/customer-nudge-claim'
import { loadJourneyLane } from '@/lib/onboarding-journey-data'
import { buildOnboardingPacePush } from '@/lib/onboarding-journey'
import { logError, logInfo, logWarn } from '@/lib/log'
import { locationsWithSource, skippedSummary } from '@/lib/membership/locations-for-source'
import { gateDailySlot, slotFor } from '@/lib/cron-daily-slot'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Only these two states are coach-actionable AND worth a member nudge:
// on_track needs no push, expired can't be fixed, completed is done.
const NUDGE_STATUSES = new Set(['behind', 'at_risk'])

/**
 * Pure selection: from a loadJourneyLane lane and the set of contactIds with a
 * registered push token, pick the rows to nudge — status in {behind, at_risk}
 * AND reachable. Kept pure (no I/O) so it's unit-testable and so the send loop
 * below reads as a straight iteration. Exported for the route test.
 *
 * @param {Array<{contactId: string, status: string}>} lane  loadJourneyLane().lane
 * @param {Set<string>} reachable  contactIds with a champ_push_token
 * @returns {Array<object>} the lane rows to nudge, in lane (worst-first) order
 */
export function selectPaceNudgeRows(lane, reachable) {
  return (lane || []).filter(
    (row) => NUDGE_STATUSES.has(row?.status) && reachable.has(row?.contactId)
  )
}

export async function POST(request) { return GET(request) }

export const GET = defineCron({ heartbeat: 'notify-onboarding-pace' }, async ({ db }) => {
  const nowMs = Date.now()

  // TZ.6 — which locations are at their daily slot this tick (claimed, so
  // never twice in one local day). An unreadable zone acts for nobody.
  const gate = await gateDailySlot(db, 'notify-onboarding-pace', { nowMs, module: 'cron-onboarding-pace' })
  if (!gate.ok) return { ok: false, body: { ok: false, slot: gate.summary } }
  if (gate.slots.size === 0) {
    // TZ.6: a quiet tick (no slot taken) never stamps, so the row keeps the legacy
    // clock; a faulted one (a claim write failed) answers 500 and the slot pages.
    return { ok: !gate.faulted, stamp: false, body: { ok: !gate.faulted, slot: gate.summary, locations: 0, candidates: 0, nudged: 0 } }
  }

  // Live locations = Glofox-connected (attendance data only exists there); same
  // discovery sync-class-occurrences uses. W1.M3b: through the membership seam
  // (membership_source = 'glofox' and configured), never the settings slice. A
  // location with no membership source has no class_bookings to pace against.
  // A failed seam read is a 500 with no heartbeat.
  const { eligible: liveLocations, skipped, error: locErr } = await locationsWithSource(db, 'glofox', { module: 'cron-onboarding-pace' })
  if (locErr) {
    logError('cron-onboarding-pace', 'membership seam read failed', { err: locErr })
    return { ok: false, body: { ok: false, error: 'Could not list locations' } }
  }

  let candidates = 0
  let nudged = 0
  let failed = 0
  let reachabilityFailed = 0
  let paced = 0
  let laneFailed = 0

  for (const loc of liveLocations) {
    if (!slotFor(gate.slots, loc.id)) continue // TZ.6: not this location's slot
    paced++
    let lane
    try {
      const res = await loadJourneyLane(db, loc.id, nowMs)
      lane = res.lane
    } catch (err) {
      laneFailed++
      logWarn('cron-onboarding-pace', 'lane load failed', { err, locationId: loc.id })
      continue
    }

    // Reachable = has a registered push token. Filter BEFORE the dedup insert so
    // we never burn a dedup claim on an unreachable member (mirrors
    // send-class-booking-reminders).
    const actionable = (lane || []).filter((row) => NUDGE_STATUSES.has(row?.status))
    if (actionable.length === 0) continue
    const reach = await readReachableContacts(db, actionable.map((r) => r.contactId), 'cron-onboarding-pace')
    const reachable = reach.reachable
    reachabilityFailed += reach.failed

    const toNudge = selectPaceNudgeRows(lane, reachable)
    candidates += toNudge.length

    for (const row of toNudge) {
      try {
        // Claim-before-send: the nudge insert is the at-most-once dedup — max
        // one pace nudge per member per journey week; released if it failed.
        const { status } = await sendNudgeOnce(db, {
          contactId: row.contactId, type: 'onboarding_pace', dedupKey: `${row.contactId}:wk${row.weekIndex}`,
          payload: buildOnboardingPacePush(row), module: 'cron-onboarding-pace',
        })
        if (status === 'sent') nudged++
        else if (nudgeFailed(status)) failed++
      } catch (err) {
        failed++
        logWarn('cron-onboarding-pace', 'nudge failed', { err, contactId: row.contactId })
      }
    }
  }

  // The skip split rides on the stamp's last_outcome, so an `unknown` location
  // (credentials unreadable at discovery) never reads as a healthy quiet tick.
  const skipCounts = skippedSummary(skipped)
  logInfo('cron-onboarding-pace', 'tick', {
    locations: liveLocations.length, locations_skipped: skipped.length, ...skipCounts, candidates, nudged, failed, reachability_failed: reachabilityFailed,
  })
  const counts = { candidates, nudged, failed, reachability_failed: reachabilityFailed }
  const body = { locations: liveLocations.length, locations_skipped: skipped.length, ...skipCounts, ...counts }
  // Every location at its slot failed to load its lane: nobody was paced.
  if (paced > 0 && laneFailed === paced) {
    return { ok: false, body: { ok: false, error: 'Every location failed', ...body } }
  }
  // A slot tick stamps unless the gate faulted (a claim write failed).
  const ok = !gate.faulted
  return { ok, outcome: { locations: liveLocations.length, ...skipCounts, ...counts }, body: { ok, ...body } }
})
