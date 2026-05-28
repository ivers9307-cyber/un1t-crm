// CHECKLIST.2 — lazy instance generation + tick recording.
//
// Generation flow (resolveTodayInstances):
//   1. Resolve "today" in the location's timezone → calendar date.
//   2. Find the coach's shift assignments at that location on that
//      date (status NOT cancelled). If none, no checklists today.
//   3. Look up the template at (location, role, day_of_week) for
//      the coach's role. If no template, nothing to surface.
//   4. Upsert an instance keyed (profile, date, template). Snapshot
//      the template's items into the new row; deadline_at = end of
//      the latest shift block today.
//   5. Return the instance(s) — multiple roles → multiple instances,
//      but in practice a coach holds one role per location so this
//      is almost always 0 or 1.
//
// Tick flow (tickItem):
//   1. Read the instance, validate item_id exists in the snapshot.
//   2. Patch items_checked: set or remove the key.
//   3. If every snapshot item id now has a key → status=complete,
//      completed_at=now. Otherwise revert to pending.
//
// Both surfaces are stamp-and-go — no DB triggers do this work
// because the logic depends on caller identity (checked_by) which
// the DB doesn't see cleanly with the service-role client.

import { logWarn } from '@/lib/log'

// Shift assignments in these states do NOT count as "on shift" for
// generation. Mirrors the existing schedule UIs.
const SKIP_ASSIGNMENT_STATUSES = Object.freeze(['cancelled'])

export const INSTANCE_STATUS = Object.freeze({
  PENDING:    'pending',
  COMPLETE:   'complete',
  INCOMPLETE: 'incomplete',
})

// ────────────────────────────────────────────────────────────────
// Pure helpers — exported for tests
// ────────────────────────────────────────────────────────────────

/**
 * Resolve "today" in a given IANA timezone as YYYY-MM-DD + dow.
 * Uses Intl.DateTimeFormat — works everywhere modern (Node 19+,
 * Edge runtime, browsers). Returns:
 *   { date: 'YYYY-MM-DD', dow: 0..6 }   (Sun=0, Sat=6 — matches Pg)
 *
 * Pure: takes a Date so tests can fix it.
 */
export function todayInTimezone(now, timezone) {
  const tz = timezone || 'Europe/Dublin'
  // Get the calendar-date parts in tz.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(now)
  const find = (t) => parts.find((p) => p.type === t)?.value
  const date = `${find('year')}-${find('month')}-${find('day')}`
  // Convert weekday short label to dow (Pg convention).
  const weekday = find('weekday')   // e.g. "Mon"
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return { date, dow: DOW[weekday] ?? 0 }
}

/**
 * Given the shift blocks (with start/end times resolved) on a date,
 * compute the deadline_at = end of the LATEST block today, as a
 * timestamptz string. Returns null if no usable blocks.
 *
 * blocks: [{ block_date: 'YYYY-MM-DD', end_time: 'HH:MM:SS' }, ...]
 * timezone: IANA tz string
 */
export function computeDeadlineAt(blocks, timezone) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null
  let latestUtcMs = null
  for (const b of blocks) {
    if (!b?.block_date || !b?.end_time) continue
    const iso = `${b.block_date}T${b.end_time}`
    const ms = parseLocalToUtcMs(iso, timezone || 'Europe/Dublin')
    if (Number.isFinite(ms) && (latestUtcMs == null || ms > latestUtcMs)) {
      latestUtcMs = ms
    }
  }
  return latestUtcMs == null ? null : new Date(latestUtcMs).toISOString()
}

/**
 * Compute the next status given the items snapshot + the
 * items_checked map. Pure.
 * - Every snapshot item id is keyed → 'complete'
 * - Otherwise → 'pending'
 *
 * 'incomplete' is set by the PR 3 cron, not from this path.
 */
export function computeStatus(items, itemsChecked) {
  if (!Array.isArray(items) || items.length === 0) return INSTANCE_STATUS.PENDING
  const keys = new Set(Object.keys(itemsChecked || {}))
  for (const item of items) {
    if (!keys.has(item.id)) return INSTANCE_STATUS.PENDING
  }
  return INSTANCE_STATUS.COMPLETE
}

/**
 * Apply a single tick / untick to an items_checked map. Pure;
 * returns a new map (caller writes it back).
 */
export function applyTick(itemsChecked, { itemId, checked, byProfileId, at }) {
  const next = { ...(itemsChecked || {}) }
  if (checked) {
    next[itemId] = {
      checked_at: (at || new Date()).toISOString(),
      checked_by: byProfileId,
    }
  } else {
    delete next[itemId]
  }
  return next
}

// Parse a local 'YYYY-MM-DDTHH:MM[:SS]' wall-clock time in a given
// timezone to a UTC ms epoch. Approximate (DST around the boundary
// minute may shift by an hour) — fine for deadlines which round to
// the minute. Inverse of Intl.DateTimeFormat.
function parseLocalToUtcMs(localIso, timezone) {
  // Trim off any trailing 'Z' or offset — local means local.
  const cleaned = localIso.replace(/[zZ].*$/, '').replace(/[+-]\d\d:?\d\d$/, '')
  // Compose a guess UTC and snap by the timezone offset at that
  // moment. Two-pass to absorb DST in the same direction.
  const guess = Date.parse(`${cleaned}Z`)
  if (!Number.isFinite(guess)) return NaN
  const offsetMs = tzOffsetMs(new Date(guess), timezone)
  const candidate = guess - offsetMs
  // One refinement in case DST shifted under us.
  const offsetMs2 = tzOffsetMs(new Date(candidate), timezone)
  return guess - offsetMs2
}

function tzOffsetMs(date, timezone) {
  // Intl can give us the wall-clock parts in the target tz; compute
  // their UTC ms and the diff is the offset.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts = fmt.formatToParts(date)
  const find = (t) => parts.find((p) => p.type === t)?.value
  const localMs = Date.UTC(
    Number(find('year')),
    Number(find('month')) - 1,
    Number(find('day')),
    Number(find('hour')),
    Number(find('minute')),
    Number(find('second')),
  )
  return localMs - date.getTime()
}

// ────────────────────────────────────────────────────────────────
// DB-backed: lookups, generation, ticking
// ────────────────────────────────────────────────────────────────

/**
 * Fetch the coach's shift assignments for a given (location, date).
 * Returns the joined block + assignment rows we need to compute
 * deadline_at. Cancelled assignments are excluded.
 */
export async function listTodayShiftBlocks(db, { profileId, locationId, date }) {
  if (!profileId || !locationId || !date) return []
  const { data, error } = await db
    .from('shift_assignments')
    .select(`
      id, status,
      start_time_override, end_time_override,
      shift_blocks!inner (
        id, location_id, block_date, start_time, end_time
      )
    `)
    .eq('profile_id', profileId)
    .eq('shift_blocks.location_id', locationId)
    .eq('shift_blocks.block_date', date)
  if (error) {
    logWarn('checklist-instances', 'listTodayShiftBlocks failed', { error: error.message })
    return []
  }
  return (data || [])
    .filter((sa) => !SKIP_ASSIGNMENT_STATUSES.includes(sa.status))
    .map((sa) => ({
      assignment_id: sa.id,
      block_date:    sa.shift_blocks.block_date,
      start_time:    sa.start_time_override || sa.shift_blocks.start_time,
      end_time:      sa.end_time_override   || sa.shift_blocks.end_time,
    }))
}

/**
 * Find the matching template for a coach's role on a given date
 * at a location. Returns the template row or null.
 */
export async function findMatchingTemplate(db, { locationId, role, dow }) {
  if (!locationId || !role || dow == null) return null
  const { data } = await db
    .from('checklist_templates')
    .select('id, name, items, enabled')
    .eq('location_id', locationId)
    .eq('role', role)
    .eq('day_of_week', dow)
    .eq('enabled', true)
    .maybeSingle()
  return data || null
}

/**
 * Resolve (and lazily create) the coach's checklist instances for
 * today. Returns an array (usually 0 or 1) of instance rows. The
 * caller can iterate; the mobile UI shows them as one "today's
 * checklist" surface.
 */
export async function resolveTodayInstances(db, {
  profile, location, now = new Date(),
}) {
  if (!profile || !location) return []
  const { date, dow } = todayInTimezone(now, location.timezone)

  // 1. Is the coach on shift today at this location?
  const blocks = await listTodayShiftBlocks(db, {
    profileId: profile.id, locationId: location.id, date,
  })
  if (blocks.length === 0) return []

  // 2. Is there a template for their role + this dow at this location?
  // The coach's role at THIS location is read from profile_locations,
  // which the caller resolves; fall back to the top-level role if
  // the per-location join wasn't done.
  const role = profile.location_role || profile.role
  if (!role) return []
  const template = await findMatchingTemplate(db, {
    locationId: location.id, role, dow,
  })
  if (!template) return []

  // 3. Compute the deadline from the latest block today.
  const deadlineAt = computeDeadlineAt(blocks, location.timezone)
  if (!deadlineAt) return []

  // 4. Upsert the instance. On conflict (profile, date, template)
  //    we leave the existing row alone — don't reset items_checked
  //    or shift the deadline forwards on a later view.
  const { data: existing } = await db
    .from('checklist_instances')
    .select('*')
    .eq('profile_id', profile.id)
    .eq('date', date)
    .eq('template_id', template.id)
    .maybeSingle()

  if (existing) {
    // If the schedule shifted the end time LATER mid-day, surface
    // that. We don't move the deadline EARLIER to avoid surprise
    // cron-fired incompletes.
    if (new Date(deadlineAt).getTime() > new Date(existing.deadline_at).getTime()) {
      const { data: updated } = await db
        .from('checklist_instances')
        .update({ deadline_at: deadlineAt })
        .eq('id', existing.id)
        .select()
        .single()
      return [updated || existing]
    }
    return [existing]
  }

  const { data: created, error: insErr } = await db
    .from('checklist_instances')
    .insert({
      template_id: template.id,
      profile_id:  profile.id,
      location_id: location.id,
      date,
      items:       template.items || [],
      items_checked: {},
      deadline_at: deadlineAt,
      status:      INSTANCE_STATUS.PENDING,
    })
    .select()
    .single()
  if (insErr) {
    logWarn('checklist-instances', 'create failed', { error: insErr.message })
    return []
  }
  return [created]
}

/**
 * Tick (or untick) a single item on an instance. Validates that
 * the caller owns the instance and that the item exists in the
 * snapshot. Returns the updated instance row or an error envelope.
 */
export async function tickItem(db, {
  instanceId, itemId, checked, user,
}) {
  if (!instanceId || !itemId || !user?.id) {
    return { ok: false, status: 400, error: 'instance, item and user required.', code: 'bad_args' }
  }
  const { data: instance } = await db
    .from('checklist_instances')
    .select('id, profile_id, items, items_checked, status, completed_at, location_id, date, template_id, deadline_at')
    .eq('id', instanceId)
    .maybeSingle()
  if (!instance) {
    return { ok: false, status: 404, error: 'Checklist not found.', code: 'not_found' }
  }
  if (instance.profile_id !== user.id) {
    // 404 not 403 so we don't leak existence.
    return { ok: false, status: 404, error: 'Checklist not found.', code: 'not_yours' }
  }
  const item = (instance.items || []).find((i) => i.id === itemId)
  if (!item) {
    return { ok: false, status: 400, error: 'Item not on this checklist.', code: 'unknown_item' }
  }

  const itemsChecked = applyTick(instance.items_checked || {}, {
    itemId, checked: !!checked, byProfileId: user.id, at: new Date(),
  })
  const status = computeStatus(instance.items, itemsChecked)
  const completed_at = status === INSTANCE_STATUS.COMPLETE
    ? (instance.completed_at || new Date().toISOString())
    : null

  const { data: updated, error: updErr } = await db
    .from('checklist_instances')
    .update({ items_checked: itemsChecked, status, completed_at })
    .eq('id', instance.id)
    .select()
    .single()
  if (updErr) {
    return { ok: false, status: 500, error: updErr.message, code: 'update_failed' }
  }
  return { ok: true, data: updated }
}
