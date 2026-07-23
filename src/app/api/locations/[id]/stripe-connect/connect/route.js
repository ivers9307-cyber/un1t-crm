// POST /api/locations/[id]/stripe-connect/connect
// Ensures this location has a Stripe Connect (Standard) account and returns a
// hosted-onboarding Account Link URL. Account Links MUST be presented in an
// authenticated session (Stripe's rule) — a Manager+ operator action.
// Completes Phase 3c of the paid class-funnel intro.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { getAppUrl } from '@/lib/app-url'
import { createConnectedAccount, createOnboardingLink } from '@/lib/payments/stripe-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const { id: locationId } = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!['master', 'owner', 'manager'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  const denied = assertLocationAccessOr404(user, locationId)
  if (denied) return denied

  const db = createServerClient()
  const { data: loc, error: readErr } = await db.from('locations').select('id, name, settings').eq('id', locationId).maybeSingle()
  if (readErr || !loc) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  try {
    const payments = loc.settings?.payments || {}
    let accountId = payments.stripe_connected_account_id
    if (!accountId) {
      accountId = await createConnectedAccount({ name: loc.name, locationId })
      const nextSettings = { ...(loc.settings || {}), payments: { ...payments, stripe_connected_account_id: accountId } }
      const { error: upErr } = await db.from('locations').update({ settings: nextSettings, updated_at: new Date().toISOString() }).eq('id', locationId)
      if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 500 })
    }
    const base = getAppUrl()
    const url = await createOnboardingLink({
      accountId,
      refreshUrl: `${base}/api/locations/${locationId}/stripe-connect/refresh`,
      returnUrl: `${base}/settings/locations/${locationId}?section=integrations&tab=payments&stripe=return`,
    })
    return NextResponse.json({ success: true, data: { url } })
  } catch (e) {
    return NextResponse.json({ success: false, error: `Stripe onboarding failed: ${e.message || 'unknown'}` }, { status: 502 })
  }
}
