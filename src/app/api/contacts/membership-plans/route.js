// GET /api/contacts/membership-plans
//
// CHURN-PREP.2 — lists the distinct Glofox membership plan names
// currently held by contacts at the operator's active location
// (e.g. "3 Month Membership", "10 Class Pack"). Powers the
// "Membership Plan" value dropdown in the AudienceBuilder — the plan
// catalog is operator-defined, so it can't be a hardcoded enum.
//
// Returns:
//   { success, data: ['10 Class Pack', '3 Month Membership', ...] }
//
// Manager+ only. Master without an active location selected sees the
// plans across all locations.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const db = createServerClient()
  // Scope to the operator's ACTIVE location, mirroring /api/segments.
  const activeLocationId = user.activeLocation?.id || null
  if (!activeLocationId && user.role !== 'master') {
    return NextResponse.json({ success: true, data: [] })
  }

  let q = db
    .from('contacts')
    .select('glofox_membership_plan')
    .not('glofox_membership_plan', 'is', null)
  if (activeLocationId) q = q.eq('location_id', activeLocationId)
  const { data, error } = await q.limit(20000)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  // The Supabase JS client has no DISTINCT, so de-dup in memory. The
  // plan catalog is tiny (a dozen-ish), so the row scan is cheap.
  const plans = Array.from(
    new Set((data || []).map(r => r.glofox_membership_plan).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b))

  return NextResponse.json({ success: true, data: plans })
}
