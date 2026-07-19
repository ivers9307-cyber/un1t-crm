// Relocated from src/app/api/events/route.js (E2 of events expansion).
// /events URL space freed for the multi-kind events feature; Calendly's
// bookable templates now live alongside their /bookings hub. See
// next.config.js for the back-compat rewrite from old /api/events/*.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { authenticateApiKey, orgScopeLocationIds, assertCreateInOrg } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, hexColor, url, DEFAULT_COLOR } from '@/lib/schemas'

const EventCreateSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().max(100).optional(),
  description: z.string().max(5000).nullable().optional(),
  duration_minutes: z.number().int().min(1).max(1440).optional(),
  color: hexColor.optional(),
  availability: z.unknown().optional(),  // opaque JSON shape, schema lives client-side
  buffer_minutes: z.number().int().min(0).max(1440).optional(),
  max_advance_days: z.number().int().min(0).max(3650).optional(),
  custom_fields: z.array(z.unknown()).optional(),
  webhook_url: url.nullable().optional(),
  active: z.boolean().optional(),
  location_id: uuidLike.optional(),
  // Mig 125: how many staff are needed to keep this booking type
  // bookable. Commitment-based — if availability exists for a day,
  // this many staff must be rostered to cover (regardless of actual
  // booking count). 0 = covered by another role. Drives the studio
  // overview classifier on /schedule.
  staff_required: z.number().int().min(0).max(50).optional(),
  // Mig 144 (GLOFOX3.2): when true, public bookings on this event
  // type push the booking customer to Glofox (search-and-link OR
  // create + attach trial). Default false — operator opts in per
  // booking type. See /api/public/book/route.js for the call site.
  create_in_glofox: z.boolean().optional(),
})

// GET /api/bookings/event-types — List all event types
export async function GET(request) {
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const db = createServerClient()
  const { searchParams } = new URL(request.url)
  const activeOnly = searchParams.get('active') === 'true'

  let query = db.from('event_types').select('*').order('created_at', { ascending: false })
  const locationId = searchParams.get('location_id')
  if (locationId) query = query.eq('location_id', locationId)
  if (activeOnly) query = query.eq('active', true)
  // APIKEYS.3 — per-org key: restrict to the org's locations.
  const orgLocs = await orgScopeLocationIds(db, auth.orgId)
  if (orgLocs) query = query.in('location_id', orgLocs)

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}

// POST /api/bookings/event-types — Create a new event type
export async function POST(request) {
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const validation = await validateBody(request, EventCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // APIKEYS.3 — per-org key may only create an event type at a location in its org.
  const scopeErr = await assertCreateInOrg({ db, orgId: auth.orgId, locationId: body.location_id })
  if (scopeErr) return scopeErr

  // Auto-generate slug from name if not provided
  const slug = body.slug || body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

  const { data, error } = await db.from('event_types').insert({
    name: body.name,
    slug,
    description: body.description || null,
    duration_minutes: body.duration_minutes || 30,
    color: body.color || DEFAULT_COLOR,
    availability: body.availability || undefined,
    buffer_minutes: body.buffer_minutes || 0,
    max_advance_days: body.max_advance_days || 30,
    custom_fields: body.custom_fields || [],
    webhook_url: body.webhook_url || null,
    active: body.active !== false,
    staff_required: body.staff_required ?? 1,
    create_in_glofox: body.create_in_glofox === true,
    ...(body.location_id ? { location_id: body.location_id } : {}),
  }).select().single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}
