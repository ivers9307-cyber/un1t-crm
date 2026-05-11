// /api/glofox/list-members?location_id=<uuid>&limit=200
//
// Master-only debug endpoint for browsing the Glofox members list
// at a location. Built specifically to validate the GLOFOX2.1.5
// status mapping — fetches a batch of members, groups them by
// lead_status, and surfaces one candidate per category so the
// operator can pick test IDs without clicking through the portal.
//
// Group keys in the response:
//   COLD, TOUR, NO_SALE_TOUR, TRIAL, NO_SALE_TRIAL,
//   MEMBER_ACTIVE,    — lead_status=MEMBER + active=true
//   MEMBER_LAPSED,    — lead_status=MEMBER + active=false (ex_member)
//   LEAD,
//   OTHER             — anything else (unknown future statuses)
//
// `recommended` block picks the FIRST member in each group so the
// operator can copy-paste IDs straight into /api/glofox/sync-member.

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

function bucketFor(member) {
  const raw = (member?.lead_status || member?.leads?.status || '').toString().toUpperCase().trim()
  // Normalise the portal-label form so "No Sale (Tour)" buckets
  // alongside the API form "NO_SALE_TOUR".
  const norm = raw.replace(/[()]/g, '').replace(/[\s\-.]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  if (norm === 'COLD')          return 'COLD'
  if (norm === 'TOUR')          return 'TOUR'
  if (norm === 'NO_SALE_TOUR' || norm === 'NOSALE_TOUR')   return 'NO_SALE_TOUR'
  if (norm === 'TRIAL')         return 'TRIAL'
  if (norm === 'NO_SALE_TRIAL' || norm === 'NOSALE_TRIAL') return 'NO_SALE_TRIAL'
  if (norm === 'MEMBER')        return member.active === false ? 'MEMBER_LAPSED' : 'MEMBER_ACTIVE'
  if (norm === 'LEAD')          return 'LEAD'
  return 'OTHER'
}

function summarise(member) {
  return {
    id: member._id || member.id || null,
    name: [member.first_name, member.last_name].filter(Boolean).join(' ').trim() || member.name || null,
    email: member.email || null,
    lead_status: member.lead_status || member.leads?.status || null,
    active: typeof member.active === 'boolean' ? member.active : null,
  }
}

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
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1), 500)

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
    const r = await glofoxFetch(creds, `/2.0/members?limit=${limit}`)
    let body
    try { body = await r.json() } catch { body = null }
    if (!r.ok) {
      return NextResponse.json({
        ok: false, configured: true, status: r.status,
        location_id: locationId, branch_id: creds.branchId,
        error: body?.error || body?.message || `Glofox returned HTTP ${r.status}`,
      })
    }
    const members = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []

    const buckets = {
      COLD: [], TOUR: [], NO_SALE_TOUR: [], TRIAL: [], NO_SALE_TRIAL: [],
      MEMBER_ACTIVE: [], MEMBER_LAPSED: [], LEAD: [], OTHER: [],
    }
    const otherSamples = new Map() // raw lead_status → first sample (for OTHER)
    for (const m of members) {
      const b = bucketFor(m)
      const summary = summarise(m)
      buckets[b].push(summary)
      if (b === 'OTHER' && summary.lead_status && !otherSamples.has(summary.lead_status)) {
        otherSamples.set(summary.lead_status, summary)
      }
    }

    const recommended = {}
    for (const key of Object.keys(buckets)) {
      if (buckets[key][0]) recommended[key] = buckets[key][0]
    }

    const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]))

    return NextResponse.json({
      ok: true, configured: true, status: 200,
      location_id: locationId, branch_id: creds.branchId,
      total_fetched: members.length,
      counts,
      recommended,
      // Trim each bucket to the first 5 samples so the response stays
      // small but still gives the operator alternates if the first
      // pick isn't a good fit.
      samples: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.slice(0, 5)])),
      // If we hit OTHER, show the unique raw lead_status values so we
      // know if Glofox shipped something we haven't mapped yet.
      other_unique_statuses: Array.from(otherSamples.keys()),
    })
  } catch (e) {
    return NextResponse.json({
      ok: false, configured: true,
      location_id: locationId, branch_id: creds.branchId,
      error: e?.message || 'Network error',
    })
  }
}
