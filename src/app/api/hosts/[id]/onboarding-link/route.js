// POST /api/hosts/[id]/onboarding-link
//
// Operator action: mint a secure, self-serve onboarding link for a Stripe host.
// UN1T sends this link (email / WhatsApp / copy-paste) to the host; the host
// opens it with NO login and connects their OWN Stripe account via the
// token-gated public page. Manager+ (ADMIN_ROLES), org-scoped. (EVENTS-HOST.5)

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { getAppUrl } from '@/lib/app-url'
import { ADMIN_ROLES } from '@/lib/schemas'
import { loadHostForOrg } from '@/lib/hosts'
import { signHostOnboardingToken } from '@/lib/host-onboarding-tokens'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!ADMIN_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 })

  const db = createServerClient()
  const host = await loadHostForOrg(db, params.id, orgId)
  if (!host) return NextResponse.json({ success: false, error: 'Host not found' }, { status: 404 })
  if (host.payment_provider !== 'stripe_connect') {
    return NextResponse.json({ success: false, error: 'Only Stripe Connect hosts need an onboarding link.' }, { status: 400 })
  }

  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || null
  if (!secret) return NextResponse.json({ success: false, error: 'server_misconfigured' }, { status: 500 })
  const token = signHostOnboardingToken({ hostId: host.id }, secret)
  return NextResponse.json({ success: true, data: { url: `${getAppUrl()}/host-connect/${token}` } })
}
