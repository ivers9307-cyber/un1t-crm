// GET /api/locations/[id]/stripe-connect/status — charges-enabled status of the
// location's Stripe connected account, for the payments settings tab.
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { retrieveAccountStatus } from '@/lib/payments/stripe-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STRIPE_STATUS_ROLES = Object.freeze(['master', 'owner', 'manager'])

export const GET = withAuth({ permission: null, location: 'param', roles: STRIPE_STATUS_ROLES, forbiddenMessage: 'Manager+ required' }, async ({ db, locationId }) => {
  const { data: loc } = await db.from('locations').select('settings').eq('id', locationId).maybeSingle()
  const accountId = loc?.settings?.payments?.stripe_connected_account_id
  if (!accountId) return NextResponse.json({ success: true, data: { connected: false, charges_enabled: false } })

  try {
    const s = await retrieveAccountStatus(accountId)
    return NextResponse.json({ success: true, data: { connected: true, charges_enabled: s.chargesEnabled, details_submitted: s.detailsSubmitted } })
  } catch (e) {
    return NextResponse.json({ success: false, error: `Stripe status failed: ${e.message || 'unknown'}` }, { status: 502 })
  }
})
