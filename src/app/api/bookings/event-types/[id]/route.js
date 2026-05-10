// Relocated from src/app/api/events/[id]/route.js (E2 of events expansion).
// See src/app/api/bookings/event-types/route.js header for context.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { requireApiKeyOrManager } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'
import { hexColor, url } from '@/lib/schemas'

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
})

// GET /api/bookings/event-types/:id — Get single event type with bookings count
//
// Auth: requireApiKeyOrManager — accepts both the n8n bearer-token
// (CRM_API_KEY) AND a manager+ cookie session. The original handler
// (relocated from /api/events/[id]) used requireApiKey-only because
// the only consumer was n8n; once the in-CRM operator UI started
// invoking these (EventActions delete button), cookie auth had to
// be allowed. Same pattern as /api/contacts/[id] (mig 109 contact CRUD).
export async function GET(request, { params }) {
  const auth = await requireApiKeyOrManager(request)
  if (!auth.ok) return auth.response

  const db = createServerClient()
  const { data, error } = await db.from('event_types').select('*').eq('id', params.id).single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 404 })

  return NextResponse.json({ success: true, data })
}

// PUT /api/bookings/event-types/:id — Update event type
export async function PUT(request, { params }) {
  const auth = await requireApiKeyOrManager(request)
  if (!auth.ok) return auth.response

  const validation = await validateBody(request, EventUpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

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
export async function DELETE(request, { params }) {
  const auth = await requireApiKeyOrManager(request)
  if (!auth.ok) return auth.response

  const db = createServerClient()
  const { data, error } = await db.from('event_types').update({ active: false }).eq('id', params.id).select().single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}
