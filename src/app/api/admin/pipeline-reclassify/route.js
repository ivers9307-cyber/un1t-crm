// POST /api/admin/pipeline-reclassify  (PIPELINE5.7)
//
// Operator-triggered version of the nightly classifier cron
// (PIPELINE5.6). Uses the same reclassifyAllContacts() orchestrator
// — the only difference is who's calling it (master via this
// endpoint, vs the Vercel cron via /api/cron/pipeline-classify) and
// the source string written to the audit row ('manual' or
// 'backfill' instead of 'cron').
//
// Used to:
//   - Run the FIRST one-shot backfill of all 8,131 deals after the
//     classifier ships (operator doesn't want to wait until
//     03:30 tonight).
//   - Re-run after a threshold tweak in pipeline-classifier.js so
//     the new rules take effect immediately.
//   - Diagnostic dry-runs ("show me what would change") before
//     committing.
//
// Master-only. Runs synchronously inside a single Vercel request
// (60s ceiling — 8k contacts × ~9 stages = ≤9 bulk UPDATEs, fits
// comfortably). If we ever cross 50k contacts at one location this
// should move to a background job pattern.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { reclassifyAllContacts } from '@/lib/pipeline-reclassify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  if (user.profileRole !== 'master') {
    return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })
  }

  let body = {}
  try { body = await request.json() } catch { /* body optional */ }

  const locationId = body?.location_id || user.activeLocation?.id || null
  if (!locationId) {
    return NextResponse.json({ ok: false, error: 'location_id required (no active location)' }, { status: 400 })
  }

  // Source defaults to 'backfill' — the typical first-use case.
  // Operator can pass 'manual' for ad-hoc post-tweak re-runs.
  const source = body?.source === 'manual' ? 'manual' : 'backfill'
  const dryRun = body?.dry_run === true

  const db = createServerClient()
  const result = await reclassifyAllContacts(db, {
    locationId,
    dryRun,
    source,
    userId: user.id || null,
  })

  // The orchestrator returns ok:true even on partial — the audit row
  // status is the source of truth there. Pass through unchanged so
  // the UI can render the movement_matrix.
  if (!result.ok) {
    return NextResponse.json(result, { status: 500 })
  }
  return NextResponse.json(result)
}
