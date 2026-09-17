import { NextResponse, after } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, isoDate , MANAGER_ROLES} from '@/lib/schemas'
import { bulkUpsertShiftAssignments } from '@/lib/roster-write'
import { fetchSourceBlocks, buildCopyPlan, COPY_MODES } from '@/lib/roster-copy'
import { formatDate, fetchSlotRemovalKeys } from '@/lib/roster'
import { readAssignmentKeysInRange, logAndNotifyCopiedShifts } from '@/lib/roster-change-notify'

const CopyWeekSchema = z.object({
  location_id: uuidLike,
  source_start: isoDate,
  target_start: isoDate,
  // COPYMODES.1 — 'exact' is a carbon copy (today's behaviour, the default so
  // an old client is unchanged); 'template' re-applies the template slots.
  mode: z.enum(COPY_MODES).default('exact'),
})

// Date math extracted as pure helpers so the BST-sensitive bits are
// unit-testable without mocking Supabase (mirrors copy-month's exported
// daysInMonth/mapDayOfMonth). They build local-midnight Dates and format
// via roster.formatDate (LOCAL Y/M/D) — never toISOString(), which would
// slip the date back a day under BST.

/**
 * Last day of the source week: source_start (a Monday) + 6 days.
 * Returns YYYY-MM-DD.
 */
export function sourceWeekEnd(sourceStart) {
  const end = new Date(sourceStart + 'T00:00:00')
  end.setDate(end.getDate() + 6)
  return formatDate(end)
}

/**
 * Whole-day offset between two YYYY-MM-DD dates (target - source).
 * Positive when target is later. Built on local-midnight Dates so the
 * subtraction can't be skewed by a DST boundary between them.
 */
export function weekDayOffset(sourceStart, targetStart) {
  const s = new Date(sourceStart + 'T00:00:00')
  const t = new Date(targetStart + 'T00:00:00')
  return Math.round((t - s) / (1000 * 60 * 60 * 24))
}

/**
 * Shift a YYYY-MM-DD date by `dayOffset` whole days, returning
 * YYYY-MM-DD. Local-component arithmetic keeps Sunday in range and
 * lands the copy on the intended calendar day under BST.
 */
export function redateShiftDate(shiftDate, dayOffset) {
  const d = new Date(shiftDate + 'T00:00:00')
  d.setDate(d.getDate() + dayOffset)
  return formatDate(d)
}

// POST /api/schedule/shifts/copy-week
// Copy all shifts from one week to another
// Body: { location_id, source_start (Mon), target_start (Mon), mode? }
// mode: 'exact' (default) | 'template' — see src/lib/roster-copy.js.
// Response: { success, copied, skipped, skipped_removed, mode }
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, CopyWeekSchema)
  if (!validation.ok) return validation.response
  const { location_id, source_start, target_start, mode } = validation.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard

  const db = createServerClient()

  // Source week end (source_start + 6 days). See sourceWeekEnd note:
  // local-component formatting, never toISOString() (BST off-by-one).
  const sourceEnd = sourceWeekEnd(source_start)

  // Source blocks (with their template + assignments) from the Roster v2
  // model. Paged, so it is never cut at the 1,000-row select cap.
  const { blocks: sourceBlocks, error: fetchError } = await fetchSourceBlocks(db, {
    locationId: location_id,
    startDate: source_start,
    endDate: sourceEnd,
  })

  if (fetchError) return NextResponse.json({ success: false, error: fetchError.message }, { status: 400 })

  // Re-date each source block into the target week (same weekday).
  const dayOffset = weekDayOffset(source_start, target_start)
  const plan = buildCopyPlan(sourceBlocks, {
    mode,
    mapDate: (d) => redateShiftDate(d, dayOffset),
  })

  // Nothing rostered in the source week: nothing to copy (the empty blocks the
  // nightly generator made are not a roster).
  if (plan.sourceAssignments === 0) {
    return NextResponse.json({ success: false, error: 'No shifts found in the source week' }, { status: 404 })
  }

  // NOTIFY.1 — snapshot the target week so coaches copied onto an already
  // PUBLISHED week can be logged and told. A copy onto an unpublished week
  // changes nothing here: the first publish notifies them.
  const targetEnd = sourceWeekEnd(target_start)
  const before = await readAssignmentKeysInRange(db, { locationId: location_id, startDate: target_start, endDate: targetEnd })

  // SLOTREMOVAL.1 — slots a manager deleted in the target week stay deleted:
  // the writer neither re-creates them nor places the source's coaches on
  // them (those coaches are counted as skipped). Read before any write, and
  // a failed read stops the copy — copying blind would bring them back.
  let removedSlots
  try {
    removedSlots = await fetchSlotRemovalKeys(db, { locationId: location_id, startDate: target_start, endDate: targetEnd })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }

  // Find-or-create blocks + insert assignments (new model). A block created
  // inside an already-published period joins that roster (ROSTER-FIX.4).
  const { count, skippedRemoved = 0, error } = await bulkUpsertShiftAssignments(db, {
    locationId: location_id,
    actorId: user.id,
    rows: plan.rows,
    blocks: plan.blocks,
    removedSlots,
  })

  // NOTIFY.1 review — the AFTER snapshot is read synchronously, here, right
  // after the upsert commits — not inside the deferred callback below, so it
  // can never race a second copy onto the same period. Only the log+notify
  // step (N change-log inserts plus a push/email per coach) is deferred via
  // next/server's `after`; awaiting that here risked a function timeout
  // AFTER the upsert had already committed, and a retry of a timed-out
  // request would then log nothing.
  const afterSnap = await readAssignmentKeysInRange(db, { locationId: location_id, startDate: target_start, endDate: targetEnd })

  after(() => logAndNotifyCopiedShifts(db, {
    locationId: location_id,
    actorId: user.id,
    startDate: target_start,
    endDate: targetEnd,
    before,
    after: afterSnap,
    via: 'copy_week',
  }))

  // Review fix — the writer batches its inserts, so an error can arrive AFTER
  // earlier batches committed. Those coaches are real and must still be logged
  // and told: the snapshot + after() above run first, and the before/after
  // diff only ever names what actually landed. A retry cannot catch them up,
  // because its own before-snapshot already contains them.
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  // skipped_removed is the part of `skipped` that landed on a deleted slot
  // (SLOTREMOVAL.1), so the toast can say why.
  return NextResponse.json({
    success: true, copied: count, skipped: plan.skipped + skippedRemoved, skipped_removed: skippedRemoved, mode,
  }, { status: 201 })
}
