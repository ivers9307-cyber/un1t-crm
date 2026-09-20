// RUNWAY.1 — the daily roster-runway push. ONE push per location, per week,
// per severity: a week is announced once when it enters the 10-day horizon
// unready (amber) and once more if it is still unready at 5 days (red).
//
// Idempotency is push_event_sends (mig 349) through notifyUsersAtRolesOnce:
// the claim key carries location + week + severity, and each recipient gets
// their own claim row, so a re-run, a retry or a second daily tick is a no-op.
// Amber and red are different keys, so an amber on day 9 cannot block the red
// on day 4; and a week's severity only ever escalates (pinned in
// shared/roster-runway.test.js), so a red is never followed by an amber.
// Rows are pruned after 30 days; a week leaves the horizon after at most 17.
//
// QUIET HOURS. A staff push that is not a direct response to the recipient's
// own action may only be SENT while the studio's wall clock is inside
// [07:00, 22:00). The cron this rides (contract-reminders, 08:00 UTC) is
// inside that band today; the check lives in the pure decision below so that
// moving the cron can never push at night. Outside the band NOTHING is
// claimed: the dedup sender is not reached at all, so the next run inside the
// band still sends.
//
// WHO. People who can publish a roster AT THAT STUDIO, and nobody else. The
// publish gate (POST /api/schedule/rosters) is hasRoleAtLocation(user,
// location_id, MANAGER_ROLES) = master, owner, manager, head_coach, judged on
// the per-location role. resolveRoleRecipientIds (src/lib/push.js) reads the
// same per-location role off profile_locations FOR THIS LOCATION ONLY, keeps
// active profiles only, and adds masters who hold a row here. So: never a
// coach, never a deactivated profile, never someone whose only link is to
// another studio (and so never another organisation).

import { notifyUsersAtRolesOnce } from './push-dedup'
import { fetchRosterRunways } from './roster-runway-data'
import { dublinDayStr } from './dublin-time'
import { isValidTz, DEFAULT_TZ } from './tz-time'
import { rosterRunwayHeadline, rosterRunwayDetail } from '@shared/roster-runway'
import { logWarn } from './log'

// `master` is not listed because resolveRoleRecipientIds always includes the
// masters linked to the location.
export const RUNWAY_NOTIFY_ROLES = Object.freeze(['owner', 'manager', 'head_coach'])

// The send band, studio wall clock, [from, until).
export const RUNWAY_SEND_FROM = '07:00'
export const RUNWAY_SEND_UNTIL = '22:00'

export const runwayEventKey = (locationId, runway) =>
  `roster_runway:${locationId}:${runway.weekStart}:${runway.severity}`

const _clockFmt = new Map()
function wallClockHHMM(nowMs, tz) {
  if (!_clockFmt.has(tz)) {
    _clockFmt.set(tz, new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }))
  }
  const parts = _clockFmt.get(tz).formatToParts(new Date(nowMs))
  const get = (type) => parts.find((p) => p.type === type)?.value
  // 'en-GB' has historically emitted hour '24' at midnight (tz-time.js and
  // dublin-time.js carry the same guard).
  const hour = get('hour') === '24' ? '00' : get('hour')
  return `${hour}:${get('minute')}`
}

/**
 * True only while the wall clock in `tz` is inside [07:00, 22:00). Intl does
 * the DST work, so the 23-hour and 25-hour days need no special case. An
 * invalid `tz` reads as Dublin rather than throwing (decideRunwayPush is what
 * reports the fallback). An unreadable instant is CLOSED: never push on a guess.
 */
export function isInRunwaySendWindow(nowMs, tz = DEFAULT_TZ) {
  if (!Number.isFinite(nowMs)) return false
  const wall = wallClockHHMM(nowMs, isValidTz(tz) ? tz : DEFAULT_TZ)
  return wall >= RUNWAY_SEND_FROM && wall < RUNWAY_SEND_UNTIL
}

/**
 * PURE: should this studio's runway be pushed right now, and as what?
 *
 * locations.timezone is nullable free text. null / undefined is "not set" and
 * means Dublin, silently (the column default). Anything else that is not a
 * real IANA zone (empty, a typo, a fixed offset, a non-string) ALSO means
 * Dublin, but `timezoneFallback` is true so the caller can warn once. Never
 * throws.
 *
 * @param {{ runway: object|null, location: { id: string, name?: string, timezone?: string|null }, nowMs: number }} args
 * @returns {{ send: false, reason: 'ready' }
 *   | { send: false, reason: 'quiet_hours', timezoneFallback: boolean }
 *   | { send: true, timezoneFallback: boolean, eventKey: string, payload: object }}
 */
export function decideRunwayPush({ runway, location, nowMs }) {
  if (!runway) return { send: false, reason: 'ready' }

  const raw = location?.timezone
  const valid = isValidTz(raw)
  const timezoneFallback = raw != null && !valid
  const tz = valid ? raw : DEFAULT_TZ

  if (!isInRunwaySendWindow(nowMs, tz)) return { send: false, reason: 'quiet_hours', timezoneFallback }

  const title = rosterRunwayHeadline(runway, { locationName: location.name || '' })
  return {
    send: true,
    timezoneFallback,
    eventKey: runwayEventKey(location.id, runway),
    payload: {
      title,
      body: rosterRunwayDetail(runway),
      category: 'schedule',
      // The `schedule` category has fallbackEmail: true with the registry
      // subject "Your schedule has been published" (notifications-registry.js),
      // which is the OPPOSITE of this message. notifyUsers prefers
      // payload.emailSubject, so a manager with no device gets this email
      // under its own title.
      emailSubject: title,
      data: { type: 'roster_runway', location_id: location.id, week_start: runway.weekStart, severity: runway.severity },
    },
  }
}

/**
 * @param {object} db  service-role supabase client
 * @param {{ nowMs?: number }} [opts]  the instant; "today" is its Dublin day
 * @returns {Promise<{ locations: number, alerts: number, quiet_hours: number, sent: number, emailed: number, deduped: number, failed: number }>}
 *   throws when the locations or runway read fails, BEFORE anything is sent
 *   (the cron records it).
 */
export async function runRosterRunwayAlerts(db, { nowMs = Date.now() } = {}) {
  const outcome = { locations: 0, alerts: 0, quiet_hours: 0, sent: 0, emailed: 0, deduped: 0, failed: 0 }
  const todayIso = dublinDayStr(nowMs)

  const { data: locations, error: locErr } = await db.from('locations').select('id, name, timezone')
  if (locErr) throw new Error(`locations read failed: ${locErr.message}`)
  outcome.locations = (locations || []).length
  if (outcome.locations === 0) return outcome

  const res = await fetchRosterRunways(db, locations.map((l) => l.id), { todayIso })
  if (!res.success) throw new Error(`runway read failed: ${res.error}`)

  for (const loc of locations) {
    const decision = decideRunwayPush({ runway: res.data.byLocation[loc.id], location: loc, nowMs })
    if (decision.reason === 'ready') continue
    outcome.alerts++
    if (decision.timezoneFallback) {
      logWarn('roster-runway', `invalid timezone on a location: using ${DEFAULT_TZ} for it`, { locationId: loc.id, timezone: loc.timezone })
    }
    if (!decision.send) {
      outcome.quiet_hours++
      continue
    }
    try {
      const r = await notifyUsersAtRolesOnce(db, decision.eventKey, loc.id, RUNWAY_NOTIFY_ROLES, decision.payload)
      outcome.sent += r.sent || 0
      outcome.emailed += r.emailed || 0
      outcome.deduped += r.deduped || 0
      outcome.failed += r.failed || 0
    } catch (err) {
      // One studio's failure must not cost the next studio its alert.
      outcome.failed++
      logWarn('roster-runway', 'notify failed for location', { locationId: loc.id, err: err?.message })
    }
  }
  return outcome
}
