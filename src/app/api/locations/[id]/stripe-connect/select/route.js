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
//
// LOCFIX-ROLEGATE.1 — the role is judged AT params.id, never via `user.role`.
// That field resolves at the caller's ACTIVE location (with a
// highest-role-anywhere fallback in auth.js), so the location-scoped guard
// this header describes was only half present: MEMBERSHIP was judged at the
// target, but the ROLE was judged at the caller's active studio. A manager at
// studio A who is plain staff at studio B could POST
// /api/locations/<B>/stripe-connect/select and move where B's class-funnel
// money lands, with a 200.
//
// Order (the #1589 email-copy shape, with this route's own membership helper):
// target from the path, then MEMBERSHIP via assertLocationAccessOr404 — this
// is a DETAIL route and the 404 is deliberate — then the role AT THAT TARGET,
// then the provider parse, the fetch and the Stripe status call. BOTH GUARDS
// RUN BEFORE ANY STRIPE CALL (retrieveAccountStatus).
//
// TIER: ['master','owner','manager'], deliberately EXCLUDING head_coach —
// narrower than the MANAGER_ROLES used by the holidays/channels routes,
// because this switches the live payment provider. Do not widen it.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { retrieveAccountStatus } from '@/lib/payments/stripe-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Money-adjacent tier — NOT MANAGER_ROLES. head_coach is excluded on purpose
// (see the header): this handler switches the LIVE payment provider.
const STRIPE_SELECT_ROLES = Object.freeze(['master', 'owner', 'manager'])

const PROVIDERS = new Set(['revolut', 'stripe_connect'])

export async function POST(request, props) {
  const { id: locationId } = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const denied = assertLocationAccessOr404(user, locationId)
  if (denied) return denied
  if (!hasRoleAtLocation(user, locationId, STRIPE_SELECT_ROLES)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

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
