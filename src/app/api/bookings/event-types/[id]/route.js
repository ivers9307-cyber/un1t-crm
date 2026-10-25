// Relocated from src/app/api/events/[id]/route.js (E2 of events expansion).
// See src/app/api/bookings/event-types/route.js header for context.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { requireApiKeyOrManager, assertRowInOrg } from '@/lib/api-auth'
import { assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'
import { EventTypeUpdateSchema, eventTypeSlug } from '@/lib/event-type-schema'
import { resolveEventTypeSlug, slugTaken, isSlugConflict, SLUG_IN_USE } from '@/lib/event-type-slug'
import { logError } from '@/lib/log'

// SAAS-12 — cookie/session location guard for this detail route.
// assertRowInOrg only scopes per-org API keys (it no-ops when orgId is
// null — the cookie path), so without this a manager
// cookie session could read/edit/soft-delete ANY tenant's event type by
// id. Scope the session caller to their own locations; master (whose
// user.locations is every active location) is exempt. Returns a 404
// NextResponse (not 403) so a cross-tenant probe can't confirm an id
// exists — same convention as assertRowInOrg. No-op for the API-key
// paths (user is null). Mirrors the cookie guard in /api/contacts/[id].
//
// ROLESWEEP.2 — requireApiKeyOrManager's cookie branch only says "Manager+
// somewhere"; THIS decides: MANAGER_ROLES at the event type's location, 404
// like a non-member. A missing row is 404 too (it used to pass: a null
// location_id reads as "no specific location" to assertLocationAccessOr404),
// and a failed read is a 500, never a pass.
async function assertEventTypeSessionAccess(db, user, id) {
  if (!user || user.role === 'master') return null
  const { data: row, error } = await db.from('event_types').select('location_id').eq('id', id).maybeSingle()
  if (error) {
    logError('event-types', 'session access read failed', { id, err: error })
    return NextResponse.json({ success: false, error: 'Could not load event type' }, { status: 500 })
  }
  const guard = assertLocationAccessOr404(user, row?.location_id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, row?.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  return null
}

// GET /api/bookings/event-types/:id — Get single event type with bookings count
//
// Auth: requireApiKeyOrManager — a per-org API key (Bearer) AND a manager+
// cookie session. Cookie callers: the booking-type form's
// PUT (EVENTTYPERLS.1, the only way the UI edits a booking type) and
// EventActions' DELETE, both judged by assertEventTypeSessionAccess at the
// row's location — the same rule as canManageEventType on the pages.
export async function GET(request, props) {
  const params = await props.params;
  const auth = await requireApiKeyOrManager(request)
  if (!auth.ok) return auth.response

  const db = createServerClient()
  const scopeErr = await assertRowInOrg({ db, orgId: auth.orgId, table: 'event_types', id: params.id })
  if (scopeErr) return scopeErr
  const sessionErr = await assertEventTypeSessionAccess(db, auth.user, params.id)
  if (sessionErr) return sessionErr
  const { data, error } = await db.from('event_types').select('*').eq('id', params.id).single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 404 })

  return NextResponse.json({ success: true, data })
}

// PUT /api/bookings/event-types/:id — Update event type
export async function PUT(request, props) {
  const params = await props.params;
  const auth = await requireApiKeyOrManager(request)
  if (!auth.ok) return auth.response

  const validation = await validateBody(request, EventTypeUpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()
  const scopeErr = await assertRowInOrg({ db, orgId: auth.orgId, table: 'event_types', id: params.id })
  if (scopeErr) return scopeErr
  const sessionErr = await assertEventTypeSessionAccess(db, auth.user, params.id)
  if (sessionErr) return sessionErr

  const updates = { ...body }

  // ETSLUG.1 — the slug is the public /book/ address, unique across every
  // studio. The booking-type form sends the name on every save and never a
  // slug (EVENTTYPERLS.1), so the address moves only when the name really
  // changes (a plain save used to re-derive it, which would collide for a
  // type whose address had to carry a suffix). A new name picks a free
  // variant; an explicit slug held by another type is a 409.
  if (updates.slug) {
    const held = await slugTaken(db, updates.slug, params.id)
    if (held.error) return NextResponse.json({ success: false, error: held.error }, { status: 500 })
    if (held.taken) return NextResponse.json({ success: false, error: SLUG_IN_USE }, { status: 409 })
  } else if (updates.name) {
    const { data: current, error: curErr } = await db.from('event_types').select('name, location_id').eq('id', params.id).maybeSingle()
    if (curErr) return NextResponse.json({ success: false, error: curErr.message }, { status: 500 })
    if (!current) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    if (eventTypeSlug(updates.name) !== eventTypeSlug(current.name)) {
      const picked = await resolveEventTypeSlug(db, { name: updates.name, locationId: current.location_id, excludeId: params.id })
      if (picked.error) return NextResponse.json({ success: false, error: picked.error }, { status: 500 })
      updates.slug = picked.slug
    }
  }

  const { data, error } = await db.from('event_types').update(updates).eq('id', params.id).select().single()
  if (isSlugConflict(error)) return NextResponse.json({ success: false, error: SLUG_IN_USE }, { status: 409 })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}

// DELETE /api/bookings/event-types/:id — Deactivate event type (soft delete)
export async function DELETE(request, props) {
  const params = await props.params;
  const auth = await requireApiKeyOrManager(request)
  if (!auth.ok) return auth.response

  const db = createServerClient()
  const scopeErr = await assertRowInOrg({ db, orgId: auth.orgId, table: 'event_types', id: params.id })
  if (scopeErr) return scopeErr
  const sessionErr = await assertEventTypeSessionAccess(db, auth.user, params.id)
  if (sessionErr) return sessionErr
  const { data, error } = await db.from('event_types').update({ active: false }).eq('id', params.id).select().single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}
