// POST /api/hosts/[id]/stripe/connect
//
// Ensures the host has a Stripe connected account (creates a Standard account
// on first call) and returns a hosted-onboarding Account Link URL. The operator
// UI redirects the browser to that URL — Account Links MUST be presented inside
// an authenticated session (Stripe's rule), which a Manager+ operator page is.
// (EVENTS-HOST.2)

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { getAppUrl } from '@/lib/app-url'
import { loadHostForOrg } from '@/lib/hosts'
import { createConnectedAccount, createOnboardingLink } from '@/lib/payments/stripe-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The caller is signed in by withAuth; the role and organisation checks keep
// their old order and answers.
function gate(user) {
  if (!['master', 'owner', 'manager'].includes(user.role)) {
    return { error: NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 }) }
  }
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return { error: NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 }) }
  return { user, orgId }
}

// Sign-in only: Manager+ on the active role (403), the active organisation
// (400), then the host read within it (404), as before.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const g = gate(user)
  if (g.error) return g.error
  const host = await loadHostForOrg(db, params?.id, g.orgId)
  if (!host) return NextResponse.json({ success: false, error: 'Host not found' }, { status: 404 })
  if (host.payment_provider !== 'stripe_connect') {
    return NextResponse.json({ success: false, error: 'This host is not a Stripe Connect host.' }, { status: 400 })
  }

  try {
    let accountId = host.stripe_connected_account_id
    if (!accountId) {
      accountId = await createConnectedAccount({ name: host.name, email: host.email, hostId: host.id })
      const { error: upErr } = await db
        .from('event_hosts')
        .update({ stripe_connected_account_id: accountId })
        .eq('id', host.id)
      if (upErr) {
        logError('host-stripe-connect', 'saving the connected account failed', { hostId: host.id, err: upErr })
        return NextResponse.json({ success: false, error: 'Could not save the Stripe account. Try again.' }, { status: 500 })
      }
    }
    const base = getAppUrl()
    const url = await createOnboardingLink({
      accountId,
      refreshUrl: `${base}/api/hosts/${host.id}/stripe/refresh`,
      returnUrl: `${base}/settings/hosts/${host.id}?stripe=return`,
    })
    return NextResponse.json({ success: true, data: { url } })
  } catch (e) {
    logError('host-stripe-connect', 'Stripe onboarding failed', { hostId: host.id, err: e })
    return NextResponse.json(
      { success: false, error: 'Stripe onboarding failed. Try again.' },
      { status: 502 },
    )
  }
})
