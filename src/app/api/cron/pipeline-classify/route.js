// PIPELINE5.6 — nightly classifier cron.
//
// Runs at 03:30 Dublin time, 30 minutes after the glofox-sync
// cron (which fires at 03:00). Order matters — glofox-sync writes
// the latest engagement signals (last_attended_at, total_attended_*,
// trial_credits_remaining) and the classifier reads them. Running
// the other way would re-classify against day-old data.
//
// Per location with Glofox configured:
//   1. Pull every contact + their classifier inputs
//   2. Run classifyContact() for each
//   3. Compare against current open deal stage
//   4. Move (or create) deals as needed
//   5. Audit to pipeline_classification_runs
//
// Auth: same CRON_SECRET pattern as the other Vercel crons.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError } from '@/lib/log'
import { reclassifyAllContacts } from '@/lib/pipeline-reclassify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// 8k contacts → ~25k DB rows touched (contacts read + deals read +
// deals updated + audit). Easily inside 60s in practice; bumping to
// 120s for headroom on busy nights.
export const maxDuration = 120

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()

  // Run for every active location. Most of the codebase runs single-
  // tenant in practice but we want this to grow with Hatch Street etc.
  const { data: locations, error: locErr } = await db
    .from('locations')
    .select('id, name')
    .eq('active', true)
  if (locErr) {
    console.warn(`[cron][pipeline-classify] failed to list locations: ${locErr.message}`)
    return NextResponse.json({ success: false, error: locErr.message }, { status: 500 })
  }

  const perLocation = []
  for (const loc of locations || []) {
    // One studio's throw must not stop the others (or skip the summary).
    let result
    try {
      result = await reclassifyAllContacts(db, {
        locationId: loc.id,
        source: 'cron',
        dryRun: false,
      })
    } catch (e) {
      result = { ok: false, error: `threw: ${e?.message || e}` }
    }
    perLocation.push({
      location_id: loc.id,
      location_name: loc.name,
      ...result,
    })
  }

  // CRONSTAMP.1 (audit 2026-11-15, item 12): the heartbeat used to be
  // stamped whatever happened, so a night where every studio failed (claims
  // unreadable, a stage load error) read as a clean run and nothing paged.
  // It is stamped only when no studio failed; the failures are logged.
  const failed = perLocation.filter((r) => r.ok === false)
  for (const r of failed) {
    logError('cron.pipeline-classify', 'studio reclassify failed', { location_id: r.location_id, error: r.error || r.reason || null })
  }
  if (failed.length === 0) await stampHeartbeat('pipeline-classify')

  return NextResponse.json({
    success: failed.length === 0,
    locations: perLocation.length,
    failed: failed.length,
    summary: perLocation.map((r) => ({
      location_name: r.location_name,
      ok: r.ok !== false,
      ...(r.ok === false ? { error: r.error || r.reason || 'failed' } : {}),
      contacts_seen: r.contacts_seen,
      deals_moved: r.deals_moved,
      deals_unchanged: r.deals_unchanged,
      deals_created: r.deals_created,
      errors: r.errors,
    })),
  }, { status: failed.length === 0 ? 200 : 500 })
}
