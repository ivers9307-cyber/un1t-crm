// GET /api/public/tv-live/[token]
//
// P0-3 — token-gated entrypoint for the live HR board. Same payload as
// /api/public/live/[locationId], but the caller presents an opaque
// tv_displays.token instead of a guessable location UUID. The token resolves to
// a location (the same bearer-token-as-URL model used by /api/public/tv/[token]/
// content — see mig 160), so live HR (health) data is no longer exposed by
// merely knowing/enumerating a location id.
//
// No auth header — the token IS the auth (UC Cast / kiosk browsers can't supply
// cookies). Invalid / inactive tokens return 404 (never reveal whether a token
// or location exists). Rate-limited per token + IP and no-store, same as the
// location entrypoint.
//
// The location endpoint stays live during the transition; this is the URL the
// studio TV should move to. Operator cutover steps are in the PR notes.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { buildLiveBoardPayload } from '@/lib/live-board'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'

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

  const payload = await buildLiveBoardPayload(db, { location, nowMs })
  return NextResponse.json(payload, { headers: NO_STORE })
}
