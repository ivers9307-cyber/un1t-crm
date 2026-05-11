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
  // 'path' is required — without it we have nothing to probe.
  const rawPath = url.searchParams.get('path')
  if (!rawPath) {
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
  // Normalise: ensure leading slash.
  const glofoxPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`

  const db = createServerClient()
  const creds = await glofoxCredentialsForLocation(db, locationId)
  const missing = missingGlofoxCredentialsForLocation(creds)
  if (missing.length > 0) {
    return NextResponse.json({
      ok: false, configured: false, location_id: locationId, missing,
      hint: 'Open Settings → Locations → this location → Glofox Integration and fill in the missing fields.',
    })
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
