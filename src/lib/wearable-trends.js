// Pure: OW timeseries samples → member_health_metrics insert rows.
export const TREND_METRICS = ['resting_heart_rate', 'heart_rate_variability_sdnn', 'vo2_max']
const ALLOWED = new Set(TREND_METRICS)

export function samplesToMetricRows({ contactId, locationId = null, samples } = {}) {
  const seen = new Set()
  const rows = []
  for (const s of Array.isArray(samples) ? samples : []) {
    const metric = s?.type
    if (!ALLOWED.has(metric)) continue
    const t = Date.parse(s?.timestamp)
    if (!Number.isFinite(t)) continue
    const value = Number(s?.value)
    if (s?.value === null || s?.value === undefined || s?.value === '' || !Number.isFinite(value)) continue
    const recorded_at = new Date(t).toISOString()
    const key = `${metric}|${recorded_at}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ contact_id: contactId, location_id: locationId, metric, recorded_at, value, unit: s?.unit ?? null, source: 'apple_health' })
  }
  return rows
}
