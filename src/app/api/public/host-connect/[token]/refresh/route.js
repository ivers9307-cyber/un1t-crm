// GET /api/public/host-connect/[token]/refresh
//
// Public — token-gated. Stripe sends the host's browser here when their Account
// Link expired or was already used; we mint a fresh one and 302 to it. Falls
// back to the token page on any problem. (EVENTS-HOST.5)

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getAppUrl } from '@/lib/app-url'
import { verifyHostOnboardingToken } from '@/lib/host-onboarding-tokens'
import { createOnboardingLink } from '@/lib/payments/stripe-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params
  const base = getAppUrl()
  const pageUrl = `${base}/host-connect/${params.token}`

  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || null
  const payload = secret ? verifyHostOnboardingToken(params.token, secret) : null
  if (!payload) return NextResponse.redirect(pageUrl)

  const db = createServerClient()
  const { data: host } = await db
    .from('event_hosts')
    .select('id, stripe_connected_account_id')
    .eq('id', payload.hostId)
    .maybeSingle()
  if (!host || !host.stripe_connected_account_id) return NextResponse.redirect(pageUrl)

  try {
    const url = await createOnboardingLink({
      accountId: host.stripe_connected_account_id,
      refreshUrl: `${base}/api/public/host-connect/${params.token}/refresh`,
      returnUrl: `${base}/host-connect/${params.token}?done=1`,
    })
    return NextResponse.redirect(url)
  } catch {
    return NextResponse.redirect(pageUrl)
  }
}
