// Vercel cron — daily at 04:00 Dublin time.
//
// CHURN-PREP.1 / .2 — full member data refresh (attendance + plan).
//
// WHY THIS EXISTS
// ───────────────
// The glofox-sync cron is a DELTA sync: it only processes members
// whose Glofox record was modified in the last ~25h, and the
// booking aggregates (last_attended_at, total_bookings_30d,
// total_attended_7d/30d, total_noshow_30d) are only computed for
// the members it touches. So:
//   - a member not modified in Glofox recently NEVER gets their
//     attendance refreshed, and
//   - the rolling 7/30-day counts decay even for those who were.
// Net effect: attendance data is complete for only a fraction of
// the member base and goes stale — unusable as a churn signal.
//
// WHAT THIS DOES
// ──────────────
// Every day, for ALL paying members ('member' / 'credit_member'):
//   1. re-fetch bookings and recompute the six engagement columns,
//      so attendance data is complete and current, and
//   2. re-fetch the single-member payload and store the current
//      membership plan name (glofox_membership_plan) — the
//      /2.0/members LIST + /2.0/bookings payloads don't carry it,
//      so this is the only place the whole base gets it refreshed.
// Together these are the prerequisite for the churn-risk radar.
//
// Members are processed stalest-glofox_synced_at-first and the run
// is time-budgeted: if a run can't finish the whole base it stops
// cleanly and the next run resumes from the stalest remaining
// members. A transient Glofox error on a member leaves that
// member's existing aggregates / plan untouched (never wiped).
//
// Auth: same CRON_SECRET pattern as the other Vercel crons.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { glofoxCredentialsForLocation, fetchUserBookingsResult, fetchMemberResult } from '@/lib/glofox'
import { computeBookingAggregates, mergeBookingAggregates, trimRecentBookings, extractMembershipPlan, extractMembershipState, extractMemberProfile } from '@/lib/glofox-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Stop fetching once we're this close to the Vercel ceiling; the
// remaining members are picked up next run (stalest-first ordering
// guarantees the run always advances the freshness frontier).
const TIME_BUDGET_MS = 250_000

// Membership tiers that count as paying members — the churn radar's
// population. Drop-in tiers (classpass_payg) and prospects are out.
const MEMBER_STATUSES = ['member', 'credit_member']

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const startedAt = Date.now()
  const db = createServerClient()

  // Locations with Glofox configured — same discovery as glofox-sync.
  const { data: locations, error: locErr } = await db
    .from('locations')
    .select('id, name, settings')
    .filter('settings', 'cs', JSON.stringify({ glofox: {} }))
  if (locErr) {
    console.warn(`[cron][glofox-attendance-refresh] list locations failed: ${locErr.message}`)
    return NextResponse.json({ success: false, error: locErr.message }, { status: 500 })
  }
  const eligible = (locations || []).filter(loc => {
    const cfg = loc.settings?.glofox || {}
    return cfg.branch_id && cfg.api_key && cfg.api_token
  })

  const perLocation = []
  let budgetExhausted = false
  for (const loc of eligible) {
    if (budgetExhausted) break
    const res = await refreshLocation(db, loc, startedAt)
    perLocation.push(res)
    if (res.budget_exhausted) budgetExhausted = true
  }

  await stampHeartbeat('glofox-attendance-refresh')

  return NextResponse.json({
    success: true,
    locations_processed: perLocation.length,
    budget_exhausted: budgetExhausted,
    per_location: perLocation,
  })
}

/**
 * Refresh attendance aggregates for every paying member at one
 * location, stalest first, within the shared time budget.
 */
async function refreshLocation(db, location, startedAt) {
  const summary = { refreshed: 0, fetch_failed: 0, update_failed: 0, membership_failed: 0 }
  let budgetExhausted = false

  // Audit row up-front so a mid-run timeout still leaves a trace.
  const { data: runRow } = await db
    .from('glofox_sync_runs')
    .insert({
      location_id: location.id,
      filter_used: { attendance_refresh: true, statuses: MEMBER_STATUSES },
      status: 'running',
    })
    .select('id')
    .single()
  const runId = runRow?.id

  try {
    const creds = await glofoxCredentialsForLocation(db, location.id)
    if (!creds.branchId || !creds.apiKey || !creds.apiToken) {
      throw new Error('Glofox credentials missing on this location.')
    }

    // Stalest glofox_synced_at first so each run advances coverage.
    // Supabase caps a single response at ~1000 rows regardless of
    // .limit(), so page through with .range() — otherwise members
    // past the first 1000 are never seen in a run (the comment above
    // promises ALL paying members). `id` is the stable tiebreaker so
    // pagination doesn't skip/repeat rows that share glofox_synced_at.
    const members = []
    const PAGE = 1000
    for (let from = 0; ; from += PAGE) {
      const { data: page, error } = await db
        .from('contacts')
        // last_attended_at / last_booked_at are needed so the
        // advance-only merge below can compare against the stored
        // value and never regress it.
        .select('id, glofox_member_id, last_attended_at, last_booked_at')
        .eq('location_id', location.id)
        .in('glofox_membership_status', MEMBER_STATUSES)
        .not('glofox_member_id', 'is', null)
        .order('glofox_synced_at', { ascending: true, nullsFirst: true })
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw new Error(error.message)
      members.push(...(page || []))
      if (!page || page.length < PAGE) break
    }
    const eligibleCount = members.length

    for (const m of (members || [])) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) { budgetExhausted = true; break }

      const { ok, bookings } = await fetchUserBookingsResult(creds, m.glofox_member_id)
      if (!ok) {
        // Transient Glofox error — leave this member's aggregates
        // as they are rather than wiping them to zero. Next run
        // retries (stalest-first ordering brings it back round).
        summary.fetch_failed++
        continue
      }

      const aggs = computeBookingAggregates(bookings)
      // mergeBookingAggregates: the 7-/30-day counts always refresh,
      // but last_attended_at / last_booked_at are advance-only — so
      // this 30-day fetch window can NEVER wipe a real historical
      // attendance date for a member who simply hasn't trained in the
      // last month. (Previously it overwrote those dates with null,
      // making ~80% of the member base look like zero-activity ghosts.)
      const update = {
        ...mergeBookingAggregates(m, aggs),
        glofox_synced_at: new Date().toISOString(),
      }
      // recent_bookings drives the contact-profile history list — only
      // refresh it when we actually fetched bookings, so an empty
      // 30-day window doesn't blank a member's recent-bookings panel.
      if (bookings.length > 0) {
        update.recent_bookings = trimRecentBookings(bookings, 10)
      }

      // CHURN-PREP.2 — also refresh the current membership plan +
      // lifecycle state (active/paused/cancelled) from the
      // single-member payload. On a fetch failure we omit both from
      // the update (existing values kept) rather than failing the
      // whole member — attendance still saves.
      const { ok: memberOk, member } = await fetchMemberResult(creds, m.glofox_member_id)
      if (memberOk) {
        update.glofox_membership_plan = extractMembershipPlan(member)
        update.glofox_membership_state = extractMembershipState(member)
        // GLOFOX-PROFILE — renewal/billing detail + profile attributes.
        Object.assign(update, extractMemberProfile(member))
      } else {
        summary.membership_failed++
      }

      const { error: upErr } = await db
        .from('contacts')
        .update(update)
        .eq('id', m.id)
      if (upErr) summary.update_failed++
      else summary.refreshed++
    }

    if (runId) {
      await db.from('glofox_sync_runs').update({
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        leads_processed: summary.refreshed,
        total_available: eligibleCount,
        summary,
        status: 'completed',
      }).eq('id', runId)
    }
    return {
      location_id: location.id,
      location_name: location.name,
      status: 'completed',
      eligible: eligibleCount,
      summary,
      budget_exhausted: budgetExhausted,
    }
  } catch (e) {
    const msg = e?.message || 'unknown error'
    if (runId) {
      await db.from('glofox_sync_runs').update({
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        first_error: msg,
        summary,
        status: 'failed',
      }).eq('id', runId)
    }
    console.warn(`[cron][glofox-attendance-refresh] location ${location.id} failed: ${msg}`)
    return {
      location_id: location.id,
      location_name: location.name,
      status: 'failed',
      error: msg,
      summary,
      budget_exhausted: false,
    }
  }
}
