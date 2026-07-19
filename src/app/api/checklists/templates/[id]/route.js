// CHECKLIST.1 — drill-in + edit + soft-delete a single template.
//
//   GET    → read one. Read-gated on studio_management.
//   PATCH  → master + owner only. Body: { name?, items?, enabled? }.
//            role + day_of_week are intentionally NOT mutable —
//            the unique constraint means "moving" a template is
//            "create a new one and disable the old".
//   DELETE → soft-delete (sets enabled=false). Hard delete is not
//            exposed because PR 2 instances will FK the template
//            id and we don't want orphans.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { getTemplate, updateTemplate, disableTemplate } from '@/lib/checklists'
import { logAuditEvent } from '@/lib/audit'
import { validateBody } from '@/lib/validate'

// role + day_of_week are intentionally not patchable (see route header)
const ChecklistTemplatePatchSchema = z.object({
  name:    z.string().optional(),
  items:   z.array(z.unknown()).optional(),
  enabled: z.boolean().optional(),
})

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function isMasterOrOwner(user) {
  if (user?.role === 'master' || user?.profileRole === 'master' || user?.isMaster) return true
  return user?.role === 'owner'
}

// ---- GET ----

export const GET = withAuth(
  { permission: 'studio_management' },
  async ({ db, params, locationId }) => {
    const id = params?.id
    if (!id) {
      return NextResponse.json({ success: false, error: 'id required' }, { status: 400 })
    }
    const row = await getTemplate(db, id)
    if (!row) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
    // Scope to the active location — master sees everything, but a
    // non-master with admin access shouldn't be able to peek at a
    // template from another location by guessing its id.
    if (locationId && row.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json({ success: true, data: row })
  }
)

// ---- PATCH ----

export const PATCH = withAuth(
  { permission: 'studio_management' },
  async ({ user, db, params, request, locationId }) => {
    if (!isMasterOrOwner(user)) {
      return NextResponse.json(
        { success: false, error: 'Only master + owner can edit checklist templates.' },
        { status: 403 }
      )
    }
    const id = params?.id
    if (!id) {
      return NextResponse.json({ success: false, error: 'id required' }, { status: 400 })
    }

    // Existence + location scoping check so the audit log + the
    // 404 semantics are accurate.
    const existing = await getTemplate(db, id)
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
    if (locationId && existing.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }

    const v = await validateBody(request, ChecklistTemplatePatchSchema)
    if (!v.ok) return v.response
    const body = v.data

    const out = await updateTemplate(db, id, {
      // Whitelist — `role` + `day_of_week` + `location_id` are not
      // patchable. See header.
      ...('name' in body ? { name: body.name } : {}),
      ...('items' in body ? { items: body.items } : {}),
      ...('enabled' in body ? { enabled: body.enabled } : {}),
    })
    if (!out.ok) {
      return NextResponse.json(
        { success: false, error: out.error, code: out.code },
        { status: out.status || 500 }
      )
    }

    await logAuditEvent({
      category: 'mutation',
      action: 'checklist_template.updated',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: { label: out.data.name, resource: `checklist_template/${out.data.id}` },
      locationId: existing.location_id,
      details: {
        // Audit only what actually changed, not the full payload.
        ...(body && 'name'    in body ? { name_changed: true }    : {}),
        ...(body && 'items'   in body ? { items_changed: true, item_count: out.data.items?.length || 0 } : {}),
        ...(body && 'enabled' in body ? { enabled: !!body.enabled } : {}),
      },
      request,
    })

    return NextResponse.json({ success: true, data: out.data })
  }
)

// ---- DELETE ----

export const DELETE = withAuth(
  { permission: 'studio_management' },
  async ({ user, db, params, request, locationId }) => {
    if (!isMasterOrOwner(user)) {
      return NextResponse.json(
        { success: false, error: 'Only master + owner can remove checklist templates.' },
        { status: 403 }
      )
    }
    const id = params?.id
    if (!id) {
      return NextResponse.json({ success: false, error: 'id required' }, { status: 400 })
    }
    const existing = await getTemplate(db, id)
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
    if (locationId && existing.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }

    const out = await disableTemplate(db, id)
    if (!out.ok) {
      return NextResponse.json(
        { success: false, error: out.error, code: out.code },
        { status: out.status || 500 }
      )
    }

    await logAuditEvent({
      category: 'mutation',
      action: 'checklist_template.disabled',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: { label: existing.name, resource: `checklist_template/${existing.id}` },
      locationId: existing.location_id,
      details: { role: existing.role, day_of_week: existing.day_of_week },
      request,
    })

    return NextResponse.json({ success: true })
  }
)
