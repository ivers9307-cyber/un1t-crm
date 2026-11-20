// PATCH /api/offer-stock/[id] — set or clear a sale offer's stock limit
// (OFFERSTOCK.1). Owners, managers and masters at the offer's studio. An id
// outside the caller's studios is a 404, so offer ids can't be enumerated.
//
// A limit below what has already sold is allowed: the offer simply reads as
// sold out. Paid purchases are never touched.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { hasRoleAtLocation } from '@/lib/role-at-location'
import { ADMIN_ROLES } from '@/lib/schemas'
import { uuidLike, validateBody } from '@/lib/validate'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'

export const offerStockSchema = z.object({
  stock_limit: z.number().int().min(1).max(100000).nullable(),
})

const NOT_FOUND = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

// withAuth only signs the caller in; the id, the body, the offer's studio
// (404) and the role AT that studio (403) follow in their old order.
export const PATCH = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const id = params?.id
  if (!uuidLike.safeParse(id).success) return NOT_FOUND()

  const parsed = await validateBody(request, offerStockSchema)
  if (!parsed.ok) return parsed.response

  const { data: offer, error: readErr } = await db
    .from('sale_offers')
    .select('id, location_id')
    .eq('id', id)
    .maybeSingle()
  if (readErr) {
    logError('offers', 'offer unreadable for the stock limit', { offerId: id, code: readErr.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not save the limit' }, { status: 500 })
  }
  if (!offer) return NOT_FOUND()
  const guard = assertLocationAccessOr404(user, offer.location_id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, offer.location_id, ADMIN_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const { data: saved, error } = await db
    .from('sale_offers')
    .update({ stock_limit: parsed.data.stock_limit, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('location_id', offer.location_id)
    .select('id')
  if (error || !Array.isArray(saved) || saved.length !== 1) {
    logError('offers', 'stock limit not saved', { offerId: id, code: error?.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not save the limit' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: { id, stock_limit: parsed.data.stock_limit } })
})
