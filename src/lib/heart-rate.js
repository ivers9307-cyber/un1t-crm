// Heart rate zone math + UN1T Points helper.
//
// Pure functions — no React, no Supabase, no env. Used here for
// session-end finalisation (bridge writes raw samples, server
// computes zones_seconds + effort_points + avg/peak when the
// session ends) and the live coach view (current zone for each
// open session).
//
// IMPORTANT: keep in sync with champ-app/src/lib/heart-rate.js.
// Both apps render the same numbers to the same human (member
// sees their UN1T Points in champ-app; coach sees them in CRM
// live view). If they drift, finalised sessions will show
// mismatched totals between the two views.
// champ-app is canon. Cross-Vercel-project workspace sharing is
// on the future-cleanup list.
//
// Five zones, %-of-max-HR brackets:
//   Z1 grey    <60%
//   Z2 blue    60-69%
//   Z3 green   70-79%
//   Z4 yellow  80-89%
//   Z5 red     90%+
//
// UN1T Points: 1 point per minute in Z1, 2 in Z2, 3 in Z3, 4 in Z4,
// 5 in Z5. Per-second sample → 1/60th of the per-minute weight.
//
// Max HR: contacts.max_hr_override if set, else the Tanaka estimate
// 208 − 0.7 × age (see resolveMaxHr below). Tanaka is more accurate
// above 40 than the classic 220 − age; the +/-10bpm CI on either makes
// the day-to-day difference noise.

export const ZONE_DEFS = [
  { id: 1, label: 'Z1', name: 'Warm-up',  pctMin: 0,    pctMax: 0.60, color: '#9CA3AF', points: 1 },
  { id: 2, label: 'Z2', name: 'Easy',     pctMin: 0.60, pctMax: 0.70, color: '#3B82F6', points: 2 },
  { id: 3, label: 'Z3', name: 'Aerobic',  pctMin: 0.70, pctMax: 0.80, color: '#10B981', points: 3 },
  { id: 4, label: 'Z4', name: 'Threshold',pctMin: 0.80, pctMax: 0.90, color: '#F59E0B', points: 4 },
  { id: 5, label: 'Z5', name: 'Max',      pctMin: 0.90, pctMax: 1.10, color: '#EF4444', points: 5 },
]

// Operator-configurable scoring defaults. zone_points mirror the
// per-zone `points` on ZONE_DEFS above (1..5) so that the default
// resolved config reproduces the hardcoded behaviour exactly — keep
// these two in sync. participation_points is awarded for attending a
// class with no HR data (no strap), so it isn't on ZONE_DEFS.
export const SCORING_DEFAULTS = { zone_points: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }, participation_points: 50 }

/**
 * Resolve the effective scoring config for a location. Reads the
 * operator overrides from `location.settings.scoring` (a future admin
 * surface writes these) and partial-merges them over SCORING_DEFAULTS,
 * coercing each value to a finite number and falling back to the
 * default for anything missing or non-numeric.
 *
 * @param {object} location  locations row — may have settings.scoring.
 * @returns {{ zonePoints: { 1:number,2:number,3:number,4:number,5:number }, participationPoints: number }}
 */
export function resolveScoringConfig(location) {
  const s = location?.settings?.scoring || {}
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  const zonePoints = {}
  for (const id of [1, 2, 3, 4, 5]) zonePoints[id] = num(s?.zone_points?.[id], SCORING_DEFAULTS.zone_points[id])
  return { zonePoints, participationPoints: num(s?.participation_points, SCORING_DEFAULTS.participation_points) }
}

/**
 * Resolve effective max HR for a contact.
 *
 * @param {object} contact  contacts row — may have max_hr_override and dob.
 * @param {Date|number} [referenceDate=now]
 * @returns {number}  max HR in bpm
 */
export function resolveMaxHr(contact, referenceDate = Date.now()) {
  const override = Number(contact?.max_hr_override)
  if (Number.isFinite(override) && override >= 100 && override <= 240) {
    return Math.round(override)
  }
  const age = computeAge(contact?.dob, referenceDate)
  if (age == null) {
    // No dob, no override — pick a moderate adult default rather than
    // refusing. Operators set the override on the rare cases this
    // matters (older members, athletes).
    return 180
  }
  const tanaka = 208 - 0.7 * age
  return Math.round(Math.max(140, Math.min(220, tanaka)))
}

/**
 * Find the zone for a given BPM at a given max HR.
 * Returns the zone def (id 1-5). Uses [pctMin, pctMax) right-open
 * intervals so 90% lands in Z5 not Z4.
 */
export function zoneForBpm(bpm, maxHr) {
  if (!Number.isFinite(bpm) || !Number.isFinite(maxHr) || maxHr <= 0) {
    return ZONE_DEFS[0]
  }
  const pct = bpm / maxHr
  for (const z of ZONE_DEFS) {
    if (pct >= z.pctMin && pct < z.pctMax) return z
  }
  // pct >= 1.10 — clamp into Z5 rather than returning undefined.
  return ZONE_DEFS[ZONE_DEFS.length - 1]
}

/**
 * Compute zones_seconds + effort_points + summary stats for a list
 * of HR samples. Used at session end (after BLE bridge or async sync
 * finishes) to populate heart_rate_sessions.{zones_seconds,
 * effort_points, avg_hr_bpm, peak_hr_bpm}.
 *
 * @param {Array<{recorded_at: string|Date, bpm: number}>} samples
 * @param {number} maxHr
 * @param {{ zonePoints?: { [zoneId: number]: number } }} [opts]
 *   Optional per-zone points override (from resolveScoringConfig). When
 *   omitted, the hardcoded ZONE_DEFS points are used so behaviour is
 *   byte-identical to before this argument existed.
 * @returns {{
 *   zonesSeconds: { 1: number, 2: number, 3: number, 4: number, 5: number },
 *   effortPoints: number,
 *   avgHrBpm: number|null,
 *   peakHrBpm: number|null,
 *   totalSeconds: number,
 * }}
 */
export function summariseSession(samples, maxHr, opts = {}) {
  const zonesSeconds = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  if (!Array.isArray(samples) || samples.length === 0) {
    return { zonesSeconds, effortPoints: 0, avgHrBpm: null, peakHrBpm: null, totalSeconds: 0 }
  }
  let sum = 0
  let peak = 0
  let count = 0
  // Walk samples sorted by time. Each sample contributes the gap to
  // the next sample (or 1 second for the last sample) to its zone.
  // This gives correct totals even when sampling rate isn't 1Hz.
  const sorted = [...samples]
    .map((s) => ({ ms: new Date(s.recorded_at).getTime(), bpm: Number(s.bpm) }))
    .filter((s) => Number.isFinite(s.ms) && Number.isFinite(s.bpm))
    .sort((a, b) => a.ms - b.ms)

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]
    const next = sorted[i + 1]
    let durSec = next ? (next.ms - s.ms) / 1000 : 1
    // Bound the gap to a sane range — a 30+ second gap is probably
    // a dropout, not 30 seconds in this zone. Cap at 5s.
    if (durSec < 0) durSec = 0
    if (durSec > 5) durSec = 5
    const z = zoneForBpm(s.bpm, maxHr)
    zonesSeconds[z.id] = (zonesSeconds[z.id] || 0) + durSec
    sum += s.bpm
    if (s.bpm > peak) peak = s.bpm
    count++
  }

  const totalSeconds = Object.values(zonesSeconds).reduce((a, b) => a + b, 0)
  const effortPoints = effortPointsFromZones(zonesSeconds, opts.zonePoints)

  return {
    zonesSeconds,
    effortPoints,
    avgHrBpm: count > 0 ? Math.round(sum / count) : null,
    peakHrBpm: peak > 0 ? Math.round(peak) : null,
    totalSeconds: Math.round(totalSeconds),
  }
}

/**
 * UN1T Points from a zones_seconds tally. Per-second weight is points/60
 * (so a minute in Z3 = 3 points). Floored at the END so partial sub-second
 * contributions round consistently rather than per-zone. The per-zone points
 * rate comes from `zonePoints` (operator-configurable) when supplied, else the
 * hardcoded ZONE_DEFS points.
 *
 * Extracted so summariseSession (one-shot, session end) and
 * applyBatchToRunningSummary (incremental, live) compute effort_points from
 * IDENTICAL math — the whole point of the incremental path is that its output
 * matches the one-shot recompute exactly.
 *
 * @param {{ [zoneId: number]: number }} zonesSeconds
 * @param {{ [zoneId: number]: number }} [zonePoints]
 * @returns {number}
 */
export function effortPointsFromZones(zonesSeconds, zonePoints) {
  const raw = ZONE_DEFS.reduce(
    (acc, z) => {
      const secs = Number(zonesSeconds?.[z.id] ?? zonesSeconds?.[String(z.id)] ?? 0) || 0
      return acc + secs * ((zonePoints?.[z.id] ?? z.points) / 60)
    },
    0,
  )
  return Math.floor(raw)
}

// ── incremental running summary (live board) ─────────────────────
//
// The live TV board (buildLiveBoardPayload) used to page EVERY hr_sample for
// EVERY open session every 2s poll and re-run summariseSession over the whole
// class — O(minutes × attendees) rows re-scanned per poll. Instead we maintain
// the same aggregate INCREMENTALLY on heart_rate_sessions at ingest, and the
// live route just reads the row.
//
// applyBatchToRunningSummary is the pure kernel: given the running state and a
// freshly-inserted, time-ordered batch of samples, it folds the batch in and
// returns the new state. It mirrors summariseSession's gap-weighting EXACTLY
// (same zoneForBpm, same 5s dropout cap, same effortPointsFromZones) so that,
// after a final flush of the pending last sample, the incremental running
// zones/points/peak/avg equal summariseSession(fullStream) byte-for-byte —
// regardless of how the stream was split into batches. See the equivalence
// tests in heart-rate.test.js.
//
// THE ONE DELIBERATE LAG: summariseSession attributes the gap between a sample
// and the NEXT sample to that sample's zone (capped 5s), and gives the LAST
// sample a flat 1 second. Incrementally, a sample's gap can only be known once
// the following sample arrives — so the batch's final sample is held "pending"
// (its bpm + recorded_at stashed in lastBpm/lastAtMs) and contributes nothing
// until the next batch lands, at which point its real gap (capped 5s) is
// attributed. This means the LIVE value under-counts by the pending sample's
// not-yet-known contribution (≤5s). flushRunningSummary() closes that gap by
// attributing the summariseSession last-sample rule (a flat 1 second) to the
// pending sample, producing the exact one-shot result. endSession's
// authoritative full recompute (summariseSession over all persisted samples)
// remains the backstop that overwrites any residual live lag at class end.

/**
 * A zeroed running-summary state. Nullable DB columns (a session that has
 * never received a batch) normalise to this via normaliseRunningState.
 */
export function emptyRunningSummary() {
  return {
    zonesSeconds: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    effortPoints: 0,
    peakBpm: null,
    sumBpm: 0,
    sampleCount: 0,
    lastBpm: null,
    lastAtMs: null,
  }
}

/**
 * Coerce a persisted (possibly null / jsonb-string-keyed) running state into
 * the canonical numeric shape emptyRunningSummary() produces. Tolerates the
 * DB round-trip: zones_seconds comes back with string keys, last_sample_at as
 * an ISO string, any counter as null on a fresh session.
 *
 * @param {object|null|undefined} prev
 * @returns {ReturnType<typeof emptyRunningSummary>}
 */
export function normaliseRunningState(prev) {
  const base = emptyRunningSummary()
  if (!prev || typeof prev !== 'object') return base
  const z = prev.zonesSeconds || prev.zones_seconds || {}
  for (const id of [1, 2, 3, 4, 5]) {
    base.zonesSeconds[id] = Number(z?.[id] ?? z?.[String(id)] ?? 0) || 0
  }
  const sumBpm = Number(prev.sumBpm ?? prev.live_sum_bpm)
  base.sumBpm = Number.isFinite(sumBpm) ? sumBpm : 0
  const count = Number(prev.sampleCount ?? prev.live_sample_count)
  base.sampleCount = Number.isFinite(count) ? count : 0
  const peak = Number(prev.peakBpm ?? prev.peak_hr_bpm)
  base.peakBpm = Number.isFinite(peak) && peak > 0 ? peak : null
  const lastBpm = Number(prev.lastBpm ?? prev.live_last_bpm)
  base.lastBpm = Number.isFinite(lastBpm) && lastBpm > 0 ? lastBpm : null
  const lastAtRaw = prev.lastAtMs ?? prev.live_last_at
  if (lastAtRaw != null) {
    const ms = typeof lastAtRaw === 'number' ? lastAtRaw : new Date(lastAtRaw).getTime()
    base.lastAtMs = Number.isFinite(ms) ? ms : null
  }
  // effortPoints is derived, not authoritative — recompute from zones so it is
  // always consistent with the zone tally we just loaded.
  base.effortPoints = effortPointsFromZones(base.zonesSeconds)
  return base
}

/**
 * The per-sample gap cap summariseSession applies (a 30s+ silence is a dropout,
 * not 30s in-zone). Exported so the incremental path and the one-shot path
 * share the exact same constant.
 */
export const MAX_SAMPLE_GAP_SECONDS = 5

/**
 * Fold a freshly-inserted, time-ordered batch of samples into the running
 * summary. PURE — no DB, no clock. Mirrors summariseSession's gap-weighting so
 * that (after flushRunningSummary) the running totals equal the one-shot
 * summariseSession(fullStream) for ANY batch split.
 *
 * Algorithm:
 *   1. Finalise the previously-pending last sample: its gap = firstBatchSample
 *      − prev.lastAtMs, capped [0, 5]s, attributed to the PREVIOUS sample's
 *      zone (zone from prev.lastBpm). Skipped when there is no prior sample.
 *   2. For each consecutive pair WITHIN the batch, attribute (gap capped [0,5]s)
 *      to the earlier sample's zone.
 *   3. The batch's LAST sample becomes the new pending sample (lastBpm/lastAtMs);
 *      it earns no gap yet (counted when the next batch arrives).
 *   4. peak = max, sumBpm += Σbpm, sampleCount += n, effortPoints recomputed
 *      from the running zones via the shared effortPointsFromZones.
 *
 * @param {ReturnType<typeof emptyRunningSummary>|object|null} prevState
 * @param {Array<{recorded_at: string|Date|number, bpm: number}>} batchSamples
 * @param {number} maxHr
 * @param {{ zonePoints?: { [zoneId: number]: number } }} [opts]
 * @returns {ReturnType<typeof emptyRunningSummary>}  the new state
 */
export function applyBatchToRunningSummary(prevState, batchSamples, maxHr, opts = {}) {
  const state = normaliseRunningState(prevState)

  // Defensive sort — the batch SHOULD already be recorded_at-ascending (the
  // bridge buffers in order), but a caller must never corrupt the aggregate on
  // an out-of-order slice. filter+sort mirrors summariseSession exactly.
  const sorted = (Array.isArray(batchSamples) ? batchSamples : [])
    .map((s) => ({ ms: toMs(s.recorded_at), bpm: Number(s.bpm) }))
    .filter((s) => Number.isFinite(s.ms) && Number.isFinite(s.bpm))
    .sort((a, b) => a.ms - b.ms)

  if (sorted.length === 0) return state

  const addGap = (bpm, gapSec) => {
    let d = gapSec
    if (!(d > 0)) d = 0
    if (d > MAX_SAMPLE_GAP_SECONDS) d = MAX_SAMPLE_GAP_SECONDS
    const z = zoneForBpm(bpm, maxHr)
    state.zonesSeconds[z.id] = (state.zonesSeconds[z.id] || 0) + d
  }

  // (1) Close out the previously-pending sample using this batch's first sample.
  if (state.lastBpm != null && state.lastAtMs != null) {
    addGap(state.lastBpm, (sorted[0].ms - state.lastAtMs) / 1000)
  }

  // (2) Consecutive pairs within the batch — each earlier sample gets its gap.
  for (let i = 0; i < sorted.length - 1; i++) {
    addGap(sorted[i].bpm, (sorted[i + 1].ms - sorted[i].ms) / 1000)
  }

  // (4) bpm-derived running stats over the whole batch.
  for (const s of sorted) {
    state.sumBpm += s.bpm
    state.sampleCount += 1
    if (state.peakBpm == null || s.bpm > state.peakBpm) state.peakBpm = s.bpm
  }

  // (3) The batch's last sample is the new pending sample.
  const last = sorted[sorted.length - 1]
  state.lastBpm = last.bpm
  state.lastAtMs = last.ms

  state.effortPoints = effortPointsFromZones(state.zonesSeconds, opts.zonePoints)
  return state
}

/**
 * Attribute the summariseSession last-sample rule (a flat 1 second) to the
 * pending sample and return the FINAL zones/points/peak/avg. This is what makes
 * the incremental path equal summariseSession(fullStream) exactly — call it to
 * "flush" the tail (in tests, and conceptually at end-of-stream). Does NOT
 * mutate the running state (the live board never flushes — it tolerates the
 * ≤5s pending-tail lag, and endSession re-derives authoritatively anyway).
 *
 * @param {ReturnType<typeof emptyRunningSummary>|object|null} state
 * @param {{ zonePoints?: { [zoneId: number]: number } }} [opts]
 * @returns {{ zonesSeconds: object, effortPoints: number, avgHrBpm: number|null, peakHrBpm: number|null, totalSeconds: number }}
 */
export function flushRunningSummary(state, opts = {}) {
  const s = normaliseRunningState(state)
  const zonesSeconds = { ...s.zonesSeconds }
  // Pending last sample contributes a flat 1s to its zone (summariseSession's
  // `durSec = next ? … : 1` last-sample rule).
  if (s.lastBpm != null) {
    // maxHr isn't stored in the running state, but the pending sample's zone
    // was already fixed when it was folded in — we re-resolve it here against
    // the same maxHr the caller used. Callers that flush must pass maxHr via
    // opts.maxHr; summariseSession-equivalence tests do.
    const z = zoneForBpm(s.lastBpm, opts.maxHr)
    zonesSeconds[z.id] = (zonesSeconds[z.id] || 0) + 1
  }
  const totalSeconds = Object.values(zonesSeconds).reduce((a, b) => a + b, 0)
  return {
    zonesSeconds,
    effortPoints: effortPointsFromZones(zonesSeconds, opts.zonePoints),
    avgHrBpm: s.sampleCount > 0 ? Math.round(s.sumBpm / s.sampleCount) : null,
    peakHrBpm: s.peakBpm != null && s.peakBpm > 0 ? Math.round(s.peakBpm) : null,
    totalSeconds: Math.round(totalSeconds),
  }
}

/** Coerce a recorded_at (ISO string / Date / epoch-ms) to epoch ms. */
function toMs(v) {
  if (typeof v === 'number') return v
  if (v instanceof Date) return v.getTime()
  return new Date(v).getTime()
}

/**
 * Helper for the dashboard / detail page: takes the persisted
 * zones_seconds JSON (which may have string keys after a round-trip
 * through Postgres jsonb) and returns a normalised array ready
 * for rendering.
 */
export function zoneBreakdown(zonesSeconds) {
  if (!zonesSeconds || typeof zonesSeconds !== 'object') {
    return ZONE_DEFS.map((z) => ({ ...z, seconds: 0, percent: 0 }))
  }
  const totalSeconds = Object.values(zonesSeconds).reduce((a, b) => a + Number(b || 0), 0)
  return ZONE_DEFS.map((z) => {
    const seconds = Number(zonesSeconds[z.id] ?? zonesSeconds[String(z.id)] ?? 0) || 0
    const percent = totalSeconds > 0 ? seconds / totalSeconds : 0
    return { ...z, seconds, percent }
  })
}

// ── The Burn ─────────────────────────────────────────────────────
//
// A named, binary per-session win condition (like Orangetheory's
// "splat"): a session earns a **Burn** when the member spent ≥ 12
// minutes in Zone 4 or Zone 5 combined. Chantable, screenshot-worthy.
//
// Mirrors the existing z4plus concept (challenges.js metricValue
// z4plus_minutes = (z4+z5)/60) — same numerator, expressed in seconds
// so the threshold comparison is exact and unit-free.
//
// KEEP IN SYNC with the un1t-crm copy of this file (champ-app is canon)
// so the CRM TV renders the identical Burn boolean.

/** 12 minutes in Zone 4+ (Z4+Z5), in seconds. */
export const BURN_THRESHOLD_SECONDS = 720

/**
 * Combined seconds in Zone 4 + Zone 5 for a persisted zones_seconds
 * tally. Tolerates missing/partial/non-object input and postgres jsonb
 * string keys ('4'/'5'). Returns 0 rather than throwing.
 *
 * @param {object|null|undefined} zonesSeconds  { '1'..'5': seconds }
 * @returns {number} seconds in Z4 + Z5 (>= 0)
 */
export function burnSeconds(zonesSeconds) {
  if (!zonesSeconds || typeof zonesSeconds !== 'object') return 0
  const sec = (id) => {
    const v = Number(zonesSeconds[id] ?? zonesSeconds[String(id)] ?? 0)
    return Number.isFinite(v) && v > 0 ? v : 0
  }
  return sec(4) + sec(5)
}

/**
 * Did this session earn a Burn? True when Z4+Z5 combined ≥ 12 min.
 * Safe on missing/partial data (no Burn, no throw).
 *
 * @param {object|null|undefined} zonesSeconds
 * @returns {boolean}
 */
export function isBurn(zonesSeconds) {
  return burnSeconds(zonesSeconds) >= BURN_THRESHOLD_SECONDS
}

// ── internals ────────────────────────────────────────────────────

export function computeAge(dob, refMs) {
  if (!dob) return null
  const dobMs = new Date(dob).getTime()
  if (!Number.isFinite(dobMs)) return null
  const ms = (typeof refMs === 'number' ? refMs : refMs.getTime?.()) ?? Date.now()
  const ageYears = (ms - dobMs) / (365.25 * 24 * 3600 * 1000)
  return ageYears > 5 && ageYears < 110 ? Math.floor(ageYears) : null
}
