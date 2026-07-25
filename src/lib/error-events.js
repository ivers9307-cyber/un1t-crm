// OBS-HANDLED.1 — shared error_events persistence.
//
// Two producers write to error_events (mig 435):
//   1. src/instrumentation.js onRequestError — UNHANDLED errors that
//      escape Next (route_type from Next's context: 'route' | 'render' | …).
//   2. serverErrorResponse below — HANDLED failures: routes that catch an
//      upstream/DB error and return 500/502 themselves. These previously
//      never reached error_events at all (five real prod 5xx — Xero
//      contacts + invoice approval — left zero rows; external review
//      2026-07-25). Handled rows are stamped route_type = 'handled' so
//      Sentinel/queries can tell the two populations apart.
//
// Hard rule inherited from instrumentation.js: this path must NEVER
// throw. Observability failing must not make an incident worse. Every
// side effect is wrapped and swallowed.

import { NextResponse } from 'next/server'
import { logError } from '@/lib/log'
import { createServerClient } from '@/lib/supabase'

// Storm guard: a broken deploy or a flapping upstream can fail on every
// request. logError is cheap so it always fires, but cap the DB writes
// per serverless instance so an error storm can't hammer Postgres.
// Instances are ephemeral, so this is a per-instance floor, not a global
// limit — enough to blunt a storm. Shared by BOTH producers (unhandled +
// handled) so their combined write rate stays bounded.
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

// Test seam only — the storm guard is module-level state, so tests need
// a way back to a clean window. Not for production use.
export function _resetStormGuardForTests() {
  windowStart = 0
  windowCount = 0
}

/**
 * Best-effort insert into error_events. Storm-guarded, never throws.
 * Caller shapes the row (see mig 435 columns); message should already
 * be truncated / PII-light.
 *
 * @param {object} row  subset of error_events columns
 * @returns {Promise<void>}
 */
export async function recordErrorEvent(row) {
  if (!mayPersist()) return
  try {
    const db = createServerClient()
    await db.from('error_events').insert(row)
  } catch { /* swallow — never worsen an incident */ }
}

/**
 * Route-facing failure response for CAUGHT errors: logs through the
 * existing log.js pipeline, persists a route_type='handled' error_events
 * row correlated to the request, and returns the standard
 * `{ success: false, error }` response.
 *
 * Drop-in for the bare
 *   `return NextResponse.json({ success:false, error: e.message }, { status: 500 })`
 * catch-sites — same body, same status, plus observability. Pass
 * `publicMessage` when the raw error text is too detailed for a client.
 *
 * @param {object} args
 * @param {string} args.module         log.js module tag (e.g. 'xero', 'invoice-approve')
 * @param {Error|{message?: string}|null} args.error  the caught error (Error or PostgREST-style object)
 * @param {Request} [args.request]     the route's Request, for path/method/vercel-id correlation
 * @param {number} [args.status=500]   response status (500, 502, …)
 * @param {string} [args.publicMessage] client-visible error text; defaults to error.message
 * @returns {Promise<NextResponse>}
 */
export async function serverErrorResponse({ module, error, request, status = 500, publicMessage }) {
  const message = typeof error?.message === 'string' ? error.message : 'Unexpected error'

  let routePath = null
  let method = null
  let vercelId = null
  try {
    method = request?.method || null
    routePath = request?.url ? new URL(request.url).pathname : null
    // Request headers are a Headers instance on routes, but a plain
    // object if someone hands us instrumentation-style input.
    vercelId = typeof request?.headers?.get === 'function'
      ? (request.headers.get('x-vercel-id') || null)
      : (request?.headers?.['x-vercel-id'] || null)
  } catch { /* correlation is best-effort */ }

  try {
    logError(module, 'handled request failure', { error, status, route: routePath, method, vercel_id: vercelId })
  } catch { /* logging must never throw */ }

  await recordErrorEvent({
    vercel_id: vercelId,
    runtime: process.env.NEXT_RUNTIME || null,
    route_path: routePath,
    route_type: 'handled',
    method,
    name: error?.name || 'Error',
    message: message.slice(0, 500),
    digest: null,
  })

  return NextResponse.json({ success: false, error: publicMessage || message }, { status })
}
