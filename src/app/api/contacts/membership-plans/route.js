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
import { withAuth } from '@/lib/with-auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The role at the ACTIVE studio (withAuth's roles, the same includes(user.role)
// check as before) with the same 403 text; no active studio is required, a
// master without one reads every studio's plans, as before.
export const GET = withAuth({ permission: null, location: false, roles: MANAGER_ROLES, forbiddenMessage: 'Manager+ required' }, async ({ user, db }) => {
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
    logError('contacts', 'membership plans read failed', { err: error })
    return NextResponse.json({ success: false, error: 'Could not load the membership plans.' }, { status: 500 })
  }

  // The Supabase JS client has no DISTINCT, so de-dup in memory. The
  // plan catalog is tiny (a dozen-ish), so the row scan is cheap.
  const plans = Array.from(
    new Set((data || []).map(r => r.glofox_membership_plan).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b))

  return NextResponse.json({ success: true, data: plans })
})
