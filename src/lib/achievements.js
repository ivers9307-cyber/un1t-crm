// Achievements detection engine — Phase 4 Slice A.
//
// Pure detectors + an orchestrator. The DB-touching part lives in
// `runDetectionForSession()`; everything else is fixture-testable.
//
// Architecture
// ------------
// Each rule_type maps to a detector function: takes a precomputed
// AchievementContext + the rule's config jsonb, returns
// { unlocked: bool, metadata?: object }. The dispatcher walks every
// active rule and calls the matching detector. Already-earned rules
// are filtered upstream so detectors don't need to think about
// idempotency.
//
// Why a precomputed context: many rules need the same data
// (history aggregates, distinct locations, has-Z5-before). Building
// it once per session and re-using it across all rules avoids
// O(rules × scans).
//
// Wiring: live-class.endSession() calls runDetectionForSession()
// best-effort. Failures are logged + swallowed — never block the
// session-finalisation path.

import { logWarn } from '@/lib/log'

// ── Period helpers ────────────────────────────────────────────

const MS_PER_DAY = 24 * 3600 * 1000

// ISO-week boundary: Monday 00:00:00.
function startOfIsoWeek(date) {
  const d = new Date(date)
  const day = (d.getUTCDay() + 6) % 7 // 0=Mon … 6=Sun
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() - day)
  return d
}
function startOfMonth(date) {
  const d = new Date(date)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}
function startOfYear(date) {
  const d = new Date(date)
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
}

function periodStart(period, ref = new Date()) {
  if (period === 'week') return startOfIsoWeek(ref)
  if (period === 'month') return startOfMonth(ref)
  if (period === 'year') return startOfYear(ref)
  return null // 'all_time'
}

// ── Field extractors ──────────────────────────────────────────

function zonesSecondsSafe(s) {
  return s?.zones_seconds || {}
}

function sessionMetric(session, field) {
  const z = zonesSecondsSafe(session)
  const z1 = z[1] || z['1'] || 0
  const z2 = z[2] || z['2'] || 0
  const z3 = z[3] || z['3'] || 0
  const z4 = z[4] || z['4'] || 0
  const z5 = z[5] || z['5'] || 0
  switch (field) {
    case 'effort_points':  return Number(session?.effort_points) || 0
    case 'classes':         return 1
    case 'z3_minutes':      return z3 / 60
    case 'z4_minutes':      return z4 / 60
    case 'z5_minutes':      return z5 / 60
    case 'z3plus_minutes':  return (z3 + z4 + z5) / 60
    case 'total_minutes':   return (z1 + z2 + z3 + z4 + z5) / 60
    default:                return 0
  }
}

// ── Context builder ───────────────────────────────────────────

/**
 * Pre-compute everything the detectors might need, once per session.
 *
 * @param {object} session  the just-ended heart_rate_sessions row
 * @param {Array}  history  prior heart_rate_sessions rows for this contact (any order, any window)
 */
export function buildAchievementContext(session, history) {
  const all = [...(history || []), session]
  const now = new Date(session.ended_at || session.started_at || Date.now())

  // Has-Z5-before excludes THIS session — the first_z5 detector
  // wants "is this the first session that touched Z5?"
  const priorZ5Total = (history || []).reduce(
    (acc, s) => acc + ((zonesSecondsSafe(s)[5] || zonesSecondsSafe(s)['5']) || 0),
    0
  )
  const thisZ5 = (zonesSecondsSafe(session)[5] || zonesSecondsSafe(session)['5']) || 0

  // Distinct locations / event types touched (incl. this session).
  const distinctLocationIds = new Set(
    all.map((s) => s.location_id).filter(Boolean)
  )
  const distinctEventTypeIds = new Set(
    all.map((s) => s.event_type_id).filter(Boolean)
  )

  // Per-event-type max points across history (for new_personal_record).
  // Excludes this session — we want "is THIS the new record?"
  const priorMaxByEventType = new Map()
  for (const s of history || []) {
    const id = s.event_type_id
    if (!id) continue
    const pts = Number(s.effort_points) || 0
    if (!priorMaxByEventType.has(id) || priorMaxByEventType.get(id) < pts) {
      priorMaxByEventType.set(id, pts)
    }
  }

  // Streak: distinct days with at least one session, including this.
  // Ordered most-recent-first.
  const dayKeys = new Set()
  for (const s of all) {
    const d = new Date(s.started_at || s.ended_at)
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
    dayKeys.add(key)
  }
  const sortedDays = [...all]
    .map((s) => {
      const d = new Date(s.started_at || s.ended_at)
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).getTime()
    })
    .sort((a, b) => b - a)
  // Dedup by day.
  const uniqDayMs = []
  for (const ms of sortedDays) {
    if (uniqDayMs[uniqDayMs.length - 1] !== ms) uniqDayMs.push(ms)
  }

  return {
    session,
    history: history || [],
    all,
    now,
    isFirstSession: (history || []).length === 0,
    priorZ5Total,
    thisZ5,
    distinctLocationIds,
    distinctEventTypeIds,
    priorMaxByEventType,
    uniqDayMs,
    // Pre-summed for aggregate_threshold
    aggregateAllTime: (field) => all.reduce((a, s) => a + sessionMetric(s, field), 0),
    aggregateInPeriod: (field, period) => {
      const start = periodStart(period, now)
      if (!start) return all.reduce((a, s) => a + sessionMetric(s, field), 0)
      const startMs = start.getTime()
      return all.reduce((a, s) => {
        const t = new Date(s.started_at || s.ended_at).getTime()
        return t >= startMs ? a + sessionMetric(s, field) : a
      }, 0)
    },
    countOfEventType: (eventTypeId) =>
      all.filter((s) => s.event_type_id === eventTypeId).length,
  }
}

// ── Detectors ─────────────────────────────────────────────────

export function detectFirstEvent(ctx, cfg) {
  const event = String(cfg?.event || '')
  if (event === 'session') {
    return ctx.isFirstSession ? { unlocked: true, metadata: {} } : { unlocked: false }
  }
  if (event === 'z5_minute') {
    // First time the member has ever logged Z5. ctx.priorZ5Total
    // is across history; ctx.thisZ5 is this session.
    if (ctx.priorZ5Total === 0 && ctx.thisZ5 >= 60) {
      return { unlocked: true, metadata: { z5Seconds: ctx.thisZ5 } }
    }
    return { unlocked: false }
  }
  if (event === 'class_type') {
    const id = cfg?.event_type_id
    if (!id) return { unlocked: false }
    if (ctx.session.event_type_id !== id) return { unlocked: false }
    const priorOfType = ctx.history.filter((s) => s.event_type_id === id).length
    return priorOfType === 0
      ? { unlocked: true, metadata: { eventTypeId: id } }
      : { unlocked: false }
  }
  if (event === 'location_visit') {
    const id = cfg?.location_id
    if (!id) return { unlocked: false }
    if (ctx.session.location_id !== id) return { unlocked: false }
    const priorAtLoc = ctx.history.filter((s) => s.location_id === id).length
    return priorAtLoc === 0
      ? { unlocked: true, metadata: { locationId: id } }
      : { unlocked: false }
  }
  return { unlocked: false }
}

/**
 * Streak detector. Counts the run of consecutive distinct days with
 * at least one session, ending today (or yesterday — see below).
 *
 * "Consecutive" means each step is exactly 1 day apart. We start
 * from the most recent session day. If that day is older than
 * cfg.gap_tolerance_days from today, the streak is "broken" and
 * doesn't count. (This means the achievement only fires when the
 * member is actively training — not retroactively on stale history.)
 */
export function detectStreak(ctx, cfg) {
  const requiredDays = Number(cfg?.days) || 0
  const gapTolerance = Number(cfg?.gap_tolerance_days) || 0
  if (requiredDays < 2) return { unlocked: false }
  if (ctx.uniqDayMs.length < requiredDays) return { unlocked: false }

  // The streak is "live" if the most recent training day is within
  // gap_tolerance_days of today. Otherwise we don't unlock.
  const todayUtc = (() => {
    const d = ctx.now
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).getTime()
  })()
  const mostRecent = ctx.uniqDayMs[0]
  const daysSince = (todayUtc - mostRecent) / MS_PER_DAY
  if (daysSince > gapTolerance) return { unlocked: false }

  let streak = 1
  for (let i = 1; i < ctx.uniqDayMs.length; i++) {
    const gap = (ctx.uniqDayMs[i - 1] - ctx.uniqDayMs[i]) / MS_PER_DAY
    if (gap === 1) streak++
    else break
    if (streak >= requiredDays) return { unlocked: true, metadata: { days: streak } }
  }
  return streak >= requiredDays
    ? { unlocked: true, metadata: { days: streak } }
    : { unlocked: false }
}

export function detectAggregateThreshold(ctx, cfg) {
  const field = String(cfg?.field || '')
  const period = String(cfg?.period || 'all_time')
  const threshold = Number(cfg?.threshold) || 0
  if (!field || threshold <= 0) return { unlocked: false }
  const total = period === 'all_time'
    ? ctx.aggregateAllTime(field)
    : ctx.aggregateInPeriod(field, period)
  return total >= threshold
    ? { unlocked: true, metadata: { field, period, total: Math.round(total * 100) / 100, threshold } }
    : { unlocked: false }
}

export function detectSessionProperty(ctx, cfg) {
  const predicate = String(cfg?.predicate || '')
  const z = zonesSecondsSafe(ctx.session)
  if (predicate === 'all_zones_present') {
    const have = [1, 2, 3, 4, 5].every((zid) => (z[zid] || z[String(zid)] || 0) > 0)
    return have ? { unlocked: true, metadata: {} } : { unlocked: false }
  }
  if (predicate === 'sustained_z5') {
    const need = Number(cfg?.threshold) || 60
    const z5 = z[5] || z['5'] || 0
    return z5 >= need
      ? { unlocked: true, metadata: { z5Seconds: z5, thresholdSeconds: need } }
      : { unlocked: false }
  }
  if (predicate === 'new_personal_record') {
    const eventTypeId = ctx.session.event_type_id
    if (!eventTypeId) return { unlocked: false }
    const thisPts = Number(ctx.session.effort_points) || 0
    const priorMax = ctx.priorMaxByEventType.get(eventTypeId) || 0
    if (thisPts > priorMax && thisPts > 0) {
      return { unlocked: true, metadata: { eventTypeId, points: thisPts, priorBest: priorMax } }
    }
    return { unlocked: false }
  }
  return { unlocked: false }
}

export function detectClassTypeCount(ctx, cfg) {
  const id = cfg?.event_type_id
  const count = Number(cfg?.count) || 0
  if (!id || count <= 0) return { unlocked: false }
  if (ctx.session.event_type_id !== id) return { unlocked: false }
  const total = ctx.countOfEventType(id)
  return total >= count
    ? { unlocked: true, metadata: { eventTypeId: id, count: total } }
    : { unlocked: false }
}

export function detectLocationVisit(ctx, cfg) {
  const need = Number(cfg?.location_count) || 0
  if (need <= 0) return { unlocked: false }
  return ctx.distinctLocationIds.size >= need
    ? { unlocked: true, metadata: { locationCount: ctx.distinctLocationIds.size } }
    : { unlocked: false }
}

const DETECTORS = {
  first_event:           detectFirstEvent,
  streak:                detectStreak,
  aggregate_threshold:   detectAggregateThreshold,
  session_property:      detectSessionProperty,
  class_type_count:      detectClassTypeCount,
  location_visit:        detectLocationVisit,
}

/**
 * Run every active rule against the context. Returns the list of
 * { rule, metadata } for those that fired. Caller is responsible
 * for filtering already-earned rules and inserting rows.
 */
export function runDetectors(rules, ctx) {
  const out = []
  for (const rule of rules || []) {
    if (rule.is_active === false) continue
    const fn = DETECTORS[rule.rule_type]
    if (!fn) continue
    let res
    try { res = fn(ctx, rule.rule_config || {}) }
    catch { res = { unlocked: false } }
    if (res?.unlocked) {
      out.push({ rule, metadata: res.metadata || {} })
    }
  }
  return out
}

// ── Orchestrator (only DB IO in this module) ──────────────────

/** Map runDetectors() output to the push-friendly unlocked summary. */
export function summariseUnlocked(fired) {
  return (fired || []).map(({ rule }) => ({
    slug: rule.slug, ruleId: rule.id, name: rule.name, icon: rule.icon,
  }))
}

const HISTORY_LOOKBACK_DAYS = 365

/**
 * Run the engine for a finalised session and persist any newly-unlocked
 * achievements. Best-effort: logs and returns shape on errors but
 * never throws.
 *
 * @returns {Promise<{ ok: boolean, unlocked?: Array<{slug:string, ruleId:string}>, error?: string }>}
 */
export async function runDetectionForSession(db, sessionId, { nowMs = Date.now() } = {}) {
  try {
    // 1) Load the session.
    const { data: session, error: sErr } = await db
      .from('heart_rate_sessions')
      .select('id, contact_id, location_id, booking_id, started_at, ended_at, effort_points, peak_hr_bpm, avg_hr_bpm, zones_seconds, max_hr_used, bookings:bookings(event_type_id)')
      .eq('id', sessionId)
      .single()
    if (sErr || !session) {
      return { ok: false, error: sErr?.message || 'session not found' }
    }
    if (!session.ended_at) return { ok: true, unlocked: [] }

    // Flatten event_type_id from booking (sessions don't carry it directly).
    session.event_type_id = session.bookings?.event_type_id || null

    // 2) Load history (last 365d) for this contact.
    const since = new Date(nowMs - HISTORY_LOOKBACK_DAYS * MS_PER_DAY).toISOString()
    const { data: rawHistory } = await db
      .from('heart_rate_sessions')
      .select('id, location_id, started_at, ended_at, effort_points, zones_seconds, bookings:bookings(event_type_id)')
      .eq('contact_id', session.contact_id)
      .not('ended_at', 'is', null)
      .neq('id', sessionId)
      .gte('started_at', since)
      .order('started_at', { ascending: true })
    const history = (rawHistory || []).map((s) => ({
      ...s, event_type_id: s.bookings?.event_type_id || null,
    }))

    // 3) Load active rules + already-earned rule_ids for this contact.
    const [{ data: rules }, { data: earned }] = await Promise.all([
      db.from('achievement_rules').select('id, slug, name, icon, rule_type, rule_config, is_active').eq('is_active', true),
      db.from('contact_achievements').select('rule_id').eq('contact_id', session.contact_id),
    ])
    const earnedSet = new Set((earned || []).map((r) => r.rule_id))
    const candidateRules = (rules || []).filter((r) => !earnedSet.has(r.id))
    if (candidateRules.length === 0) return { ok: true, unlocked: [] }

    // 4) Run detectors.
    const ctx = buildAchievementContext(session, history)
    const fired = runDetectors(candidateRules, ctx)
    if (fired.length === 0) return { ok: true, unlocked: [] }

    // 5) Insert rows. UNIQUE (contact_id, rule_id) protects us from
    // races (e.g. two endSession calls for the same session).
    const rows = fired.map(({ rule, metadata }) => ({
      contact_id: session.contact_id,
      rule_id: rule.id,
      rule_slug: rule.slug,
      source_session_id: session.id,
      metadata,
    }))
    const { data: insertedRows, error: insErr } = await db
      .from('contact_achievements')
      .upsert(rows, { onConflict: 'contact_id,rule_id', ignoreDuplicates: true })
      .select('id')
    if (insErr) {
      logWarn('achievements', 'insert failed', { sessionId, err: insErr })
      return { ok: false, error: insErr.message }
    }

    // Fire sequence triggers for each newly-inserted row. Best-effort —
    // import is deferred to keep this module from depending on the
    // sequences barrel at top-of-file (avoids cycles when sequences
    // imports anything that ends up touching achievements later).
    if (insertedRows && insertedRows.length > 0) {
      const { triggerSequencesForAchievement } = await import('@/lib/sequences')
      for (const row of insertedRows) {
        triggerSequencesForAchievement(row.id).catch((err) =>
          logWarn('achievements', 'sequence trigger failed', { rowId: row.id, err }))
      }
    }

    return {
      ok: true,
      unlocked: summariseUnlocked(fired),
    }
  } catch (err) {
    logWarn('achievements', 'detection threw', { sessionId, err })
    return { ok: false, error: err?.message || String(err) }
  }
}
