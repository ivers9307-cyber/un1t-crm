// SEG-TRIG.1 — Vercel cron — every 5 minutes.
//
// Recomputes the membership snapshot for every segment referenced by
// at least one active segment_added / segment_removed sequence
// trigger, then fires the appropriate triggers on the diff.
//
// Auth: same Bearer-token pattern as the other crons. Vercel hits
// this URL with `Authorization: Bearer ${CRON_SECRET}`.
//
// Heartbeat: stamped on success (last_ok_at). The heartbeat row is
// seeded by migration 174 — stampHeartbeat is UPDATE-only so the
// row must pre-exist (lesson learned, multiple times).

import { NextResponse } from 'next/server'
import { syncSegmentMemberships } from '@/lib/sequences'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Pro ceiling. Most ticks will exit in <1s with zero segments to
// process (no operator-wired triggers yet). A loaded tick with
// thousands of contacts per segment caps at ~10s of paged scans;
// 300s gives plenty of headroom for a pathological 10-segment +
// 50k-contact-per-segment case.
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  try {
    const stats = await syncSegmentMemberships()
    await stampHeartbeat('sync-segment-memberships')
    return NextResponse.json({ success: true, ...stats })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e.message || String(e) },
      { status: 500 }
    )
  }
}
