// GET /api/hosts/[id]/stripe/refresh
//
// Stripe sends the operator's browser here when an Account Link has expired or
// was already visited. We mint a fresh link and 302 to it. Runs in the operator's
// authenticated browser session, so the same Manager+ gate applies. (EVENTS-HOST.2)

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { getAppUrl } from '@/lib/app-url'
import { loadHostForOrg } from '@/lib/hosts'
import { createOnboardingLink } from '@/lib/payments/stripe-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params
  const base = getAppUrl()
  const settingsUrl = `${base}/settings/hosts/${params.id}`

  const user = await getCurrentUser()
  if (!user || !['master', 'owner', 'manager'].includes(user.role)) {
    // Session lapsed mid-onboarding — bounce to the (auth-gated) host page,
    // which will send them through login and back.
    return NextResponse.redirect(settingsUrl)
  }
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return NextResponse.redirect(settingsUrl)

  const db = createServerClient()
  const host = await loadHostForOrg(db, params.id, orgId)
  if (!host || !host.stripe_connected_account_id) return NextResponse.redirect(settingsUrl)

  try {
    const url = await createOnboardingLink({
      accountId: host.stripe_connected_account_id,
      refreshUrl: `${base}/api/hosts/${host.id}/stripe/refresh`,
      returnUrl: `${base}/settings/hosts/${host.id}?stripe=return`,
    })
    return NextResponse.redirect(url)
  } catch {
    return NextResponse.redirect(settingsUrl)
  }
}
