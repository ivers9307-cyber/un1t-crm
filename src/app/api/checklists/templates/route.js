// CHECKLIST.1 — list + create checklist templates for the active
// location.
//
//   GET  → list templates at the active location, ordered by day +
//          role. Used by the /admin/checklists grid.
//   POST → create a new template. Body: { role, day_of_week, name,
//          items? }. 409 if a template already exists for that
//          (role, day) at this location (unique constraint).
//
// Auth: studio_management permission (anyone with admin access to
// the location can read), plus role check (master + owner) for the
// write side. Mirrors the policies admin pattern.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { listTemplates, createTemplate } from '@/lib/checklists'
import { logAuditEvent } from '@/lib/audit'
import { validateBody } from '@/lib/validate'

const ChecklistTemplateCreateSchema = z.object({
  role:        z.string().optional(),
  day_of_week: z.union([z.string(), z.number()]).optional(),
  name:        z.string().optional(),
  items:       z.array(z.unknown()).optional(),
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
  async ({ db, locationId }) => {
    if (!locationId) {
      return NextResponse.json(
        { success: false, error: 'Active location required.' },
        { status: 400 }
      )
    }
    const data = await listTemplates(db, locationId)
    return NextResponse.json({ success: true, data })
  }
)

// ---- POST ----

export const POST = withAuth(
  { permission: 'studio_management' },
  async ({ user, db, locationId, request }) => {
    if (!isMasterOrOwner(user)) {
      return NextResponse.json(
        { success: false, error: 'Only master + owner can create checklist templates.' },
        { status: 403 }
      )
    }
    if (!locationId) {
      return NextResponse.json(
        { success: false, error: 'Active location required.' },
        { status: 400 }
      )
    }

    const v = await validateBody(request, ChecklistTemplateCreateSchema)
    if (!v.ok) return v.response
    const body = v.data

    const out = await createTemplate(db, {
      locationId,
      role:       body?.role,
      dayOfWeek:  body?.day_of_week,
      name:       body?.name,
      items:      body?.items || [],
    })
    if (!out.ok) {
      return NextResponse.json(
        { success: false, error: out.error, code: out.code },
        { status: out.status || 500 }
      )
    }

    await logAuditEvent({
      category: 'mutation',
      action: 'checklist_template.created',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: { label: out.data.name, resource: `checklist_template/${out.data.id}` },
      locationId,
      details: { role: out.data.role, day_of_week: out.data.day_of_week, item_count: out.data.items?.length || 0 },
      request,
    })

    return NextResponse.json({ success: true, data: out.data }, { status: 201 })
  }
)
