// GET /api/public/host-connect/[token]
//
// Public — token-gated. Read-only host status for the self-serve onboarding
// page. The signed token authenticates the caller as this host; only
// non-sensitive fields are returned. (EVENTS-HOST.5)
//
// EVENTS-HOST.6: while the host is still PENDING (has a connected account but
// charges_enabled is false), pull live status straight from Stripe and persist
// it — the public page has no operator to click "Refresh status", and trusting
// only the account.updated webhook leaves a host who JUST finished onboarding
// stuck on "you haven't finished". Bounded to pending hosts (once charges flips
// true we stop calling Stripe); Stripe errors fall back to the DB snapshot.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyHostOnboardingToken } from '@/lib/host-onboarding-tokens'
import { retrieveAccountStatus } from '@/lib/payments/stripe-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || null
  const payload = secret ? verifyHostOnboardingToken(params.token, secret) : null
  if (!payload) {
    return NextResponse.json({ success: false, error: 'This onboarding link is invalid or has expired.' }, { status: 400 })
  }
  const db = createServerClient()
  const { data: host } = await db
    .from('event_hosts')
    .select('id, name, payment_provider, charges_enabled, payouts_enabled, details_submitted, stripe_connected_account_id, onboarding_completed_at')
    .eq('id', payload.hostId)
    .maybeSingle()
  if (!host || host.payment_provider !== 'stripe_connect') {
    return NextResponse.json({ success: false, error: 'Host not found.' }, { status: 404 })
  }

  let charges = !!host.charges_enabled
  let payouts = !!host.payouts_enabled
  let details = !!host.details_submitted

  // Live-refresh from Stripe for a pending host (mirrors the operator sync
  // route). Fire-and-forget on the persist; if Stripe is unreachable or not
  // configured we keep the DB snapshot rather than 500 the host's page.
  if (host.stripe_connected_account_id && !charges) {
    try {
      const st = await retrieveAccountStatus(host.stripe_connected_account_id)
      charges = !!st.chargesEnabled
      payouts = !!st.payoutsEnabled
      details = !!st.detailsSubmitted
      const updates = {
        charges_enabled: st.chargesEnabled,
        payouts_enabled: st.payoutsEnabled,
        details_submitted: st.detailsSubmitted,
        requirements_currently_due: st.requirementsCurrentlyDue,
      }
      if (st.chargesEnabled && !host.onboarding_completed_at) {
        updates.onboarding_completed_at = new Date().toISOString()
      }
      await db.from('event_hosts').update(updates).eq('id', host.id)
    } catch {
      // Stripe unreachable / unconfigured — fall back to the DB snapshot.
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      name: host.name,
      charges_enabled: charges,
      payouts_enabled: payouts,
      details_submitted: details,
      connected: !!host.stripe_connected_account_id,
    },
  })
}
