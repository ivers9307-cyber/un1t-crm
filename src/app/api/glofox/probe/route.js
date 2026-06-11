// /api/glofox/probe?location_id=<uuid>&path=<glofox-path>
//
// Master-only debug endpoint that proxies arbitrary Glofox API
// paths through the existing per-location credential plumbing.
// Built to validate Plan A — confirming the /2.0/credits endpoint
// returns the data shape we expect for a real Credit Member
// (Cathy Laverty) before wiring it into the sync.
//
// Usage examples:
//   /api/glofox/probe?path=/2.0/credits?user_id=69e677b6fd868d85ee088cb3
//   /api/glofox/probe?path=/2.0/members/69e677b6fd868d85ee088cb3
//   /api/glofox/probe?path=/2.0/memberships/{id}
//
// Path may be supplied as-is (leading slash optional). Query string
// is preserved (any chars after the first '?' in the path are
// forwarded to Glofox). The endpoint surfaces ONLY GET requests
// — we never POST/PATCH/DELETE through this debug surface.
//
// Response shape:
//   { ok, status, glofox_path, response_body, response_keys, response_size }
//   response_keys is a top-level enumeration so the operator can
//   see the shape at a glance even when the body is large.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import {
  glofoxFetch,
  glofoxCredentialsForLocation,
  missingGlofoxCredentialsForLocation,
  createBooking,
} from '@/lib/glofox'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  if (user.role !== 'master') {
    return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })
  }

  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id || null
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({
      ok: false,
      error: 'Provide ?location_id=<uuid> or set an active location',
    }, { status: 400 })
  }
  // UIX-0 (unified inbox): named multi-step checks that can't be
  // expressed through the single-GET ?path= proxy. Whitelisted —
  // NOT an arbitrary-request surface.
  const check = url.searchParams.get('check')

  // 'path' is required in proxy mode — without it we have nothing to probe.
  const rawPath = url.searchParams.get('path')
  if (!rawPath && !check) {
    return NextResponse.json({
      ok: false,
      error: 'Provide ?path=<glofox-path> (e.g., /2.0/credits?user_id=XXX)',
      examples: [
        '/2.0/credits?user_id=69e677b6fd868d85ee088cb3',
        '/2.0/members/69e677b6fd868d85ee088cb3',
        '/2.0/memberships',
      ],
    }, { status: 400 })
  }
  // Normalise: ensure leading slash (proxy mode only).
  const glofoxPath = rawPath ? (rawPath.startsWith('/') ? rawPath : `/${rawPath}`) : null

  const db = createServerClient()
  const creds = await glofoxCredentialsForLocation(db, locationId)
  const missing = missingGlofoxCredentialsForLocation(creds)
  if (missing.length > 0) {
    return NextResponse.json({
      ok: false, configured: false, location_id: locationId, missing,
      hint: 'Open Settings → Locations → this location → Glofox Integration and fill in the missing fields.',
    })
  }

  // ── UIX-0 check: events_discovery ─────────────────────────────
  // The unified inbox's class-booking panel needs an "upcoming
  // classes" listing, and no event-list endpoint is verified yet
  // (the lesson: absence from docs ≠ absence — probe live). Try
  // the candidate GET paths in one pass and report each status +
  // shape so we can wire fetchUpcomingEvents against the real one.
  if (check === 'events_discovery') {
    const now = Math.floor(Date.now() / 1000)
    const week = now + 7 * 86400
    const candidates = [
      `/2.0/events?limit=3`,
      `/2.0/events?start=${now}&end=${week}&limit=3`,
      `/2.0/branches/${creds.branchId}/events?limit=3`,
      `/2.0/calendar?start=${now}&end=${week}`,
      `/2.0/bookings?limit=3`,
    ]
    const results = []
    for (const path of candidates) {
      try {
        const r = await glofoxFetch(creds, path)
        let body = null
        try { body = JSON.parse(await r.text()) } catch { body = null }
        const arr = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null
        results.push({
          path,
          status: r.status,
          top_keys: body && !Array.isArray(body) ? Object.keys(body).slice(0, 12) : (Array.isArray(body) ? ['_array'] : null),
          items: arr ? arr.length : null,
          first_item_keys: arr?.[0] ? Object.keys(arr[0]).slice(0, 20) : null,
          sample: arr?.[0] ? JSON.stringify(arr[0]).slice(0, 500) : (body ? JSON.stringify(body).slice(0, 300) : null),
        })
      } catch (e) {
        results.push({ path, status: 0, error: e?.message || String(e) })
      }
    }
    return NextResponse.json({ ok: true, check, location_id: locationId, results })
  }

  // ── UIX-0 check: booking_dryrun ───────────────────────────────
  // Proves POST /2.0/bookings RESOLVES and accepts the BookingRequest
  // shape WITHOUT creating anything: the ids are syntactically valid
  // 24-hex ObjectIds that don't exist, so Glofox must answer with a
  // structured error (message_code) rather than a booking. Same
  // technique that proved the undocumented pause endpoint exists.
  if (check === 'booking_dryrun') {
    const fakeId = '0123456789abcdef01234567'
    const result = await createBooking(creds, { user_id: fakeId, event_id: fakeId })
    return NextResponse.json({
      ok: true,
      check,
      location_id: locationId,
      interpretation: 'A structured Glofox error (message_code / validation) proves the endpoint resolves; WRONG_URL means it does not exist on this account tier.',
      glofox_status: result.status,
      glofox_body: result.body,
    })
  }

  if (check) {
    return NextResponse.json({ ok: false, error: `Unknown check '${check}'. Available: events_discovery, booking_dryrun.` }, { status: 400 })
  }

  try {
    const r = await glofoxFetch(creds, glofoxPath)
    let body, raw
    try {
      raw = await r.text()
      body = raw ? JSON.parse(raw) : null
    } catch {
      body = { _parse_error: 'response was not valid JSON', _raw: raw?.slice(0, 500) }
    }
    // Top-level keys for quick shape inspection.
    let keys = null
    if (Array.isArray(body)) {
      keys = { _type: 'array', length: body.length, first_item_keys: body[0] ? Object.keys(body[0]) : null }
    } else if (body && typeof body === 'object') {
      keys = Object.keys(body)
    }
    return NextResponse.json({
      ok: r.ok,
      status: r.status,
      location_id: locationId,
      branch_id: creds.branchId,
      glofox_path: glofoxPath,
      response_size: raw?.length ?? 0,
      response_keys: keys,
      response_body: body,
    })
  } catch (e) {
    return NextResponse.json({
      ok: false,
      location_id: locationId,
      branch_id: creds.branchId,
      glofox_path: glofoxPath,
      error: e?.message || 'Network error',
    })
  }
}
