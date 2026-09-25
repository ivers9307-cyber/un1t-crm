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

import { buildPublishSnapshot, clipWindow, compareSnapshot, SNAPSHOT_FORMAT_VERSION } from './roster-compare'
import { logError, logWarn } from './log'
import { periodLabel } from './roster-compare-format'

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

export const COMPARE_PUBLISHES_LISTED = 20
const NAME_CHUNK = 200

// The two snapshot reads below spell their columns as LITERALS, not a shared
// constant, so check:select-columns can prove them against mig 634.

/**
 * Everything GET /api/schedule/rosters/[id]/compare returns. The caller has
 * loaded the roster and checked the manager's access to roster.location_id;
 * every read here is pinned to that location.
 *
 * @param {object} args
 * @param {object} args.roster     { id, location_id, status, period_start, period_end, published_at }
 * @param {string|null} [args.againstId]  compare with this snapshot instead of the roster's own
 * @param {string|null} [args.from]       YYYY-MM-DD window (the period on screen)
 * @param {string|null} [args.to]
 * @param {number} args.nowMs
 * @returns {Promise<{ data: object } | { notFound: true } | { conflict: string } | { error: object }>}
 *   conflict: the against snapshot is at this studio but covers none of this
 *   roster's published dates (review 3), so comparing them would be nonsense.
 */
export async function loadRosterComparison(db, { roster, againstId = null, from = null, to = null, nowMs = Date.now() }) {
  const meta = { roster_id: roster.id, location_id: roster.location_id }
  const fail = (what, err) => {
    logError('roster-snapshot', `compare: ${what}`, { ...meta, err })
    return { error: err || { message: what } }
  }

  const { data: location, error: locErr } = await db
    .from('locations')
    .select('id, timezone')
    .eq('id', roster.location_id)
    .maybeSingle()
  if (locErr) return fail('location read failed', locErr)

  // The roster's OWN snapshot is always read: it is the default baseline and
  // its period is what "these dates" means for a chosen one (the rosters row's
  // period can have been shrunk by a later publish; the snapshot's cannot).
  const own = await db
    .from('roster_publish_snapshots')
    .select('id, roster_id, location_id, period_start, period_end, published_at, published_by, format_version, snapshot')
    .eq('roster_id', roster.id)
    .eq('location_id', roster.location_id)
    .maybeSingle()
  if (own.error) return fail('snapshot read failed', own.error)
  const rosterPeriod = own.data
    ? { from: own.data.period_start, to: own.data.period_end }
    : { from: roster.period_start, to: roster.period_end }

  let baseline = own.data || null
  if (againstId && againstId !== own.data?.id) {
    const { data, error } = await db
      .from('roster_publish_snapshots')
      .select('id, roster_id, location_id, period_start, period_end, published_at, published_by, format_version, snapshot')
      .eq('id', againstId)
      .eq('location_id', roster.location_id)
      .maybeSingle()
    if (error) return fail('snapshot read failed', error)
    if (!data) return { notFound: true }
    // Review 3 — same studio is not enough: a publish of other dates would
    // read as every shift "added after publish".
    if (data.period_start > rosterPeriod.to || data.period_end < rosterPeriod.from) {
      return {
        conflict: `That publish covers ${periodLabel(data.period_start, data.period_end)}, which does not overlap this roster's dates (${periodLabel(rosterPeriod.from, rosterPeriod.to)}), so it cannot be compared with it.`,
      }
    }
    baseline = data
  }
  if (baseline && Number(baseline.format_version) > SNAPSHOT_FORMAT_VERSION) {
    return fail(`snapshot format ${baseline.format_version} is newer than this code reads`, null)
  }

  // The studio's first snapshot: the date the view names for older rosters.
  const { data: first, error: firstErr } = await db
    .from('roster_publish_snapshots')
    .select('published_at')
    .eq('location_id', roster.location_id)
    .order('published_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (firstErr) return fail('first-snapshot read failed', firstErr)
  const snapshotsBeganAt = first?.published_at ?? null

  // Every publish at this studio overlapping the window, newest first: the
  // "compare with" choices (the first publish of the week, say).
  const askFrom = from || roster.period_start
  const askTo = to || roster.period_end
  const { data: pubs, error: pubsErr } = await db
    .from('roster_publish_snapshots')
    .select('id, roster_id, published_at, period_start, period_end')
    .eq('location_id', roster.location_id)
    .lte('period_start', askTo)
    .gte('period_end', askFrom)
    .order('published_at', { ascending: false })
    .limit(COMPARE_PUBLISHES_LISTED)
  if (pubsErr) return fail('publish list read failed', pubsErr)
  const publishes = (pubs || []).map((p) => ({
    snapshot_id: p.id, roster_id: p.roster_id, published_at: p.published_at,
    period_start: p.period_start, period_end: p.period_end,
  }))

  const rosterSummary = {
    id: roster.id, status: roster.status,
    period_start: roster.period_start, period_end: roster.period_end,
    published_at: roster.published_at ?? null,
  }

  if (!baseline) {
    // No backfill (D11): a roster published before the studio's first
    // snapshot never had one; after it, one should have been written and was
    // not (the write failed and was logged at the time).
    const publishedMs = Date.parse(roster.published_at || '')
    const beganMs = Date.parse(snapshotsBeganAt || '')
    const before = !Number.isFinite(beganMs) || !Number.isFinite(publishedMs) || publishedMs < beganMs
    return {
      data: {
        roster: rosterSummary, window: null, baseline: null,
        missing_reason: before ? 'before_snapshots' : 'not_saved',
        snapshots_began_at: snapshotsBeganAt, publishes, blocks: [], totals: null,
      },
    }
  }

  const window = clipWindow(baseline.snapshot, from, to)
  let current = []
  if (window) {
    const { blocks, error: curErr } = await loadWindowBlocks(db, { locationId: roster.location_id, from: window.from, to: window.to })
    if (curErr) return fail('current blocks read failed', curErr)
    current = blocks
  }

  // Names for coaches the live embed does not already name (removed since
  // publish), plus whoever published. A failed read costs names, not the view.
  const namedNow = new Set(current.flatMap((b) => (b.shift_assignments || [])
    .filter((a) => a?.profiles?.full_name).map((a) => a.profile_id)))
  const wanted = new Set()
  for (const b of baseline.snapshot.blocks || []) {
    if (!window || b.date < window.from || b.date > window.to) continue
    for (const c of b.coaches || []) if (!namedNow.has(c.profile_id)) wanted.add(c.profile_id)
  }
  if (baseline.published_by) wanted.add(baseline.published_by)
  const names = {}
  const ids = [...wanted]
  for (let i = 0; i < ids.length; i += NAME_CHUNK) {
    const { data, error } = await db.from('profiles').select('id, full_name').in('id', ids.slice(i, i + NAME_CHUNK))
    if (error) {
      logWarn('roster-snapshot', 'compare: names read failed; showing the comparison without them', { ...meta, err: error })
      break
    }
    for (const p of data || []) names[p.id] = p.full_name
  }

  const result = compareSnapshot({
    snapshot: baseline.snapshot, currentBlocks: current, from, to, nowMs, tz: location?.timezone ?? null, names,
  })

  const baselineSummary = {
    snapshot_id: baseline.id, roster_id: baseline.roster_id, published_at: baseline.published_at,
    period_start: baseline.period_start, period_end: baseline.period_end,
    published_by_name: baseline.published_by ? (names[baseline.published_by] ?? null) : null,
  }

  // Review 3 — a baseline whose dates miss the window has nothing to compare.
  // It is its own state, never an empty comparison (which would read as
  // "every shift is as it was published").
  if (!window) {
    return {
      data: {
        roster: rosterSummary, window: null, baseline: baselineSummary,
        missing_reason: 'outside_window', snapshots_began_at: snapshotsBeganAt,
        publishes, blocks: [], totals: null,
      },
    }
  }

  return {
    data: {
      roster: rosterSummary,
      window: result.window,
      baseline: baselineSummary,
      missing_reason: null,
      snapshots_began_at: snapshotsBeganAt,
      publishes,
      blocks: result.blocks,
      totals: result.totals,
    },
  }
}
