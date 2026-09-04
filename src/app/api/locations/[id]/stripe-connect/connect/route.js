// POST /api/locations/[id]/stripe-connect/connect
// Ensures this location has a Stripe Connect (Standard) account and returns a
// hosted-onboarding Account Link URL. Account Links MUST be presented in an
// authenticated session (Stripe's rule) — a Manager+ operator action.
// Completes Phase 3c of the paid class-funnel intro.
//
// LOCFIX-ROLEGATE.1 — the role is judged AT params.id, never via `user.role`.
// That field resolves at the caller's ACTIVE location (with a
// highest-role-anywhere fallback in auth.js), while this route acts on the
// path-param location — so the old `['master','owner','manager'].includes(
// user.role)` check let a manager at studio A who is plain STAFF at studio B
// POST /api/locations/<B>/stripe-connect/connect, mint a Stripe connected
// account against B and receive a hosted-onboarding link into it, with a 200.
//
// Order (the #1589 email-copy shape, with this route's own membership helper):
// target from the path, then MEMBERSHIP via assertLocationAccessOr404 — this
// is a DETAIL route and the 404 is deliberate, so a foreign location id is
// indistinguishable from a missing one — then the role AT THAT TARGET, then
// the fetch and the Stripe calls. BOTH GUARDS RUN BEFORE ANY STRIPE CALL:
// createConnectedAccount is an irreversible external side effect, so a
// refused caller must never reach it.
//
// TIER: this list is ['master','owner','manager'] and deliberately EXCLUDES
// head_coach — narrower than the MANAGER_ROLES used by the holidays/channels
// routes, because this mints a payment account. Do not widen it to
// MANAGER_ROLES for consistency; the difference is the point.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { getAppUrl } from '@/lib/app-url'
import { createConnectedAccount, createOnboardingLink } from '@/lib/payments/stripe-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Money-adjacent tier — NOT MANAGER_ROLES. head_coach is excluded on purpose
// (see the header): this handler mints a Stripe connected account.
const STRIPE_CONNECT_ROLES = Object.freeze(['master', 'owner', 'manager'])

export async function POST(_request, props) {
  const { id: locationId } = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const denied = assertLocationAccessOr404(user, locationId)
  if (denied) return denied
  if (!hasRoleAtLocation(user, locationId, STRIPE_CONNECT_ROLES)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

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
