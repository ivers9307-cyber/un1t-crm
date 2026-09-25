import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { dublinTodayStr } from '@/lib/dublin-time'
import { validateBody } from '@/lib/validate'
import { timeOfDay, hexColor , MANAGER_ROLES} from '@/lib/schemas'
import { WEEKDAY_CODES, generateBlocksForTemplate, liveAssignments } from '@/lib/roster'
import { logRosterChange } from '@/lib/roster-change-log'
import {
  readFutureBlocksForTemplate,
  clearEmptyFutureBlocks,
  planBlockCapacityUpdates,
} from '@/lib/shift-template-blocks'
import { SHIFT_KINDS } from '@shared/shift-kind'
import { resolveTemplateKindWrite } from '@/lib/shift-template-kind'

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
  // SHIFTMIN.1 — minimum coaches floor.
  min_coaches: z.number().int().min(0).max(50).optional(),
  // SHIFTTYPE.1 (mig 628) — see resolveTemplateKindWrite for the rule.
  kind: z.enum(SHIFT_KINDS).optional(),
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
//     via the FK cascade on shift_assignments.shift_block_id) — EXCEPT
//     (ROSTER-FIX.4) where such a block still has LIVE assignments,
//     published or not: the whole PUT is refused with 409
//     `blocks_have_assignments` listing the dates, because deleting
//     those blocks cancels a coach's shift with no notice and no trace.
//   - start_time / end_time change on a PUBLISHED block → a
//     roster_change_log `time_changed` row per live coach, so the next
//     publish of that period re-notifies them (ROSTER-FIX.4).
//   - active:false → future blocks that are BOTH empty of live
//     assignments AND not on a published roster are deleted, and
//     regeneration is SKIPPED (it used to re-create every block it had
//     just removed). A block with a live coach on it is left alone —
//     deactivating a template must not cancel a shift — and so is an
//     empty PUBLISHED block (ROSTER-FIX.4): it is on a roster staff
//     have already been shown, and unlike the day-removal path there
//     is no change-log entry saying it went, so the slot would vanish
//     from a published week with nothing recording it. The count kept
//     back comes out as `propagation.publishedEmptiesKept`.
//   - kind (SHIFTTYPE.1): class -> admin also writes min_coaches 0, which
//     propagates to FUTURE blocks like any minimum edit. Past blocks keep
//     their minimum; staffing never reads a past block, and it reads kind
//     through the template, so an admin block's stale minimum is inert.
//
// Today is computed in UTC because shift_blocks.block_date is a
// calendar date with no TZ. Comparing block_date >= today_utc gives
// the right "future" boundary for the day the operator is in
// (within ±1 day, acceptable for this surface).
export async function PUT(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  // SCHEDROLES.1 — coarse pre-check only; the authority decision is the
  // role at the TEMPLATE's location, once the row is loaded below.
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, TemplateUpdateSchema)
  if (!validation.ok) return validation.response
  const updates = { ...validation.data }
  const db = createServerClient()

  // Fetch the template by id FIRST — this route runs the service-role
  // client (RLS bypassed), so this app-layer check is the ONLY thing
  // stopping a manager at tenant A from editing tenant B's template by
  // id. The same fetch doubles as the OLD-template read we need to diff
  // days_of_week (which days were removed), so one scoped read serves
  // both. Absent row → 404; foreign-tenant row → 404 too (detail route,
  // so a cross-tenant id is indistinguishable from a missing one).
  const { data: priorTemplate } = await db
    .from('shift_templates')
    .select('location_id, days_of_week, kind, min_coaches')
    .eq('id', params.id)
    .maybeSingle()
  if (!priorTemplate) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, priorTemplate.location_id)
  if (guard) return guard
  // SCHEDROLES.1 — a member of the template's studio who is not a manager
  // THERE (e.g. head coach at their active studio, staff at this one).
  if (!hasRoleAtLocation(user, priorTemplate.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  const locationId = priorTemplate.location_id
  // SHIFTTYPE.1 — kind + minimum. Runs BEFORE changingCapacity is computed
  // below: a switch to admin adds min_coaches: 0 to `updates`, and that must
  // reach the future blocks through the SHIFTMIN-CLAMP.1 path like any other
  // minimum edit. An explicit minimum on an admin template is refused before
  // any write.
  const kindWrite = resolveTemplateKindWrite({ prior: priorTemplate, body: validation.data })
  if (!kindWrite.ok) return NextResponse.json(kindWrite.body, { status: kindWrite.status })
  Object.assign(updates, kindWrite.patch)
  const priorDays = new Set(priorTemplate.days_of_week || [])

  const today = dublinTodayStr()
  const changingTimes = Object.prototype.hasOwnProperty.call(updates, 'start_time')
    || Object.prototype.hasOwnProperty.call(updates, 'end_time')
  const changingDays = Object.prototype.hasOwnProperty.call(updates, 'days_of_week')
  const deactivating = updates.active === false
  // SHIFTMIN-CLAMP.1 — a capacity edit now needs the blocks' OWN min/max, so
  // each one can be clamped against its own ceiling rather than pushed the
  // same number in a single statement that the CHECK can fail wholesale.
  const changingCapacity = Object.prototype.hasOwnProperty.call(updates, 'min_coaches')
    || Object.prototype.hasOwnProperty.call(updates, 'max_coaches')
  // SHIFTTPL.1 — a REORDER is one PUT per template that moved, and running the
  // 8-week generator behind each click is work nobody asked for. Narrow on
  // purpose: only a display_order-only body skips it. Every other edit keeps
  // the rolling-horizon backfill it has always had, because that backfill is
  // load-bearing for more than the field being written (SLOTREMOVAL.1's
  // regeneration test saves a name for exactly that reason).
  const reorderOnly = Object.keys(updates).length > 0
    && Object.keys(updates).every((k) => k === 'display_order')

  // ROSTER-FIX.4 — a template edit is a BULK EDIT of everybody's shifts, and
  // on a published roster those shifts are promises already made to coaches.
  // Read the future blocks WITH their roster status and assignments once,
  // before anything is written, so we can refuse the destructive case and
  // change-log the rest.
  let futureBlocks = []
  if (changingTimes || changingDays || deactivating || changingCapacity) {
    const { blocks, error: fbErr } = await readFutureBlocksForTemplate(db, {
      templateId: params.id, locationId, today,
    })
    if (fbErr) {
      return NextResponse.json({ success: false, error: fbErr.message }, { status: 400 })
    }
    futureBlocks = blocks
  }

  const isPublishedBlock = (b) => b.rosters?.status === 'published'
  const blockDayCode = (b) => WEEKDAY_CODES[(new Date(b.block_date + 'T00:00:00Z').getUTCDay() + 6) % 7]

  // ROSTER-FIX.4 — REFUSE, before any write, to remove a weekday whose future
  // blocks still have live coaches on them. The old code deleted those blocks
  // and the FK cascaded their assignments away, so a coach lost a shift with
  // no notice and no trace: they turned up for a shift that no longer existed.
  // The operator unassigns first; the dates are listed so they know where to
  // look.
  //
  // The refusal covers DRAFT blocks too, not just published ones. A draft
  // block with coaches on it is the more destructive case, if anything: the
  // deactivate path already leaves a staffed draft block alone, so removing a
  // weekday was the one route that still cascaded live assignments away —
  // silently, and with the roster about to be published carrying a hole in it.
  // Nothing here is a notice to staff either way; the only safe answer is to
  // make the operator unassign deliberately.
  const removedDays = changingDays
    ? [...priorDays].filter((d) => !new Set(updates.days_of_week || []).has(d))
    : []
  if (removedDays.length > 0) {
    const blocked = futureBlocks.filter((b) => (
      removedDays.includes(blockDayCode(b))
      && liveAssignments(b.shift_assignments).length > 0
    ))
    if (blocked.length > 0) {
      const dates = [...new Set(blocked.map((b) => b.block_date))].sort()
      return NextResponse.json({
        success: false,
        error: 'blocks_have_assignments',
        dates,
        message: `Unassign the coaches on ${dates.join(', ')} before removing that day — those shifts still have someone on them.`,
      }, { status: 409 })
    }
  }

  // Scope the UPDATE to the verified location too (not just id) so even
  // a racing re-point of the row can't cross tenants.
  const { data: template, error } = await db.from('shift_templates')
    .update(updates)
    .eq('id', params.id)
    .eq('location_id', locationId)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  // ---------- Propagate to FUTURE blocks only ----------

  // 1. If start_time / end_time / max_coaches changed, push the
  //    new values onto every future block under this template.
  const futureFieldUpdates = {}
  if (Object.prototype.hasOwnProperty.call(updates, 'start_time')) {
    futureFieldUpdates.start_time = template.start_time
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'end_time')) {
    futureFieldUpdates.end_time = template.end_time
  }
  let futureBlocksUpdated = 0
  if (Object.keys(futureFieldUpdates).length > 0) {
    const { data: updatedBlocks, error: updErr } = await db
      .from('shift_blocks')
      .update(futureFieldUpdates)
      .eq('template_id', params.id)
      .eq('location_id', locationId)
      .gte('block_date', today)
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

  // SHIFTMIN-CLAMP.1 — min_coaches / max_coaches do NOT ride the statement
  // above. `shift_blocks_min_coaches_check` (mig 177) forbids min > max per
  // ROW, so one UPDATE writing the template's minimum onto every future block
  // fails ENTIRELY the moment a single block's max sits below it — and the
  // template row has already saved by then, so the operator gets a saved
  // template, a warning they cannot act on, and a calendar still flagging the
  // old minimum. Mig 611 solved the same thing with LEAST(min, max); this is
  // that, grouped into one statement per distinct clamped value.
  let capacityWarning = null
  if (changingCapacity) {
    const groups = planBlockCapacityUpdates(futureBlocks, {
      minCoaches: Object.prototype.hasOwnProperty.call(updates, 'min_coaches') ? template.min_coaches : null,
      maxCoaches: Object.prototype.hasOwnProperty.call(updates, 'max_coaches') ? template.max_coaches : null,
    })
    const failures = []
    for (const g of groups) {
      const { data: touched, error: capErr } = await db
        .from('shift_blocks')
        .update(g.patch)
        .in('id', g.ids)
        .eq('location_id', locationId)
        .select('id')
      // One failing group must not abandon the rest: the whole point is that
      // the blocks are no longer all-or-nothing.
      if (capErr) failures.push(capErr.message)
      else futureBlocksUpdated += touched?.length || 0
    }
    if (failures.length > 0) {
      capacityWarning = `Template saved but the coach minimum/maximum did not reach every future shift: ${failures.join('; ')}`
    }
  }

  // ROSTER-FIX.4 — a published shift whose window just moved is a change the
  // coach has to be told about. logRosterChange writes a roster_change_log
  // row per live coach on a published block (it no-ops for draft blocks),
  // which the next publish of that period picks up and re-notifies — the
  // same path a manual re-time already uses. Only blocks whose times ACTUALLY
  // moved are logged.
  let timeChangesLogged = 0
  if (changingTimes) {
    for (const b of futureBlocks) {
      if (!isPublishedBlock(b)) continue
      const newStart = futureFieldUpdates.start_time ?? b.start_time
      const newEnd = futureFieldUpdates.end_time ?? b.end_time
      if (newStart === b.start_time && newEnd === b.end_time) continue
      for (const a of liveAssignments(b.shift_assignments)) {
        const { logged } = await logRosterChange(db, {
          isPublished: true,
          locationId,
          action: 'time_changed',
          coachId: a.profile_id,
          actorId: user.id,
          blockId: b.id,
          blockDate: b.block_date,
          details: {
            source: 'template_edit',
            template_id: params.id,
            from: { start_time: b.start_time, end_time: b.end_time },
            to: { start_time: newStart, end_time: newEnd },
          },
        })
        if (logged) timeChangesLogged++
      }
    }
  }

  // 2. If days_of_week REMOVED any day, delete future blocks on
  //    that day. The shift_assignments FK on block_id cascades, so
  //    any draft assignments at those blocks are removed too.
  let futureBlocksDeleted = 0
  if (changingDays) {
    if (removedDays.length > 0) {
      // We can't filter by weekday in SQL directly without a date_part call,
      // so filter the future blocks we already read in JS. The volume is
      // small — at most 8 weeks × 7 days = 56 rows. Anything still here
      // passed the published-with-live-coaches refusal above.
      const toDelete = futureBlocks.filter((b) => removedDays.includes(blockDayCode(b)))
      if (toDelete.length > 0) {
        const { error: delErr } = await db
          .from('shift_blocks')
          .delete()
          .in('id', toDelete.map((b) => b.id))
          .eq('location_id', locationId)
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

  // ROSTER-FIX.4 — deactivating a template. The old code deactivated the
  // row and then, one step later, REGENERATED its blocks for the next 8
  // weeks — so "switch this shift off" left the calendar exactly as it was.
  // Regeneration is skipped below; here the future blocks nobody is on are
  // cleared out. A block with a live coach is LEFT ALONE: deactivating a
  // template must not silently cancel somebody's shift (unassign first).
  //
  // ROSTER-FIX.4 — an empty block on a PUBLISHED roster is kept back too. It
  // is part of a week staff have already been shown, and this path writes no
  // roster_change_log row, so deleting it made a published slot disappear
  // with nothing recording that it ever existed — an unstaffed shift the
  // manager still has to fill is exactly the one they need to keep seeing.
  // The count is reported so the operator learns why the calendar did not go
  // empty; clearing those is the publish path's job, not a side effect here.
  //
  // SHIFTTPL.1 — the clean-up itself now lives in `clearEmptyFutureBlocks` so
  // the DELETE route (which is what the web Deactivate button calls) performs
  // exactly the same one.
  let deactivatedBlocksDeleted = 0
  let publishedEmptiesKept = 0
  if (deactivating) {
    const cleared = await clearEmptyFutureBlocks(db, {
      templateId: params.id, locationId, today, blocks: futureBlocks,
    })
    publishedEmptiesKept = cleared.publishedEmptiesKept
    if (cleared.error) {
      return NextResponse.json({
        success: true,
        data: template,
        warning: `Template deactivated but clearing its empty future blocks failed: ${cleared.error.message}`,
        propagation: { futureBlocksUpdated, futureBlocksDeleted, timeChangesLogged, deactivatedBlocksDeleted: 0, publishedEmptiesKept },
      })
    }
    deactivatedBlocksDeleted = cleared.deleted
  }

  // 3. Backfill any missing dates in the next 8 weeks (handles ADDED
  //    days, plus the rolling horizon). Idempotent — the unique key
  //    on (location, template, date) means existing blocks are
  //    untouched; only genuinely new dates get rows.
  //
  // SHIFTTPL.1 — skipped for a reorder, which writes `display_order` on every
  // template that moved and has no block consequences at all.
  let generated = { inserted: 0, skipped: 0 }
  if (!deactivating && !reorderOnly && (template.days_of_week?.length || 0) > 0) {
    try {
      generated = await generateBlocksForTemplate(db, template)
    } catch (e) {
      return NextResponse.json({
        success: true,
        data: template,
        warning: `Template + future fields saved, but new-day generation failed: ${e.message}`,
        propagation: { futureBlocksUpdated, futureBlocksDeleted, timeChangesLogged, deactivatedBlocksDeleted, publishedEmptiesKept },
      })
    }
  }

  return NextResponse.json({
    success: true,
    data: template,
    generated,
    propagation: { futureBlocksUpdated, futureBlocksDeleted, timeChangesLogged, deactivatedBlocksDeleted, publishedEmptiesKept },
    ...(capacityWarning ? { warning: capacityWarning } : {}),
  })
}

// DELETE /api/schedule/templates/:id[?hard=true]
//
// SHIFTTPL.1 — TWO findings met here.
//
// 1. CONSISTENCY. This is the route the web Deactivate button calls, and all
//    it did was set `active:false`. The PUT route's `active:false` path also
//    CLEARS the future blocks nobody is on (keeping the published ones, which
//    staff have already been shown). So the same operator action left the
//    calendar full of slots for a shift that no longer exists, or not,
//    depending on which surface they happened to use. Both now run
//    `clearEmptyFutureBlocks`.
//
// 2. HARD DELETE. A template created by mistake could only ever be
//    deactivated, so it sat in the Inactive list forever. `?hard=true`
//    removes the row outright, but ONLY when it has no shift_blocks and no
//    shift_assignments ever — anything else is history, and
//    `shift_blocks.template_id` is ON DELETE RESTRICT precisely so the
//    database has the last word if this check races a block being created.
//    A refusal is a 409 naming what is in the way, and the operator
//    deactivates instead.
export async function DELETE(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  // SCHEDROLES.1 — coarse pre-check only; the authority decision is the
  // role at the TEMPLATE's location, once the row is loaded below.
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()
  const hard = wantsHardDelete(request)

  // Fetch the template's location FIRST so we can gate cross-tenant
  // access before mutating anything — the service-role client bypasses
  // RLS, so this is the only guard. Absent → 404; foreign-tenant row →
  // 404 too (detail route: a cross-tenant id must look identical to a
  // missing one).
  const { data: template } = await db
    .from('shift_templates')
    .select('location_id')
    .eq('id', params.id)
    .maybeSingle()
  if (!template) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, template.location_id)
  if (guard) return guard
  // SCHEDROLES.1 — manager AT the template's studio, not the active one.
  if (!hasRoleAtLocation(user, template.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  const locationId = template.location_id

  if (hard) {
    return hardDelete(db, { templateId: params.id, locationId })
  }

  // Soft-delete by deactivating. Scope the write to the verified location
  // too, so even a racing re-point of the row can't cross tenants.
  const { data, error } = await db.from('shift_templates')
    .update({ active: false })
    .eq('id', params.id)
    .eq('location_id', locationId)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  // SHIFTTPL.1 — the clean-up the PUT path has always done. Best-effort: the
  // template IS deactivated either way, and refusing to say so because the
  // tidy-up failed would be the louder failure.
  const cleared = await clearEmptyFutureBlocks(db, {
    templateId: params.id, locationId, today: dublinTodayStr(),
  })
  if (cleared.error) {
    return NextResponse.json({
      success: true,
      data,
      warning: `Template deactivated but clearing its empty future shifts failed: ${cleared.error.message}`,
      propagation: { deactivatedBlocksDeleted: 0, publishedEmptiesKept: cleared.publishedEmptiesKept },
    })
  }
  return NextResponse.json({
    success: true,
    data,
    propagation: {
      deactivatedBlocksDeleted: cleared.deleted,
      publishedEmptiesKept: cleared.publishedEmptiesKept,
    },
  })
}

// A DELETE carries no body, so the hard flag rides the query string. Read
// defensively: `request.url` is absolute in Next but need not be everywhere
// this is called from, and an unreadable URL must mean the SAFE answer
// (deactivate), never the destructive one.
function wantsHardDelete(request) {
  try {
    return new URL(request?.url).searchParams.get('hard') === 'true'
  } catch {
    return false
  }
}

// SHIFTTPL.1 — "no blocks and no assignments EVER". Both are checked, not
// just the one the FK would catch:
//   - blocks: any row at all, past or future. A past block is the record that
//     the shift ran, and a template with history is never deletable.
//   - assignments: they hang off blocks (ON DELETE CASCADE), so zero blocks
//     implies zero assignments — but the count is still taken over whatever
//     blocks exist, because the refusal reads very differently to an operator
//     when coaches are on them, and "check both" should not rest on a
//     cascade being remembered correctly.
// The `.in()` is bounded by the page read below; the refusal only needs to
// know that SOMETHING is in the way, never the exact total.
const BLOCK_PROBE_LIMIT = 1000

async function hardDelete(db, { templateId, locationId }) {
  const { data: blocks, error: blocksErr } = await db
    .from('shift_blocks')
    .select('id')
    .eq('template_id', templateId)
    .eq('location_id', locationId)
    .order('block_date', { ascending: true })
    .limit(BLOCK_PROBE_LIMIT)
  if (blocksErr) {
    // An unreadable probe must never read as "nothing in the way".
    return NextResponse.json({ success: false, error: blocksErr.message }, { status: 400 })
  }

  const blockIds = (blocks || []).map((b) => b.id)
  if (blockIds.length > 0) {
    const { count: assignmentCount, error: assignErr } = await db
      .from('shift_assignments')
      .select('id', { count: 'exact', head: true })
      .in('block_id', blockIds)
    if (assignErr) {
      return NextResponse.json({ success: false, error: assignErr.message }, { status: 400 })
    }
    return NextResponse.json({
      success: false,
      error: 'template_in_use',
      blocks: blockIds.length,
      assignments: assignmentCount || 0,
      message: assignmentCount
        ? `This template has shifts on the calendar and ${assignmentCount} coach assignment${assignmentCount === 1 ? '' : 's'}, so it cannot be deleted. Deactivate it instead, which keeps them.`
        : 'This template has shifts on the calendar, so it cannot be deleted. Deactivate it instead, which keeps them.',
    }, { status: 409 })
  }

  const { error: delErr } = await db
    .from('shift_templates')
    .delete()
    .eq('id', templateId)
    .eq('location_id', locationId)
  if (delErr) {
    // 23503 = a block was created between the probe and this statement.
    // `shift_blocks.template_id` is ON DELETE RESTRICT, which is why the
    // race ends in a refusal rather than a cascade.
    if (delErr.code === '23503') {
      return NextResponse.json({
        success: false,
        error: 'template_in_use',
        message: 'A shift was created for this template while it was being deleted, so it was kept. Deactivate it instead.',
      }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: delErr.message }, { status: 400 })
  }
  return NextResponse.json({ success: true, deleted: true })
}
