// SHELLYALERTS.3 — the alert pass. Run at the end of each location's
// reconcile, after the state writes, and pushes to the studio's owners and
// managers (category 'shelly_alert', registered in shared/permissions.js so it
// does not fail closed) when:
//
//   key rejected  this tick's read was refused for the key (kind 'auth').
//   offline       a device has said nothing for OFFLINE_AFTER_MS.
//   power fault   an online device lists a tripped protection in `errors`.
//
// EXACTLY ONCE IS THE LEDGER'S JOB, NOT OURS. Every push goes through
// sendPushToRolesAtLocationOnce with a key that names ONE event, so a tick that
// sees the same fact again is a deduped no-op, and a send that failed outright
// releases its claim and is tried on the next tick. The keys:
//
//   shelly_key:<connection id>:<last_ok_at | never>
//     NOT last_error_at, which the reconcile re-stamps on every failed retry
//     (each ACTION_NEEDED_RETRY_MS), so a key on it would push every 15
//     minutes for as long as the key stays wrong. last_ok_at does not move
//     while the connection is failing, and moves when it recovers, so it names
//     one outage.
//   shelly_offline:<device row id>:<last_seen_at>
//     last_seen_at advances only on a device that spoke, so it names one
//     outage too.
//   shelly_fault:<device row id>:<sorted faults>:<studio's local day>
//     at most one push a day per device for the same faults; a new fault is a
//     new push.
//
// ONE PUSH PER BOX. A Pro 4PM or an RGBW PM is one Shelly device and several
// rows (one per channel); when the box drops off its rows all go offline
// together, and a box-wide fault (overheating) shows on every channel. Rows are
// grouped by the Shelly device id, and the group is keyed on its first row.
//
// NEVER THROWS, AND LOGS IDS ONLY. A failed push is logged (ids, the kind, the
// error message) and swallowed: an alert must never be the reason a studio's
// relays were not reconciled. No URL, body or key is ever logged (the
// reconcile's header rule 4).

import { logWarn } from '@/lib/log'
import { sendPushToRolesAtLocationOnce } from '@/lib/push-dedup'
import { strictDayStrIn as dayStrInTz, timeLabelIn, formatInZone } from '@/lib/location-time'

const MODULE = 'shelly-alerts'

export const ALERT_ROLES = Object.freeze(['owner', 'manager'])
export const OFFLINE_AFTER_MS = 15 * 60_000
// The ledger makes a retry free of duplicates but not free of cost: each
// attempt is a role read and a claim insert. A device that has been dark for
// more than a day was pushed about on its first day (or the push kept failing
// for a day); either way another attempt every minute buys nothing.
export const OFFLINE_ALERT_WINDOW_MS = 24 * 3600_000

// The protections the decision names, in the words the push uses. Any other
// string in `errors` (a calibration flag, a future code) is not a power fault
// and pushes nothing.
export const FAULT_WORDS = Object.freeze({
  overpower: 'overpower',
  overtemp: 'overheating',
  overvoltage: 'over-voltage',
  undervoltage: 'under-voltage',
})

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// "A", "A and B", "A, B and C".
function listWords(words) {
  if (words.length <= 1) return words[0] ?? ''
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

const rowName = (d) => (typeof d?.name === 'string' && d.name.trim() ? d.name.trim() : 'A smart plug')

// One label for a box: its row's name, or "Gym lights 1 and 3 more".
function boxName(rows) {
  const first = rowName(rows[0])
  return rows.length > 1 ? `${first} and ${rows.length - 1} more` : first
}

// Rows grouped by the physical device, in the order they came (created_at).
function byBox(devices) {
  const boxes = new Map()
  for (const d of devices) {
    const key = typeof d?.device_id === 'string' && d.device_id ? d.device_id : `row:${d?.id}`
    if (!boxes.has(key)) boxes.set(key, [])
    boxes.get(key).push(d)
  }
  return [...boxes.values()]
}

// "14:05", or "25 Oct 14:05" when the outage began on an earlier local day.
function sinceLabel(iso, nowMs, tz) {
  const hm = timeLabelIn(iso, tz)
  if (!hm) return null
  const sameDay = dayStrInTz(Date.parse(iso), tz) === dayStrInTz(nowMs, tz)
  return sameDay ? hm : `${formatInZone(Date.parse(iso), tz, { day: 'numeric', month: 'short' })} ${hm}`
}

/**
 * The alerts this location owes right now, as { kind, eventKey, payload }.
 * Pure: the caller sends them (the ledger decides which are new).
 *
 * @param {{ locationId, conn, devices, nowMs, tz, keyRejected?, studioName? }} input
 *   devices: the rows AS THEY STAND after this tick's state writes.
 */
export function planShellyAlerts({ locationId, conn, devices, nowMs, tz, keyRejected = false, studioName = null }) {
  const out = []
  const at = typeof studioName === 'string' && studioName.trim() ? ` at ${studioName.trim()}` : ''
  const data = (kind, extra = {}) => ({ type: 'shelly_alert', kind, location_id: locationId, ...extra })

  if (keyRejected && conn?.id) {
    out.push({
      kind: 'key_rejected',
      eventKey: `shelly_key:${conn.id}:${conn.last_ok_at || 'never'}`,
      payload: {
        title: `Smart plugs need attention${at}`,
        body: "Shelly stopped accepting the studio's key. Re-paste it on the web Smart plugs page.",
        data: data('key_rejected'),
        category: 'shelly_alert',
      },
    })
  }

  for (const rows of byBox(Array.isArray(devices) ? devices : [])) {
    // ---- offline: every row of the box dark, judged on the newest sighting.
    const seen = rows.map((d) => d?.last_seen_at).filter((s) => typeof s === 'string' && Number.isFinite(Date.parse(s)))
    const allOffline = rows.every((d) => isObj(d?.last_state) && d.last_state.online === false)
    if (allOffline && seen.length) {
      // A never-seen box (adopted while dark) has no outage to name: skipped.
      const lastSeen = seen.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a))
      const age = nowMs - Date.parse(lastSeen)
      if (age >= OFFLINE_AFTER_MS && age <= OFFLINE_ALERT_WINDOW_MS) {
        const since = sinceLabel(lastSeen, nowMs, tz)
        out.push({
          kind: 'offline',
          eventKey: `shelly_offline:${rows[0].id}:${lastSeen}`,
          payload: {
            title: `Smart plug offline${at}`,
            body: `${boxName(rows)} has been offline${since ? ` since ${since}` : ' for over 15 minutes'}.`,
            data: data('offline', { device_id: rows[0].id }),
            category: 'shelly_alert',
          },
        })
      }
    }

    // ---- power fault: only from a device that is talking (a frozen offline
    // reading is not a fresh report; the offline alert covers that box).
    const faulted = rows.filter((d) => isObj(d?.last_state) && d.last_state.online === true
      && Array.isArray(d.last_state.errors) && d.last_state.errors.some((e) => FAULT_WORDS[e]))
    if (faulted.length) {
      const faults = [...new Set(faulted.flatMap((d) => d.last_state.errors.filter((e) => FAULT_WORDS[e])))].sort()
      const day = dayStrInTz(nowMs, tz)
      out.push({
        kind: 'fault',
        eventKey: `shelly_fault:${faulted[0].id}:${faults.join(',')}:${day}`,
        payload: {
          title: `Smart plug power fault${at}`,
          body: `${boxName(faulted)} reported ${listWords(faults.map((f) => FAULT_WORDS[f]))} and may have switched off.`,
          data: data('fault', { device_id: faulted[0].id }),
          category: 'shelly_alert',
        },
      })
    }
  }
  return out
}

/**
 * Plan and send. Never throws.
 *
 * @param deps {{ send? }} send(db, eventKey, locationId, roles, payload);
 *   defaults to sendPushToRolesAtLocationOnce.
 * @returns {{ alerts, sent, failed }}
 */
export async function runShellyAlerts(db, input, deps = {}) {
  const send = deps.send || sendPushToRolesAtLocationOnce
  const counts = { alerts: 0, sent: 0, failed: 0 }
  let planned
  try {
    if (!Number.isFinite(input?.nowMs)) return counts
    planned = planShellyAlerts(input)
  } catch (e) {
    logWarn(MODULE, 'alert planning failed', { locationId: input?.locationId, err: e?.message })
    return counts
  }
  for (const a of planned) {
    counts.alerts++
    try {
      const r = await send(db, a.eventKey, input.locationId, ALERT_ROLES, a.payload)
      if ((r?.sent || 0) > 0) counts.sent++
      if ((r?.failed || 0) > 0 || r?.recipients_failed) {
        counts.failed++
        logWarn(MODULE, 'alert push not delivered', {
          locationId: input.locationId, kind: a.kind, deviceId: a.payload.data.device_id ?? null,
          failed: r?.failed ?? 0, recipients_failed: r?.recipients_failed ?? 0,
        })
      }
    } catch (e) {
      counts.failed++
      logWarn(MODULE, 'alert push failed', {
        locationId: input.locationId, kind: a.kind, deviceId: a.payload.data.device_id ?? null, err: e?.message,
      })
    }
  }
  return counts
}
