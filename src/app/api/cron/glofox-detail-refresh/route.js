// Vercel cron — Glofox per-member DETAIL refresh drainer (GLOFOX4.1).
//
// Resumable + concurrency-limited. Each tick pulls /members/:id detail
// for a batch of the ever-member/trial/pack/classpass cohort, NULLS-
// first (one-time backfill of the ~6.3k base), then re-pulls rows
// whose detail is older than STALE_DAYS as a safety net for webhooks
// Glofox fails to deliver. Idles cheaply once the cohort is all-fresh.
//
// Why: the nightly glofox-sync pulls only the lightweight LIST shape,
// so rich detail (plan, paused/overdue state, price, credits) only
// ever landed for the ~660 contacts that triggered a webhook. This
// drainer makes plan/state accurate for the WHOLE relevant base — the
// prerequisite for accurate classification (pipeline / churn / lead).
//
// Safety: 5 concurrent fetches; 429/5xx backoff in glofoxFetch; a
// per-run time budget under the 300s cap; a kill-switch env
// (GLOFOX_DETAIL_REFRESH_ENABLED=false). Same CRON_SECRET auth as the
// other crons.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { glofoxCredentialsForLocation } from '@/lib/glofox'
import {
  selectDetailRefreshBatch,
  refreshOneContact,
  mapWithConcurrency,
} from '@/lib/glofox-detail-refresh'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const CONCURRENCY = 5
const BATCH = Number(process.env.GLOFOX_DETAIL_BATCH || 600)
const STALE_DAYS = Number(process.env.GLOFOX_DETAIL_STALE_DAYS || 7)
const TIME_BUDGET_MS = 270_000 // headroom under the 300s cap
const SUBCHUNK = CONCURRENCY * 10

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (process.env.GLOFOX_DETAIL_REFRESH_ENABLED === 'false') {
    await stampHeartbeat('glofox-detail-refresh')
    return NextResponse.json({ success: true, disabled: true })
  }

  const startedAt = Date.now()
  const db = createServerClient()
  const staleBefore = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString()

  let batch
  try {
    batch = await selectDetailRefreshBatch(db, { limit: BATCH, staleBefore })
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || 'select failed' }, { status: 500 })
  }

  if (!batch.length) {
    await stampHeartbeat('glofox-detail-refresh')
    return NextResponse.json({ success: true, processed: 0, idle: true })
  }

  // Group by location → resolve creds once per location and share a
  // membership cache (the class-pack / subscription membership object
  // is identical across members on the same plan, so we fetch it once).
  const byLocation = new Map()
  for (const c of batch) {
    if (!byLocation.has(c.location_id)) byLocation.set(c.location_id, [])
    byLocation.get(c.location_id).push(c)
  }

  const counts = { synced: 0, gone: 0, skipped: 0, error: 0 }
  let stoppedEarly = false

  for (const [locationId, contacts] of byLocation) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { stoppedEarly = true; break }
    let creds
    try {
      creds = await glofoxCredentialsForLocation(db, locationId)
    } catch {
      counts.error += contacts.length
      continue
    }
    const membershipCache = new Map()

    for (let i = 0; i < contacts.length; i += SUBCHUNK) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) { stoppedEarly = true; break }
      const slice = contacts.slice(i, i + SUBCHUNK)
      const settled = await mapWithConcurrency(slice, CONCURRENCY, (c) =>
        refreshOneContact(db, c, creds, { membershipCache }))
      for (const r of settled) {
        if (r.status === 'fulfilled') counts[r.value] = (counts[r.value] || 0) + 1
        else counts.error++
      }
    }
  }

  await stampHeartbeat('glofox-detail-refresh')
  return NextResponse.json({
    success: true,
    duration_ms: Date.now() - startedAt,
    batch_size: batch.length,
    stopped_early: stoppedEarly,
    counts,
  })
}
