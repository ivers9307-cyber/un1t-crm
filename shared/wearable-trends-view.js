// Pure: member_health_metrics rows → per-metric display models for the
// "Recovery & fitness" Progress section. Metrics with no rows are omitted.
export const TREND_META = {
  resting_heart_rate:          { label: 'Resting heart rate', unit: 'bpm', lowerIsBetter: true },
  heart_rate_variability_sdnn: { label: 'HRV', unit: 'ms', lowerIsBetter: false },
  vo2_max:                     { label: 'VO₂ max', unit: 'mL/kg/min', lowerIsBetter: false },
}
const ORDER = ['resting_heart_rate', 'heart_rate_variability_sdnn', 'vo2_max']

// The metric keys these views actually display. Exported so the readers that
// fetch member_health_metrics can server-side filter to just these — an
// ascending, unfiltered read gets capped at the row limit and returns the
// OLDEST rows, hiding the member's latest reading. Keep in sync with ORDER.
export const TREND_METRICS = ORDER

export function buildTrendViews(rows) {
  const byMetric = new Map()
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!TREND_META[r?.metric]) continue
    const t = Date.parse(r?.recorded_at)
    const v = Number(r?.value)
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue
    if (!byMetric.has(r.metric)) byMetric.set(r.metric, [])
    byMetric.get(r.metric).push({ t, recorded_at: r.recorded_at, value: v })
  }
  const views = []
  for (const metric of ORDER) {
    const pts = byMetric.get(metric)
    if (!pts || pts.length === 0) continue
    pts.sort((a, b) => a.t - b.t)
    const meta = TREND_META[metric]
    const first = pts[0].value
    const latest = pts[pts.length - 1].value
    const delta = latest - first
    const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
    const improving = delta === 0 ? null : meta.lowerIsBetter ? delta < 0 : delta > 0
    views.push({ metric, label: meta.label, unit: meta.unit, latest, direction, improving, points: pts.map((p) => ({ recorded_at: p.recorded_at, value: p.value })) })
  }
  return views
}
