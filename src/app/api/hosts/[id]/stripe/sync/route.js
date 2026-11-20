// POST /api/hosts/[id]/stripe/sync
//
// Pull the host's live Stripe status (charges_enabled etc.) and persist it.
// Called by the host page on the onboarding return_url — return_url only means
// the host exited the flow, so we retrieve the account for the truth. The
// account.updated webhook keeps it fresh thereafter. (EVENTS-HOST.2)

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { HOST_COLS, loadHostForOrg } from '@/lib/hosts'
import { retrieveAccountStatus } from '@/lib/payments/stripe-connect'
import { registerCheckoutDomainsForAccount } from '@/lib/payments/apple-pay-domains'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// withAuth only signs the caller in (the same 401); the manager rule (403) and
// the active organisation (400) keep their order and texts here.
function gate(user) {
  if (!['master', 'owner', 'manager'].includes(user.role)) {
    return { error: NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 }) }
  }
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return { error: NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 }) }
  return { user, orgId }
}

export const POST = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const g = gate(user)
  if (g.error) return g.error
  const host = await loadHostForOrg(db, params.id, g.orgId)
  if (!host) return NextResponse.json({ success: false, error: 'Host not found' }, { status: 404 })
  if (!host.stripe_connected_account_id) {
    return NextResponse.json({ success: true, data: host })
  }

  try {
    const st = await retrieveAccountStatus(host.stripe_connected_account_id)
    const updates = {
      charges_enabled: st.chargesEnabled,
      payouts_enabled: st.payoutsEnabled,
      details_submitted: st.detailsSubmitted,
      requirements_currently_due: st.requirementsCurrentlyDue,
    }
    if (st.chargesEnabled && !host.onboarding_completed_at) {
      updates.onboarding_completed_at = new Date().toISOString()
    }
    const { data, error } = await db
      .from('event_hosts')
      .update(updates)
      .eq('id', host.id)
      .select(HOST_COLS)
      .single()
    if (error) {
      logError('host-stripe-sync', 'status save failed', { hostId: host.id, err: error })
      return NextResponse.json({ success: false, error: 'Could not save the Stripe status. Try again.' }, { status: 500 })
    }
    // HOSTAPPLEPAY.1 — once the host can charge, register our checkout
    // domains on their account so Apple Pay shows on their checkout. Best
    // effort (never throws); the daily cron retries anything missed.
    if (st.chargesEnabled) await registerCheckoutDomainsForAccount(db, host.stripe_connected_account_id)
    return NextResponse.json({ success: true, data })
  } catch (e) {
    logError('host-stripe-sync', 'Stripe sync failed', { hostId: host.id, err: e })
    return NextResponse.json(
      { success: false, error: 'Stripe sync failed. Try again.' },
      { status: 502 },
    )
  }
})
