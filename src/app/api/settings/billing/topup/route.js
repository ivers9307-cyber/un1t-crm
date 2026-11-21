// INTEG-C2b — POST /api/settings/billing/topup: start a Stripe wallet
// top-up (plain platform charge — no Connect params) and return the
// hosted Checkout URL.
//
// Access mirrors the sibling auto-topup route exactly: an organisation
// admin of the location's org (C18 ORGROLE.1: master or an org_admin
// grant; a studio owner is not one);
// a foreign/unknown location_id answers 404, never 403 (no cross-
// tenant existence probing). On top of that, createTopup enforces the
// two business gates: the fixed denomination whitelist (also pinned by
// the Zod schema here) and an ACTIVE tier pinning — nothing is pinned
// today, so this route is unreachable-in-effect until the master pins
// a plan.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { isOrgAdmin, isOrgAdminSomewhere } from '@/lib/org-admin'
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

// withAuth only signs the caller in. Every check after it runs by hand, in the
// order it always has: org admin somewhere 403, body 400, the location's
// organisation 404; the checkout it starts is unchanged.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  // C18 ORGROLE.1 — organisation admins only (master or an org_admin grant);
  // the coarse check here, the location's organisation below.
  if (!isOrgAdminSomewhere(user)) {
    return NextResponse.json(
      { success: false, error: 'Wallet top-ups are made by an organisation admin' },
      { status: 403 }
    )
  }

  const validation = await validateBody(request, TopupSchema)
  if (!validation.ok) return validation.response
  const body = validation.data


  // Resolve the location's org; foreign or missing → identical 404.
  const { data: location, error: locationError } = await db
    .from('locations')
    .select('id, organization_id')
    .eq('id', body.location_id)
    .maybeSingle()
  if (locationError) {
    return NextResponse.json({ success: false, error: 'Could not read the location just now. Try again.' }, { status: 500 })
  }
  if (!location) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  // An org-less location is master-only (isOrgAdmin answers false for null).
  if (!isOrgAdmin(user, location.organization_id)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
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
})
