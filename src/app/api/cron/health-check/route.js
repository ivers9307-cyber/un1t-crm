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
//
// RESILIENCE (2026-05-30): the read of cron_health used to 503 on the
// FIRST DB error. A single transient blip — Supabase pooler reconnect,
// a cold serverless connection, a momentary network glitch (all self-
// healing in well under a second) — therefore tripped BetterStack and
// paged the team even though every cron was actually fresh (~5/6 false
// "service down" alerts in a day). A monitor that feeds a pager must
// only 503 on a SUSTAINED problem, so the cron_health READ is now
// bounded by a timeout and retried once before we give up. The
// cron-staleness semantics are UNCHANGED: a genuinely stale cron still
// returns 503 every time.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ATTEMPT_TIMEOUT_MS = 2500
const RETRY_DELAY_MS = 400

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// One bounded read of the cron_health view. Returns { ok, checks } on
// success or { ok: false, error } on a transient/DB failure.
async function readCronHealth() {
  const db = createServerClient()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS)
  try {
    const { data, error } = await db
      .from('cron_health')
      .select('name, last_ok_at, stale_seconds, max_allowed_seconds, is_stale')
      .order('name')
      .abortSignal(controller.signal)
    if (error) return { ok: false, error: error.message }
    return { ok: true, checks: data || [] }
  } catch (e) {
    return { ok: false, error: e?.message || 'health check failed' }
  } finally {
    clearTimeout(timer)
  }
}

export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get('authorization')
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  // Read cron_health, tolerating a single transient blip. Only a
  // SUSTAINED failure to read it (both attempts) is treated as a cron
  // health failure worth a 503.
  let result = await readCronHealth()
  if (!result.ok) {
    await sleep(RETRY_DELAY_MS)
    result = await readCronHealth()
  }
  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.error, all_healthy: false },
      { status: 503 }
    )
  }

  const checks = result.checks
  const stale = checks.filter((c) => c.is_stale)
  const allHealthy = stale.length === 0

  return NextResponse.json(
    {
      success: allHealthy,
      all_healthy: allHealthy,
      stale: stale.map((c) => c.name),
      checks,
      checked_at: new Date().toISOString(),
    },
    { status: allHealthy ? 200 : 503 }
  )
}
