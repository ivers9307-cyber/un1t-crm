// GET /api/dashboard/business
//
// DASH-M.1 — every block of the /dashboard/business command centre as
// one JSON payload, so the mobile Business dashboard renders the SAME
// numbers the web page streams. Neutral /api/dashboard prefix (not
// /api/mobile/*) by standing decision — the payload is platform-
// agnostic and the web could adopt it for client refreshes later.
//
// Same lib calls as the page's server components — the KPI/briefing
// composition lives in src/lib/dashboard/business-kpis.js (extracted
// from the page, consumed by both). Per-block failure isolation
// mirrors the page's Suspense-cell posture: a failed block arrives as
// null under its key instead of failing the whole response; `rail`
// distinguishes null (failed) from [] (nothing waiting).
//
// Auth: session cookie (web) or Supabase JWT Bearer + x-active-location
// (mobile) — getCurrentUser handles both. Gate matches the web page:
// hasPermission(user, 'dashboard_business') — the same top-level
// permission key that shows/hides the mobile segment.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { fetchFunnelCounts, fetchAdsSummary, fetchTodayOps } from '@shared/dashboard-data'
import { buildBusinessKpis } from '@/lib/dashboard/business-kpis'
import { buildNeedsYouRail } from '@/lib/dashboard/business-rail'
import { computeMembershipCounts, fetchMembershipTrend } from '@/lib/membership-snapshot'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// buildBusinessKpis → loadRadar pages a few thousand rows + the
// approvals registry fans out across providers — same ceiling as
// /api/mobile/today-feed.
export const maxDuration = 60

// Membership block semantics match the page's MembershipBlock: a throw
// OR falsy live counts = failure (null), never a fake-zero panel.
async function membershipBlock(db, locationId) {
  try {
    const [live, trend] = await Promise.all([
      computeMembershipCounts(db, locationId),
      fetchMembershipTrend(db, locationId, 12),
    ])
    if (!live) return null
    return { live, trend }
  } catch {
    return null
  }
}

// { success, data } fetchers → block data or null. The fetchers only
// reject on programmer error; the (r, err) pair keeps a rejection
// isolated to its own block either way.
function blockData(promise) {
  return promise.then(r => (r?.success ? r.data : null), () => null)
}

export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'dashboard_business')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const [kpis, funnel, ads, membership, today, rail] = await Promise.all([
    buildBusinessKpis(db, user, locationId), // null on failure by contract
    blockData(fetchFunnelCounts(db, locationId)),
    blockData(fetchAdsSummary(db, locationId)),
    membershipBlock(db, locationId),
    blockData(fetchTodayOps(db, locationId)),
    buildNeedsYouRail(db, user, locationId).then(rows => rows, () => null),
  ])

  return NextResponse.json({
    success: true,
    data: {
      locationName: user.activeLocation?.name || null,
      kpis,
      funnel,
      ads,
      membership,
      today,
      rail,
    },
  })
}
