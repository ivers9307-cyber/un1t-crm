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
    const result = await reclassifyAllContacts(db, {
      locationId: loc.id,
      source: 'cron',
      dryRun: false,
    })
    perLocation.push({
      location_id: loc.id,
      location_name: loc.name,
      ...result,
    })
  }

  // Mig 172 audit caught: stampHeartbeat(name) only takes one arg.
  // Passing `db` as the first arg silently fails the type check and
  // returns without stamping. Heartbeat row also wasn't seeded in
  // cron_heartbeats until mig 172.
  await stampHeartbeat('pipeline-classify').catch(() => {})

  return NextResponse.json({
    success: true,
    locations: perLocation.length,
    summary: perLocation.map((r) => ({
      location_name: r.location_name,
      contacts_seen: r.contacts_seen,
      deals_moved: r.deals_moved,
      deals_unchanged: r.deals_unchanged,
      deals_created: r.deals_created,
      errors: r.errors,
    })),
  })
}
