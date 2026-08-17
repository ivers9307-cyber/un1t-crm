// FLAGSHIP — pure helpers for InBody body-composition derivation (mobile).
//
// No IO, no React, no SecureStore — just derivation over `inbody_scans` rows
// the member's RLS-scoped client already returns. This is the SINGLE source of
// the metric definitions: mobile/app/coaching/inbody.jsx imports METRICS from
// here, and ChallengeTransformationCard's "InBody bookend" (start-of-challenge
// vs latest) is computed by inbodyBookend below.
//
// A scan row is `{ scanned_at, weight_kg, smm_kg, pbf_percent, inbody_score, … }`.
// `scanned_at` is an ISO timestamp; all window comparisons are done in ms
// (timezone-safe — an absolute instant, no calendar arithmetic here).

// Trend/bookend metric definitions. `betterWhenLower` flips the improvement
// direction for deltas (lower weight + body-fat = good; more muscle = good).
export const METRICS = [
  { key: 'weight_kg',   label: 'Weight',   short: 'Weight',   unit: 'kg', dp: 1, betterWhenLower: true },
  { key: 'smm_kg',      label: 'Muscle',   short: 'Muscle',   unit: 'kg', dp: 1, betterWhenLower: false },
  { key: 'pbf_percent', label: 'Body fat', short: 'Body fat', unit: '%',  dp: 1, betterWhenLower: true },
]

// Finite Number or null. null/undefined/'' → null (they'd coerce to 0/NaN
// otherwise), so an absent metric field reads as "no value", not zero.
function num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ms instant for a scan's `scanned_at`, or null when unparseable/missing.
function scanMs(scan) {
  const t = Date.parse(scan?.scanned_at)
  return Number.isFinite(t) ? t : null
}

/**
 * Build the InBody "transformation bookend" for a window — the body-comp change
 * between the member's baseline (at/before the challenge start) and their
 * latest scan (at/before the challenge end). Pure + total: never throws.
 *
 * Baseline = the LATEST scan on/before `fromMs`; if none exists, the EARLIEST
 * scan WITHIN the window (fromMs..toMs). Latest = the LATEST scan on/before
 * `toMs`. Both endpoints must be usable and distinct scans, and there must be
 * ≥2 usable scans spanning the window — otherwise the bookend is null.
 *
 * @param {Array<object>} scans  inbody_scans rows (any order)
 * @param {{fromMs:number, toMs:number}} window  challenge window in ms
 * @returns {{
 *   baseline: object,
 *   latest: object,
 *   metrics: Array<{ key,label,short,unit,dp,betterWhenLower,from,to,delta,improved }>,
 *   score: { from:number|null, to:number|null, delta:number|null, improved:boolean|null },
 * } | null}
 */
export function inbodyBookend(scans, { fromMs, toMs } = {}) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return null

  // Usable scans = those with a parseable timestamp, tagged with their ms.
  const usable = (Array.isArray(scans) ? scans : [])
    .map((s) => ({ scan: s, ms: scanMs(s) }))
    .filter((x) => x.ms !== null)
    .sort((a, b) => a.ms - b.ms) // oldest → newest

  if (usable.length < 2) return null

  // Latest = the latest scan on/before toMs.
  let latestEntry = null
  for (const x of usable) {
    if (x.ms <= toMs) latestEntry = x
    else break
  }
  if (!latestEntry) return null

  // Baseline = latest scan on/before fromMs; else earliest scan within window.
  let baselineEntry = null
  for (const x of usable) {
    if (x.ms <= fromMs) baselineEntry = x
    else break
  }
  if (!baselineEntry) {
    baselineEntry = usable.find((x) => x.ms >= fromMs && x.ms <= toMs) || null
  }
  if (!baselineEntry) return null

  // Need two DISTINCT bookend scans that actually span the window.
  if (baselineEntry.ms >= latestEntry.ms) return null

  const baseline = baselineEntry.scan
  const latest = latestEntry.scan

  const metrics = METRICS.map((m) => {
    const from = num(baseline[m.key])
    const to = num(latest[m.key])
    const delta = from !== null && to !== null ? to - from : null
    let improved = null
    if (delta !== null) {
      if (m.betterWhenLower === true) improved = delta < 0
      else if (m.betterWhenLower === false) improved = delta > 0
      // betterWhenLower null (no better direction) ⇒ improved stays null.
    }
    return { ...m, from, to, delta, improved }
  })

  const scoreFrom = num(baseline.inbody_score)
  const scoreTo = num(latest.inbody_score)
  const scoreDelta = scoreFrom !== null && scoreTo !== null ? scoreTo - scoreFrom : null
  const score = {
    from: scoreFrom,
    to: scoreTo,
    delta: scoreDelta,
    improved: scoreDelta === null ? null : scoreDelta > 0, // higher score = better
  }

  return { baseline, latest, metrics, score }
}
