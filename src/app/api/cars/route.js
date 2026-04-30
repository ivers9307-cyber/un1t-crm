// /api/cars — list and create.
//
// Auth: session (getCurrentUser). Permission: car_processing must
// be true on the caller. RLS enforces location scoping at the DB
// layer; the permission check is the UI/UX gate.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike, money } from '@/lib/schemas'

const CarStatus = z.enum(['new', 'pending', 'completed'])

const CarCreateSchema = z.object({
  location_id: uuidLike.optional(),
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
  // Ancillary cost line items (migration 026). All optional at
  // registration time — operator fills in as they're known.
  uk_transporter_cost: money.nullable().optional(),
  ferry_cost: money.nullable().optional(),
  import_customs_cost: money.nullable().optional(),
  nct_cost: money.nullable().optional(),
  additional_costs: money.nullable().optional(),
  additional_costs_label: z.string().max(120).nullable().optional(),
  notes: z.string().max(20_000).nullable().optional(),
})

// GET /api/cars?status=new|pending|completed&location_id=...
//
// `status` accepts a comma-separated list ('new,pending') so the UI's
// merged Active tab can fetch new + pending in a single round-trip.
// Unknown values are silently dropped to avoid 400ing on a UI typo.
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const statusParam = searchParams.get('status') || ''
  const statuses = statusParam
    .split(',')
    .map(s => s.trim())
    .filter(s => CarStatus.safeParse(s).success)
  const locationId = searchParams.get('location_id')

  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  let query = db.from('cars').select('*, car_documents(id, doc_type, filename)').order('updated_at', { ascending: false })

  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    const ids = getUserLocationIds(user)
    if (ids.length === 0) return NextResponse.json({ success: true, data: [] })
    query = query.in('location_id', ids)
  }
  if (statuses.length === 1) query = query.eq('status', statuses[0])
  else if (statuses.length > 1) query = query.in('status', statuses)

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

// POST /api/cars — create a new car (always lands in 'new' status).
// All identifying / cost fields are optional at creation; the operator
// fills them in iteratively from the new tab.
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const validation = await validateBody(request, CarCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // Resolve location: prefer explicit body, fall back to active location.
  const locationId = body.location_id || user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const { data, error } = await db.from('cars').insert({
    location_id: locationId,
    status: 'new',
    uk_reg: body.uk_reg || null,
    irish_reg: body.irish_reg || null,
    vin: body.vin || null,
    make: body.make || 'Tesla',
    model: body.model || null,
    vehicle_year: body.vehicle_year || null,
    uk_purchase_price_ex_vat: body.uk_purchase_price_ex_vat ?? null,
    uk_vat: body.uk_vat ?? null,
    irish_sale_price_inc_vat: body.irish_sale_price_inc_vat ?? null,
    irish_sale_price_ex_vat: body.irish_sale_price_ex_vat ?? null,
    uk_transporter_cost: body.uk_transporter_cost ?? null,
    ferry_cost: body.ferry_cost ?? null,
    import_customs_cost: body.import_customs_cost ?? null,
    nct_cost: body.nct_cost ?? null,
    additional_costs: body.additional_costs ?? null,
    additional_costs_label: body.additional_costs_label || null,
    notes: body.notes || null,
    created_by: user.id,
  }).select().single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data }, { status: 201 })
}
