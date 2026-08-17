// WAVE-4 — pure helpers for the post-class "wrapped" ceremony (mobile).
// No IO, no React, no SecureStore — just derivation from a session report so
// it's unit-testable and shared with any future web recap. The SecureStore
// "seen recap" flag lives in mobile/lib/recap-seen.js (native-only).

import { dominantZone } from './share-card.js'

/**
 * The single celebratory line for the recap, in priority order:
 *   1. the report's own highlight (PB / red-zone / streak — already computed)
 *   2. a category-percentile brag ("Top N% of your RIDE classes")
 *   3. a Burn callout
 *   4. null (no hero line — the points count-up carries the moment)
 *
 * Returns { kind, message } or null. `kind` lets the UI style PB vs Burn
 * differently (a PB gets the full-width celebratory treatment).
 * Pure — never throws on a partial/empty report.
 * @param {object} report the /api session report envelope's `.report`
 */
export function pickRecapHighlight(report) {
  const r = report || {}
  const s = r.summary || {}

  const hl = r.highlight?.message
  if (hl) return { kind: 'highlight', message: String(hl) }

  const vc = r.comparisons?.vs_category
  if (vc && vc.percentile != null && (vc.sample_size ?? 0) >= 2) {
    const pct = Math.round(vc.percentile * 100)
    if (pct >= 100) {
      return { kind: 'pb', message: `Personal best — top of your last ${vc.sample_size} ${vc.category} classes.` }
    }
    if (pct >= 50) {
      // Floor at 1: a percentile of 1.0 is handled above; 0.995 → "Top 1%".
      return { kind: 'top', message: `Top ${Math.max(1, 100 - pct)}% of your ${vc.category} classes.` }
    }
  }

  if (s.burn === true) {
    const mins = Number.isFinite(s.z4plus_minutes) ? s.z4plus_minutes : null
    return { kind: 'burn', message: mins ? `The Burn — ${mins} min in Zone 4+.` : 'The Burn earned.' }
  }

  return null
}

/**
 * Flatten a report into the exact field set the wrapped screen renders. Pure,
 * total (safe on empty/partial reports), and independent of React so it can be
 * unit-tested. `samples` are the [{ recorded_at, bpm }] rows; we only need bpm
 * for the trace so we don't parse timestamps here.
 * @param {object} report
 * @param {Array<{bpm:number}>} [samples]
 */
export function recapModel(report, samples = []) {
  const r = report || {}
  const s = r.summary || {}
  const zones = Array.isArray(s.zones) ? s.zones : []

  const z4 = zones.find((z) => z.id === 4)
  const z5 = zones.find((z) => z.id === 5)
  const z4plusSeconds = (Number(z4?.seconds) || 0) + (Number(z5?.seconds) || 0)

  return {
    points: Number.isFinite(s.effort_points) ? s.effort_points : 0,
    dominant: dominantZone(zones),
    zones,
    avgHr: Number.isFinite(s.avg_hr_bpm) ? s.avg_hr_bpm : null,
    peakHr: Number.isFinite(s.peak_hr_bpm) ? s.peak_hr_bpm : null,
    calories: Number.isFinite(r.session?.calories_kcal) ? Math.round(r.session.calories_kcal) : null,
    burn: s.burn === true,
    z4plusMinutes: Number.isFinite(s.z4plus_minutes)
      ? s.z4plus_minutes
      : (z4plusSeconds > 0 ? Math.round(z4plusSeconds / 60) : null),
    z4plusSeconds,
    className: r.session?.class?.name || null,
    highlight: pickRecapHighlight(r),
    // Only the bpm series matters for the trace polyline.
    traceSamples: (samples || []).filter((x) => Number.isFinite(x?.bpm)),
    hasTrace: (samples || []).filter((x) => Number.isFinite(x?.bpm)).length >= 2,
  }
}
