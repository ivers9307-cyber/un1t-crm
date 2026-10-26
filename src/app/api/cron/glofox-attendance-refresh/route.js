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
// ATTPROSPECTS.1 — before the members, every OTHER active contact at the
// studio except ClassPass (trials, leads, tours, cold …) gets step 1 only, so
// their 7-/30-day counts are current too. See PROSPECT_* below.
//
// Members are processed stalest-glofox_synced_at-first and the run
// is time-budgeted: if a run can't finish the whole base it stops
// cleanly and the next run resumes from the stalest remaining
// members. A transient Glofox error on a member, or Glofox refusing
// the member read (200 success:false — MEMBERRESULT.1), leaves that
// member's existing aggregates / plan untouched (never wiped).
//
// Auth: same CRON_SECRET pattern as the other Vercel crons.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { glofoxCredentialsForLocation, fetchUserBookingsResult, fetchMemberResult, glofoxHttpStats, glofoxHttpStatsSince } from '@/lib/glofox'
import { GLOFOX_SETTINGS_UNREADABLE_MESSAGE } from '@/lib/glofox-settings-read'
import { locationsWithSource, skippedSummary } from '@/lib/membership/locations-for-source'
import { computeBookingAggregates, mergeBookingAggregates, trimRecentBookings, extractMembershipPlan, extractMembershipState, extractMemberProfile } from '@/lib/glofox-sync'
import { logWarn, logError } from '@/lib/log'
import { glofoxCrossoverContactIds, scopeToGlofoxStudio } from '@/lib/glofox-crossover'
import { dayStrIn, DAY_MS } from '@/lib/location-time'

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

// ATTPROSPECTS.1 — the non-member contacts that get the bookings refresh.
// ClassPass is left out (Richard, 15 Oct 2026). Only the ACTIVE ones: a booking
// or an attended class in the last PROSPECT_WINDOW_DAYS, or a stored count
// that still has to decay to 0. That was ~76 contacts against ~5,700 on file
// at Stillorgan (15 Oct 2026, run ~212s of the 250s budget), so this adds
// seconds; the whole population would blow the budget many times over.
// Bookings only, no member read: the delta sync keeps their profile, and it
// halves the Glofox calls. They run BEFORE the members: they are few and
// bounded, and an over-budget member run rotates stalest-first anyway, while
// a list run after it would never be reached.
const PROSPECT_EXCLUDED_STATUSES = [...MEMBER_STATUSES, 'classpass_payg']
const PROSPECT_WINDOW_DAYS = 35

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const startedAt = Date.now()
  // CREDITSREAD.1 — Glofox traffic for this invocation (instance-wide counters).
  const httpBefore = glofoxHttpStats()
  const db = createServerClient()

  // W1.M3b — same discovery as glofox-sync: the membership seam, never the
  // settings slice. A failed seam read is a 500 with no heartbeat.
  const { eligible, skipped, error: locErr } = await locationsWithSource(db, 'glofox', { module: 'glofox-attendance-refresh' })
  if (locErr) {
    console.warn(`[cron][glofox-attendance-refresh] list locations failed: ${locErr.message}`)
    return NextResponse.json({ success: false, error: locErr.message }, { status: 500 })
  }

  const perLocation = []
  let budgetExhausted = false
  for (const loc of eligible) {
    if (budgetExhausted) break
    const res = await refreshLocation(db, loc, startedAt)
    perLocation.push(res)
    if (res.budget_exhausted) budgetExhausted = true
  }

  // CREDITSREAD.1 — reach + traffic, readable from SQL (was: last_outcome NULL).
  // The run is time-bound (sequential, TIME_BUDGET_MS), so refreshed < eligible
  // with budget_exhausted=true is its normal shape; the stalest-first order
  // rotates who is left for tomorrow.
  //
  // GLOFOX414.1 — a location that failed did no work, so it withholds the stamp
  // (as glofox-detail-backfill does): the heartbeat goes stale and pages. It
  // used to stamp anyway, so from 25 Oct 2026 a failing Stillorgan run looked
  // healthy with failed_locations: 1 and no member refreshed.
  const failed = perLocation.filter((r) => r.status === 'failed')
  if (failed.length > 0) {
    logError('glofox-attendance-refresh', 'location run failed; heartbeat not stamped', {
      failed: failed.map((r) => ({ locationId: r.location_id, error: r.error })),
    })
  } else {
    await stampHeartbeat('glofox-attendance-refresh', attendanceOutcome(perLocation, budgetExhausted, glofoxHttpStatsSince(httpBefore), skipped))
  }

  return NextResponse.json({
    success: failed.length === 0,
    locations_processed: perLocation.length,
    locations_skipped: skipped.length,
    ...skippedSummary(skipped),
    budget_exhausted: budgetExhausted,
    per_location: perLocation,
  })
}

function attendanceOutcome(perLocation, budgetExhausted, glofoxHttp, skipped = []) {
  const sum = (k) => perLocation.reduce((n, r) => n + (r.summary?.[k] ?? 0), 0)
  return {
    // W1.M3b — locations on the source the seam would not hand over this tick.
    ...skippedSummary(skipped),
    eligible: perLocation.reduce((n, r) => n + (r.eligible ?? 0), 0),
    refreshed: sum('refreshed'),
    fetch_failed: sum('fetch_failed'),
    membership_failed: sum('membership_failed'),
    member_refused: sum('member_refused'),
    update_failed: sum('update_failed'),
    // A run where every location failed would otherwise read as all zeros (idle).
    failed_locations: perLocation.filter((r) => r.status === 'failed').length,
    prospects: ['eligible', 'refreshed', 'fetch_failed', 'update_failed']
      .reduce((o, k) => ({ ...o, [k]: perLocation.reduce((n, r) => n + (r.prospects?.[k] ?? 0), 0) }), {}),
    budget_exhausted: budgetExhausted,
    glofox_http: glofoxHttp,
  }
}

/**
 * Refresh attendance aggregates for every paying member at one
 * location, stalest first, within the shared time budget.
 */
async function refreshLocation(db, location, startedAt) {
  // MEMBERRESULT.1 — member_refused: Glofox answered the member read without a
  // member (200 success:false "Resource not available" = a deleted/merged
  // account). Not a blip, so it is counted apart from membership_failed.
  const summary = { refreshed: 0, fetch_failed: 0, update_failed: 0, membership_failed: 0, member_refused: 0 }
  const prospects = { eligible: 0, refreshed: 0, fetch_failed: 0, update_failed: 0 }
  const httpBefore = glofoxHttpStats()
  let budgetExhausted = false

  // Audit row up-front so a mid-run timeout still leaves a trace.
  const { data: runRow, error: runErr } = await db
    .from('glofox_sync_runs')
    .insert({
      location_id: location.id,
      filter_used: {
        attendance_refresh: true,
        statuses: MEMBER_STATUSES,
        prospects: { excluded_statuses: PROSPECT_EXCLUDED_STATUSES, window_days: PROSPECT_WINDOW_DAYS },
      },
      status: 'running',
    })
    .select('id')
    .single()
  // SINGLEERR.1 — the audit row is best-effort, but a rejected insert used to be
  // SILENT: the error lives in the result object, so `const { data } =` threw it
  // away and the whole run then wrote its progress to runId=null.
  if (runErr) {
    console.warn(`[cron][glofox-attendance-refresh] audit run row insert failed for ${location.id}: ${runErr.message}`)
  }
  const runId = runRow?.id

  try {
    const creds = await glofoxCredentialsForLocation(db, location.id)
    if (creds.readError) {
      // REGISTRYREAD.1b: same failed-location row, true text; the next run retries.
      throw new Error(GLOFOX_SETTINGS_UNREADABLE_MESSAGE)
    }
    if (!creds.branchId || !creds.apiKey || !creds.apiToken) {
      throw new Error('Glofox credentials missing on this location.')
    }

    // GLOFOXREADERS.1 — Glofox members whose contact lives at a sibling studio
    // (a contact_studios row with source glofox, mig 768) are refreshed here too. A failed read keeps
    // the run going on the studio's own contacts: it is logged, never fatal.
    const crossover = await glofoxCrossoverContactIds(db, location.id)
    if (crossover.error) {
      logWarn('glofox-attendance-refresh', 'crossover contacts unreadable; refreshing studio contacts only', {
        locationId: location.id, err: crossover.error,
      })
    }
    const crossoverIds = crossover.ids

    // ATTPROSPECTS.1 — the active non-members first (see PROSPECT_* above).
    const prospectRows = await listProspects(db, location.id, crossoverIds)
    prospects.eligible = prospectRows.length
    for (const p of prospectRows) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) { budgetExhausted = true; break }
      const { ok, bookings } = await fetchUserBookingsResult(creds, p.glofox_member_id)
      if (!ok) { prospects.fetch_failed++; continue }
      const { error: upErr } = await db
        .from('contacts')
        .update(attendanceUpdate(p, bookings))
        .eq('id', p.id)
      if (upErr) prospects.update_failed++
      else prospects.refreshed++
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
      const { data: page, error } = await scopeToGlofoxStudio(db
        .from('contacts')
        // last_attended_at / last_booked_at are needed so the
        // advance-only merge below can compare against the stored
        // value and never regress it.
        .select('id, glofox_member_id, last_attended_at, last_booked_at'), location.id, crossoverIds)
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

      const update = attendanceUpdate(m, bookings)

      // CHURN-PREP.2 — also refresh the current membership plan +
      // lifecycle state (active/paused/cancelled) from the
      // single-member payload. On a fetch failure OR a refusal we omit
      // every member-read field from the update (existing values kept)
      // rather than failing the whole member — attendance still saves.
      // MEMBERRESULT.1 — a refusal used to be read as a member here, and
      // extract*() of the error body wrote NULL over 16 columns (live,
      // 30 Aug 2026). fetchMemberResult now returns ok:false for it.
      const memberRead = await fetchMemberResult(creds, m.glofox_member_id)
      if (memberRead.ok) {
        update.glofox_membership_plan = extractMembershipPlan(memberRead.member)
        update.glofox_membership_state = extractMembershipState(memberRead.member)
        // GLOFOX-PROFILE — renewal/billing detail + profile attributes.
        Object.assign(update, extractMemberProfile(memberRead.member))
      } else if (memberRead.refused) {
        summary.member_refused++
        logWarn('glofox-attendance-refresh', 'Glofox refused the member read; stored membership fields kept', {
          locationId: location.id, contactId: m.id, messageCode: memberRead.messageCode,
        })
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
        summary: { ...summary, prospects, glofox_http: glofoxHttpStatsSince(httpBefore) },
        status: 'completed',
      }).eq('id', runId)
    }
    return {
      location_id: location.id,
      location_name: location.name,
      status: 'completed',
      eligible: eligibleCount,
      summary,
      prospects,
      budget_exhausted: budgetExhausted,
    }
  } catch (e) {
    const msg = e?.message || 'unknown error'
    if (runId) {
      await db.from('glofox_sync_runs').update({
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        first_error: msg,
        summary: { ...summary, prospects },
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
      prospects,
      budget_exhausted: false,
    }
  }
}

/**
 * The contacts update for one fresh bookings fetch. mergeBookingAggregates:
 * the 7-/30-day counts always refresh, but last_attended_at / last_booked_at
 * are advance-only, so this 30-day fetch window can NEVER wipe a real
 * historical attendance date for someone who simply hasn't trained in the
 * last month. (Previously it overwrote those dates with null, making ~80% of
 * the member base look like zero-activity ghosts.)
 */
function attendanceUpdate(contact, bookings) {
  const update = {
    ...mergeBookingAggregates(contact, computeBookingAggregates(bookings)),
    glofox_synced_at: new Date().toISOString(),
  }
  // recent_bookings drives the contact-profile history list — only refresh it
  // when we actually fetched bookings, so an empty 30-day window doesn't blank
  // someone's recent-bookings panel.
  if (bookings.length > 0) {
    update.recent_bookings = trimRecentBookings(bookings, 10)
  }
  return update
}

/**
 * ATTPROSPECTS.1 — the active non-member, non-ClassPass Glofox contacts at one
 * location, stalest glofox_synced_at first, paged past the 1,000-row cap.
 */
async function listProspects(db, locationId, crossoverIds = []) {
  // A day string, not an instant: the PostgREST or() grammar reserves '.' and
  // ':', and a day either side does not matter to a 35-day window.
  const since = dayStrIn(new Date(Date.now() - PROSPECT_WINDOW_DAYS * DAY_MS))
  const rows = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data: page, error } = await scopeToGlofoxStudio(db
      .from('contacts')
      .select('id, glofox_member_id, last_attended_at, last_booked_at'), locationId, crossoverIds)
      .not('glofox_member_id', 'is', null)
      .not('glofox_membership_status', 'in', `(${PROSPECT_EXCLUDED_STATUSES.join(',')})`)
      .or([
        `last_booked_at.gte.${since}`,
        `last_attended_at.gte.${since}`,
        'total_bookings_30d.gt.0',
        'total_attended_30d.gt.0',
        'total_attended_7d.gt.0',
        'total_noshow_30d.gt.0',
      ].join(','))
      .order('glofox_synced_at', { ascending: true, nullsFirst: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    rows.push(...(page || []))
    if (!page || page.length < PAGE) break
  }
  return rows
}
