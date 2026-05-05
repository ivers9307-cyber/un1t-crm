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
//
// Edit propagation rules (the operator's mental model):
//   - PAST blocks (block_date < today) are NEVER touched. Completed
//     shifts keep the times/capacity they ran at. Audit truth.
//   - FUTURE blocks (block_date >= today) reflect the new template
//     IMMEDIATELY for start_time / end_time / max_coaches.
//   - days_of_week add → new blocks materialised for added days
//     across the next 8 weeks via generateBlocksForTemplate (idempotent).
//   - days_of_week remove → future blocks for the removed days are
//     DELETED (and any existing assignments under them go with them
//     via the FK cascade on shift_assignments.shift_block_id).
//
// Today is computed in UTC because shift_blocks.block_date is a
// calendar date with no TZ. Comparing block_date >= today_utc gives
// the right "future" boundary for the day the operator is in
// (within ±1 day, acceptable for this surface).
export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, TemplateUpdateSchema)
  if (!validation.ok) return validation.response
  const updates = { ...validation.data }
  const db = createServerClient()

  // Pre-fetch the OLD template so we can diff days_of_week and
  // know which days to delete (if any were removed).
  const { data: priorTemplate } = await db
    .from('shift_templates')
    .select('days_of_week')
    .eq('id', params.id)
    .single()
  const priorDays = new Set(priorTemplate?.days_of_week || [])

  const { data: template, error } = await db.from('shift_templates')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  // ---------- Propagate to FUTURE blocks only ----------

  const todayUtc = new Date().toISOString().slice(0, 10)

  // 1. If start_time / end_time / max_coaches changed, push the
  //    new values onto every future block under this template.
  const futureFieldUpdates = {}
  if (Object.prototype.hasOwnProperty.call(updates, 'start_time')) {
    futureFieldUpdates.start_time = template.start_time
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'end_time')) {
    futureFieldUpdates.end_time = template.end_time
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'max_coaches')) {
    futureFieldUpdates.max_coaches = template.max_coaches
  }
  let futureBlocksUpdated = 0
  if (Object.keys(futureFieldUpdates).length > 0) {
    const { data: updatedBlocks, error: updErr } = await db
      .from('shift_blocks')
      .update(futureFieldUpdates)
      .eq('template_id', params.id)
      .gte('block_date', todayUtc)
      .select('id')
    if (updErr) {
      return NextResponse.json({
        success: true,
        data: template,
        warning: `Template saved but propagation to future blocks failed: ${updErr.message}`,
      })
    }
    futureBlocksUpdated = updatedBlocks?.length || 0
  }

  // 2. If days_of_week REMOVED any day, delete future blocks on
  //    that day. The shift_assignments FK on block_id cascades, so
  //    any draft assignments at those blocks are removed too.
  let futureBlocksDeleted = 0
  if (Object.prototype.hasOwnProperty.call(updates, 'days_of_week')) {
    const newDays = new Set(template.days_of_week || [])
    const removedDays = [...priorDays].filter((d) => !newDays.has(d))

    if (removedDays.length > 0) {
      // We can't filter by weekday in SQL directly without a
      // date_part call, so pull the future blocks and filter in JS.
      // The volume is small — at most 8 weeks × 7 days = 56 rows.
      const { data: futureBlocks } = await db
        .from('shift_blocks')
        .select('id, block_date')
        .eq('template_id', params.id)
        .gte('block_date', todayUtc)
      const toDelete = (futureBlocks || []).filter((b) => {
        const code = WEEKDAY_CODES[(new Date(b.block_date + 'T00:00:00Z').getUTCDay() + 6) % 7]
        return removedDays.includes(code)
      })
      if (toDelete.length > 0) {
        const { error: delErr } = await db
          .from('shift_blocks')
          .delete()
          .in('id', toDelete.map((b) => b.id))
        if (delErr) {
          return NextResponse.json({
            success: true,
            data: template,
            warning: `Template saved + future fields propagated, but stale-day cleanup failed: ${delErr.message}`,
          })
        }
        futureBlocksDeleted = toDelete.length
      }
    }
  }

  // 3. Backfill any missing dates in the next 8 weeks (handles ADDED
  //    days, plus the rolling horizon). Idempotent — the unique key
  //    on (location, template, date) means existing blocks are
  //    untouched; only genuinely new dates get rows.
  let generated = { inserted: 0, skipped: 0 }
  if ((template.days_of_week?.length || 0) > 0) {
    try {
      generated = await generateBlocksForTemplate(db, template)
    } catch (e) {
      return NextResponse.json({
        success: true,
        data: template,
        warning: `Template + future fields saved, but new-day generation failed: ${e.message}`,
        propagation: { futureBlocksUpdated, futureBlocksDeleted },
      })
    }
  }

  return NextResponse.json({
    success: true,
    data: template,
    generated,
    propagation: { futureBlocksUpdated, futureBlocksDeleted },
  })
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
