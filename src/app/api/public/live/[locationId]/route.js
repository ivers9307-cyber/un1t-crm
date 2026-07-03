// GET /api/public/live/[locationId]
//
// Public — no auth. Powers the in-studio TV display at
// /tv/[locationId]. Returns enough state to render the live class
// board: per-attendee first-name + initial, current BPM, current
// zone, accumulated UN1T Points + zone breakdown so far.
//
// Privacy: full names, contact ids, MAC addresses are NOT exposed.
// The TV display lives in a public room so the bar is "what would
// I be comfortable showing the next class waiting in the lobby" —
// first name + last initial is the cap. DECISION #1 (mig 348):
// members who opted out of the leaderboard are filtered out in the
// shared builder (buildLiveBoardPayload).
//
// P0-3: transition — this endpoint is keyed only by a guessable
// location UUID, which exposes live HR (health) data to anyone who
// knows/enumerates the id. The token-gated replacement is
// /api/public/tv-live/[token] (resolves the location from an opaque
// tv_displays.token). This entrypoint stays FUNCTIONAL for now
// because the live studio TV still points at it; DEPRECATE the
// location-keyed entrypoint once every TV is switched to the token
// URL (operator + device-verify step — see the PR notes). It keeps
// the Wave-1 rate-limit + no-store below.
//
// Refresh: page polls every 2s. force-dynamic + revalidate=0 so
// edge caches don't kick in.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { buildLiveBoardPayload } from '@/lib/live-board'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Never let an edge/browser cache serve a stale board — the TV polls every 2s
// for liveness and each response is location-specific.
const NO_STORE = { 'Cache-Control': 'no-store' }

// Rate limit: the TV polls at 2s (≈30 req/min) and a studio may run one board
// plus a spare/preview, so allow generous headroom while still capping a public,
// unauthenticated endpoint against abuse. Keyed per client IP AND per location
// so one busy studio can't starve another's bucket.
const RATE_MAX = 240
const RATE_WINDOW_MS = 60 * 1000

export async function GET(request, props) {
  const params = await props.params;
  const db = createServerClient()
  const locationId = params.locationId
  const nowMs = Date.now()

  // Abuse limiter (fail-open — a limiter outage must not black out the TV).
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `public-live:${locationId}:${ip}`, {
    max: RATE_MAX,
    windowMs: RATE_WINDOW_MS,
  })
  if (!limit.allowed) return rateLimitResponse(limit)

  // Confirm the location exists. Also lets the TV page render the
  // studio name in the header without a separate API call.
  const { data: location } = await db
    .from('locations')
    .select('id, name')
    .eq('id', locationId)
    .single()
  if (!location) {
    return NextResponse.json({ ok: false, error: 'Location not found' }, { status: 404, headers: NO_STORE })
  }

  const payload = await buildLiveBoardPayload(db, { location, nowMs })
  return NextResponse.json(payload, { headers: NO_STORE })
}
