// SCHEDULE-SPEND-AGG.1 — GET /api/schedule/contractor-spend
//
// Returns the calendar month's aggregate contractor spend + budget
// utilisation for a location, computed server-side from full pay
// data. Gated to MANAGER_ROLES (master, owner, manager, head_coach)
// so head_coach can see totals + over-budget signals without being
// granted visibility of individual hourly_rate / salary figures —
// the per-coach figures never leave the server.
//
// Query params:
//   location_id     uuid (required)
//   reference_date  YYYY-MM-DD inside the target month (required)
//
// Returns:
//   { success, data: {
//       monthStartIso, monthEndIso,
//       contractorCostEur, fteImplicitCostEur,
//       monthlyBudgetEur, remainingEur, overBudget, utilisationPct
//   }}

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { uuidLike, isoDate, MANAGER_ROLES } from '@/lib/schemas'
import { computeMonthlyContractorSpend } from '@/lib/roster-summary-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QuerySchema = z.object({
  location_id: uuidLike,
  reference_date: isoDate,
})

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
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

  // Location-membership gate (master bypasses).
  if (user.role !== 'master') {
    const userLocationIds = getUserLocationIds(user)
    if (!userLocationIds.includes(location_id)) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
  }

  try {
    const db = createServerClient()
    const data = await computeMonthlyContractorSpend({
      db,
      locationId: location_id,
      referenceDate: reference_date,
    })
    return NextResponse.json({ success: true, data })
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
