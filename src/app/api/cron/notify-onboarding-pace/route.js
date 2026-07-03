// PULSE-90.3 — Vercel cron, daily ~10:30 UTC (offset from the streak 11:00 /
// winback 10:00 crons so the three engagement pushes don't stack).
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
// HARD CONSTRAINT (pulse-scope-no-booking): the push copy from
// buildOnboardingPacePush is motivational only — never any booking language.
// Pulse never books, pauses or cancels.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendCustomerPush } from '@/lib/customer-push'
import { loadJourneyLane } from '@/lib/onboarding-journey-data'
import { buildOnboardingPacePush } from '@/lib/onboarding-journey'
import { logInfo, logWarn } from '@/lib/log'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

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

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  const db = createServerClient()
  const nowMs = Date.now()

  // Live locations = Glofox-connected (attendance data only exists there); same
  // filter sync-class-occurrences uses. A location with no Glofox creds has no
  // class_bookings to pace against.
  const { data: locs, error: locErr } = await db
    .from('locations')
    .select('id, settings')
    .filter('settings', 'cs', JSON.stringify({ glofox: {} }))
  if (locErr) {
    return NextResponse.json({ ok: false, error: locErr.message }, { status: 500 })
  }
  const liveLocations = (locs || []).filter((l) => {
    const g = l.settings?.glofox || {}
    return g.branch_id && g.api_key && g.api_token
  })

  let candidates = 0
  let nudged = 0
  let failed = 0

  for (const loc of liveLocations) {
    let lane
    try {
      const res = await loadJourneyLane(db, loc.id, nowMs)
      lane = res.lane
    } catch (err) {
      logWarn('cron-onboarding-pace', 'lane load failed', { err, locationId: loc.id })
      continue
    }

    // Reachable = has a registered push token. Filter BEFORE the dedup insert so
    // we never burn a dedup claim on an unreachable member (mirrors
    // send-class-booking-reminders).
    const actionable = (lane || []).filter((row) => NUDGE_STATUSES.has(row?.status))
    if (actionable.length === 0) continue
    const reachable = new Set()
    const ids = [...new Set(actionable.map((r) => r.contactId))]
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200)
      const { data: toks } = await db
        .from('champ_push_tokens')
        .select('contact_id')
        .in('contact_id', chunk)
      for (const t of toks || []) reachable.add(t.contact_id)
    }

    const toNudge = selectPaceNudgeRows(lane, reachable)
    candidates += toNudge.length

    for (const row of toNudge) {
      try {
        // Claim-before-send: the nudge insert is the at-most-once dedup. A
        // unique-conflict (already nudged this journey week) returns no row and
        // we skip — max one pace nudge per member per week.
        const dedupKey = `${row.contactId}:wk${row.weekIndex}`
        const { data: ins, error: insErr } = await db
          .from('customer_engagement_nudges')
          .insert({ contact_id: row.contactId, type: 'onboarding_pace', dedup_key: dedupKey })
          .select('id')
        if (insErr || !ins || !ins.length) continue // already nudged this week, or error

        const payload = buildOnboardingPacePush(row)
        await sendCustomerPush(db, [row.contactId], payload)
        nudged++
      } catch (err) {
        failed++
        logWarn('cron-onboarding-pace', 'nudge failed', { err, contactId: row.contactId })
      }
    }
  }

  logInfo('cron-onboarding-pace', 'tick', {
    locations: liveLocations.length, candidates, nudged, failed,
  })
  await stampHeartbeat('notify-onboarding-pace').catch((err) =>
    logWarn('cron-onboarding-pace', 'heartbeat failed', { err }))
  return NextResponse.json({
    ok: true, locations: liveLocations.length, candidates, nudged, failed,
  })
}
