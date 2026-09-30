import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess , getUserLocationIds} from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'

// GATES-2 — `email` at the studio the list or the new template is for (the
// rule of /api/templates/[id] and /api/campaigns/[id]/send). Before, any
// member of the studio passed.
const emailForbidden = () => NextResponse.json(
  { success: false, error: 'No email permission at this location' }, { status: 403 })

const TemplateCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  category: z.string().max(50).optional(),
  design_json: z.unknown().nullable().optional(),
  html_content: z.string().max(1_000_000).optional(),
  location_id: uuidLike.optional(),
})

// GET /api/templates — list email templates
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'email')) return emailForbidden()

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (locationId && !hasPermissionForLocation(user, locationId, 'email')) return emailForbidden()

  const db = createServerClient()
  let query = db.from('email_templates')
    .select('id, name, description, category, thumbnail_url, created_at, updated_at')
    .order('updated_at', { ascending: false })

  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    // Only the studios where the caller holds `email`.
    const userLocationIds = getUserLocationIds(user).filter((id) => hasPermissionForLocation(user, id, 'email'))
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, templates: [] })
    query = query.in('location_id', userLocationIds)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, templates: data })
}

// POST /api/templates — create template
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'email')) return emailForbidden()

  const validation = await validateBody(request, TemplateCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const locationId = body.location_id || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasPermissionForLocation(user, locationId, 'email')) return emailForbidden()

  const db = createServerClient()
  const { data, error } = await db.from('email_templates').insert({
    name: body.name || 'Untitled Template',
    description: body.description || null,
    category: body.category || 'general',
    design_json: body.design_json || null,
    html_content: body.html_content || '',
    location_id: locationId,
    created_by: user.id,
  }).select().single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, template: data })
}
