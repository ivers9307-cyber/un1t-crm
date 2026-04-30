// /api/cars/[id] — detail + update.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { money } from '@/lib/schemas'

const CarUpdateSchema = z.object({
  uk_reg: z.string().max(20).nullable().optional(),
  irish_reg: z.string().max(20).nullable().optional(),
  vin: z.string().max(40).nullable().optional(),
  make: z.string().max(100).nullable().optional(),
  model: z.string().max(100).nullable().optional(),
  vehicle_year: z.number().int().min(1900).max(2100).nullable().optional(),
  uk_purchase_price_ex_vat: money.nullable().optional(),
  uk_vat: money.nullable().optional(),
  irish_sale_price_inc_vat: money.nullable().optional(),
  irish_sale_price_ex_vat: money.nullable().optional(),
  // GBP→EUR FX rate (migration 028). Bounded so a typo can't
  // push the calc into wild territory.
  fx_gbp_to_eur: z.number().finite().min(0).max(10).nullable().optional(),
  // Ancillary costs — see migration 026 + COST_FIELDS in src/lib/cars.js.
  uk_transporter_cost: money.nullable().optional(),
  ferry_cost: money.nullable().optional(),
  import_customs_cost: money.nullable().optional(),
  nct_cost: money.nullable().optional(),
  additional_costs: money.nullable().optional(),
  additional_costs_label: z.string().max(120).nullable().optional(),
  buyer_name: z.string().max(200).nullable().optional(),
  buyer_email: z.string().email().max(320).nullable().optional()
    .or(z.literal('').transform(() => null)),
  buyer_phone: z.string().max(50).nullable().optional(),
  buyer_address: z.string().max(2000).nullable().optional(),
  uk_vat_refund_received: z.boolean().optional(),
  notes: z.string().max(20_000).nullable().optional(),
})

async function loadCar(db, id) {
  return db.from('cars').select('*, car_documents(*)').eq('id', id).single()
}

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: car, error } = await loadCar(db, params.id)
  if (error || !car) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const guard = assertLocationAccess(user, car.location_id)
  if (guard) return guard
  return NextResponse.json({ success: true, data: car })
}

export async function PATCH(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const validation = await validateBody(request, CarUpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data: existing } = await loadCar(db, params.id)
  if (!existing) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccess(user, existing.location_id)
  if (guard) return guard

  // Stamp uk_vat_refund_received_at on the transition to true so we
  // know when it landed without needing an audit table.
  const updates = { ...body }
  if (body.uk_vat_refund_received === true && !existing.uk_vat_refund_received) {
    updates.uk_vat_refund_received_at = new Date().toISOString()
  } else if (body.uk_vat_refund_received === false) {
    updates.uk_vat_refund_received_at = null
  }

  const { data, error } = await db.from('cars').update(updates).eq('id', params.id).select().single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

export async function DELETE(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: existing } = await loadCar(db, params.id)
  if (!existing) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccess(user, existing.location_id)
  if (guard) return guard

  // Hard-delete on purpose for now — there's no archived view yet.
  // Storage objects orphan if not cleaned up; we walk the documents
  // first.
  if (existing.car_documents?.length) {
    const paths = existing.car_documents.map(d => d.storage_path)
    await db.storage.from('car-documents').remove(paths).catch(() => {})
  }
  const { error } = await db.from('cars').delete().eq('id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true })
}
