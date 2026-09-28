// SCHEDULE-SPEND-AGG.1 — GET /api/schedule/contractor-spend
//
// Returns the calendar month's aggregate contractor spend + budget
// utilisation for a location, computed server-side from full pay
// data. Gated to MANAGER_ROLES (master, owner, manager, head_coach)
// so head_coach can see contractor totals + over-budget signals without
// being granted visibility of individual hourly_rate / salary figures —
// the per-coach figures never leave the server.
//
// SCHEDROLES.1 — the role is judged AT location_id (hasRoleAtLocation),
// never from `user.role` (the ACTIVE studio's role).
//
// FTECOSTVIS.1 (Richard, 28 Sep 2026: "keep the cost hidden") — the FTE
// labour total is salary-derived (one employee's pay, in a month only they
// work), so it goes to owner / manager / master AT location_id only. A head
// coach gets 200 with the contractor keys and no fteImplicitCostEur
// (contractorSpendOnly, an allowlist).
//
// Query params:
//   location_id     uuid (required)
//   reference_date  YYYY-MM-DD inside the target month (required)
//
// Returns (studio TOTALS only — CONTRACTORSPEND.1 pins the key list in
// src/lib/roster-summary-server.test.js):
//   { success, data: {
//       monthStartIso, monthEndIso,
//       contractorCostEur,              // PUBLISHED shifts, every holder
//       unpublishedContractorCostEur,   // drafts + shifts no roster owns yet
//       projectedContractorCostEur,     // the two together
//       fteImplicitCostEur,             // published, context only; ADMIN_ROLES at location_id only
//       monthlyBudgetEur, remainingEur, overBudget, projectedOverBudget, utilisationPct
//   }}

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { uuidLike, realIsoDate, MANAGER_ROLES, ADMIN_ROLES } from '@/lib/schemas'
import { computeMonthlyContractorSpend, contractorSpendOnly } from '@/lib/roster-summary-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QuerySchema = z.object({
  location_id: uuidLike,
  // DATECHECK.1 — a real date, not just the shape: 2026-02-30 was read as
  // 2 March and answered 200 with March's spend and budget, silently.
  reference_date: realIsoDate,
})

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    location_id: url.searchParams.get('location_id'),
    reference_date: url.searchParams.get('reference_date'),
  })
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }
  const { location_id, reference_date } = parsed.data

  // Location-membership gate, then the role THERE (master bypasses both).
  if (user.role !== 'master') {
    const userLocationIds = getUserLocationIds(user)
    if (!userLocationIds.includes(location_id)) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
  }
  if (!hasRoleAtLocation(user, location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  try {
    const db = createServerClient()
    const data = await computeMonthlyContractorSpend({
      db,
      locationId: location_id,
      referenceDate: reference_date,
    })
    // FTECOSTVIS.1 (Richard, 28 Sep 2026: "keep the cost hidden") — the FTE
    // labour total is salary-derived: owner / manager / master AT location_id
    // only. Everyone else gets the contractor figures through an allowlist, so
    // a key added to the aggregate later stays behind until it is classified.
    const fteCostVisible = hasRoleAtLocation(user, location_id, ADMIN_ROLES)
    return NextResponse.json({ success: true, data: fteCostVisible ? data : contractorSpendOnly(data) })
  } catch (e) {
    if (e?.code === 'LOCATION_NOT_FOUND') {
      return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
    }
    return NextResponse.json(
      { success: false, error: e?.message || 'Failed to compute contractor spend' },
      { status: 500 },
    )
  }
}
