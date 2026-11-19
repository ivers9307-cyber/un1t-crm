// OFFERSEDIT.1 — GET/POST /api/locations/[id]/offers: a studio's sale offers,
// edited at /settings/offers (step 4 offers design, 19 Nov 2026).
//
//   GET  → { offers: [{ ...offer, problems }], products, platform, can_edit }
//   POST { name, category, bonus_headline, price_cents, … } → 201 { offer, problems }
//
// Gate (withAuth, location 'param'): another studio is a 404. Reading needs the
// Offer sales permission at the studio (who already sees the purchases);
// creating needs owner or master AT the studio. An active offer the storefront
// could not sell is refused (offerSaleProblems); an inactive one is saved as a
// draft with its problems returned.
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { hasRoleAtLocation } from '@/lib/role-at-location'
import { logError } from '@/lib/log'
import { OFFER_EDITOR_COLUMNS, offerCreateSchema, offerSaleProblems, slugFromName } from '@/lib/offers-admin'
import { readStudioForOffers, readUn1tProducts, productFor } from '@/lib/offers-admin-db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const EDIT_ROLES = ['owner']
const fail = (status, error, extra = {}) => NextResponse.json({ success: false, error, ...extra }, { status })

export const GET = withAuth(
  { permission: 'approvals_offer_purchases', location: 'param' },
  async ({ user, db, locationId }) => {
    const studio = await readStudioForOffers(db, locationId)
    if (studio.error) return fail(503, 'Could not read the offers. Try again.')
    const { data: offers, error } = await db.from('sale_offers')
      .select(OFFER_EDITOR_COLUMNS)
      .eq('location_id', locationId)
      .order('sort', { ascending: true })
      .order('created_at', { ascending: true })
    if (error) {
      logError('offers-admin', 'offers unreadable', { locationId, code: error.code ?? null })
      return fail(503, 'Could not read the offers. Try again.')
    }
    const products = await readUn1tProducts(db, studio.location)
    if (products.error) return fail(503, 'Could not read the un1t.online products. Try again.')
    return NextResponse.json({
      success: true,
      data: {
        offers: (offers || []).map((o) => ({ ...o, problems: offerSaleProblems(studio.location, o, productFor(products.list, o.un1t_product_id)) })),
        products: products.list,
        platform: studio.location.membership_source || null,
        can_edit: hasRoleAtLocation(user, locationId, EDIT_ROLES),
      },
    })
  },
)

export const POST = withAuth(
  { permission: 'approvals_offer_purchases', location: 'param', roles: EDIT_ROLES, schema: offerCreateSchema, forbiddenMessage: 'Only owners and masters can create offers.' },
  async ({ db, locationId, input }) => {
    const studio = await readStudioForOffers(db, locationId)
    if (studio.error) return fail(503, 'Could not save the offer. Try again.')
    const products = await readUn1tProducts(db, studio.location)
    if (products.error) return fail(503, 'Could not save the offer. Try again.')
    const offer = { ...input, un1t_product_id: input.un1t_product_id || null }
    const problems = offerSaleProblems(studio.location, offer, productFor(products.list, offer.un1t_product_id))
    if (offer.active && problems.length) {
      return fail(422, problems[0].message, { code: problems[0].code, problems })
    }

    // A free web address at this studio: the name's, then -2, -3, …
    const base = offer.slug || slugFromName(offer.name)
    const { data: taken, error: slugErr } = await db.from('sale_offers')
      .select('slug').eq('location_id', locationId).like('slug', `${base}%`).limit(500)
    if (slugErr) return fail(503, 'Could not save the offer. Try again.')
    const used = new Set((taken || []).map((r) => r.slug))
    let slug = base
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`

    const row = {
      location_id: locationId, slug, category: offer.category, name: offer.name,
      bonus_headline: offer.bonus_headline, description: offer.description, fine_print: offer.fine_print,
      price_cents: offer.price_cents, currency: 'EUR', active: offer.active,
      ...(offer.starts_at ? { starts_at: offer.starts_at } : {}),
      ends_at: offer.ends_at, sort: offer.sort, stock_limit: offer.stock_limit, un1t_product_id: offer.un1t_product_id,
    }
    const { data: saved, error } = await db.from('sale_offers').insert(row).select(OFFER_EDITOR_COLUMNS).maybeSingle()
    if (error || !saved) {
      logError('offers-admin', 'offer not created', { locationId, code: error?.code ?? null })
      return fail(error?.code === '23505' ? 409 : 500, error?.code === '23505' ? 'That web address is already used at this studio.' : 'Could not save the offer.')
    }
    return NextResponse.json({ success: true, data: { offer: { ...saved, problems } } }, { status: 201 })
  },
)
