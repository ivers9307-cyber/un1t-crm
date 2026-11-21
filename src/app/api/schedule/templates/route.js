import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { logError, logWarn } from '@/lib/log'
import { assertLocationAccess, getUserLocationIds, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'
import { MANAGER_ROLES, timeOfDay, hexColor, DEFAULT_COLOR } from '@/lib/schemas'
import { WEEKDAY_CODES, generateBlocksForTemplate } from '@/lib/roster'
import { SHIFT_KINDS } from '@shared/shift-kind'
import { resolveTemplateKindWrite } from '@/lib/shift-template-kind'

// days_of_week + max_coaches landed in mig 067 (Roster v2 phase 1).
// When a template is saved with non-empty days_of_week, we auto-
// generate shift_blocks for the next 8 weeks so the calendar has
// something to render. See src/lib/roster.js for the generator.
const CreateTemplateSchema = z.object({
  location_id: uuidLike,
  name: z.string().min(1).max(100),
  start_time: timeOfDay,
  end_time: timeOfDay,
  color: hexColor.optional(),
  role_label: z.string().max(50).nullable().optional(),
  display_order: z.number().int().min(0).max(1000).optional(),
  days_of_week: z.array(z.enum(WEEKDAY_CODES)).optional(),
  max_coaches: z.number().int().min(1).max(50).optional(),
  // SHIFTMIN.1 — minimum coaches floor. 0 = no minimum.
  // DB CHECK enforces min ≤ max; we don't cross-validate here
  // because max might also be in the same payload — let Postgres
  // be the source of truth for the relational invariant.
  min_coaches: z.number().int().min(0).max(50).optional(),
  // SHIFTTYPE.1 (mig 628) — class (default) or admin. An admin template has
  // no minimum: min_coaches > 0 with kind admin is refused (400), and the
  // database CHECKs it too (shift_templates_admin_no_minimum).
  kind: z.enum(SHIFT_KINDS).optional(),
})

// GET /api/schedule/templates?location_id=xxx
// withAuth signs the caller in (the same 401 assertLocationAccess gave).
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  let query = db.from('shift_templates').select('*').order('display_order').order('start_time')
  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    const userLocationIds = getUserLocationIds(user)
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, data: [] })
    query = query.in('location_id', userLocationIds)
  }

  const { data, error } = await query
  if (error) {
    logError('shift-templates', 'template list read failed', { locationId, code: error.code || null, err: error.message })
    return NextResponse.json({ success: false, error: 'Could not load the shift templates.' }, { status: 400 })
  }
  return NextResponse.json({ success: true, data })
})

// POST /api/schedule/templates — Create a shift template.
// Auto-generates blocks for the next 8 weeks if days_of_week is set.
//
// SCHEDROLES.1 — manager AT body.location_id, not at the active studio
// (`user.role`); the first check is only "manages somewhere".
// withAuth signs the caller in (401 signed out; this answered 403 before); the
// "manages somewhere" 403 and the rest stay by hand, in their old order.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, CreateTemplateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, body.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  // SHIFTTYPE.1 — kind + minimum, decided before any write.
  const kindWrite = resolveTemplateKindWrite({ prior: null, body })
  if (!kindWrite.ok) return NextResponse.json(kindWrite.body, { status: kindWrite.status })

  const { data: template, error } = await db.from('shift_templates').insert({
    location_id: body.location_id,
    name: body.name,
    start_time: body.start_time,
    end_time: body.end_time,
    color: body.color || DEFAULT_COLOR,
    role_label: body.role_label || null,
    display_order: body.display_order || 0,
    days_of_week: body.days_of_week || [],
    max_coaches: body.max_coaches || 15,
    // SHIFTMIN.1 — 1 is the class default and an explicit 0 is legitimate;
    // SHIFTTYPE.1 — an admin template is always 0. resolveTemplateKindWrite
    // decides both.
    kind: kindWrite.patch.kind,
    min_coaches: kindWrite.patch.min_coaches,
  }).select().single()

  if (error) {
    logError('shift-templates', 'template insert failed', { locationId: body.location_id, code: error.code || null, err: error.message })
    // 23514 is a CHECK refusal; the one a valid body can still hit is
    // shift_templates_min_coaches_check (mig 177).
    const message = error.code === '23514'
      ? 'Minimum coaches cannot be more than maximum coaches.'
      : 'Could not save the shift template.'
    return NextResponse.json({ success: false, error: message }, { status: 400 })
  }

  // Auto-generate blocks for the next 8 weeks.
  let generated = { inserted: 0, skipped: 0 }
  if (template.days_of_week?.length > 0) {
    try {
      generated = await generateBlocksForTemplate(db, template)
    } catch (e) {
      // Don't fail the template create — just surface as a warning.
      logWarn('shift-templates', 'block generation failed', { templateId: template.id, err: e?.message || String(e) })
      return NextResponse.json({
        success: true,
        data: template,
        warning: 'Template created but block generation failed.',
      }, { status: 201 })
    }
  }

  return NextResponse.json({ success: true, data: template, generated }, { status: 201 })
})
