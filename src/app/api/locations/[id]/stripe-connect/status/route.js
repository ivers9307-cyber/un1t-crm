// GET /api/locations/[id]/stripe-connect/status — charges-enabled status of the
// location's Stripe connected account, for the payments settings tab.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { retrieveAccountStatus } from '@/lib/payments/stripe-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STRIPE_STATUS_ROLES = Object.freeze(['master', 'owner', 'manager'])

export async function GET(_request, props) {
  const { id: locationId } = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  // Membership first (404 — a detail route must not confirm the id), then
  // the role judged AT THIS LOCATION. `user.role` is the caller's ACTIVE
  // -location role, so a manager at Stillorgan who is plain staff at Hatch
  // could read Hatch's Stripe status. Same tier as connect/select, and
  // head_coach is excluded ON PURPOSE — do not widen this to MANAGER_ROLES.
  const denied = assertLocationAccessOr404(user, locationId)
  if (denied) return denied
  if (!hasRoleAtLocation(user, locationId, STRIPE_STATUS_ROLES)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: loc } = await db.from('locations').select('settings').eq('id', locationId).maybeSingle()
  const accountId = loc?.settings?.payments?.stripe_connected_account_id
  if (!accountId) return NextResponse.json({ success: true, data: { connected: false, charges_enabled: false } })

  try {
    const s = await retrieveAccountStatus(accountId)
    return NextResponse.json({ success: true, data: { connected: true, charges_enabled: s.chargesEnabled, details_submitted: s.detailsSubmitted } })
  } catch (e) {
    return NextResponse.json({ success: false, error: `Stripe status failed: ${e.message || 'unknown'}` }, { status: 502 })
  }
}
