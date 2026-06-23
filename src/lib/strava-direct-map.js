// Pure: a raw Strava REST activity (summary OR detailed) → a strava_activities row.
// strava_activity_id is Strava's real numeric activity id (the dedup key for the
// direct path). Personal-only store (mig 308) — never a heart_rate_sessions row.
export function mapStravaApiActivity({ contactId, activity, athleteId = null } = {}) {
  const a = activity || {}
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
  const str = (v) => (v === null || v === undefined || v === '' ? null : String(v))
  return {
    contact_id: contactId,
    strava_activity_id: str(a.id),
    activity_type: str(a.sport_type || a.type),
    name: str(a.name),
    started_at: a.start_date ?? null,
    duration_seconds: num(a.moving_time ?? a.elapsed_time),
    distance_meters: num(a.distance),
    calories_kcal: num(a.calories),
    avg_hr_bpm: num(a.average_heartrate),
    max_hr_bpm: num(a.max_heartrate),
    raw_metadata: { source: 'strava', strava_athlete_id: athleteId ?? null, type: a.type ?? null, sport_type: a.sport_type ?? null },
  }
}
