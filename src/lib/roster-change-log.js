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

export const ROSTER_CHANGE_ACTIONS = ['assigned', 'unassigned', 'time_changed']

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
/** Ceiling on one drawer's rows (a multiple of the page). Past it the answer is flagged `truncated`. */
export const ROSTER_CHANGE_LOG_MAX_ROWS = 5000

// `details` is free-form jsonb that any writer can extend. Only the keys
// roster-change-format.js prints leave the server, so a field a future writer
// adds (a note, a rate) cannot reach a browser through this read by accident.
const DETAIL_SCALAR_KEYS = ['via', 'source', 'start_time_override', 'end_time_override']
const DETAIL_TIME_KEYS = ['from', 'to']

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function publicDetails(details) {
  if (!isPlainObject(details)) return {}
  const out = {}
  // Key PRESENCE is kept even when the value is null: both overrides present
  // and null is how the formatter tells "reset" from "unknown".
  for (const k of DETAIL_SCALAR_KEYS) if (k in details) out[k] = details[k] ?? null
  for (const k of DETAIL_TIME_KEYS) {
    if (isPlainObject(details[k])) {
      out[k] = { start_time: details[k].start_time ?? null, end_time: details[k].end_time ?? null }
    }
  }
  return out
}

/**
 * Pure. One PostgREST row (listRosterChanges' select) -> the API shape. Names
 * and times only; `details` is whitelisted (publicDetails). block_id / actor_id / coach_id are ON DELETE SET NULL (mig
 * 236), so every embed may be null.
 */
export function shapeRosterChange(r) {
  return {
    id: r.id,
    action: r.action,
    block_id: r.block_id ?? null,
    block_date: r.block_date ?? null,
    start_time: r.shift_blocks?.start_time ?? null,
    end_time: r.shift_blocks?.end_time ?? null,
    shift_name: r.shift_blocks?.shift_templates?.name ?? null,
    coach_id: r.coach_id ?? null,
    coach_name: r.coach?.full_name ?? null,
    actor_name: r.actor?.full_name ?? null,
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
        id, block_id, block_date, coach_id, action, details, notified_at, created_at,
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
