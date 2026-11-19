// OFFERSEDIT.1 — PATCH /api/locations/[id]/offers/[offerId]: edit one offer.
// Owners and masters AT the studio; an offer at another studio, or an id that
// is not one, is a 404. The web address never changes (links and ads point at
// it). An offer left active must still be sellable (offerSaleProblems);
// switching it off is always allowed. Paid purchases are never touched.
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { uuidLike } from '@/lib/schemas'
import { logError } from '@/lib/log'
import { OFFER_EDITOR_COLUMNS, offerUpdateSchema, offerSaleProblems } from '@/lib/offers-admin'
import { readStudioForOffers, readUn1tProducts, productFor } from '@/lib/offers-admin-db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (status, error, extra = {}) => NextResponse.json({ success: false, error, ...extra }, { status })
const NOT_FOUND = () => fail(404, 'Not found')

export const PATCH = withAuth({ permission: 'approvals_offer_purchases', location: 'param', roles: ['owner'], schema: offerUpdateSchema, forbiddenMessage: 'Only owners and masters can edit offers.' }, async ({ db, locationId, input, params }) => {
    const offerId = params?.offerId
    if (!uuidLike.safeParse(offerId).success) return NOT_FOUND()
    const { data: current, error: readErr } = await db.from('sale_offers')
      .select(OFFER_EDITOR_COLUMNS).eq('id', offerId).eq('location_id', locationId).maybeSingle()
    if (readErr) return fail(503, 'Could not save the offer. Try again.')
    if (!current) return NOT_FOUND()

    const next = { ...current, ...input }
    if ('un1t_product_id' in input) next.un1t_product_id = input.un1t_product_id || null
    if (next.ends_at && Date.parse(next.ends_at) <= Date.parse(next.starts_at)) {
      return fail(400, 'The end must be after the start', { code: 'dates' })
    }
    const studio = await readStudioForOffers(db, locationId)
    if (studio.error) return fail(503, 'Could not save the offer. Try again.')
    const products = await readUn1tProducts(db, studio.location)
    if (products.error) return fail(503, 'Could not save the offer. Try again.')
    const problems = offerSaleProblems(studio.location, next, productFor(products.list, next.un1t_product_id))
    if (next.active && problems.length) return fail(422, problems[0].message, { code: problems[0].code, problems })

    const patch = { ...input, updated_at: new Date().toISOString() }
    if ('un1t_product_id' in input) patch.un1t_product_id = next.un1t_product_id
    const { data: saved, error } = await db.from('sale_offers')
      .update(patch).eq('id', offerId).eq('location_id', locationId).select(OFFER_EDITOR_COLUMNS)
    if (error || !Array.isArray(saved) || saved.length !== 1) {
      logError('offers-admin', 'offer not saved', { offerId, locationId, code: error?.code ?? null })
      return fail(500, 'Could not save the offer.')
    }
    return NextResponse.json({ success: true, data: { offer: { ...saved[0], problems } } })
  },
)
