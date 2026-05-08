// TCX (Training Center XML) builder for HR session uploads.
//
// Strava (and Garmin Connect) accept TCX as a per-second time-series
// of HR samples. Uploading the stream — instead of just a summary —
// makes the activity render with the proper HR graph + zone times,
// which is what makes the integration valuable to athletes.
//
// Schema reference: Garmin TCX v2 schema. We emit only the parts
// Strava actually parses (Activity → Lap → Track → Trackpoint).
// No GPS, no cadence — Strava is fine without those.
//
// Pure: no IO, no external libs. The output is a UTF-8 XML string.

function escapeXml(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/**
 * Build a TCX document for a single heart-rate session.
 *
 * @param {object} input
 * @param {object} input.session   heart_rate_sessions row (started_at, ended_at, avg_hr_bpm, peak_hr_bpm)
 * @param {Array}  input.samples   hr_samples rows: { recorded_at, bpm }, sorted ascending
 * @param {string} [input.title]   activity name; defaults to "UN1T HR session"
 * @param {string} [input.sport]   "Other" | "Running" | "Biking"; Strava maps Other → "Workout"
 * @returns {string} TCX XML
 */
export function buildTcx({ session, samples = [], title = null, sport = 'Other' }) {
  const startIso = new Date(session.started_at).toISOString()
  const endMs = session.ended_at ? new Date(session.ended_at).getTime()
                                  : new Date(session.started_at).getTime() + 60_000
  const totalSec = Math.max(1, Math.round((endMs - new Date(session.started_at).getTime()) / 1000))

  const trackpoints = samples
    .map((s) => {
      const time = new Date(s.recorded_at).toISOString()
      const bpm = Math.max(30, Math.min(240, Math.round(s.bpm)))
      return `<Trackpoint><Time>${time}</Time><HeartRateBpm><Value>${bpm}</Value></HeartRateBpm></Trackpoint>`
    })
    .join('\n        ')

  const safeTitle = escapeXml(title || 'UN1T HR session')
  const avg = Number.isFinite(session.avg_hr_bpm) ? Math.round(session.avg_hr_bpm) : null
  const peak = Number.isFinite(session.peak_hr_bpm) ? Math.round(session.peak_hr_bpm) : null

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
                       xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                       xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabaseV2.xsd">
  <Activities>
    <Activity Sport="${escapeXml(sport)}">
      <Id>${startIso}</Id>
      <Lap StartTime="${startIso}">
        <TotalTimeSeconds>${totalSec}</TotalTimeSeconds>
        <DistanceMeters>0</DistanceMeters>
        <Calories>0</Calories>
        ${avg != null ? `<AverageHeartRateBpm><Value>${avg}</Value></AverageHeartRateBpm>` : ''}
        ${peak != null ? `<MaximumHeartRateBpm><Value>${peak}</Value></MaximumHeartRateBpm>` : ''}
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
        ${trackpoints}
        </Track>
      </Lap>
      <Notes>${safeTitle}</Notes>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`
}
