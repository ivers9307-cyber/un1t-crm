// src/lib/roster-snapshot.js
// SNAPSHOT.1 — the IO around roster_publish_snapshots (mig 634). The rules
// live in the pure src/lib/roster-compare.js; this file only reads and writes.
//
// WRITE (writePublishSnapshot) is BEST-EFFORT and NEVER THROWS. A publish is a
// chain of separate PostgREST writes with no transaction to join (see
// src/app/api/schedule/rosters/route.js), and CLAUDE.md's rule is that removing
// a silent failure must never create a louder one: failing a publish over a
// lost audit record would leave coaches untold about their week. So: one
// retry, a unique violation on the retry = the first attempt landed, and a
// failure is logged with logError (module 'roster-snapshot', roster_id,
// location_id) and returned, never thrown. The compare view then says the
// snapshot "could not be saved at the time" instead of comparing against
// nothing.
//
// READS page past the 1,000-row cap with a stable order (CLAUDE.md), and every
// read is scoped to the roster's location_id. Service role only; the caller
// has already checked the manager's access to that location.

import { buildPublishSnapshot, SNAPSHOT_FORMAT_VERSION } from './roster-compare'
import { logError } from './log'

export const SNAPSHOT_BLOCK_PAGE = 1000

/**
 * Every shift block at a studio in [from, to], with its template's name and
 * kind, its briefing (read only to be fingerprinted, see roster-compare.js)
 * and every assignment (arrival stamp and name included). Paged. Named
 * columns only: no pay, and not the manager's working `notes`.
 *
 * @returns {Promise<{ blocks: object[]|null, error: object|null }>}
 */
export async function loadWindowBlocks(db, { locationId, from, to }) {
  const blocks = []
  for (let offset = 0; ; offset += SNAPSHOT_BLOCK_PAGE) {
    const { data, error } = await db
      .from('shift_blocks')
      .select(`
        id, block_date, template_id, start_time, end_time, min_coaches, max_coaches, briefing,
        shift_templates(name, kind),
        shift_assignments(id, profile_id, status, start_time_override, end_time_override, arrived_at, profiles:profile_id(full_name))
      `)
      .eq('location_id', locationId)
      .gte('block_date', from)
      .lte('block_date', to)
      .order('block_date', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + SNAPSHOT_BLOCK_PAGE - 1)
    if (error) return { blocks: null, error }
    const page = data || []
    blocks.push(...page)
    if (page.length < SNAPSHOT_BLOCK_PAGE) break
  }
  return { blocks, error: null }
}

/**
 * Record what a publish published. Call AFTER the publish has tagged the
 * period's blocks with the roster's id, and only then.
 *
 * @param {object} roster  the rosters row as the publish wrote it:
 *                         { id, location_id, period_start, period_end, published_at, published_by }
 * @returns {Promise<{ saved: true, duplicate?: true } | { saved: false, reason: string }>}
 */
export async function writePublishSnapshot(db, roster) {
  const meta = { roster_id: roster?.id ?? null, location_id: roster?.location_id ?? null }
  try {
    if (!roster?.id || !roster?.location_id || !roster?.period_start || !roster?.period_end) {
      logError('roster-snapshot', 'publish snapshot not saved: the roster row is incomplete', meta)
      return { saved: false, reason: 'bad_roster' }
    }

    const { blocks, error: readErr } = await loadWindowBlocks(db, {
      locationId: roster.location_id,
      from: roster.period_start,
      to: roster.period_end,
    })
    if (readErr) {
      logError('roster-snapshot', 'publish snapshot not saved: block read failed', { ...meta, err: readErr })
      return { saved: false, reason: 'read_failed' }
    }

    const built = buildPublishSnapshot({ periodStart: roster.period_start, periodEnd: roster.period_end, blocks })
    const row = {
      roster_id: roster.id,
      location_id: roster.location_id,
      period_start: roster.period_start,
      period_end: roster.period_end,
      // Both publish paths stamp published_at; the fallback only keeps a NOT
      // NULL column from turning a missing stamp into a lost snapshot.
      published_at: roster.published_at || new Date().toISOString(),
      published_by: roster.published_by ?? null,
      format_version: SNAPSHOT_FORMAT_VERSION,
      block_count: built.blockCount,
      assignment_count: built.assignmentCount,
      snapshot: built.snapshot,
    }

    let lastErr = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const { error } = await db.from('roster_publish_snapshots').insert(row)
        if (!error) return { saved: true }
        // UNIQUE (roster_id): a retry that meets its own first attempt.
        if (attempt > 1 && error.code === '23505') return { saved: true, duplicate: true }
        lastErr = error
      } catch (e) {
        lastErr = e
      }
    }
    logError('roster-snapshot', 'publish snapshot not saved: insert failed twice', { ...meta, err: lastErr })
    return { saved: false, reason: 'insert_failed' }
  } catch (e) {
    logError('roster-snapshot', 'publish snapshot not saved: threw', { ...meta, err: e })
    return { saved: false, reason: 'threw' }
  }
}
