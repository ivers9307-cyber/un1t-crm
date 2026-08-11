// Vercel cron — GLOFOX-DETAIL backfill (2026-05-30).
//
// WHY THIS EXISTS
// ───────────────
// The rich membership detail (plan name, lifecycle state, type,
// renewal/expiry, price, billing interval, payment method, source)
// lives ONLY on the single-member GET (/2.0/members/:id) — the bulk
// LIST payload the nightly glofox-sync uses omits it. Historically
// the only writer of that detail was glofox-attendance-refresh, which
// round-robins the whole member base at a slow cadence, so detail
// coverage sat at ~8% and was badly stale. The shared sync write-path
// now PERSISTS detail whenever it sees the single-member shape
// (GLOFOX-DETAIL in glofox-sync.js), so the webhook keeps active
// members fresh in near-real-time — but the historical base still
// needs a one-time catch-up. That's this cron.
//
// WHAT THIS DOES
// ──────────────
// For everyone who's ever had a real relationship (member /
// credit_member / trial / classpass_payg / no_sale_trial) whose
// detail is missing OR stale (>14d), oldest-first:
//   1. GET /2.0/members/:id (single-member shape, carries detail)
//   2. applyMemberSync(..., { skipBookings, skipInteractions }) — this
//      writes plan/state/type/expiry/price/interval/payment/source +
//      the live credit balance (via the credits sub-fetch). Booking
//      aggregates are intentionally skipped — attendance-refresh owns
//      those, and skipping keeps this fast + detail-focused.
//
// Runs members CONCURRENTLY (pool of GLOFOX_CONCURRENCY) and is
// time-budgeted: once the budget is hit it stops cleanly and the next
// tick resumes (oldest-first ordering advances the frontier). Once the
// base is caught up the candidate query returns ~nothing, so this also
// serves as a cheap safety net alongside the webhook.
//
// Auth: same fail-closed CRON_SECRET pattern as the other crons.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { glofoxCredentialsForLocation, fetchMemberResult } from '@/lib/glofox'
import { applyMemberSync } from '@/lib/glofox-sync'

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
// rest are picked up next tick.
const TIME_BUDGET_MS = 270_000
// Detail considered stale after this — re-pulled even if present.
const STALE_DAYS = 14
// How many candidates to pull into memory per location per tick.
const CANDIDATE_LIMIT = 3000

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

  await stampHeartbeat('glofox-detail-backfill')

  return NextResponse.json({
    success: true,
    locations_processed: perLocation.length,
    budget_exhausted: budgetExhausted,
    per_location: perLocation,
  })
}

async function backfillLocation(db, location, startedAt) {
  const summary = { create: 0, update: 0, leave: 0, fetch_failed: 0, error: 0, ambiguous: 0, invalid: 0 }
  let budgetExhausted = false
  let candidatesSeen = 0
  let remaining = null

  const { data: runRow, error: runErr } = await db
    .from('glofox_sync_runs')
    .insert({
      location_id: location.id,
      filter_used: { detail_backfill: true, statuses: RELATIONSHIP_STATUSES, stale_days: STALE_DAYS },
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
    if (!creds.branchId || !creds.apiKey || !creds.apiToken) {
      throw new Error('Glofox credentials missing on this location.')
    }

    const staleCutoff = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString()

    // Candidates: relationship cohort, detail missing OR stale, with a
    // Glofox id to fetch. Missing-plan first, then stalest, then id.
    const { data: candidates, error: candErr } = await db
      .from('contacts')
      .select('id, glofox_member_id, glofox_membership_plan, glofox_synced_at')
      .eq('location_id', location.id)
      .in('glofox_membership_status', RELATIONSHIP_STATUSES)
      .not('glofox_member_id', 'is', null)
      .or(`glofox_membership_plan.is.null,glofox_synced_at.lt.${staleCutoff}`)
      .order('glofox_membership_plan', { ascending: true, nullsFirst: true })
      .order('glofox_synced_at', { ascending: true, nullsFirst: true })
      .order('id', { ascending: true })
      .range(0, CANDIDATE_LIMIT - 1)
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
        try {
          const { ok, member } = await fetchMemberResult(creds, c.glofox_member_id)
          if (!ok || !member) { summary.fetch_failed++; continue }
          const r = await applyMemberSync(db, location.id, member, {
            creds, membershipCache, skipBookings: true, skipInteractions: true, skipReclassify: true,
          })
          if (r?.error) summary.error++
          else summary[r.action] = (summary[r.action] || 0) + 1
        } catch {
          summary.error++
        }
      }
    }
    await Promise.all(Array.from({ length: GLOFOX_CONCURRENCY }, worker))

    // How many in the cohort still need detail (progress signal).
    const { count } = await db
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', location.id)
      .in('glofox_membership_status', RELATIONSHIP_STATUSES)
      .not('glofox_member_id', 'is', null)
      .is('glofox_membership_plan', null)
    remaining = typeof count === 'number' ? count : null

    if (runId) {
      await db.from('glofox_sync_runs').update({
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        leads_processed: (summary.create + summary.update + summary.leave),
        total_available: candidatesSeen,
        summary: { ...summary, remaining_missing_plan: remaining },
        status: 'completed',
      }).eq('id', runId)
    }

    return {
      location_id: location.id,
      location_name: location.name,
      status: 'completed',
      candidates_seen: candidatesSeen,
      remaining_missing_plan: remaining,
      budget_exhausted: budgetExhausted,
      summary,
    }
  } catch (e) {
    const errMessage = e?.message || 'unknown error'
    if (runId) {
      await db.from('glofox_sync_runs').update({
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        summary,
        first_error: errMessage,
        status: 'failed',
      }).eq('id', runId)
    }
    console.warn(`[cron][glofox-detail-backfill] location ${location.id} failed: ${errMessage}`)
    return {
      location_id: location.id,
      location_name: location.name,
      status: 'failed',
      candidates_seen: candidatesSeen,
      budget_exhausted: budgetExhausted,
      summary,
      first_error: errMessage,
    }
  }
}
