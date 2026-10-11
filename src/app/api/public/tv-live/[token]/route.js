// GET /api/public/tv-live/[token]
//
// P0-3 — THE entrypoint for the live HR board. The caller presents an opaque
// tv_displays.token instead of a location UUID. The token resolves to a
// location (the same bearer-token-as-URL model used by /api/public/tv/[token]/
// content — see mig 160), so live HR (health) data is not exposed by merely
// knowing/enumerating a location id. The location-keyed twin
// (/api/public/live/[locationId], same payload via buildLiveBoardPayload) was
// removed in W0.9c once every kiosk had moved to this URL (W0.9b).
//
// No auth header — the token IS the auth (UC Cast / kiosk browsers can't supply
// cookies). Invalid / inactive tokens return 404 (never reveal whether a token
// or location exists). Rate-limited per token + IP and no-store.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { buildLiveBoardPayload } from '@/lib/live-board'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { stampRender, deviceFromRequest } from '@/lib/fleet-render'
import { resolveLocationBrand } from '@/lib/host-brand'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }
const RATE_MAX = 240
const RATE_WINDOW_MS = 60 * 1000

export async function GET(request, props) {
  const params = await props.params
  const db = createServerClient()
  const token = params.token
  const nowMs = Date.now()

  if (!token) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404, headers: NO_STORE })
  }

  // Abuse limiter (fail-open) — keyed on the token so one display can't starve
  // another's bucket. Runs BEFORE the token lookup so an enumeration attempt is
  // still capped.
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `tv-live:${token}:${ip}`, {
    max: RATE_MAX,
    windowMs: RATE_WINDOW_MS,
  })
  if (!limit.allowed) return rateLimitResponse(limit)

  // Resolve the opaque token → display → location. Only active displays. Invalid
  // token or inactive display → 404 (don't confirm existence of either).
  const { data: display } = await db
    .from('tv_displays')
    .select('location_id, active')
    .eq('token', token)
    .maybeSingle()
  if (!display || !display.active) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404, headers: NO_STORE })
  }

  // Load the location the token maps to (for the board header + as the scope).
  const { data: location } = await db
    .from('locations')
    .select('id, name')
    .eq('id', display.location_id)
    .single()
  if (!location) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404, headers: NO_STORE })
  }

  // FLEET-CMD.2 / W0.9a — this request IS the proof a kiosk is rendering.
  //
  // The kiosk's render heartbeat lives here since W0.9a (the location-keyed
  // entrypoint that first stamped it is gone). Fire-and-forget, deliberately
  // NOT awaited: the studio board must never wait on fleet telemetry, and
  // stampRender swallows its own errors. The location is the one the TOKEN
  // resolved to — never caller-supplied — and the stamp sits after the token
  // check so an unknown token cannot be used to probe device names. No
  // ?device= → no stamp.
  const device = deviceFromRequest(request)
  if (device) void stampRender(db, device, location.id)

  // W1.S1b — the studio's brand for the board's wordmark and tab title.
  // This endpoint is polled every few seconds, so it reads the per-location
  // cache (host-brand.js), never a fresh walk per poll.
  const [payload, brand] = await Promise.all([
    buildLiveBoardPayload(db, { location, nowMs }),
    resolveLocationBrand({ locationId: location.id, db, nowMs }),
  ])
  return NextResponse.json(
    { ...payload, brand: { name: brand.companyName, short_name: brand.shortName } },
    { headers: NO_STORE },
  )
}
