// Pure: an OW strava workout.created payload's `data` → a strava_activities row.
// Personal-only store (mig 308) — never a heart_rate_sessions row.
export function mapStravaActivity({ contactId, activity } = {}) {
  const a = activity || {}
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
  const str = (v) => (v === null || v === undefined || v === '' ? null : String(v))
  return {
    contact_id: contactId,
    strava_activity_id: str(a.id),
    activity_type: str(a.type),
    name: str(a.name),
    started_at: a.start_time ?? null,
    duration_seconds: num(a.duration_seconds),
    distance_meters: num(a.distance_meters),
    calories_kcal: num(a.calories_kcal),
    avg_hr_bpm: num(a.avg_heart_rate_bpm),
    max_hr_bpm: num(a.max_heart_rate_bpm),
    raw_metadata: { ow_activity_id: a.id ?? null, source: 'strava' },
  }
}
