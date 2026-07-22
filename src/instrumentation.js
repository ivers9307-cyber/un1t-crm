// Next.js instrumentation entrypoint (OBSERVABILITY — audit OBS-2/3/4).
//
// onRequestError fires for every UNHANDLED server error — the RSC /
// route-handler / server-action / middleware throws that bubble past Next and
// currently land nowhere consistent. We (1) route them through the existing
// structured logger (log.js -> Sentinel's Vercel-log signal) and (2) persist a
// best-effort row in error_events (mig 435) so they're queryable + alertable
// via the DB, correlated to the x-vercel-id the browser saw on the failing
// response. See src/app/global-error.js for the client render-crash boundary.
//
// Hard rule: this path must NEVER throw. Observability failing must not make an
// incident worse. Every side effect is wrapped and swallowed.

import { logError } from '@/lib/log'
import { createServerClient } from '@/lib/supabase'

// Storm guard: a broken deploy can throw on every request. logError is cheap so
// it always fires, but cap the DB writes per serverless instance so an error
// storm can't hammer Postgres. Instances are ephemeral, so this is a per-instance
// floor, not a global limit — that's enough to blunt a storm.
const MAX_INSERTS_PER_MIN = 30
let windowStart = 0
let windowCount = 0

function mayPersist() {
  const now = Date.now()
  if (now - windowStart > 60_000) {
    windowStart = now
    windowCount = 0
  }
  if (windowCount >= MAX_INSERTS_PER_MIN) return false
  windowCount += 1
  return true
}

export async function onRequestError(error, request, context) {
  const vercelId = request?.headers?.['x-vercel-id'] || null

  // (1) Always log — rides the existing log.js JSON-line pipeline.
  try {
    logError('unhandled', 'unhandled request error', {
      error,
      vercel_id: vercelId,
      route: context?.routePath,
      route_type: context?.routeType,
      method: request?.method,
    })
  } catch { /* logging must never throw */ }

  // (2) Best-effort persist for correlation + alerting.
  if (!mayPersist()) return
  try {
    const message = typeof error?.message === 'string' ? error.message.slice(0, 500) : null
    const digest = error && typeof error === 'object' && typeof error.digest === 'string' ? error.digest : null
    const db = createServerClient()
    await db.from('error_events').insert({
      vercel_id: vercelId,
      runtime: process.env.NEXT_RUNTIME || null,
      route_path: context?.routePath || null,
      route_type: context?.routeType || null,
      method: request?.method || null,
      name: error?.name || null,
      message,
      digest,
    })
  } catch { /* swallow — never worsen an incident */ }
}
