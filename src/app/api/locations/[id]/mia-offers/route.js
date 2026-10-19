// GET/PUT /api/locations/[id]/mia-offers
//
// MIAHATCH.4 (Task 14, spec 6.5.1) — "What Mia can sell" at a un1t.online
// studio (Hatch Street): the products staff let Mia offer in WhatsApp, in
// order, each with a one-line blurb (mia_purchase_offers, mig 752; service
// role only, so every read and write is judged here).
//
//   GET  any member of the studio. { offers, products }: `offers` is the saved
//        list in order, each flagged `inactive` when its product has since
//        gone inactive or free (Mia skips it; staff see it and decide);
//        `products` is what can be added: active, price above zero, THIS
//        studio's, private ones included and flagged `private`.
//   PUT  an OWNER at the studio, or a master (canEditMiaSettings, the same
//        predicate as the settings route). Body { offers: [{ un1t_product_row_id,
//        blurb }] }, array order = sort order; replaces the studio's rows. A
//        product that is not at the studio, not active or at 0 cents answers
//        400 { error: 'product_not_sellable', product_id } and writes nothing.
//
// Gate (Style B): membership first (404: a detail route never confirms an id
// to a caller outside the studio), then the role at the TARGET (403), then
// validation. A studio that is not on un1t.online has no un1t.online
// products, so both verbs answer 400 there.
//
// REPLACE WITHOUT A GAP. Delete-all-then-insert would leave the studio with
// no offers if the insert failed halfway, and Mia would stop selling. So the
// save goes: update the rows that stay, insert the new ones, and only then
// delete the rows that are no longer listed; every write's `error` is judged.
// A failure before the delete leaves the old list intact (at worst re-ordered
// or with a new row added); a failure of the delete leaves extras, never none.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { miaOffersPutSchema } from '@/lib/schemas'
import { canEditMiaSettings } from '@/lib/agent/settings-access'
import { isSellableUn1tProduct } from '@/lib/agent/mia-offer-limits'
import { UN1T_PRODUCT_ACTIVE_STATUS, UN1T_PRODUCT_PRIVATE_VISIBILITY } from '@/lib/agent/un1t-tools'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UN1T_ONLINE = 'un1t_online'
const PRODUCT_COLS = 'id, title, price_cents, billing_interval, status, visibility'

const fail = (status, error, extra = {}) => NextResponse.json({ success: false, error, ...extra }, { status })
const unreadable = () => fail(500, 'Could not read the offer list.')

const isSellable = isSellableUn1tProduct

// null = the studio is on un1t.online; otherwise the response to return.
async function requireUn1tStudio(db, locationId) {
  const { data, error } = await db.from('locations').select('id, membership_source').eq('id', locationId).maybeSingle()
  if (error) {
    logError('mia-offers', 'location read failed', { locationId, err: error })
    return fail(500, 'Could not read the studio.')
  }
  if (!data) return fail(404, 'Not found')
  if (data.membership_source !== UN1T_ONLINE) {
    return fail(400, 'This studio does not sell through un1t.online, so Mia has no offers to set.')
  }
  return null
}

// { offers, products } or { response } when a read failed.
async function readOffers(db, locationId) {
  const { data: rows, error: offersErr } = await db
    .from('mia_purchase_offers')
    .select('id, un1t_product_row_id, blurb, sort_order')
    .eq('location_id', locationId)
    .order('sort_order')
    .order('id')
  if (offersErr) {
    logError('mia-offers', 'offers read failed', { locationId, err: offersErr })
    return { response: unreadable() }
  }

  const ids = (rows || []).map((r) => r.un1t_product_row_id)
  let owned = []
  if (ids.length > 0) {
    const { data, error } = await db.from('un1t_products').select(PRODUCT_COLS).eq('location_id', locationId).in('id', ids)
    if (error) {
      logError('mia-offers', 'offer products read failed', { locationId, err: error })
      return { response: unreadable() }
    }
    owned = data || []
  }
  const byId = new Map(owned.map((p) => [p.id, p]))

  const offers = (rows || []).map((r) => {
    const p = byId.get(r.un1t_product_row_id)
    const isPrivate = p?.visibility === UN1T_PRODUCT_PRIVATE_VISIBILITY
    return {
      id: r.id,
      un1t_product_row_id: r.un1t_product_row_id,
      title: p?.title ?? null,
      price_cents: p?.price_cents ?? null,
      interval: p?.billing_interval ?? null,
      visibility: p?.visibility ?? null,
      private: isPrivate,
      blurb: r.blurb ?? '',
      sort_order: r.sort_order,
      inactive: !isSellable(p),
    }
  })

  const { data: sellable, error: productsErr } = await db
    .from('un1t_products')
    .select(PRODUCT_COLS)
    .eq('location_id', locationId)
    .eq('status', UN1T_PRODUCT_ACTIVE_STATUS)
    .gt('price_cents', 0)
    .order('title')
  if (productsErr) {
    logError('mia-offers', 'products read failed', { locationId, err: productsErr })
    return { response: unreadable() }
  }
  const products = (sellable || []).map((p) => ({
    id: p.id,
    title: p.title,
    price_cents: p.price_cents,
    interval: p.billing_interval ?? null,
    private: p.visibility === UN1T_PRODUCT_PRIVATE_VISIBILITY,
  }))

  return { offers, products }
}

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return fail(401, 'Unauthorized')

  const locationId = params.id
  const access = assertLocationAccessOr404(user, locationId)
  if (access) return access

  const db = createServerClient()
  const notUn1t = await requireUn1tStudio(db, locationId)
  if (notUn1t) return notUn1t

  const out = await readOffers(db, locationId)
  if (out.response) return out.response
  return NextResponse.json({ success: true, data: { offers: out.offers, products: out.products } })
}

export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return fail(401, 'Unauthorized')

  const locationId = params.id
  const access = assertLocationAccessOr404(user, locationId)
  if (access) return access
  if (!canEditMiaSettings(user, locationId)) {
    return fail(403, 'Only the studio owner can change what Mia can sell.')
  }

  const validation = await validateBody(request, miaOffersPutSchema)
  if (!validation.ok) return validation.response
  const { offers } = validation.data

  const db = createServerClient()
  const notUn1t = await requireUn1tStudio(db, locationId)
  if (notUn1t) return notUn1t

  // Every listed product must be sellable AT THIS STUDIO: product row ids are
  // per studio, so a foreign id is "not found" here, same as an inactive one.
  const ids = offers.map((o) => o.un1t_product_row_id)
  let products = []
  if (ids.length > 0) {
    const { data, error } = await db.from('un1t_products').select(PRODUCT_COLS).eq('location_id', locationId).in('id', ids)
    if (error) {
      logError('mia-offers', 'product check read failed', { locationId, err: error })
      return fail(500, 'Could not check the products.')
    }
    products = data || []
  }
  const byId = new Map(products.map((p) => [p.id, p]))
  const refused = ids.find((id) => !isSellable(byId.get(id)))
  if (refused) return fail(400, 'product_not_sellable', { product_id: refused })

  const { data: existing, error: existingErr } = await db
    .from('mia_purchase_offers')
    .select('id, un1t_product_row_id')
    .eq('location_id', locationId)
  if (existingErr) {
    logError('mia-offers', 'existing offers read failed', { locationId, err: existingErr })
    return fail(500, 'Could not read the current offers.')
  }
  const have = new Set((existing || []).map((r) => r.un1t_product_row_id))
  const wanted = new Set(ids)
  const now = new Date().toISOString()
  const row = (o, i) => ({
    location_id: locationId,
    un1t_product_row_id: o.un1t_product_row_id,
    sort_order: i,
    blurb: o.blurb === '' ? null : o.blurb,
    updated_at: now,
  })

  // 1. Rows that stay: new order and blurb. created_by is left alone.
  const staying = offers.map((o, i) => ({ o, i })).filter(({ o }) => have.has(o.un1t_product_row_id))
  if (staying.length > 0) {
    const { error } = await db
      .from('mia_purchase_offers')
      .upsert(staying.map(({ o, i }) => row(o, i)), { onConflict: 'location_id,un1t_product_row_id' })
    if (error) {
      logError('mia-offers', 'offers update failed', { locationId, err: error })
      return fail(500, 'Could not save the offers.')
    }
  }
  // 2. New rows.
  const adding = offers.map((o, i) => ({ o, i })).filter(({ o }) => !have.has(o.un1t_product_row_id))
  if (adding.length > 0) {
    const { error } = await db
      .from('mia_purchase_offers')
      .insert(adding.map(({ o, i }) => ({ ...row(o, i), created_by: user.id })))
    if (error) {
      logError('mia-offers', 'offers insert failed', { locationId, err: error })
      return fail(500, 'Could not save the offers.')
    }
  }
  // 3. Only now drop what is no longer listed.
  const staleIds = (existing || []).filter((r) => !wanted.has(r.un1t_product_row_id)).map((r) => r.id)
  if (staleIds.length > 0) {
    const { error } = await db.from('mia_purchase_offers').delete().eq('location_id', locationId).in('id', staleIds)
    if (error) {
      logError('mia-offers', 'stale offers delete failed', { locationId, err: error })
      return fail(500, 'Saved the new offers but could not remove the old ones.')
    }
  }

  const out = await readOffers(db, locationId)
  if (out.response) return out.response
  return NextResponse.json({ success: true, data: { offers: out.offers, products: out.products } })
}
