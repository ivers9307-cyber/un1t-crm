// ROSTER-FIX.5 — nightly Vercel cron. Keeps 8 weeks of shift_blocks
// materialised ahead of this week's Monday for every active shift template,
// so the roster is never empty just because nobody scrolled the calendar
// far enough to trigger the old lazy extend. Auth: CRON_SECRET.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { extendRosterHorizon } from '@/lib/roster-horizon'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  let stats
  try {
    stats = await extendRosterHorizon(db)
  } catch (err) {
    // No heartbeat on a failed sweep — a stamp here would tell Sentinel the
    // horizon is healthy while blocks silently stop being generated.
    logWarn('roster-horizon', 'sweep failed', { err })
    return NextResponse.json({ success: false, error: err?.message || 'Horizon sweep failed' }, { status: 500 })
  }

  // ROSTER-FIX.5 — extendRosterHorizon returns normally when every template
  // failed individually, so a sweep that generated NOTHING used to stamp a
  // healthy heartbeat: Sentinel saw a green cron while the horizon stopped
  // moving, which is the exact failure the heartbeat exists to catch. A total
  // failure is a failed run — 500, no stamp.
  //
  // A PARTIAL failure still stamps, deliberately: the horizon did advance for
  // the rest of the estate, and the per-template failures ride along in
  // last_outcome.failed, where the heartbeat's own notes say to look for them.
  // Withholding the stamp there would page the on-call for one malformed
  // template while everything else worked.
  if (stats.failed > 0 && stats.failed === stats.templates) {
    logWarn('roster-horizon', 'every template failed — heartbeat not stamped', { stats })
    return NextResponse.json({ success: false, error: 'Every template failed to generate', stats }, { status: 500 })
  }

  await stampHeartbeat('extend-roster-horizon', stats)
  return NextResponse.json({ success: true, stats })
}
