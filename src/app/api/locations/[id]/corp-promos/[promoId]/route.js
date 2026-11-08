// WAYSIN.4 — PATCH/DELETE /api/locations/[id]/corp-promos/[promoId]: change or
// remove one of the studio's promos (public.corp_promos, mig 816).
//
//   PATCH { name?, credits?, expires_in_days?, live?, tag?, lead_source?,
//           glofox_membership_id?, glofox_plan_code?, glofox_plan_name? } → { promo }
//   DELETE → { deleted: true }
//
// Gate: membership first (another studio is a 404), then owner or master AT
// this studio. The promo is read by (id, location_id), so another studio's
// promo id is a 404 too. `key` is the claim link and immutable: a PATCH that
// names it is a 400 (corpPromoPatchSchema). A promo with claims
// (corp_promo_claims rows for its location_id + key) can only be switched off,
// never deleted: 409 has_claims. A live promo is never deleted either: switch
// it off first (409 still_live), so a claim link cannot vanish under a visitor.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, guardMasterOrOwner } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { corpPromoPatchSchema } from '@/lib/schemas'
import { promoView, CORP_PROMO_COLUMNS } from '@/lib/corp-promos-db'
import { judgeGlofoxBinding, GLOFOX_PROMO_FIELDS } from '@/lib/corp-promos-admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (status, error, extra = {}) => NextResponse.json({ success: false, error, ...extra }, { status })

async function gate(params) {
  const user = await getCurrentUser()
  if (!user) return { refusal: fail(401, 'Unauthorized') }
  const { id: locationId, promoId } = await params
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return { refusal: guard }
  if (guardMasterOrOwner(user, locationId)) return { refusal: fail(403, 'Only owners and masters can change promos.') }
  return { user, locationId, promoId }
}

async function readPromoRow(db, locationId, promoId) {
  const { data, error } = await db
    .from('corp_promos')
    .select(CORP_PROMO_COLUMNS)
    .eq('id', promoId)
    .eq('location_id', locationId)
    .maybeSingle()                       // primary key; 0 rows = not this studio's
  return { row: data, error }
}

export async function PATCH(request, { params }) {
  const g = await gate(params)
  if (g.refusal) return g.refusal
  const { locationId, promoId } = g

  const validation = await validateBody(request, corpPromoPatchSchema)
  if (!validation.ok) return validation.response
  const patch = { ...validation.data }
  delete patch.key                       // refused by the schema; never written

  const db = createServerClient()
  const { row, error: readError } = await readPromoRow(db, locationId, promoId)
  if (readError) return fail(500, 'Could not read the promo')
  if (!row) return fail(404, 'Not found')

  const touchesGlofox = GLOFOX_PROMO_FIELDS.some((k) => k in patch)
  if (touchesGlofox) {
    const merged = Object.fromEntries(GLOFOX_PROMO_FIELDS.map((k) => [k, k in patch ? patch[k] : row[k]]))
    const binding = judgeGlofoxBinding(row.platform, merged)
    if (!binding.ok) return fail(binding.status, binding.error, { code: binding.code })
    Object.assign(patch, binding.glofox)
  }

  const { data, error } = await db
    .from('corp_promos')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', promoId)
    .eq('location_id', locationId)
    .select(CORP_PROMO_COLUMNS)
    .maybeSingle()                       // primary key; 0 rows = gone meanwhile
  if (error) return fail(500, 'Could not save the promo')
  if (!data) return fail(404, 'Not found')
  return NextResponse.json({ success: true, data: { promo: promoView(data) } })
}

export async function DELETE(request, { params }) {
  const g = await gate(params)
  if (g.refusal) return g.refusal
  const { locationId, promoId } = g

  const db = createServerClient()
  const { row, error: readError } = await readPromoRow(db, locationId, promoId)
  if (readError) return fail(500, 'Could not read the promo')
  if (!row) return fail(404, 'Not found')
  if (row.live === true) return fail(409, 'Switch this promo off first.', { code: 'still_live' })

  // A failed count is never "no claims": it refuses the delete.
  const { count, error: countError } = await db
    .from('corp_promo_claims')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .eq('promo_key', row.key)
  if (countError || typeof count !== 'number') return fail(500, 'Could not check the promo\'s claims')
  if (count > 0) {
    return fail(409, 'This promo has claims, so it can only be switched off.', { code: 'has_claims' })
  }

  const { data, error } = await db
    .from('corp_promos')
    .delete()
    .eq('id', promoId)
    .eq('location_id', locationId)
    .select('id')
  if (error) return fail(500, 'Could not delete the promo')
  if (!Array.isArray(data) || data.length === 0) return fail(404, 'Not found')
  return NextResponse.json({ success: true, data: { deleted: true } })
}
