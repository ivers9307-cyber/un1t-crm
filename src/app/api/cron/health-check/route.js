// Cron health-check endpoint.
//
// Reads public.cron_health (mig 053) and returns:
//   200 { success: true,  all_healthy: true,  checks: [...] }   if every cron is fresh
//   503 { success: false, all_healthy: false, stale: [...], checks: [...] }   if any cron is stale
//
// Designed for external uptime monitors (UptimeRobot, Better Stack, Pingdom,
// etc.) — they ping this URL every few minutes with the CRON_SECRET as the
// Authorization header, and alert on any 5xx response.
//
// Auth-gated by CRON_SECRET so we don't expose cron names + timestamps to
// the public internet (mild info disclosure, but no reason to allow it).
//
// This route does NOT stamp a heartbeat for itself — it's a status reader,
// not a worker.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get('authorization')
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const { data: checks, error } = await db
    .from('cron_health')
    .select('name, last_ok_at, stale_seconds, max_allowed_seconds, is_stale')
    .order('name')

  if (error) {
    // Can't read the view — that itself is a cron health failure. Return 503
    // so the external monitor alerts.
    return NextResponse.json(
      { success: false, error: error.message, all_healthy: false },
      { status: 503 }
    )
  }

  const stale = (checks || []).filter((c) => c.is_stale)
  const allHealthy = stale.length === 0

  return NextResponse.json(
    {
      success: allHealthy,
      all_healthy: allHealthy,
      stale: stale.map((c) => c.name),
      checks: checks || [],
      checked_at: new Date().toISOString(),
    },
    { status: allHealthy ? 200 : 503 }
  )
}
