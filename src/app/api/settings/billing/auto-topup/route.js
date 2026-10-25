// INTEG-D1 — PATCH /api/settings/billing/auto-topup: the wallet
// auto-top-up CONFIG knobs (wallets.auto_topup_enabled /
// _amount_cents / _threshold_cents, mig 420).
//
// These three columns are CONFIG, not balance — dormant until the
// Stripe top-up leg ships (nothing reads them yet), so a direct write
// here does not violate the "wallet_apply is the ONLY wallet write
// path" invariant: that invariant protects balance_cents + the
// append-only ledger, which this route never touches. The upsert
// payload carries ONLY location_id + the three config columns (+
// updated_at), so an existing row's balance_cents survives untouched;
// on a first-ever config write the insert creates the wallet row with
// the column default balance 0 (the same row wallet_apply would
// lazily create).
//
// Access: an organisation admin of the location's org (C18 ORGROLE.1:
// master or an org_admin grant; a studio owner is not one). A foreign/unknown location_id answers 404,
// never 403 (no cross-tenant existence probing).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { isOrgAdmin, isOrgAdminSomewhere } from '@/lib/org-admin'
import { validateBody, uuidLike } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Bounds are the D1 spec: amount €5–€500, threshold €0–€200. null
// clears a value (config is dormant until the Stripe leg, so a
// cleared value has nothing to break).
export const AutoTopupSchema = z.object({
  location_id: uuidLike,
  enabled: z.boolean(),
  amount_cents: z.number().int().min(500).max(50000).nullable().optional(),
  threshold_cents: z.number().int().min(0).max(20000).nullable().optional(),
})

export async function PATCH(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  // C18 ORGROLE.1 — organisation admins only (master or an org_admin grant);
  // the coarse check here, the location's organisation below.
  if (!isOrgAdminSomewhere(user)) {
    return NextResponse.json(
      { success: false, error: 'Auto-top-up is configured by an organisation admin' },
      { status: 403 }
    )
  }

  const validation = await validateBody(request, AutoTopupSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()

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

  const patch = {
    location_id: location.id,
    auto_topup_enabled: body.enabled,
    updated_at: new Date().toISOString(),
  }
  if ('amount_cents' in body) patch.auto_topup_amount_cents = body.amount_cents
  if ('threshold_cents' in body) patch.auto_topup_threshold_cents = body.threshold_cents

  const { data, error } = await db
    .from('wallets')
    .upsert(patch, { onConflict: 'location_id' })
    .select('auto_topup_enabled, auto_topup_amount_cents, auto_topup_threshold_cents')
    .single()
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}
