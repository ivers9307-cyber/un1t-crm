// Relocated from src/app/api/events/route.js (E2 of events expansion).
// /events URL space freed for the multi-kind events feature; Calendly's
// bookable templates now live alongside their /bookings hub. See
// next.config.js for the back-compat rewrite from old /api/events/*.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { authenticateApiKey, requireApiKeyOrManager, orgScopeLocationIds, assertCreateInOrg } from '@/lib/api-auth'
import { assertLocationAccess, hasRoleAtLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { DEFAULT_COLOR, MANAGER_ROLES } from '@/lib/schemas'
import { EventTypeCreateSchema, CONFIRMATION_FIELDS } from '@/lib/event-type-schema'
import { resolveEventTypeSlug, slugTaken, isSlugConflict, SLUG_IN_USE } from '@/lib/event-type-slug'

// GET /api/bookings/event-types — List all event types (API key only)
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
//
// EVENTTYPERLS.1 — also the booking-type form's create (cookie). The form
// used to INSERT with the browser client, which RLS (event_types_location_
// scoped, FOR ALL, any member) let plain staff do; mig 650 takes that write
// off the browser roles. A cookie caller must name the studio and be a
// master or hold MANAGER_ROLES there — canManageEventType, the rule the New
// page, the Edit/Delete buttons and /api/bookings/event-types/[id] use.
// Refusals copy POST /api/contacts: non-member 403, role 401 (the helper's
// body), no location 400. API-key callers are unchanged.
export async function POST(request) {
  const auth = await requireApiKeyOrManager(request)
  if (!auth.ok) return auth.response

  const validation = await validateBody(request, EventTypeCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  if (auth.user) {
    if (!body.location_id) {
      return NextResponse.json({ success: false, error: 'location_id required' }, { status: 400 })
    }
    if (!auth.user.isMaster) {
      const guard = assertLocationAccess(auth.user, body.location_id)
      if (guard) return guard
    }
    // requireApiKeyOrManager's cookie branch only says "Manager+ somewhere";
    // THIS is the decision, at the studio the booking type is created in.
    if (!hasRoleAtLocation(auth.user, body.location_id, MANAGER_ROLES)) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }
  }

  const db = createServerClient()

  // APIKEYS.3 — per-org key may only create an event type at a location in its org.
  const scopeErr = await assertCreateInOrg({ db, orgId: auth.orgId, locationId: body.location_id })
  if (scopeErr) return scopeErr

  // Mig 077 confirmation columns: written only when sent (the form always
  // sends all five; API-key creates keep the column defaults).
  const confirmation = Object.fromEntries(
    CONFIRMATION_FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]),
  )

  const row = {
    name: body.name,
    description: body.description || null,
    duration_minutes: body.duration_minutes || 30,
    color: body.color || DEFAULT_COLOR,
    availability: body.availability || undefined,
    buffer_minutes: body.buffer_minutes || 0,
    max_advance_days: body.max_advance_days ?? 30,
    custom_fields: body.custom_fields || [],
    webhook_url: body.webhook_url || null,
    active: body.active !== false,
    staff_required: body.staff_required ?? 1,
    create_in_glofox: body.create_in_glofox === true,
    ...confirmation,
    ...(body.location_id ? { location_id: body.location_id } : {}),
  }

  // ETSLUG.1 — the slug is the public /book/ address and is unique across
  // every studio. An explicit slug is the caller's choice: a clash is a 409,
  // never a silent rename. A derived one picks a free variant, and is picked
  // again once if another create takes it between our read and our insert.
  if (body.slug) {
    const held = await slugTaken(db, body.slug)
    if (held.error) return NextResponse.json({ success: false, error: held.error }, { status: 500 })
    if (held.taken) return NextResponse.json({ success: false, error: SLUG_IN_USE }, { status: 409 })
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    let slug = body.slug
    if (!slug) {
      const picked = await resolveEventTypeSlug(db, { name: body.name, locationId: body.location_id })
      if (picked.error) return NextResponse.json({ success: false, error: picked.error }, { status: 500 })
      slug = picked.slug
    }
    const { data, error } = await db.from('event_types').insert({ ...row, slug }).select().single()
    if (!error) return NextResponse.json({ success: true, data })
    if (!isSlugConflict(error)) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
    if (body.slug) break
  }
  return NextResponse.json({ success: false, error: SLUG_IN_USE }, { status: 409 })
}
