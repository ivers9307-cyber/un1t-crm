import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'

// GATES-2 — every handler took membership only, so a member with `email`
// switched off could read, rewrite and delete the studio's email templates.
// Same rule as /api/campaigns/[id]/send: `email` at SOME studio first (before
// any read, so an id is never confirmed), then at the TEMPLATE's studio.
const EMAIL_FORBIDDEN = { success: false, error: 'No email permission at this location' }
const emailForbidden = () => NextResponse.json(EMAIL_FORBIDDEN, { status: 403 })

const TemplateUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  category: z.string().max(50).optional(),
  design_json: z.unknown().nullable().optional(),
  html_content: z.string().max(1_000_000).optional(),
})

// W0.11 — a template with no location belongs to the platform, not to any
// tenant: assertLocationAccessOr404 passes a null location through and the
// permission check was skipped for it, so any staff member anywhere could
// read, edit or delete it by id. Platform rows are master-only.
function platformTemplateGuard(user, locationId) {
  if (locationId) return null
  const isMaster = user.isMaster || user.role === 'master' || user.profileRole === 'master'
  return isMaster ? null : NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })
}

// `found` and `locationId` are kept apart: a missing row and a platform row
// (location_id NULL) both used to come back as a falsy location, so PUT and
// DELETE 404'd a platform template for everyone, masters included.
async function loadTemplateLocation(db, id) {
  const { data } = await db.from('email_templates').select('location_id').eq('id', id).single()
  return { found: Boolean(data), locationId: data?.location_id ?? null }
}

// GET /api/templates/[id]
export async function GET(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'email')) return emailForbidden()

  const db = createServerClient()
  const { data, error } = await db.from('email_templates')
    .select('*')
    .eq('id', params.id)
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 404 })

  const guard = assertLocationAccessOr404(user, data.location_id)
  if (guard) return guard
  const pg = platformTemplateGuard(user, data.location_id)
  if (pg) return pg
  // A location-less template has no studio to judge at: it is master-only
  // (above), and the coarse check (email somewhere) is its rule, as it is on
  // the editor page.
  if (data.location_id && !hasPermissionForLocation(user, data.location_id, 'email')) return emailForbidden()

  return NextResponse.json({ success: true, template: data })
}

// PUT /api/templates/[id]
export async function PUT(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'email')) return emailForbidden()

  const db = createServerClient()
  const { found, locationId } = await loadTemplateLocation(db, params.id)
  if (!found) return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  const pg = platformTemplateGuard(user, locationId)
  if (pg) return pg
  // Same rule as GET: a platform template (master-only, above) has no studio
  // to judge `email` at; the coarse check (email somewhere) is its rule.
  if (locationId && !hasPermissionForLocation(user, locationId, 'email')) return emailForbidden()

  const validation = await validateBody(request, TemplateUpdateSchema)
  if (!validation.ok) return validation.response
  const updates = { ...validation.data }

  const { data, error } = await db.from('email_templates')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, template: data })
}

// DELETE /api/templates/[id]
export async function DELETE(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'email')) return emailForbidden()

  const db = createServerClient()
  const { found, locationId } = await loadTemplateLocation(db, params.id)
  if (!found) return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  const pg = platformTemplateGuard(user, locationId)
  if (pg) return pg
  // Same rule as GET: a platform template (master-only, above) has no studio
  // to judge `email` at; the coarse check (email somewhere) is its rule.
  if (locationId && !hasPermissionForLocation(user, locationId, 'email')) return emailForbidden()

  const { error } = await db.from('email_templates').delete().eq('id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
