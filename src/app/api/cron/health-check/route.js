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
// defineCron owns that check and the error boundary.
//
// This route does NOT stamp a heartbeat for itself — it's a status reader,
// not a worker: every answer returns `stamp: false`, and a stale or unreadable
// answer is ok:false with its 503, so the wrapper never stamps either way.
// An unreadable cron_health answers a fixed error; the detail is logged.
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

import { defineCron } from '@/lib/define-cron'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const ATTEMPT_TIMEOUT_MS = 2500
const RETRY_DELAY_MS = 400

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// One bounded read of the cron_health view. Returns { ok, checks } on
// success or { ok: false } (logged) on a transient/DB failure.
async function readCronHealth(db) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS)
  try {
    const { data, error } = await db
      .from('cron_health')
      .select('name, last_ok_at, stale_seconds, max_allowed_seconds, is_stale, is_acknowledged, acknowledged_until, acknowledged_note')
      .order('name')
      .abortSignal(controller.signal)
    if (error) {
      logWarn('cron-health-check', 'cron_health read failed', { err: error })
      return { ok: false }
    }
    return { ok: true, checks: data || [] }
  } catch (err) {
    logWarn('cron-health-check', 'cron_health read threw', { err })
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}

export const GET = defineCron({ heartbeat: 'health-check' }, async ({ db }) => {
  // Read cron_health, tolerating a single transient blip. Only a
  // SUSTAINED failure to read it (both attempts) is treated as a cron
  // health failure worth a 503.
  let result = await readCronHealth(db)
  if (!result.ok) {
    await sleep(RETRY_DELAY_MS)
    result = await readCronHealth(db)
  }
  if (!result.ok) {
    return { ok: false, stamp: false, status: 503, body: { error: 'Could not read cron health', all_healthy: false } }
  }

  const checks = result.checks
  // STALEWATCH.1 (mig 843) — an ACKNOWLEDGED stale job (a known fault, being
  // handled, acknowledged_until still ahead) no longer holds the alarm red, so
  // the next job to go stale changes the answer instead of vanishing behind
  // the first. It is still listed, under `acknowledged`.
  const stale = checks.filter((c) => c.is_stale && !c.is_acknowledged)
  const acknowledged = checks.filter((c) => c.is_stale && c.is_acknowledged)
  const allHealthy = stale.length === 0

  // SAAS4-O1 — per-tenant visibility (additive; best-effort). The
  // 200/503 contract stays driven by the GLOBAL cron_health rows —
  // per-tenant crons (e.g. glofox-data-quality) only stamp their
  // global heartbeat when every tenant is fresh, so a tenant-level
  // outage already 503s via the global row. tenant_stale names WHICH
  // tenant is behind, so the operator (and later /admin/health) can
  // route the alert instead of hunting.
  let tenantStale = []
  try {
    const { data } = await db
      .from('tenant_cron_health')
      .select('name, location_id, last_ok_at, stale_seconds')
      .eq('is_stale', true)
      .order('name')
    tenantStale = data || []
  } catch {
    /* tenant detail is diagnostic — never fail the health check over it */
  }

  return {
    ok: allHealthy,
    stamp: false,
    status: allHealthy ? 200 : 503,
    body: {
      all_healthy: allHealthy,
      stale: stale.map((c) => c.name),
      acknowledged: acknowledged.map((c) => ({ name: c.name, until: c.acknowledged_until, note: c.acknowledged_note || null })),
      tenant_stale: tenantStale,
      checks,
      checked_at: new Date().toISOString(),
    },
  }
})
