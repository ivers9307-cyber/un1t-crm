// Relocated from src/app/api/events/[id]/route.js (E2 of events expansion).
// See src/app/api/bookings/event-types/route.js header for context.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { requireApiKeyOrManager, assertRowInOrg } from '@/lib/api-auth'
import { assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'
import { EventTypeUpdateSchema, eventTypeSlug } from '@/lib/event-type-schema'
import { logError } from '@/lib/log'

// SAAS-12 — cookie/session location guard for this detail route.
// assertRowInOrg only scopes per-org API keys (it no-ops when orgId is
// null — the legacy-key and cookie paths), so without this a manager
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
// Auth: requireApiKeyOrManager — the n8n bearer-token (CRM_API_KEY / per-org
// key) AND a manager+ cookie session. Cookie callers: the booking-type form's
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

  // Re-generate slug if name changed and slug not explicitly set. The
  // booking-type form sends no slug (EVENTTYPERLS.1): it is always this one.
  if (updates.name && !updates.slug) {
    updates.slug = eventTypeSlug(updates.name)
  }

  const { data, error } = await db.from('event_types').update(updates).eq('id', params.id).select().single()
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
