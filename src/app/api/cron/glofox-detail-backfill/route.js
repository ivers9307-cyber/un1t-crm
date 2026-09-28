// Vercel cron — GLOFOX-DETAIL backfill (2026-05-30; cursor: DETAILBACKFILL.1).
//
// WHY THIS EXISTS
// ───────────────
// The rich membership detail (plan name, lifecycle state, type,
// renewal/expiry, price, billing interval, payment method, source)
// lives ONLY on the single-member GET (/2.0/members/:id) — the bulk
// LIST payload the nightly glofox-sync uses omits it. The shared sync
// write-path persists detail whenever it sees the single-member shape
// (GLOFOX-DETAIL in glofox-sync.js), so the webhook keeps active members
// fresh in near-real-time; this cron is the catch-all behind it.
//
// WHAT THIS DOES
// ──────────────
// Every 10 minutes, for up to DETAIL_PER_TICK contacts in the relationship
// cohort (member / credit_member / trial / classpass_payg / no_sale_trial)
// with a Glofox id whose contacts.glofox_detail_due_at is NULL (never
// tried) or has passed — oldest due first, then stalest glofox_synced_at:
//   1. GET /2.0/members/:id (single-member shape, carries detail);
//   2. applyMemberSync(..., { skipBookings, skipInteractions, skipReclassify })
//      — plan/state/type/expiry/price/interval/payment/source + the live
//      credit balance (via the /2.0/credits sub-fetch). Booking aggregates
//      are skipped: attendance-refresh owns them;
//   3. stamps glofox_detail_due_at WHATEVER the answer
//      (src/lib/glofox-detail-backfill.js): answered → 10.5–17.5 days on;
//      failed → 6 hours on.
//
// DETAILBACKFILL.1 — it used to pick "plan IS NULL or synced > 14 days ago",
// plan-NULL first, in one select PostgREST caps at 1,000 rows. 2,926 contacts
// legitimately have no plan, so they filled every page and were re-read every
// ~30 minutes forever (~288k Glofox calls, ~143k contact UPDATEs a day) while
// 2,917 contacts with a plan went unrefreshed from 3 Jul. The cursor advances
// on every attempt, so no answer — no plan, a refusal, a 404 — can pin a
// contact to the front of the queue again.
//
// A tick whose candidate read (or credentials) fails did no work: it logs
// and does NOT stamp its heartbeat, so a broken backfill pages rather than
// looking like a quiet one. A tick with nothing due is healthy and stamps.
//
// Auth: same fail-closed CRON_SECRET pattern as the other crons.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { glofoxCredentialsForLocation, fetchMemberResult } from '@/lib/glofox'
import { GLOFOX_SETTINGS_UNREADABLE_MESSAGE } from '@/lib/glofox-settings-read'
import { applyMemberSync } from '@/lib/glofox-sync'
import { logWarn, logError } from '@/lib/log'
import {
  DETAIL_PER_TICK, DETAIL_SWEEP_DAYS, DETAIL_RETRY_HOURS,
  detailDueFilter, nextDetailDueAt,
} from '@/lib/glofox-detail-backfill'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Statuses that mean "has, or has had, a real relationship" — the
// cohort whose membership detail is worth pulling. Pure leads / cold /
// tour-only contacts have no membership object to fetch.
const RELATIONSHIP_STATUSES = [
  'member', 'credit_member', 'trial', 'classpass_payg', 'no_sale_trial',
]

// User's call (2026-05-30): parallel fetch, 5 at a time.
const GLOFOX_CONCURRENCY = 5
// Stop scheduling new members this close to the Vercel ceiling; the
// rest are picked up next tick. (100 a tick takes ~10 s; this is a guard.)
const TIME_BUDGET_MS = 270_000

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const startedAt = Date.now()
  const db = createServerClient()

  const { data: locations, error: locErr } = await db
    .from('locations')
    .select('id, name, settings')
    .filter('settings', 'cs', JSON.stringify({ glofox: {} }))
  if (locErr) {
    console.warn(`[cron][glofox-detail-backfill] list locations failed: ${locErr.message}`)
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
    const res = await backfillLocation(db, loc, startedAt)
    perLocation.push(res)
    if (res.budget_exhausted) budgetExhausted = true
  }

  // DETAILBACKFILL.1 — a location whose candidate read (or credentials)
  // failed did no work. Stamping would report a healthy quiet run; leave the
  // heartbeat to go stale (it pages after 20 minutes) and say why.
  const failed = perLocation.filter((r) => r.status === 'failed')
  if (failed.length > 0) {
    logError('glofox-detail-backfill', 'location run failed; heartbeat not stamped', {
      failed: failed.map((r) => ({ locationId: r.location_id, error: r.first_error })),
    })
  } else {
    await stampHeartbeat('glofox-detail-backfill', heartbeatOutcome(perLocation))
  }

  return NextResponse.json({
    success: failed.length === 0,
    locations_processed: perLocation.length,
    budget_exhausted: budgetExhausted,
    per_location: perLocation,
  })
}

// The heartbeat's last_outcome: enough to verify the cursor from SQL alone.
function heartbeatOutcome(perLocation) {
  const sum = (pick) => perLocation.reduce((n, r) => n + (pick(r) ?? 0), 0)
  const dues = perLocation.map((r) => r.remaining_due)
  return {
    candidates_seen: sum((r) => r.candidates_seen),
    remaining_due: dues.some((d) => d == null) ? null : dues.reduce((a, b) => a + b, 0),
    member_refused: sum((r) => r.summary.member_refused),
    fetch_failed: sum((r) => r.summary.fetch_failed),
    error: sum((r) => r.summary.error),
    stamp_failed: sum((r) => r.summary.stamp_failed),
  }
}

async function backfillLocation(db, location, startedAt) {
  // MEMBERRESULT.1 — member_refused: Glofox answered without a member (200
  // success:false). Counted apart: it used to reach applyMemberSync and land
  // in `invalid`.
  // DETAILBACKFILL.1 — stamp_failed: the due-date write failed, so that
  // contact is simply read again next tick (a duplicate, never a loss).
  const summary = { create: 0, update: 0, leave: 0, fetch_failed: 0, error: 0, ambiguous: 0, invalid: 0, member_refused: 0, stamp_failed: 0 }
  let budgetExhausted = false
  let candidatesSeen = 0
  let remaining = null

  const { data: runRow, error: runErr } = await db
    .from('glofox_sync_runs')
    .insert({
      location_id: location.id,
      filter_used: {
        detail_backfill: true,
        statuses: RELATIONSHIP_STATUSES,
        sweep_days: DETAIL_SWEEP_DAYS,
        retry_hours: DETAIL_RETRY_HOURS,
        per_tick: DETAIL_PER_TICK,
      },
      status: 'running',
    })
    .select('id')
    .single()
  // SINGLEERR.1 — best-effort audit row, but never silent: the error arrives in
  // the result object, so discarding it left the run writing progress to
  // runId=null with nothing to say why.
  if (runErr) {
    console.warn(`[cron][glofox-detail-backfill] audit run row insert failed for ${location.id}: ${runErr.message}`)
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

    // DETAILBACKFILL.1 — the cursor. Due = never attempted, or its due time
    // has passed; oldest due first, stalest sync as the tiebreak (so the first
    // pass after mig 645 takes the contacts unrefreshed since July first).
    // DETAIL_PER_TICK < 1,000, so this one explicitly ordered page is the
    // whole tick; the next tick's page is the next slice because every
    // attempt below moves its contact's due date.
    const { data: candidates, error: candErr } = await db
      .from('contacts')
      .select('id, glofox_member_id, glofox_detail_due_at, glofox_synced_at')
      .eq('location_id', location.id)
      .in('glofox_membership_status', RELATIONSHIP_STATUSES)
      .not('glofox_member_id', 'is', null)
      .or(detailDueFilter(new Date().toISOString()))
      .order('glofox_detail_due_at', { ascending: true, nullsFirst: true })
      .order('glofox_synced_at', { ascending: true, nullsFirst: true })
      .order('id', { ascending: true })
      .range(0, DETAIL_PER_TICK - 1)
    if (candErr) throw new Error(candErr.message)

    const items = candidates || []
    candidatesSeen = items.length

    // Concurrency pool — shared cursor, GLOFOX_CONCURRENCY workers.
    // membershipCache is shared so the same parent membership object
    // (e.g. the Class Packs product) is fetched once across workers.
    const membershipCache = new Map()
    let cursor = 0
    const worker = async () => {
      while (true) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) { budgetExhausted = true; return }
        const idx = cursor++
        if (idx >= items.length) return
        const c = items[idx]
        const outcome = await readOne(db, location.id, creds, membershipCache, c, summary)
        await stampDue(db, c.id, outcome, summary)
      }
    }
    await Promise.all(Array.from({ length: GLOFOX_CONCURRENCY }, worker))

    // One structured line per run, not per member: glofoxFetch already warns
    // per call. A refused contact is due again in 10.5-17.5 days, like any answer.
    if (summary.member_refused > 0) {
      logWarn('glofox-detail-backfill', 'Glofox refused member reads; nothing written for them', {
        locationId: location.id, refused: summary.member_refused,
      })
    }
    // A stamp that keeps failing would rebuild the re-read loop (bounded at
    // DETAIL_PER_TICK a tick), so it is an error, logged once per run.
    if (summary.stamp_failed > 0) {
      logError('glofox-detail-backfill', 'could not stamp glofox_detail_due_at; those contacts will be re-read next tick', {
        locationId: location.id, stampFailed: summary.stamp_failed,
      })
    }

    // Progress signal: how many in the cohort are still due. A failed count
    // is null (unknown), never 0.
    const { count, error: countErr } = await db
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', location.id)
      .in('glofox_membership_status', RELATIONSHIP_STATUSES)
      .not('glofox_member_id', 'is', null)
      .or(detailDueFilter(new Date().toISOString()))
    if (countErr) {
      logWarn('glofox-detail-backfill', 'remaining-due count failed', { locationId: location.id, err: countErr.message })
    }
    remaining = !countErr && typeof count === 'number' ? count : null

    if (runId) {
      const { error: runUpdErr } = await db.from('glofox_sync_runs').update({
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        leads_processed: (summary.create + summary.update + summary.leave),
        total_available: candidatesSeen,
        summary: { ...summary, remaining_due: remaining },
        status: 'completed',
      }).eq('id', runId)
      if (runUpdErr) {
        logWarn('glofox-detail-backfill', 'audit run row update failed', { locationId: location.id, runId, err: runUpdErr.message })
      }
    }

    return {
      location_id: location.id,
      location_name: location.name,
      status: 'completed',
      candidates_seen: candidatesSeen,
      remaining_due: remaining,
      budget_exhausted: budgetExhausted,
      summary,
    }
  } catch (e) {
    const errMessage = e?.message || 'unknown error'
    if (runId) {
      const { error: runUpdErr } = await db.from('glofox_sync_runs').update({
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        summary,
        first_error: errMessage,
        status: 'failed',
      }).eq('id', runId)
      if (runUpdErr) {
        logWarn('glofox-detail-backfill', 'audit run row update failed', { locationId: location.id, runId, err: runUpdErr.message })
      }
    }
    return {
      location_id: location.id,
      location_name: location.name,
      status: 'failed',
      candidates_seen: candidatesSeen,
      remaining_due: null,
      budget_exhausted: budgetExhausted,
      summary,
      first_error: errMessage,
    }
  }
}

/**
 * Read one contact's detail from Glofox and apply it. Counts the outcome in
 * `summary` and returns it (the key nextDetailDueAt judges). Never throws.
 */
async function readOne(db, locationId, creds, membershipCache, c, summary) {
  try {
    const { ok, member, refused } = await fetchMemberResult(creds, c.glofox_member_id)
    if (refused) { summary.member_refused++; return 'member_refused' }
    if (!ok || !member) { summary.fetch_failed++; return 'fetch_failed' }
    const r = await applyMemberSync(db, locationId, member, {
      creds, membershipCache, skipBookings: true, skipInteractions: true, skipReclassify: true,
    })
    if (r?.error) { summary.error++; return 'error' }
    summary[r.action] = (summary[r.action] || 0) + 1
    return r.action
  } catch {
    summary.error++
    return 'error'
  }
}

/**
 * DETAILBACKFILL.1 — move this contact's due date, whatever the outcome. A
 * failed write is counted, never thrown: the contact is read again next tick.
 */
async function stampDue(db, contactId, outcome, summary) {
  try {
    const { error } = await db
      .from('contacts')
      .update({ glofox_detail_due_at: nextDetailDueAt(outcome, Date.now()) })
      .eq('id', contactId)
    if (error) summary.stamp_failed++
  } catch {
    summary.stamp_failed++
  }
}
