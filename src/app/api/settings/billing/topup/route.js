// INTEG-C2b — POST /api/settings/billing/topup: start a Stripe wallet
// top-up (plain platform charge — no Connect params) and return the
// hosted Checkout URL.
//
// Access mirrors the sibling auto-topup route exactly: owner-of-that-
// org (getOwnerOrganizationIds, incl. SAAS-4 org admins) or master;
// a foreign/unknown location_id answers 404, never 403 (no cross-
// tenant existence probing). On top of that, createTopup enforces the
// two business gates: the fixed denomination whitelist (also pinned by
// the Zod schema here) and an ACTIVE tier pinning — nothing is pinned
// today, so this route is unreachable-in-effect until the master pins
// a plan.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getOwnerOrganizationIds } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'
import { createTopup, TOPUP_DENOMINATIONS_CENTS } from '@/lib/wallet-topup'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Server-side whitelist: the fixed denominations, nothing free-form.
export const TopupSchema = z.object({
  location_id: uuidLike,
  amount_cents: z
    .number()
    .int()
    .refine((v) => TOPUP_DENOMINATIONS_CENTS.includes(v), {
      message: `amount_cents must be one of ${TOPUP_DENOMINATIONS_CENTS.join(', ')}`,
    }),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (user.role !== 'owner' && user.role !== 'master') {
    return NextResponse.json(
      { success: false, error: 'Wallet top-ups are made by an owner' },
      { status: 403 }
    )
  }

  const validation = await validateBody(request, TopupSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()

  // Resolve the location's org; foreign or missing → identical 404.
  const { data: location } = await db
    .from('locations')
    .select('id, organization_id')
    .eq('id', body.location_id)
    .maybeSingle()
  if (!location) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  if (user.role !== 'master') {
    const owned = getOwnerOrganizationIds(user)
    if (!location.organization_id || !owned.includes(location.organization_id)) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
  }

  try {
    const { checkoutUrl, invoiceId, number } = await createTopup(db, {
      locationId: location.id,
      amountCents: body.amount_cents,
      userId: user.id,
    })
    return NextResponse.json({
      success: true,
      data: { checkout_url: checkoutUrl, invoice_id: invoiceId, number },
    })
  } catch (e) {
    if (e?.code === 'invalid_denomination' || e?.code === 'not_pinned') {
      return NextResponse.json({ success: false, error: e.message }, { status: 400 })
    }
    if (e?.code === 'location_not_found') {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
    // Stripe/DB failure — log server-side, keep the response generic.
    logError('wallet-topup', 'createTopup failed', { err: e, locationId: location.id })
    return NextResponse.json(
      { success: false, error: 'Could not start the top-up checkout. Try again.' },
      { status: 502 }
    )
  }
}
