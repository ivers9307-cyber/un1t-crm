// /api/glofox/ping?location_id=<uuid> — operator connection test
// (GLOFOX1.5 + GLOFOX1.6 refactor).
//
// Master-only. Calls GET /2.0/members?limit=1 against the Glofox
// API using the configured per-location credentials (Branch ID +
// API Key + API Token from settings.glofox in LocationForm) and
// reports back what happened.
//
// Use to verify the credentials work after pasting them into
// Settings → Locations → (location) → Glofox Integration. Also
// useful after rotating credentials, or as a smoke-test mid-
// incident.
//
// Response shapes:
//   { ok: true,  status: 200, location_id, branch_id, sample }
//   { ok: false, status: 401|403, location_id, branch_id, error, hint }
//   { ok: false, configured: false, missing: [...] }   not yet set up
//   { ok: false, error: '...' }                         network / parse error

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import {
  glofoxFetch,
  glofoxCredentialsForLocation,
  missingGlofoxCredentialsForLocation,
} from '@/lib/glofox'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  // Master-only — operators don't need this, it's a debug surface
  // for the master setting up the integration. Could broaden to
  // owner-of-the-location later if useful.
  if (user.role !== 'master') {
    return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })
  }

  // Default to the user's active location for convenience —
  // master usually pings the location they're currently in.
  // Explicit ?location_id=... overrides.
  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id || null
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({
      ok: false,
      error: 'Provide ?location_id=<uuid> or set an active location',
    }, { status: 400 })
  }

  const db = createServerClient()
  const creds = await glofoxCredentialsForLocation(db, locationId)
  const missing = missingGlofoxCredentialsForLocation(creds)
  if (missing.length > 0) {
    return NextResponse.json({
      ok: false,
      configured: false,
      location_id: locationId,
      missing,
      hint: 'Open Settings → Locations → this location → Glofox Integration and fill in the missing fields.',
    })
  }

  try {
    const r = await glofoxFetch(creds, '/2.0/members?limit=1')
    let body
    try {
      body = await r.json()
    } catch {
      body = null
    }
    if (!r.ok) {
      return NextResponse.json({
        ok: false,
        configured: true,
        status: r.status,
        location_id: locationId,
        branch_id: creds.branchId,
        error: body?.error || body?.message || `Glofox returned HTTP ${r.status}`,
        hint: r.status === 401 ? 'Check API Key + API Token — auth failed.'
            : r.status === 403 ? 'Check Branch ID — credentials are valid but lack access to this branch.'
            : r.status === 429 ? 'Rate-limited (10 req/sec live, 3 req/sec sandbox). Back off and retry.'
            : 'Glofox returned an unexpected status. Verify the values in Settings → Locations.',
      })
    }
    // Success — return a tiny sample so the operator can SEE the
    // shape (number of members visible, first member's id) without
    // dumping the whole list.
    const sample = Array.isArray(body?.data)
      ? { count_in_response: body.data.length, first_id: body.data[0]?._id || body.data[0]?.id || null }
      : { keys: Object.keys(body || {}) }
    return NextResponse.json({
      ok: true,
      configured: true,
      status: 200,
      location_id: locationId,
      branch_id: creds.branchId,
      sample,
    })
  } catch (e) {
    return NextResponse.json({
      ok: false,
      configured: true,
      location_id: locationId,
      branch_id: creds.branchId,
      error: e?.message || 'Network error',
    })
  }
}
