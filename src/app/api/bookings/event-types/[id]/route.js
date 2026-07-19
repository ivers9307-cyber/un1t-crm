// Relocated from src/app/api/events/[id]/route.js (E2 of events expansion).
// See src/app/api/bookings/event-types/route.js header for context.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { requireApiKeyOrManager, assertRowInOrg } from '@/lib/api-auth'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { hexColor, url } from '@/lib/schemas'

// SAAS-12 — cookie/session location guard for this detail route.
// assertRowInOrg only scopes per-org API keys (it no-ops when orgId is
// null — the legacy-key and cookie paths), so without this a manager
// cookie session could read/edit/soft-delete ANY tenant's event type by
// id. Scope the session caller to their own locations; master (whose
// user.locations is every active location) is exempt. Returns a 404
// NextResponse (not 403) so a cross-tenant probe can't confirm an id
// exists — same convention as assertRowInOrg. No-op for the API-key
// paths (user is null). Mirrors the cookie guard in /api/contacts/[id].
async function assertEventTypeSessionAccess(db, user, id) {
  if (!user || user.role === 'master') return null
  const { data: row } = await db.from('event_types').select('location_id').eq('id', id).maybeSingle()
  return assertLocationAccessOr404(user, row?.location_id)
}

const EventUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  slug: z.string().max(100).optional(),
  description: z.string().max(5000).nullable().optional(),
  duration_minutes: z.number().int().min(1).max(1440).optional(),
  color: hexColor.optional(),
  availability: z.unknown().optional(),
  buffer_minutes: z.number().int().min(0).max(1440).optional(),
  max_advance_days: z.number().int().min(0).max(3650).optional(),
  custom_fields: z.array(z.unknown()).optional(),
  webhook_url: url.nullable().optional(),
  active: z.boolean().optional(),
  // Mig 125: editable on update. See POST schema for semantics.
  staff_required: z.number().int().min(0).max(50).optional(),
  // Mig 144 (GLOFOX3.2): editable on update. See POST schema.
  create_in_glofox: z.boolean().optional(),
})

// GET /api/bookings/event-types/:id — Get single event type with bookings count
//
// Auth: requireApiKeyOrManager — accepts both the n8n bearer-token
// (CRM_API_KEY) AND a manager+ cookie session. The original handler
// (relocated from /api/events/[id]) used requireApiKey-only because
// the only consumer was n8n; once the in-CRM operator UI started
// invoking these (EventActions delete button), cookie auth had to
// be allowed. Same pattern as /api/contacts/[id] (mig 109 contact CRUD).
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

  const validation = await validateBody(request, EventUpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()
  const scopeErr = await assertRowInOrg({ db, orgId: auth.orgId, table: 'event_types', id: params.id })
  if (scopeErr) return scopeErr
  const sessionErr = await assertEventTypeSessionAccess(db, auth.user, params.id)
  if (sessionErr) return sessionErr

  const updates = { ...body }

  // Re-generate slug if name changed and slug not explicitly set
  if (updates.name && !updates.slug) {
    updates.slug = updates.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
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
