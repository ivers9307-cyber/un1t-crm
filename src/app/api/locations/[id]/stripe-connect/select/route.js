// POST /api/locations/[id]/stripe-connect/select  { provider }
//
// Commits the class-funnel payment RAIL for this location
// (locations.settings.payments.provider). Deliberately a SERVER route with a
// location-scoped guard rather than a client-side settings write: `provider`
// (plus the connected-account id set by the connect route) routes real money, so
// it must NOT rely on the broad "owners/masters can manage locations" RLS policy
// (which authorises by the caller's GLOBAL role, not membership in THIS location).
// Also enforces server-side that Stripe can only be selected once the account is
// charges-enabled — the client guard alone is bypassable.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { retrieveAccountStatus } from '@/lib/payments/stripe-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PROVIDERS = new Set(['revolut', 'stripe_connect'])

export async function POST(request, props) {
  const { id: locationId } = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!['master', 'owner', 'manager'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  const denied = assertLocationAccessOr404(user, locationId)
  if (denied) return denied

  let body = {}
  try { body = await request.json() } catch { /* empty */ }
  const provider = body?.provider
  if (!PROVIDERS.has(provider)) {
    return NextResponse.json({ success: false, error: 'Invalid provider' }, { status: 400 })
  }

  const db = createServerClient()
  const { data: loc, error: readErr } = await db.from('locations').select('settings').eq('id', locationId).maybeSingle()
  if (readErr || !loc) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const payments = loc.settings?.payments || {}

  // Stripe can only be committed once the connected account can actually charge.
  if (provider === 'stripe_connect') {
    const accountId = payments.stripe_connected_account_id
    if (!accountId) return NextResponse.json({ success: false, error: 'Connect Stripe first.' }, { status: 400 })
    try {
      const s = await retrieveAccountStatus(accountId)
      if (!s.chargesEnabled) {
        return NextResponse.json({ success: false, error: 'Finish Stripe onboarding (charges must be enabled) before switching to Stripe.' }, { status: 400 })
      }
    } catch (e) {
      return NextResponse.json({ success: false, error: `Stripe status failed: ${e.message || 'unknown'}` }, { status: 502 })
    }
  }

  const nextSettings = { ...(loc.settings || {}), payments: { ...payments, provider } }
  const { error: upErr } = await db.from('locations').update({ settings: nextSettings, updated_at: new Date().toISOString() }).eq('id', locationId)
  if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 500 })
  return NextResponse.json({ success: true, data: { provider } })
}
