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
//
// W1.M3c — `membership_source` ({ source, state, label, missing?,
// provides_memberships, can_manage }; membershipStatePayload) rides
// ALONGSIDE the blocks. The web page gates its KPI row and membership
// trend on the same state (W1.M3a); the phone (2.4.0 bundles) reads this
// key and draws the state card instead of the Glofox-derived numbers when
// the state is not 'configured'. The blocks are still computed and keep
// their shape, so an older bundle that never reads the key renders exactly
// what it did before, and a configured studio (Stillorgan) is unchanged.
// membershipStateForPage never throws (a failed read is 'unknown'), and the
// route catches it to 'unknown' anyway: the key can never 500 the blocks.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { fetchFunnelCounts, fetchAdsSummary, fetchTodayOps } from '@shared/dashboard-data'
import { buildBusinessKpis } from '@/lib/dashboard/business-kpis'
import { adsDayZoneForDisplay } from '@/lib/ads/account-day'
import { buildNeedsYouRail } from '@/lib/dashboard/business-rail'
import { fetchMembershipTrend } from '@/lib/membership-snapshot'
import { membershipReadsFor, supportsRead } from '@/lib/membership/reads'
import { membershipStateForPage, membershipStatePayload, canManageMembershipSource } from '@/lib/membership/state-for-page'
import { zoneOfLocation } from '@/lib/location-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// buildBusinessKpis → loadRadar pages a few thousand rows + the
// approvals registry fans out across providers — same ceiling as
// /api/mobile/today-feed.
export const maxDuration = 60

// Membership block semantics match the page's MembershipBlock: a throw
// OR falsy live counts = failure (null), never a fake-zero panel.
async function membershipBlock(db, locationId, zone) {
  try {
    // UN1TREAD.3 — the live counts come through the read seam (Glofox or
    // un1t.online); a source with no counts read, or an unreadable one, is
    // the same null as a failed read, never a 500 and never Glofox zeros.
    const r = await membershipReadsFor(db, locationId)
    if (!supportsRead(r, 'membershipCounts')) return null
    const [live, trend] = await Promise.all([
      r.reads.membershipCounts(db, locationId),
      fetchMembershipTrend(db, locationId, 12, { zone }),
    ])
    if (!live) return null
    return { live, trend }
  } catch {
    return null
  }
}

// UN1TREAD.3 — the phone's `kpis`. buildBusinessKpis attaches `gate` (decided
// from the reads result its numbers came from); the phone does not get it.
// When the state this route read says the source is CONFIGURED but the vm
// carries no numbers (a diverging state read, or a configured source with no
// counts/revenue read), the phone gets null (its existing BlockError path), not
// a numberless vm that would draw zeros as if they were figures. A source that
// is not configured keeps the numberless vm (zero revenue, never null) that
// pre-M3c phones read unguarded; 2.4.0 draws the state card from
// membership_source instead.
function kpisForPhone(vm, sourceState) {
  if (!vm) return null
  const { gate, ...kpis } = vm
  if (sourceState?.state === 'configured' && !gate?.showNumbers) return null
  return kpis
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
  // TZ.11a — the active studio's calendar (its row already carries timezone).
  const zone = zoneOfLocation(user.activeLocation)
  const now = new Date()
  const [kpis, funnel, ads, membership, today, rail, sourceState] = await Promise.all([
    buildBusinessKpis(db, user, locationId, now.getTime()), // null on failure by contract
    blockData(fetchFunnelCounts(db, locationId, now, zone)),
    // TZ.11c: the 7-day window is in the ad account's zone (account-day.js),
    // NOT the studio's.
    blockData(adsDayZoneForDisplay(db, locationId).then((adsZone) => fetchAdsSummary(db, locationId, now, adsZone))),
    membershipBlock(db, locationId, zone),
    blockData(fetchTodayOps(db, locationId, now, zone)),
    buildNeedsYouRail(db, user, locationId).then(rows => rows, () => null),
    // Belt and braces: membershipStateForPage is built never to throw, but a
    // rejection here must never 500 the route for 2.3.x phones that never
    // read the key.
    membershipStateForPage(db, locationId).catch(() => ({ source: null, state: 'unknown' })),
  ])

  return NextResponse.json({
    success: true,
    data: {
      locationName: user.activeLocation?.name || null,
      kpis: kpisForPhone(kpis, sourceState),
      funnel,
      ads,
      membership,
      today,
      rail,
      membership_source: membershipStatePayload(sourceState, {
        canManage: canManageMembershipSource(user, locationId),
        // This route serves the seam's member counts (membershipBlock above).
        countsRead: true,
      }),
    },
  })
}
