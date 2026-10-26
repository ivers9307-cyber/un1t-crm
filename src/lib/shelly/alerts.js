// SHELLYALERTS.3 — the alert pass. Run at the end of each location's
// reconcile, after the state writes, and pushes to the studio's owners and
// managers (category 'shelly_alert', registered in shared/permissions.js so it
// does not fail closed) when:
//
//   key rejected  this tick's read or command was refused for the key.
//   offline       a box has said nothing for OFFLINE_AFTER_MS.
//   power fault   an online box lists a tripped protection in `errors`.
//
// EXACTLY ONCE IS THE LEDGER'S JOB, NOT OURS. Every push goes through
// sendPushOnce (push_event_sends) with a key that names ONE event, so a tick
// that sees the same fact again is a deduped no-op, and a send that failed
// outright releases its claim and is tried on the next tick. The keys:
//
//   shelly_key:<connection id>:<last_ok_at | never>
//     NOT last_error_at, which the reconcile re-stamps on every failed retry
//     (each ACTION_NEEDED_RETRY_MS), so a key on it would push every 15
//     minutes for as long as the key stays wrong. last_ok_at does not move
//     while the connection is failing, and moves when it recovers, so it names
//     one outage.
//   shelly_offline:<location id>:<id@lastSeenMs,…>
//     One push per OUTAGE CLUSTER (review item 3): boxes whose last sighting
//     is within OFFLINE_CLUSTER_MS of the cluster's earliest are one event, so
//     a power cut across eight boxes is ONE push ("8 smart plugs offline …"),
//     and a box that drops two hours later is its own.
//     Each member is named by its OUTAGE, `<first row id>@<last_seen_at ms>`:
//     last_seen_at does not move while a box is dark, so the pair is constant
//     for the whole outage however the cluster's membership shifts (a late
//     joiner, a partial recovery). The ledger read (readOfflineHistory) takes
//     the last 24 hours of these keys back, and a box is left out of the next
//     cluster when EITHER
//       - its (id, last seen) pair was already named: the same outage is
//         never pushed twice, past the 2-hour cool-down too; or
//       - its id was named under OFFLINE_COOLDOWN_MS ago: a plug flapping
//         off and on is not pushed about every time it drops.
//     The ledger has no payload column (mig 349: id, event_key, recipient_id,
//     sent_at), so the pairs live in the key. To keep the key under ~1 KB a
//     key names at most MAX_KEY_MEMBERS boxes (~50 bytes each); a larger
//     cluster is split into several pushes of that size.
//   shelly_fault:<device row id>:<sorted faults>:<studio's local day>
//     at most one push a day per box for the same faults; a new fault is a
//     new push.
//
// ONE PUSH PER BOX for faults. A Pro 4PM or an RGBW PM is one Shelly device
// and several rows (one per channel); a box-wide fault (overheating) shows on
// every channel. Rows are grouped by the Shelly device id, keyed on the first.
//
// `enabled` IS NOT A FILTER (review item 6). A device in a group carries
// enabled=false (the group runs it) and is just as managed, and an unmanaged
// plug going dark or tripping is just as much news. Every adopted row counts.
//
// BOUNDED (review item 2). The role recipients are read ONCE per pass; at most
// MAX_NEW_SENDS alerts that actually claim somebody go out per pass (the rest
// next tick, which the ledger makes safe), and at most MAX_ATTEMPTS ledger
// calls are made in all. The reconcile also skips the pass near its deadline.
//
// JUDGED AT THIS STUDIO (review item 1). The notify toggle is resolved with
// { locationId }: an owner here who is plain staff at another studio is told.
//
// NEVER THROWS, AND LOGS IDS ONLY. An alert must never be the reason a
// studio's relays were not reconciled. No URL, body or key is ever logged
// (the reconcile's header rule 4).

import { logWarn } from '@/lib/log'
import { sendPushOnce } from '@/lib/push-dedup'
import { readRoleRecipientIds } from '@/lib/push'
import { escapeLikePattern } from '@/lib/like-escape'
import { strictDayStrIn as dayStrInTz, timeLabelIn, formatInZone } from '@/lib/location-time'

const MODULE = 'shelly-alerts'

export const ALERT_ROLES = Object.freeze(['owner', 'manager'])
export const OFFLINE_AFTER_MS = 15 * 60_000
// Boxes whose last sighting is this close to the cluster's earliest are one
// outage (a power cut, a router reboot).
export const OFFLINE_CLUSTER_MS = 15 * 60_000
// No second offline push about the same box within this long.
export const OFFLINE_COOLDOWN_MS = 2 * 3600_000
// The ledger makes a retry free of duplicates but not free of cost: each
// attempt is a claim insert. A box dark for more than a day was pushed about
// on its first day (or the push kept failing for a day); another attempt
// every minute buys nothing.
export const OFFLINE_ALERT_WINDOW_MS = 24 * 3600_000
// Boxes one offline key may name (each `<uuid>@<13-digit ms>` is ~51 bytes).
export const MAX_KEY_MEMBERS = 16
export const MAX_NEW_SENDS = 3
export const MAX_ATTEMPTS = 10
// Names a combined offline push spells out before "and N more".
const NAMES_SHOWN = 2

// The protections the decision names, in the words the push uses. Any other
// string in `errors` (a calibration flag, a future code) is not a power fault
// and pushes nothing. Keys match status.js POWER_FAULTS.
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

// The outage token of one box, as an offline key names it.
const outageToken = (b) => `${b.id}@${b.lastSeenMs}`

// The [id, lastSeenMs] pairs an offline key names (the segment after the last
// ':'; a uuid and a millisecond count carry no colon).
export function outagesFromOfflineKey(key) {
  if (typeof key !== 'string' || !key.startsWith('shelly_offline:')) return []
  return key.slice(key.lastIndexOf(':') + 1).split(',').map((tok) => {
    const at = tok.lastIndexOf('@')
    return at > 0 ? [tok.slice(0, at), tok.slice(at + 1)] : null
  }).filter(Boolean)
}

const NO_HISTORY = Object.freeze({ pairs: new Set(), recentIds: new Set() })

// A box that has gone dark: every row offline, a readable newest sighting.
function darkBox(rows) {
  if (!rows.every((d) => isObj(d?.last_state) && d.last_state.online === false)) return null
  const seen = rows.map((d) => d?.last_seen_at).filter((s) => typeof s === 'string' && Number.isFinite(Date.parse(s)))
  // A never-seen box (adopted while dark) has no outage to name: skipped.
  if (!seen.length) return null
  const lastSeen = seen.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a))
  return { rows, id: rows[0].id, lastSeen, lastSeenMs: Date.parse(lastSeen) }
}

/**
 * The alerts this location owes right now, as { kind, eventKey, payload }, in
 * send priority (key, offline, fault). Pure: the caller sends them.
 *
 * @param {{ locationId, conn, devices, nowMs, tz, keyRejected?, studioName?,
 *           deviceAlerts?, offlineHistory? }} input
 *   devices: the rows AS THEY STAND after this tick's state writes.
 *   deviceAlerts: false when no read landed this tick (review item 4): only
 *     the key alert is planned.
 *   offlineHistory: { pairs, recentIds } from readOfflineHistory.
 */
export function planShellyAlerts({
  locationId, conn, devices, nowMs, tz, keyRejected = false, studioName = null,
  deviceAlerts = true, offlineHistory = NO_HISTORY,
}) {
  const pushedPairs = offlineHistory?.pairs instanceof Set ? offlineHistory.pairs : NO_HISTORY.pairs
  const recentIds = offlineHistory?.recentIds instanceof Set ? offlineHistory.recentIds : NO_HISTORY.recentIds
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
  if (!deviceAlerts) return out

  const boxes = byBox(Array.isArray(devices) ? devices : [])

  // ---- offline, clustered per outage --------------------------------------
  const dark = boxes.map((rows, order) => { const b = darkBox(rows); return b && { ...b, order } })
    .filter((b) => b && nowMs - b.lastSeenMs <= OFFLINE_ALERT_WINDOW_MS
      && !pushedPairs.has(outageToken(b)) && !recentIds.has(b.id))
    .sort((a, b) => a.lastSeenMs - b.lastSeenMs)
  for (let i = 0; i < dark.length;) {
    const start = dark[i]
    const cluster = []
    while (i < dark.length && dark[i].lastSeenMs - start.lastSeenMs <= OFFLINE_CLUSTER_MS) cluster.push(dark[i++])
    if (nowMs - start.lastSeenMs < OFFLINE_AFTER_MS) continue
    const since = sinceLabel(start.lastSeen, nowMs, tz)
    const sinceText = since ? ` since ${since}` : ' for over 15 minutes'
    // Adoption order (the page's), not the order they fell; chunked so no
    // key names more than MAX_KEY_MEMBERS boxes.
    const ordered = [...cluster].sort((x, y) => x.order - y.order)
    for (let c = 0; c < ordered.length; c += MAX_KEY_MEMBERS) {
      const part = ordered.slice(c, c + MAX_KEY_MEMBERS)
      const eventKey = `shelly_offline:${locationId}:${part.map(outageToken).sort().join(',')}`
      if (part.length === 1) {
        out.push({
          kind: 'offline',
          eventKey,
          payload: {
            title: `Smart plug offline${at}`,
            body: `${boxName(part[0].rows)} has been offline${sinceText}.`,
            data: data('offline', { device_id: part[0].id }),
            category: 'shelly_alert',
          },
        })
        continue
      }
      const names = part.map((x) => rowName(x.rows[0]))
      const shown = names.length > NAMES_SHOWN + 1
        ? `${names.slice(0, NAMES_SHOWN).join(', ')} and ${names.length - NAMES_SHOWN} more`
        : listWords(names)
      out.push({
        kind: 'offline',
        eventKey,
        payload: {
          title: `Smart plugs offline${at}`,
          body: `${part.length} smart plugs offline${at}${sinceText}: ${shown}.`,
          data: data('offline'),
          category: 'shelly_alert',
        },
      })
    }
  }

  // ---- power fault: only from a box that is talking (a frozen offline
  // reading is not a fresh report; the offline alert covers that box).
  for (const rows of boxes) {
    const faulted = rows.filter((d) => isObj(d?.last_state) && d.last_state.online === true
      && Array.isArray(d.last_state.errors) && d.last_state.errors.some((e) => FAULT_WORDS[e]))
    if (!faulted.length) continue
    const faults = [...new Set(faulted.flatMap((d) => d.last_state.errors.filter((e) => FAULT_WORDS[e])))].sort()
    out.push({
      kind: 'fault',
      eventKey: `shelly_fault:${faulted[0].id}:${faults.join(',')}:${dayStrInTz(nowMs, tz)}`,
      payload: {
        title: `Smart plug power fault${at}`,
        body: `${boxName(faulted)} reported ${listWords(faults.map((f) => FAULT_WORDS[f]))} and may have switched off.`,
        data: data('fault', { device_id: faulted[0].id }),
        category: 'shelly_alert',
      },
    })
  }
  return out
}

/**
 * What the ledger says this studio was already told about offline boxes:
 * `pairs` (every `<id>@<lastSeenMs>` named in an offline key claimed in the
 * last OFFLINE_ALERT_WINDOW_MS, the window a box can still be pushed about)
 * and `recentIds` (box ids named under OFFLINE_COOLDOWN_MS ago). One read on
 * the ledger's sent_at index, then the key prefix. Never throws: a failed read
 * is logged and answered with no history, because a repeat push beats a lost
 * one.
 */
export async function readOfflineHistory(db, locationId, nowMs) {
  try {
    const { data, error } = await db
      .from('push_event_sends')
      .select('event_key, sent_at')
      .gte('sent_at', new Date(nowMs - OFFLINE_ALERT_WINDOW_MS).toISOString())
      .like('event_key', `shelly_offline:${escapeLikePattern(locationId)}:%`)
      // A day of one studio's offline claims is a handful of keys times its
      // owners and managers; 500 is far past that, and under the 1,000-row cap.
      .limit(500)
    if (error) {
      logWarn(MODULE, 'offline history read failed; no cool-down this tick', { locationId, error: error.message })
      return NO_HISTORY
    }
    const pairs = new Set()
    const recentIds = new Set()
    for (const r of data || []) {
      const recent = nowMs - Date.parse(r?.sent_at ?? '') < OFFLINE_COOLDOWN_MS
      for (const [id, ms] of outagesFromOfflineKey(r?.event_key)) {
        pairs.add(`${id}@${ms}`)
        if (recent) recentIds.add(id)
      }
    }
    return { pairs, recentIds }
  } catch (e) {
    logWarn(MODULE, 'offline history read failed; no cool-down this tick', { locationId, err: e?.message })
    return NO_HISTORY
  }
}

/**
 * Plan and send. Never throws.
 *
 * @param deps {{ send?, readRecipients?, readHistory? }}
 *   send(db, eventKey, ids, payload, { locationId }) defaults to sendPushOnce;
 *   readRecipients(db, locationId, roles) to readRoleRecipientIds;
 *   readHistory(db, locationId, nowMs) to readOfflineHistory.
 * @returns {{ alerts, sent, failed, attempted, deferred, recipients_failed? }}
 */
export async function runShellyAlerts(db, input, deps = {}) {
  const send = deps.send || sendPushOnce
  const readRecipients = deps.readRecipients || readRoleRecipientIds
  const readHistory = deps.readHistory || readOfflineHistory
  const counts = { alerts: 0, sent: 0, failed: 0, attempted: 0, deferred: 0 }
  const locationId = input?.locationId
  try {
    if (!Number.isFinite(input?.nowMs)) return counts
    const deviceAlerts = input.deviceAlerts !== false
    // The history read is spent only when some box has gone dark, and it can
    // never cost the key alert: a throw from an injected reader is caught here
    // and planned as "no history" (readOfflineHistory itself never throws).
    const anyDark = deviceAlerts && byBox(Array.isArray(input.devices) ? input.devices : [])
      .some((rows) => darkBox(rows) !== null)
    let offlineHistory = NO_HISTORY
    if (anyDark) {
      try {
        offlineHistory = await readHistory(db, locationId, input.nowMs)
      } catch (e) {
        logWarn(MODULE, 'offline history read failed; no cool-down this tick', { locationId, err: e?.message })
      }
    }
    const planned = planShellyAlerts({ ...input, deviceAlerts, offlineHistory })
    counts.alerts = planned.length
    if (!planned.length) return counts

    // ONCE per pass (review item 2).
    const { ids, error } = await readRecipients(db, locationId, ALERT_ROLES)
    if (error) {
      logWarn(MODULE, 'alert recipients read failed; nothing claimed, nobody told this tick', { locationId, error: error?.message ?? String(error) })
      return { ...counts, recipients_failed: 1 }
    }
    if (!ids?.length) return counts

    let fresh = 0
    for (const a of planned) {
      if (fresh >= MAX_NEW_SENDS || counts.attempted >= MAX_ATTEMPTS) { counts.deferred++; continue }
      counts.attempted++
      try {
        const r = await send(db, a.eventKey, ids, a.payload, { locationId })
        // A call the ledger fully deduped claimed nobody: it does not use up
        // the per-pass allowance, so a standing alert cannot starve a new one.
        if ((r?.deduped || 0) < ids.length) fresh++
        if ((r?.sent || 0) > 0) counts.sent++
        if ((r?.failed || 0) > 0) {
          counts.failed++
          logWarn(MODULE, 'alert push not delivered', {
            locationId, kind: a.kind, deviceId: a.payload.data.device_id ?? null, failed: r.failed,
          })
        }
      } catch (e) {
        fresh++
        counts.failed++
        logWarn(MODULE, 'alert push failed', { locationId, kind: a.kind, deviceId: a.payload.data.device_id ?? null, err: e?.message })
      }
    }
    return counts
  } catch (e) {
    logWarn(MODULE, 'alert pass failed', { locationId, err: e?.message })
    return counts
  }
}
