import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'

// DELETE /api/locations/[id]/holidays/[holidayId]
// Removes a custom holiday. Static national holidays are not stored in the
// table and therefore can't be deleted — the UI hides the delete button on
// `source: 'national'` rows.
//
// LOCFIX-ROLEGATE.1 — the role is judged AT params.id, never via `user.role`.
// That field resolves at the caller's ACTIVE location (with a
// highest-role-anywhere fallback in auth.js), while this delete lands on the
// path-param location — so the old `MANAGER_ROLES.includes(user.role)` check
// let a manager at studio A who is plain STAFF at studio B re-open a day B had
// closed, with a 200. Order (the #1589 email-copy shape): target from the
// path, then MEMBERSHIP, then the role AT THAT TARGET. Tier is MANAGER_ROLES
// (head_coach INCLUDED) — deliberately wider than the stripe-connect routes'
// list. The role-miss copy and the 403-for-anonymous are this route's own.
export async function DELETE(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const locationId = params.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()
  const { error } = await db.from('location_holidays')
    .delete()
    .eq('id', params.holidayId)
    .eq('location_id', locationId)  // belt-and-braces — also constrain by parent

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true })
}
