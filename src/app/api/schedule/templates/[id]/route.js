import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { timeOfDay, hexColor , MANAGER_ROLES} from '@/lib/schemas'
import { WEEKDAY_CODES, generateBlocksForTemplate } from '@/lib/roster'

const TemplateUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  start_time: timeOfDay.optional(),
  end_time: timeOfDay.optional(),
  color: hexColor.optional(),
  role_label: z.string().max(50).nullable().optional(),
  active: z.boolean().optional(),
  display_order: z.number().int().min(0).max(1000).optional(),
  days_of_week: z.array(z.enum(WEEKDAY_CODES)).optional(),
  max_coaches: z.number().int().min(1).max(50).optional(),
})

// PUT /api/schedule/templates/:id
// Roster v2: when days_of_week or max_coaches change, regenerate
// blocks for the next 8 weeks. Existing blocks are preserved
// (unique constraint on (location, template, date)) — only missing
// dates get filled in. Capacity changes apply to NEW blocks only;
// existing block.max_coaches is a snapshot from generation time.
export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, TemplateUpdateSchema)
  if (!validation.ok) return validation.response
  const updates = { ...validation.data }
  const db = createServerClient()

  const { data: template, error } = await db.from('shift_templates')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  // If the days_of_week or max_coaches changed, materialise blocks
  // for the new configuration. Idempotent — won't disturb blocks
  // that already exist.
  let generated = { inserted: 0, skipped: 0 }
  const shouldRegen =
    Object.prototype.hasOwnProperty.call(updates, 'days_of_week') ||
    Object.prototype.hasOwnProperty.call(updates, 'max_coaches') ||
    Object.prototype.hasOwnProperty.call(updates, 'start_time') ||
    Object.prototype.hasOwnProperty.call(updates, 'end_time')

  if (shouldRegen && (template.days_of_week?.length || 0) > 0) {
    try {
      generated = await generateBlocksForTemplate(db, template)
    } catch (e) {
      return NextResponse.json({
        success: true,
        data: template,
        warning: `Template updated but block generation failed: ${e.message}`,
      })
    }
  }

  return NextResponse.json({ success: true, data: template, generated })
}

// DELETE /api/schedule/templates/:id
export async function DELETE(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()

  // Soft-delete by deactivating (can't delete if shifts reference it)
  const { data, error } = await db.from('shift_templates')
    .update({ active: false })
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}
