// POST /api/hosts/[id]/stripe/sync
//
// Pull the host's live Stripe status (charges_enabled etc.) and persist it.
// Called by the host page on the onboarding return_url — return_url only means
// the host exited the flow, so we retrieve the account for the truth. The
// account.updated webhook keeps it fresh thereafter. (EVENTS-HOST.2)

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { HOST_COLS, loadHostForOrg } from '@/lib/hosts'
import { retrieveAccountStatus } from '@/lib/payments/stripe-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function gate() {
  const user = await getCurrentUser()
  if (!user) return { error: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  if (!['master', 'owner', 'manager'].includes(user.role)) {
    return { error: NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 }) }
  }
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return { error: NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 }) }
  return { user, orgId }
}

export async function POST(_request, props) {
  const params = await props.params
  const g = await gate()
  if (g.error) return g.error
  const db = createServerClient()
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
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: `Stripe sync failed: ${e.message || 'unknown'}` },
      { status: 502 },
    )
  }
}
