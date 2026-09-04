// GET /api/locations/[id]/stripe-connect/refresh
//
// Stripe sends the operator's browser here when an Account Link has expired or
// was already visited. We mint a fresh link and 302 to it. Runs in the operator's
// authenticated browser session, so the same Manager+ gate applies. Mirrors
// /api/hosts/[id]/stripe/refresh.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { getAppUrl } from '@/lib/app-url'
import { createOnboardingLink } from '@/lib/payments/stripe-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STRIPE_REFRESH_ROLES = Object.freeze(['master', 'owner', 'manager'])

export async function GET(_request, props) {
  const { id: locationId } = await props.params
  const base = getAppUrl()
  const settingsUrl = `${base}/settings/locations/${locationId}?section=integrations&tab=payments`

  const user = await getCurrentUser()
  if (!user) {
    // Session lapsed mid-onboarding — bounce to the (auth-gated) settings page.
    return NextResponse.redirect(settingsUrl)
  }
  // This route MINTS a Stripe onboarding link for the target location's
  // connected account and 302s the browser into it, so the gate matters as
  // much as connect's. It used to read `user.role` — the caller's ACTIVE
  // -location role — so a manager at Stillorgan who is plain staff at Hatch
  // could open Hatch's onboarding just by visiting this URL. Membership,
  // then the role AT THIS LOCATION, both BEFORE createOnboardingLink.
  // head_coach is excluded ON PURPOSE — do not widen to MANAGER_ROLES.
  const denied = assertLocationAccessOr404(user, locationId)
  if (denied) return NextResponse.redirect(settingsUrl)
  if (!hasRoleAtLocation(user, locationId, STRIPE_REFRESH_ROLES)) {
    return NextResponse.redirect(settingsUrl)
  }

  const db = createServerClient()
  const { data: loc } = await db.from('locations').select('settings').eq('id', locationId).maybeSingle()
  const accountId = loc?.settings?.payments?.stripe_connected_account_id
  if (!accountId) return NextResponse.redirect(settingsUrl)

  try {
    const url = await createOnboardingLink({
      accountId,
      refreshUrl: `${base}/api/locations/${locationId}/stripe-connect/refresh`,
      returnUrl: `${settingsUrl}&stripe=return`,
    })
    return NextResponse.redirect(url)
  } catch {
    return NextResponse.redirect(settingsUrl)
  }
}
