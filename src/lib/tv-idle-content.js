// src/lib/tv-idle-content.js
//
// TVSCENE.1 — the three idle scenes' data, read only when the board has no
// open sessions. Every read FAILS TO ABSENT: a scene with no content is
// skipped by the scheduler, which is correct; a stack trace on a studio
// floor is not. Nothing here may return an aggregate COUNT — individual
// member moments only (see the spec's constraint 1). Class entries carry a
// time and a name, never capacity or a booked count.
//
// Failing to absent is not failing silently. A phantom column, an RLS change
// or a PGRST201 would otherwise leave a scene blank for good with no signal
// anywhere (the shape of the 24-day enrolment outage), so a failed read logs
// structurally (read, location, error) and then answers absent.
//
// Loud must not become unreadable. The idle board polls every ~4s per kiosk,
// so a permanent fault would write ~90 lines a minute (~130k a day) and bury
// the one line that matters. So a persistent fault reports once per read per
// location per IDLE_LOG_WINDOW_MS, and the next line says how many were held
// back (`suppressed`). Same shape as GLOFOX_WRITE_FAILURE_ROWS_PER_MIN: cap what
// one outage can emit per instance, never drop the fact that it is happening.

import { timeLabelIn } from '@/lib/location-time'
import { logWarn } from '@/lib/log'

const LOG_MODULE = 'tv-idle'

/** At most one log line per read per location in this window (per instance). */
export const IDLE_LOG_WINDOW_MS = 5 * 60 * 1000

// key `${read}:${locationId}` -> when we last emitted, and how many failures
// since. Keys are 3 reads x the studios that have a TV, so it cannot grow.
const logThrottle = new Map()

/** Test hook: clears the throttle so one test's failures cannot silence the next. Not for app code. */
export function __resetIdleLogThrottle() {
  logThrottle.clear()
}

/**
 * One structured line per failed read, throttled. Never throws and never
 * changes the answer: the caller returns absent whether or not a line went out.
 */
function readFailed(read, ctx, err) {
  try {
    const key = `${read}:${ctx.locationId}`
    const now = Date.now()
    const state = logThrottle.get(key)
    // The window runs from the last line EMITTED, so a held-back failure never
    // pushes the next report out and a fault that never clears still reports.
    if (state && now - state.emittedAtMs < IDLE_LOG_WINDOW_MS) {
      state.suppressed += 1
      return
    }
    const suppressed = state ? state.suppressed : 0
    logThrottle.set(key, { emittedAtMs: now, suppressed: 0 })
    logWarn(LOG_MODULE, 'idle read failed; scene will be skipped', {
      read,
      ...ctx,
      ...(suppressed > 0 ? { suppressed } : {}),
      err,
    })
  } catch {
    // A logger that cannot serialise the error must not turn "absent" into a 500.
  }
}

/** How far back "earned this week" looks. 65 rows / 61 people at Stillorgan. */
export const EARNED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Rows the Up next scene can show at 720px without crowding. */
export const UP_NEXT_LIMIT = 6
/** Rows the Earned scene can show at 720px without crowding. */
export const EARNED_LIMIT = 5
/**
 * How far ahead "Up next" looks. The scene prints a bare HH:MM with no day, so
 * a class more than a day out would read as a time today ("06:30" at 22:00
 * meaning the day after tomorrow). The bound stops the scene reaching further
 * ahead than that. It does not add a day: a class 9h away still shows as a
 * plain time.
 */
export const UP_NEXT_HORIZON_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Short TTL cache for the two slow-changing, expensive reads.
//
// Why: the board polls every ~4s per kiosk even when idle (live-poll.js only
// backs off overnight), so uncached all three reads run ~14,400 times a day per
// kiosk. readEarned is the costly one: contact_achievements has no index on
// earned_at alone (mig 116 indexes (contact_id, earned_at) and (rule_id,
// earned_at)) and the read has no location_id predicate, so each poll is a full
// scan and sort of the whole estate plus up to 200 embed lookups, for content
// that changes on the order of hours. Caching up_next and earned for 60s cuts
// those two reads to ~1,440 a day per kiosk.
//
// The OPERATOR read is deliberately NOT cached. It is a primary-key lookup on
// tv_content.tv_display_id, so it is cheap, and it is the one an operator
// watches for right after pushing a card: caching it would make the feature
// feel broken. Because it stays live, an operator push still appears within one
// poll.
//
// Keyed on locationId: both cached reads are per studio, not per display, so
// two kiosks in one studio share an entry. Bounded by the studios that have a
// TV, so it cannot grow. A FAILED read is never stored (it answers absent and
// the next poll retries), otherwise one blip would blank the scene for 60s.
// Entries are copied in and out so a consumer cannot mutate what the next
// caller receives.
// ---------------------------------------------------------------------------

/** How long a successful up_next / earned read is reused for the same location. */
export const IDLE_CACHE_TTL_MS = 60 * 1000

// locationId -> { rows, expiresAtMs }, one map per cached read.
const upNextCache = new Map()
const earnedCache = new Map()

/** Test hook: empties the read cache so one test's answer cannot serve the next. Test-only; not for app code. */
export function __resetIdleCache() {
  upNextCache.clear()
  earnedCache.clear()
}

// Rows are flat (strings, numbers, null), so a one-level copy is a full copy.
const copyRows = (rows) => rows.map((row) => ({ ...row }))

/**
 * Serve `load()` through `cache`. `load` returns an array on success and null
 * on a failed read; null is answered as [] and NOT cached.
 */
async function cachedRead(cache, locationId, load) {
  const now = Date.now()
  const hit = cache.get(locationId)
  if (hit && hit.expiresAtMs > now) return copyRows(hit.rows)
  const rows = await load()
  if (rows === null) return []
  cache.set(locationId, { rows: copyRows(rows), expiresAtMs: now + IDLE_CACHE_TTL_MS })
  return rows
}

/** First name + last initial — the board's privacy floor, as live-board.js. */
function shortName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  return `${parts[0]} ${parts[parts.length - 1][0]}.`
}

/**
 * The string an <img src> can use for an operator push (tv_content row).
 *
 *   storage -> the public tv-content bucket URL. source_ref is a bucket PATH,
 *              and a path in an <img src> is a broken image held for the whole
 *              30s dwell. Precedent: the cast route,
 *              src/app/api/public/tv/[token]/content/route.js (bucketUrl). That
 *              builder is also inlined in TemplateEditor.jsx; this is a third
 *              copy, deliberately not refactored here, so the duplication is
 *              visible. With no project URL configured there is no usable src,
 *              so the ref is dropped (null) and the label, if any, still draws.
 *   url     -> as pushed.
 *   other   -> left alone (template = a tv_templates id, generated = a key;
 *              neither is an image, and operatorImageRef ignores them).
 */
function resolveOperatorRef(sourceType, sourceRef) {
  if (sourceType === 'storage') {
    const path = typeof sourceRef === 'string' ? sourceRef.trim() : ''
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL
    if (!path || !base) return null
    return `${base}/storage/v1/object/public/tv-content/${path}`
  }
  return sourceRef ?? null
}

// Returns the rows, or null when the read FAILED (so the caller can tell a
// failure, which must not be cached, from a studio with nothing coming up).
async function readUpNext(db, { locationId, zone, nowMs }) {
  try {
    const { data, error } = await db
      .from('class_occurrences')
      .select('name, program, starts_at')
      .eq('location_id', locationId)
      .is('cancelled_at', null)
      .gte('starts_at', new Date(nowMs).toISOString())
      .lte('starts_at', new Date(nowMs + UP_NEXT_HORIZON_MS).toISOString())
      .order('starts_at', { ascending: true })
      .limit(UP_NEXT_LIMIT)
    if (error) {
      readFailed('up_next', { locationId }, error)
      return null
    }
    return (data || [])
      .map((o) => ({
        starts_at: o.starts_at,
        starts_at_label: timeLabelIn(o.starts_at, zone),
        class_name: o.name || null,
        program: o.program || null,
      }))
      // A class with no readable time has nothing to show under "Up next".
      .filter((o) => o.starts_at_label)
      .slice(0, UP_NEXT_LIMIT)
  } catch (err) {
    readFailed('up_next', { locationId }, err)
    return null
  }
}

// Returns the rows, or null when the read FAILED (see readUpNext).
async function readEarned(db, { locationId, nowMs }) {
  try {
    // Why the studio filter happens in JS over a 100-row window: contact_achievements
    // has no location_id of its own (it reaches a studio only through
    // contacts.location_id), so we read the newest 100 achievements in the
    // window and keep this studio's. Starving the result needs 100 other-studio
    // achievements in a week to push this studio's out, and one studio holds
    // effectively all current achievements, so it is not reachable today.
    // Revisit when a second studio earns them. The same missing predicate is
    // what makes this read expensive: with no location_id (and no index on
    // earned_at alone) it scans and sorts every studio's achievements on each
    // call, which is why buildIdleContent caches it. So cost, not only
    // correctness, is a reason to revisit the unscoped read.
    //
    // Backfilled grants are excluded: the admin backfill route upserts rows with
    // earned_at = now() and metadata.backfilled = true, so a backfill of months-old
    // milestones would otherwise read as "earned this week" on a public screen,
    // and, being newest, fill both this 100-row window and the 5-row display. The
    // key is absent on every normal grant, so IS NULL keeps those. The row check
    // below is the guard if the filter ever stops applying.
    const { data, error } = await db
      .from('contact_achievements')
      .select('earned_at, metadata, achievement_rules!rule_id(name, tier), contacts!contact_id(name, location_id, hr_leaderboard_opt_out)')
      .gte('earned_at', new Date(nowMs - EARNED_WINDOW_MS).toISOString())
      .is('metadata->>backfilled', null)
      .order('earned_at', { ascending: false })
      .limit(100)
    if (error) {
      readFailed('earned', { locationId }, error)
      return null
    }
    const out = []
    for (const row of data || []) {
      if (row?.metadata?.backfilled === true) continue
      const c = row?.contacts
      const r = row?.achievement_rules
      // A contact can be erased (CASCADE) or belong to another studio; a rule
      // can be deleted. Any of those is a row we drop, never a "Member" tile.
      if (!c || !r) continue
      if (c.location_id !== locationId) continue
      if (c.hr_leaderboard_opt_out) continue
      const name = shortName(c.name)
      if (!name) continue
      out.push({
        display_name: name,
        achievement: r.name,
        tier: r.tier ?? null,
        earned_at: row.earned_at,
      })
      if (out.length >= EARNED_LIMIT) break
    }
    return out
  } catch (err) {
    readFailed('earned', { locationId }, err)
    return null
  }
}

async function readOperator(db, { locationId, displayId }) {
  if (!displayId) return null
  try {
    const { data, error } = await db
      .from('tv_content')
      .select('source_type, source_ref, label, template_values')
      .eq('tv_display_id', displayId)
      .maybeSingle()
    if (error) {
      readFailed('operator', { locationId, displayId }, error)
      return null
    }
    // No row is the normal "nothing pushed" answer, not a failure.
    if (!data) return null
    return {
      source_type: data.source_type,
      source_ref: resolveOperatorRef(data.source_type, data.source_ref),
      label: data.label ?? null,
      template_values: data.template_values ?? null,
    }
  } catch (err) {
    readFailed('operator', { locationId, displayId }, err)
    return null
  }
}

/**
 * Build the idle block. Called ONLY from the no-sessions branch of
 * buildLiveBoardPayload, so a live class pays nothing for it. It never
 * rejects: each reader catches its own failure and answers "absent".
 *
 * up_next and earned are served from a 60s per-location cache (see the note
 * above IDLE_CACHE_TTL_MS); operator is read on every call.
 *
 * @param {object} db  service-role Supabase client
 * @param {object} opts
 * @param {string} opts.locationId
 * @param {string|null} opts.displayId
 * @param {string} opts.zone       IANA zone of the studio
 * @param {number} opts.nowMs
 * @returns {Promise<{ up_next: Array, earned: Array, operator: object|null }>}
 */
export async function buildIdleContent(db, { locationId, displayId = null, zone, nowMs = Date.now() } = {}) {
  const [up_next, earned, operator] = await Promise.all([
    cachedRead(upNextCache, locationId, () => readUpNext(db, { locationId, zone, nowMs })),
    cachedRead(earnedCache, locationId, () => readEarned(db, { locationId, nowMs })),
    readOperator(db, { locationId, displayId }),
  ])
  return { up_next, earned, operator }
}
