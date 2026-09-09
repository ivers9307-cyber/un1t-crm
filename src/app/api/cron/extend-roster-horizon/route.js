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

  await stampHeartbeat('extend-roster-horizon', stats)
  return NextResponse.json({ success: true, stats })
}
