// Vercel cron — daily at 03:00 Dublin time.
//
// GLOFOX2.2 — full bulk-sync of every location with Glofox creds.
// The webhook receiver handles real-time changes; this cron is the
// safety net + canonical full-state recompute.
//
// Per-location flow:
//   1. Insert a glofox_sync_runs row (status='running').
//   2. Paginate /2.1/branches/{branchId}/leads/filter with
//      modified.start = (now - 25h). One-hour overlap with the
//      previous tick smooths out boundary misses.
//   3. For each lead, call applyMemberSync with a SHARED
//      membership cache (so the Class Pack membership is fetched
//      ONCE per location even if 500 members are on it).
//   4. Aggregate per-action counts; capture the first error.
//   5. Update the glofox_sync_runs row with finished_at + summary.
//   6. Stamp cron_heartbeat.
//
// Auth: same CRON_SECRET pattern as the other Vercel crons.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { glofoxCredentialsForLocation, fetchAllMembersPage } from '@/lib/glofox'
import { syncMembershipCatalog } from '@/lib/glofox-catalog'
import { applyMemberSync } from '@/lib/glofox-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Vercel Pro ceiling. UN1T has ~1000 members; at ~3 Glofox calls
// per member (credits + 1 cached membership + bookings + interactions
// = 4 calls but several are cached) at 10 req/sec live ceiling, a
// full re-sync of 1000 members takes ~5 minutes. 300s gives us
// headroom + room for a second location once Hatch Street comes online.
export const maxDuration = 300

const PAGE_SIZE = 50
const LOOKBACK_HOURS = 25

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()

  // Find every location that has Glofox configured. The integration
  // is per-location (settings.glofox.branch_id + api_key + api_token).
  const { data: locations, error: locErr } = await db
    .from('locations')
    .select('id, name, settings')
    .filter('settings', 'cs', JSON.stringify({ glofox: {} }))
  if (locErr) {
    console.warn(`[cron][glofox-sync] failed to list locations: ${locErr.message}`)
    return NextResponse.json({ success: false, error: locErr.message }, { status: 500 })
  }
  // Filter to locations that ACTUALLY have all three creds set
  // (settings.glofox might exist as an empty object on rows the
  // operator started but didn't finish configuring).
  const eligibleLocations = (locations || []).filter(loc => {
    const cfg = loc.settings?.glofox || {}
    return cfg.branch_id && cfg.api_key && cfg.api_token
  })

  if (eligibleLocations.length === 0) {
    await stampHeartbeat('glofox-sync')
    return NextResponse.json({
      success: true,
      message: 'No locations with Glofox credentials configured.',
      locations_processed: 0,
    })
  }

  const lookbackSec = Math.floor((Date.now() - LOOKBACK_HOURS * 3600 * 1000) / 1000)
  // GLOFOX2.4 — filter shape kept for the audit row (operator can
  // see "what window did this run cover"). Actual filtering is now
  // client-side via the modified-DESC early-termination in
  // syncOneLocation, since /2.0/members doesn't accept a
  // server-side modified filter.
  const filters = { modified: { start: lookbackSec } }
  const perLocationResults = []

  for (const loc of eligibleLocations) {
    const result = await syncOneLocation(db, loc, filters, lookbackSec)
    perLocationResults.push(result)
  }

  await stampHeartbeat('glofox-sync')

  // Roll up across all locations for the response.
  const totals = perLocationResults.reduce((acc, r) => {
    acc.leads_processed += r.leads_processed || 0
    acc.pages_fetched += r.pages_fetched || 0
    for (const k of Object.keys(r.summary || {})) {
      acc.summary[k] = (acc.summary[k] || 0) + (r.summary[k] || 0)
    }
    if (r.status === 'failed') acc.failed_locations++
    return acc
  }, { leads_processed: 0, pages_fetched: 0, summary: {}, failed_locations: 0 })

  return NextResponse.json({
    success: true,
    lookback_hours: LOOKBACK_HOURS,
    locations_processed: perLocationResults.length,
    totals,
    per_location: perLocationResults,
  })
}

/**
 * Sync one location. Inserts an audit row, paginates through
 * /2.0/members in modified-DESC order, calls applyMemberSync per
 * member who falls within the lookback window, early-terminates
 * as soon as we hit a member modified BEFORE the cutoff (the
 * sort order means everything past that point is also outside
 * the window).
 */
async function syncOneLocation(db, location, filters, lookbackSec) {
  const startedAt = Date.now()
  const summary = { create: 0, update: 0, ambiguous: 0, invalid: 0, error: 0, leave: 0 }
  let firstError = null
  let pagesFetched = 0
  let leadsProcessed = 0
  let totalAvailable = null

  // Insert the audit row up-front so a mid-run timeout still leaves
  // a "running" row visible (operator sees the run was attempted).
  const { data: runRow } = await db
    .from('glofox_sync_runs')
    .insert({
      location_id: location.id,
      filter_used: filters,
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

    // GLOFOX-CATALOG — refresh the studio's membership catalog once per
    // location per run (~8 rows). Best-effort: a failure here must never
    // abort the member sync below.
    try {
      await syncMembershipCatalog(db, location.id, creds)
    } catch (e) {
      console.warn(`[cron][glofox-sync] catalog refresh failed for ${location.id}: ${e?.message}`)
    }

    // Shared membership cache across the WHOLE LOCATION's pages.
    // The Class Packs membership is the same object for every Credit
    // Member; the unlimited subscription membership is the same for
    // every subscription member. Without this cache we'd hit
    // /2.0/memberships/{id} N times.
    const membershipCache = new Map()

    // GLOFOX2.4 — paginate /2.0/members (sorted modified-DESC).
    // Early-terminate when we see a member modified < lookbackSec.
    let page = 1
    let stopEarly = false
    while (!stopEarly) {
      const { data: members, total, hasMore } = await fetchAllMembersPage(creds, {
        page, limit: PAGE_SIZE,
      })
      if (typeof total === 'number') totalAvailable = total
      pagesFetched++
      if (!members || members.length === 0) break

      for (const m of members) {
        const memberModified = Number(m?.modified) || 0
        if (memberModified > 0 && memberModified < lookbackSec) {
          // First member outside the window → because the list is
          // modified-DESC, EVERY subsequent member is also outside.
          // Stop the whole loop.
          stopEarly = true
          break
        }
        try {
          const result = await applyMemberSync(db, location.id, m, {
            creds, membershipCache,
          })
          summary[result.action] = (summary[result.action] || 0) + 1
          if (result.error && !firstError) {
            firstError = `[${m._id || 'unknown'}] ${result.error}`
          }
          leadsProcessed++
        } catch (e) {
          summary.error++
          if (!firstError) firstError = `[${m._id || 'unknown'}] ${e?.message || 'threw'}`
          leadsProcessed++
        }
      }

      // No more pages OR we just fetched the last one.
      if (!hasMore) break
      page++

      // Defensive cap — shouldn't trigger in practice but stops a
      // pathological infinite-pagination loop. UN1T's 8129 members
      // / 50 per page = 163 pages worst case (cron only ever needs
      // a handful due to early-termination).
      if (page > 200) break
    }

    const duration = Date.now() - startedAt
    if (runId) {
      await db.from('glofox_sync_runs').update({
        finished_at: new Date().toISOString(),
        duration_ms: duration,
        pages_fetched: pagesFetched,
        leads_processed: leadsProcessed,
        total_available: totalAvailable,
        summary,
        first_error: firstError,
        status: 'completed',
      }).eq('id', runId)
    }
    return {
      location_id: location.id,
      location_name: location.name,
      status: 'completed',
      duration_ms: duration,
      pages_fetched: pagesFetched,
      leads_processed: leadsProcessed,
      total_available: totalAvailable,
      summary,
      first_error: firstError,
    }
  } catch (e) {
    const duration = Date.now() - startedAt
    const errMessage = e?.message || 'unknown error'
    if (runId) {
      await db.from('glofox_sync_runs').update({
        finished_at: new Date().toISOString(),
        duration_ms: duration,
        pages_fetched: pagesFetched,
        leads_processed: leadsProcessed,
        summary,
        first_error: errMessage,
        status: 'failed',
      }).eq('id', runId)
    }
    console.warn(`[cron][glofox-sync] location ${location.id} failed: ${errMessage}`)
    return {
      location_id: location.id,
      location_name: location.name,
      status: 'failed',
      duration_ms: duration,
      pages_fetched: pagesFetched,
      leads_processed: leadsProcessed,
      summary,
      first_error: errMessage,
    }
  }
}
