// Public class listing for the /start wizard. Reuses the Glofox event fetch
// the agent uses, but shapes each class with a structured day (YYYY-MM-DD,
// Europe/Dublin) + HH:MM time so the UI can group by day. No auth — display-
// safe class data only: name and time. PUBCAP.1: NEVER a capacity figure
// (Richard's rule: class/event capacity is never surfaced to customers — no
// spots left, no size, no booked count, not even a "full" flag). Fullness is
// judged on the RAW Glofox event before shaping, and a full class is simply
// left out of the list.
import { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, fetchUpcomingEvents } from '@/lib/glofox'
import { getGlofoxConfig } from '@/lib/connection-registry'

const DUBLIN = 'Europe/Dublin'
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: DUBLIN, year: 'numeric', month: '2-digit', day: '2-digit' })
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: DUBLIN, hour: '2-digit', minute: '2-digit', hour12: false })
const labelFmt = new Intl.DateTimeFormat('en-IE', { timeZone: DUBLIN, weekday: 'short', day: 'numeric', month: 'short' })

// The ONLY keys a public class carries. tests/public-classes pin this list so
// a new field has to be added here on purpose, never leak in via a spread.
export const PUBLIC_CLASS_KEYS = Object.freeze(['event_id', 'name', 'starts_at', 'day', 'day_label', 'time'])

// Server-side only: is this raw Glofox event full? Never sent to a client.
export function isEventFull(e) {
  const size = Number(e?.size) || 0
  const booked = Number(e?.booked) || 0
  return size > 0 && booked >= size
}

export function shapePublicClass(e) {
  const startSec = Number(e.time_start) || 0
  const ms = startSec * 1000
  const d = new Date(ms)
  return {
    event_id: e._id || e.id,
    name: e.name || 'Class',
    starts_at: new Date(ms).toISOString(),
    day: dayFmt.format(d),
    day_label: labelFmt.format(d),
    time: timeFmt.format(d),
  }
}

// Operator deny-list. Hide classes whose name contains any configured keyword
// (case-insensitive), stored at locations.settings.glofox.hidden_class_keywords
// — keeps free-trial leads out of e.g. ELITES / members-only sessions. Applied
// inside listPublicClasses so it governs BOTH the public picker AND the booking
// enqueue (both go through here): a hidden class can be neither seen nor booked.
export function parseHiddenKeywords(raw) {
  const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\n,]/) : []
  return arr.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
}
export function isClassHidden(name, keywords) {
  if (!keywords || !keywords.length) return false
  const n = String(name || '').toLowerCase()
  return keywords.some((k) => n.includes(k))
}

// Resolve a location's live, bookable classes for the next `days` days.
export async function listPublicClasses(db, locationId, days = 7) {
  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (missingGlofoxCredentialsForLocation(creds).length) return []
  let hidden = []
  try {
    // INTEG-A2 dual-read: registry config first, legacy settings.glofox otherwise.
    const glofoxCfg = await getGlofoxConfig(db, locationId)
    hidden = parseHiddenKeywords(glofoxCfg?.hidden_class_keywords)
  } catch { /* no-op: a read failure just means no deny-list applied */ }
  const start = Math.floor(Date.now() / 1000)
  const end = start + Math.min(14, Math.max(1, days)) * 86400
  const { ok, events } = await fetchUpcomingEvents(creds, { start, end, limit: 100 })
  if (!ok || !Array.isArray(events)) return []
  const now = Date.now()
  return events
    .filter((e) => e && e.active !== false && e.private !== true && (Number(e.time_start) || 0) * 1000 > now)
    .filter((e) => !isEventFull(e))
    .map(shapePublicClass)
    .filter((c) => !isClassHidden(c.name, hidden))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
}
