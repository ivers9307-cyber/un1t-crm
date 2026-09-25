// SCHEDULE-CHANGE-LOG.1 — audit + re-notify helpers for edits to an
// already-published roster.
//
// logRosterChange() records an edit ONLY when the affected block belongs
// to a published roster (draft edits aren't audited — those ride the
// normal first-publish notification). On a re-publish, the publish path
// reads the still-unnotified rows (collectUnnotifiedChanges), re-notifies
// the distinct coaches, and stamps them (markChangesNotified) so they
// aren't re-pinged next time.

import { logWarn } from './log'
import { ROSTER_CHANGE_LOG_MAX_ROWS } from './roster-change-format'

export const ROSTER_CHANGE_ACTIONS = ['assigned', 'unassigned', 'time_changed']

// BLOCKEDIT.1 (mig 629) — one COACHLESS row per edit of a published block
// (times, minimum, maximum, briefing). Not in ROSTER_CHANGE_ACTIONS: that list
// is logRosterChange's, which requires a coach.
export const BLOCK_EDITED_ACTION = 'block_edited'

/**
 * Record a post-publish roster edit. Best-effort — never throws.
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {object} change
 * @param {boolean} change.isPublished  the block's roster is published
 * @param {string}  change.locationId
 * @param {string}  change.action       one of ROSTER_CHANGE_ACTIONS
 * @param {string}  change.coachId
 * @param {string}  [change.actorId]
 * @param {string}  [change.blockId]
 * @param {string}  [change.blockDate]  YYYY-MM-DD
 * @param {object}  [change.details]
 * @returns {Promise<{logged: boolean, id?: string, reason?: string}>}
 */
export async function logRosterChange(db, change = {}) {
  try {
    if (!change.isPublished) return { logged: false, reason: 'not_published' }
    if (!ROSTER_CHANGE_ACTIONS.includes(change.action)) return { logged: false, reason: 'bad_action' }
    if (!change.locationId || !change.coachId) return { logged: false, reason: 'missing' }
    const { data, error } = await db.from('roster_change_log').insert({
      location_id: change.locationId,
      block_id: change.blockId || null,
      block_date: change.blockDate || null,
      actor_id: change.actorId || null,
      coach_id: change.coachId,
      action: change.action,
      details: change.details || {},
    }).select('id').single()
    if (error) {
      logWarn('roster-change-log', 'insert failed', { err: error.message })
      return { logged: false, reason: 'error' }
    }
    return { logged: true, id: data.id }
  } catch (e) {
    logWarn('roster-change-log', 'insert failed', { err: e?.message })
    return { logged: false, reason: 'error' }
  }
}

/**
 * BLOCKEDIT.1 — record an edit to a PUBLISHED block that has no coach to hang
 * it on (min/max/briefing, and the block's own time change). Best-effort,
 * never throws.
 *
 * Born STAMPED: nobody is messaged about a coachless row, so the re-publish
 * safety net (collectUnnotifiedChanges) must never collect it, and the drawer
 * shows no told state for it (stampMeansTold, roster-change-format.js).
 * `details` must never carry the briefing TEXT, only what kind of change.
 */
export async function logBlockEdit(db, { isPublished, locationId, blockId, blockDate, actorId, details } = {}) {
  try {
    if (!isPublished) return { logged: false, reason: 'not_published' }
    if (!locationId || !blockId) return { logged: false, reason: 'missing' }
    const { data, error } = await db.from('roster_change_log').insert({
      location_id: locationId,
      block_id: blockId,
      block_date: blockDate || null,
      actor_id: actorId || null,
      coach_id: null,
      action: BLOCK_EDITED_ACTION,
      details: details || {},
      notified_at: new Date().toISOString(),
    }).select('id').single()
    if (error) {
      logWarn('roster-change-log', 'block edit insert failed', { err: error.message })
      return { logged: false, reason: 'error' }
    }
    return { logged: true, id: data.id }
  } catch (e) {
    logWarn('roster-change-log', 'block edit insert failed', { err: e?.message })
    return { logged: false, reason: 'error' }
  }
}

/** Distinct coach ids from change-log rows. Pure. */
export function distinctCoachIds(rows) {
  return [...new Set((rows || []).map((r) => r?.coach_id).filter(Boolean))]
}

/**
 * Still-unnotified post-publish changes in a period — the coaches the next
 * (re-)publish should re-notify. Best-effort; returns [].
 */
export async function collectUnnotifiedChanges(db, { locationId, periodStart, periodEnd } = {}) {
  if (!locationId || !periodStart || !periodEnd) return []
  try {
    const { data, error } = await db
      .from('roster_change_log')
      .select('id, coach_id, action, block_date')
      .eq('location_id', locationId)
      .gte('block_date', periodStart)
      .lte('block_date', periodEnd)
      .is('notified_at', null)
    if (error) {
      logWarn('roster-change-log', 'collect failed', { err: error.message })
      return []
    }
    return data || []
  } catch (e) {
    logWarn('roster-change-log', 'collect failed', { err: e?.message })
    return []
  }
}

/** Stamp notified_at on the given change rows. Best-effort. */
export async function markChangesNotified(db, rowIds) {
  if (!rowIds || rowIds.length === 0) return
  try {
    const { error } = await db
      .from('roster_change_log')
      .update({ notified_at: new Date().toISOString() })
      .in('id', rowIds)
    if (error) {
      logWarn('roster-change-log', 'mark notified failed', { err: error.message })
    }
  } catch (e) {
    logWarn('roster-change-log', 'mark notified failed', { err: e?.message })
  }
}

// ── CHANGELOG.1 — the human-facing read ────────────────────────────────────
//
// Everything above is best-effort because it sits on a write path. This is
// different: a manager asked "what changed since I published?", and answering
// "nothing" when the read failed is a lie. So it returns the error.

const CHANGE_LOG_PAGE = 1000
// The ceiling is declared in the pure, client-safe formatter module (the drawer
// prints it) and re-exported here, where the read enforces it.
export { ROSTER_CHANGE_LOG_MAX_ROWS }

// `details` is free-form jsonb that any writer can extend, so NOTHING in it is
// trusted on the way out: not the keys and not the values. What leaves the
// server is exactly what roster-change-format.js reads, in exactly the type it
// expects. A field a future writer adds (a note, a rate), or an object tucked
// under a known key, cannot reach a browser through this read by accident.
const DETAIL_LABEL_KEYS = ['via', 'source'] // short machine labels
const DETAIL_LABEL_MAX = 40
const DETAIL_OVERRIDE_KEYS = ['start_time_override', 'end_time_override']
const DETAIL_TIME_KEYS = ['from', 'to']
// `reason` passes by KNOWN VALUE only: it is the one key whose name invites
// free text. Add a value here AND a sentence for it in roster-change-format.js.
const DETAIL_REASONS = ['staff_permanent_delete', 'replace_undone', 'replace_shift_started'] // mig 622; REPLACE.1a
const ROSTER_STATUSES = ['draft', 'published', 'superseded'] // migs 072, 602
const TIME_SHAPE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/
// BLOCKEDIT.1 — a block edit's capacity change, as { from, to } integers
// (0..50, the shift_blocks CHECKs). Manager-only facts, and this read is
// manager-only (GET /api/schedule/change-log).
const DETAIL_COUNT_KEYS = ['min_coaches', 'max_coaches']
// The briefing passes as the KIND of change only, never its text.
const DETAIL_BRIEFING_VALUES = ['added', 'changed', 'removed']
// Stamped by the notice arm WITHOUT a message (block-edit-notify.js).
const DETAIL_NOTICES = ['not_needed']

function countOrNull(v) {
  return Number.isInteger(v) && v >= 0 && v <= 50 ? v : null
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function timeOrNull(v) {
  return typeof v === 'string' && TIME_SHAPE.test(v) ? v : null
}

function publicDetails(details) {
  if (!isPlainObject(details)) return {}
  const out = {}
  for (const k of DETAIL_LABEL_KEYS) {
    const v = details[k]
    if (typeof v === 'string' && v.length > 0 && v.length <= DETAIL_LABEL_MAX) out[k] = v
  }
  if (DETAIL_REASONS.includes(details.reason)) out.reason = details.reason
  // Key PRESENCE is meaningful for the next two, so a null survives as null.
  //   roster_status: the swap-drop writer always sets it, and anything but
  //     'published' (null included) means "stamped without a roster message".
  //   overrides: both present and null is how the formatter reads a RESET. A
  //     value that is neither null nor a time drops the key, so garbage can
  //     never be read as "cleared".
  if ('roster_status' in details) {
    out.roster_status = ROSTER_STATUSES.includes(details.roster_status) ? details.roster_status : null
  }
  for (const k of DETAIL_OVERRIDE_KEYS) {
    if (!(k in details)) continue
    const v = details[k]
    if (v === null || v === undefined) out[k] = null
    else if (timeOrNull(v)) out[k] = v
  }
  for (const k of DETAIL_TIME_KEYS) {
    if (isPlainObject(details[k])) {
      out[k] = { start_time: timeOrNull(details[k].start_time), end_time: timeOrNull(details[k].end_time) }
    }
  }
  for (const k of DETAIL_COUNT_KEYS) {
    if (isPlainObject(details[k])) out[k] = { from: countOrNull(details[k].from), to: countOrNull(details[k].to) }
  }
  if (DETAIL_BRIEFING_VALUES.includes(details.briefing)) out.briefing = details.briefing
  if (DETAIL_NOTICES.includes(details.notice)) out.notice = details.notice
  return out
}

/**
 * Pure. One PostgREST row (listRosterChanges' select) -> the API shape: names,
 * times and the whitelisted `details` (publicDetails). No id of a block or a
 * person crosses the wire; `self_change` is the one fact the ids were needed
 * for. block_id, actor_id and coach_id are ON DELETE SET NULL (mig 236), so
 * every embed may be null.
 */
export function shapeRosterChange(r) {
  return {
    id: r.id,
    action: r.action,
    block_date: r.block_date ?? null,
    start_time: r.shift_blocks?.start_time ?? null,
    end_time: r.shift_blocks?.end_time ?? null,
    shift_name: r.shift_blocks?.shift_templates?.name ?? null,
    coach_name: r.coach?.full_name ?? null,
    actor_name: r.actor?.full_name ?? null,
    // The coach made the change themselves: the notifier stamps the row and
    // tells nobody, so the drawer must not print a "told" time for it.
    self_change: Boolean(r.actor_id) && r.actor_id === r.coach_id,
    details: publicDetails(r.details),
    notified_at: r.notified_at ?? null,
    created_at: r.created_at ?? null,
  }
}

/**
 * Edits to published rosters at ONE studio whose shift date is in [from, to],
 * newest first. Paged past the 1,000-row select cap over a total order.
 * Service-role callers get no RLS: the location filter here IS the tenant
 * boundary, and the route must have authorised `locationId` first.
 *
 * Reads at most one page beyond ROSTER_CHANGE_LOG_MAX_ROWS, which is how it
 * tells "exactly the ceiling" from "more than the ceiling".
 *
 * @returns {Promise<{ changes: Array<object>, truncated: boolean, error: object|null }>}
 */
export async function listRosterChanges(db, { locationId, from, to } = {}) {
  if (!locationId || !from || !to) {
    return { changes: [], truncated: false, error: { message: 'locationId, from and to are required' } }
  }
  const rows = []
  for (let start = 0; rows.length <= ROSTER_CHANGE_LOG_MAX_ROWS; start += CHANGE_LOG_PAGE) {
    const { data, error } = await db
      .from('roster_change_log')
      // Literal on purpose: check:select-columns only resolves literal selects.
      // Two FKs to profiles, so each embed names its column (PGRST201 otherwise).
      .select(`
        id, block_id, block_date, actor_id, coach_id, action, details, notified_at, created_at,
        actor:profiles!actor_id(id, full_name),
        coach:profiles!coach_id(id, full_name),
        shift_blocks!block_id(start_time, end_time, shift_templates(name))
      `)
      .eq('location_id', locationId)
      .gte('block_date', from)
      .lte('block_date', to)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(start, start + CHANGE_LOG_PAGE - 1)
    if (error) return { changes: [], truncated: false, error }
    const page = data || []
    rows.push(...page)
    if (page.length < CHANGE_LOG_PAGE) break
  }
  return {
    changes: rows.slice(0, ROSTER_CHANGE_LOG_MAX_ROWS).map(shapeRosterChange),
    truncated: rows.length > ROSTER_CHANGE_LOG_MAX_ROWS,
    error: null,
  }
}
