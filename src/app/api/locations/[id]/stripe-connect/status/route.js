// GET /api/locations/[id]/stripe-connect/status — charges-enabled status of the
// location's Stripe connected account, for the payments settings tab.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { retrieveAccountStatus } from '@/lib/payments/stripe-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const { id: locationId } = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!['master', 'owner', 'manager'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  const denied = assertLocationAccessOr404(user, locationId)
  if (denied) return denied

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
