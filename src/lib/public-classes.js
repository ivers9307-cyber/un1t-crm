// Public class listing for the /start wizard. Reuses the Glofox event fetch
// the agent uses, but shapes each class with a structured day (YYYY-MM-DD,
// Europe/Dublin) + HH:MM time so the UI can group by day. No auth — display-
// safe class data only (name/time/spots), same as the agent's class list.
import { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, fetchUpcomingEvents } from '@/lib/glofox'

const DUBLIN = 'Europe/Dublin'
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: DUBLIN, year: 'numeric', month: '2-digit', day: '2-digit' })
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: DUBLIN, hour: '2-digit', minute: '2-digit', hour12: false })
const labelFmt = new Intl.DateTimeFormat('en-IE', { timeZone: DUBLIN, weekday: 'short', day: 'numeric', month: 'short' })

export function shapePublicClass(e) {
  const startSec = Number(e.time_start) || 0
  const ms = startSec * 1000
  const size = Number(e.size) || 0
  const booked = Number(e.booked) || 0
  const spots = Math.max(0, size - booked)
  const d = new Date(ms)
  return {
    event_id: e._id || e.id,
    name: e.name || 'Class',
    starts_at: new Date(ms).toISOString(),
    day: dayFmt.format(d),
    day_label: labelFmt.format(d),
    time: timeFmt.format(d),
    spots_left: spots,
    full: size > 0 && spots === 0,
  }
}

// Resolve a location's live, bookable classes for the next `days` days.
export async function listPublicClasses(db, locationId, days = 7) {
  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (missingGlofoxCredentialsForLocation(creds).length) return []
  const start = Math.floor(Date.now() / 1000)
  const end = start + Math.min(14, Math.max(1, days)) * 86400
  const { ok, events } = await fetchUpcomingEvents(creds, { start, end, limit: 100 })
  if (!ok || !Array.isArray(events)) return []
  const now = Date.now()
  return events
    .filter((e) => e && e.active !== false && e.private !== true && (Number(e.time_start) || 0) * 1000 > now)
    .map(shapePublicClass)
    .filter((c) => !c.full)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
}
