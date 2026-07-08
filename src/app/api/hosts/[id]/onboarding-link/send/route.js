// POST /api/hosts/[id]/onboarding-link/send
//
// Operator action: EMAIL the self-serve Stripe onboarding link straight to the
// host (instead of copy-paste). Mints the same signed token as the copy-link
// route, then sends a branded transactional email to the host's email on file.
// Manager+ (ADMIN_ROLES), org-scoped. (EVENTS-HOST.9)
//
// WhatsApp delivery is intentionally not wired: event_hosts has no phone
// column yet — add one (+ a channel selector) as a follow-up.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { getAppUrl } from '@/lib/app-url'
import { ADMIN_ROLES } from '@/lib/schemas'
import { loadHostForOrg } from '@/lib/hosts'
import { signHostOnboardingToken } from '@/lib/host-onboarding-tokens'
import { sendHostOnboardingEmail } from '@/lib/host-onboarding-email'

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
  if (!host.email) {
    return NextResponse.json({ success: false, error: 'This host has no email on file — add one, or copy the link and send it yourself.' }, { status: 400 })
  }

  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || null
  if (!secret) return NextResponse.json({ success: false, error: 'server_misconfigured' }, { status: 500 })
  const token = signHostOnboardingToken({ hostId: host.id }, secret)
  const url = `${getAppUrl()}/host-connect/${token}`

  try {
    await sendHostOnboardingEmail({ host, url })
  } catch (e) {
    return NextResponse.json({ success: false, error: `Could not send the email: ${e.message || 'unknown'}` }, { status: 502 })
  }
  return NextResponse.json({ success: true, data: { sentTo: host.email } })
}
