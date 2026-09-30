import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { deleteTemplate as deleteMetaTemplate } from '@/lib/whatsapp'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { validateBody } from '@/lib/validate'
import { ownNumberOrRefusal } from '@/lib/whatsapp-own-number'

const TemplateUpdateSchema = z.object({
  name: z.string().max(200).optional(),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).optional(),
  components: z.array(z.unknown()).optional(),
  example_values: z.unknown().optional(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'PAUSED']).optional(),
  // Operator-defined picker grouping (mig 450) — local-only, editable at
  // any status (unlike the Meta-owned fields, which lock after submit).
  display_group: z.string().max(100).nullable().optional(),
  // Media-header upload fields (mig 045) — see notes on the create
  // route for what these are.
  // Meta's resumable-upload handles are opaque and can exceed 500 chars
  // for VIDEO assets (bit a real template 2026-06-11) — the DB column is
  // TEXT, so this is just a sanity bound. Keep it generous.
  header_media_handle: z.string().max(4000).nullable().optional(),
  header_media_url: z.string().url().max(2000).nullable().optional(),
  header_media_path: z.string().max(500).nullable().optional(),
})

async function loadTemplateLocation(db, id) {
  const { data } = await db.from('whatsapp_templates').select('location_id').eq('id', id).single()
  return data?.location_id
}

// GET /api/whatsapp/templates/[id]
export async function GET(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data, error } = await db.from('whatsapp_templates')
    .select('*')
    .eq('id', params.id)
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 404 })

  const guard = assertLocationAccessOr404(user, data.location_id)
  if (guard) return guard

  const { data: events } = await db.from('whatsapp_template_events')
    .select('kind, from_value, to_value, reason, created_at')
    .eq('template_id', params.id)
    .order('created_at', { ascending: false })
    .limit(50)

  return NextResponse.json({ success: true, template: data, events: events || [] })
}

// PUT /api/whatsapp/templates/[id] — update local record. A display_group-only
// edit is open to members; any other field needs MANAGER_ROLES at the
// template's location (WATPLROLE.1).
export async function PUT(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const loc = await loadTemplateLocation(db, params.id)
  if (!loc) return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, loc)
  if (guard) return guard

  const validation = await validateBody(request, TemplateUpdateSchema)
  if (!validation.ok) return validation.response
  const updates = { ...validation.data }
  // WATPLROLE.1 — status, components, header media, name and category drive
  // what a send uses (the header URL is the media customers receive), so
  // they take the resubmit rule: MANAGER_ROLES AT the template's location.
  // display_group alone is the picker grouping (never sent to Meta) that the
  // templates list saves inline for every member.
  const groupOnly = Object.keys(updates).every((k) => k === 'display_group')
  if (!groupOnly && !hasRoleAtLocation(user, loc, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  if ('display_group' in updates) updates.display_group = updates.display_group?.trim() || null

  const { data, error } = await db.from('whatsapp_templates')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, template: data })
}

// DELETE /api/whatsapp/templates/[id] — deletes AT META by name, then the row.
// MANAGER_ROLES at the template's location, the resubmit rule (WATPLROLE.1).
export async function DELETE(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()

  // Get template name + location to delete from Meta and verify access
  const { data: template } = await db.from('whatsapp_templates')
    .select('name, location_id')
    .eq('id', params.id)
    .single()
  if (!template) return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })

  const guard = assertLocationAccessOr404(user, template.location_id)
  if (guard) return guard
  // WATPLROLE.1 — membership alone let any staff member delete a template at
  // Meta (every automation still sending it then fails). Same rule as
  // resubmit: MANAGER_ROLES AT the template's location, before Meta.
  if (!hasRoleAtLocation(user, template.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // WACONFIGFALLBACK.1 — Meta deletes by NAME on a WABA, and this call named
  // no location, so it always deleted on the global env number's WABA: a
  // template row at any other location deleted the env studio's template of
  // the same name. Now: the template's own location's WABA only. A location
  // with no number has no WABA to delete from (its rows can only be copies
  // an old env-fallback sync made), so the Meta call is skipped and the local
  // row still goes. A failed lookup keeps the row (500), so a retry can still
  // reach Meta; otherwise the next sync would bring the template back.
  if (template.name) {
    const own = await ownNumberOrRefusal(template.location_id, 'wa-templates-delete')
    if (!own.ok && own.status === 500) {
      return NextResponse.json({ success: false, error: own.error }, { status: 500 })
    }
    if (own.ok) {
      try {
        await deleteMetaTemplate(template.name, { config: own.config })
      } catch (err) {
        console.error('Meta template delete error:', err)
      }
    }
  }

  const { error } = await db.from('whatsapp_templates').delete().eq('id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
