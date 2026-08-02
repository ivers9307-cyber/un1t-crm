// FLEET-ALERT.1 — pure decision logic for Raspberry Pi fleet health alerting.
// Spec: docs/superpowers/specs/2026-08-02-fleet-health-alerting-design.md
//
// The Stillorgan bridge died on 2026-07-16 and nobody noticed for 17 days;
// 1,186 heart-rate sessions were created with zero samples. BRIDGE-STATUS.1
// (#1193) fixed the badge that lied about it. This is the other half — the
// part that shouts, so nobody has to go and look.
//
// Everything here is pure and takes an injected clock, matching
// decideConnectionHealth() and src/lib/staff-devices.js. The cron route owns
// all IO.

import { deriveBridgeStatus } from '@/lib/bridge-samples'
import { isOvernight } from '@/lib/live-poll'

// Devices are identified as fleet members by this Tailscale ACL tag, set at
// provisioning time by un1t-pi (`tailscale up --advertise-tags=tag:un1t-pi`).
// Anything else on the tailnet — Richard's laptop, an ephemeral SSH-console
// node — is none of this cron's business.
export const FLEET_TAG = 'tag:un1t-pi'

// How long a device may be disconnected before it counts as an outage.
//
// THIS NUMBER IS LOAD-BEARING. Every Pi reboots at 04:00 by fleet standard,
// and provisioning ends with a power_state reboot. A reboot takes ~90s. Set
// this too tight and the cron pages six devices every single night; the alert
// gets muted within a week and the 17-day failure becomes possible again. An
// alert that cries wolf is worse than no alert.
//
// 15 minutes is an order of magnitude above a reboot while still catching a
// real outage inside a single class.
export const OFFLINE_AFTER_MS = 15 * 60 * 1000

// The same patience, applied to the bridge service.
//
// deriveBridgeStatus defaults to BRIDGE_ONLINE_WINDOW_MS (60s — two missed 30s
// heartbeats), which is right for a BADGE: a chip that reads offline for
// ninety seconds during a wifi blip costs nothing. It is wrong for an ALERT.
// At 60s a brief blip would push, email, and then send a recovery notice five
// minutes later, which is the cry-wolf behaviour OFFLINE_AFTER_MS exists to
// prevent — and it would arrive by the same channel, so it would poison the
// reachability alert's credibility too.
//
// So the badge and the alert share one predicate and differ only in patience:
// "is it online right now?" versus "has it been down long enough to wake
// someone?". A self-reported 'error' is exempt — that is a real state the
// bridge chose to report, not a timing artefact, so it alerts immediately.
export const SERVICE_DOWN_AFTER_MS = OFFLINE_AFTER_MS

// FLEET-CMD.2 — how long a kiosk may go without its board fetching data before
// the screen counts as dark.
//
// The board polls every 4s, backing off to 30s only overnight, so ten minutes
// is roughly twenty missed idle polls — far outside anything a wifi blip or the
// nightly reboot (~90s) produces, while still catching a black screen inside a
// single class.
export const RENDER_STALE_AFTER_MS = 10 * 60 * 1000

/** Is this Tailscale device part of the Pi fleet? */
export function isFleetDevice(device) {
  return Array.isArray(device?.tags) && device.tags.includes(FLEET_TAG)
}

/**
 * The device's fleet name — equal to its fleet.yaml name, because
 * provisioning sets the Tailscale hostname from it.
 *
 * Falls back to the first label of the MagicDNS name
 * ('stillorgan-tv2.tail23a156.ts.net.' -> 'stillorgan-tv2').
 */
export function deviceNameOf(device) {
  if (device?.hostname) return device.hostname
  const dns = device?.name
  if (typeof dns === 'string' && dns.length > 0) return dns.split('.')[0]
  return null
}

/**
 * Index `ble_bridges` rows by the Tailscale device they run on.
 *
 * These two identifiers are unrelated strings that merely look alike:
 *
 *   Tailscale hostname      'stillorgan-bridge'   set by un1t-pi provisioning
 *                                                 from the fleet.yaml name
 *   ble_bridges.hardware_id 'stillorgan-pi-hr'    typed by an operator, and
 *                                                 sent by the Pi to authenticate
 *
 * The live values do not match. Keying on hardware_id matched nothing and made
 * the service-health signal dead code that looked like it worked — caught only
 * by checking prod before merge. `tailscale_hostname` (mig 473) is the explicit
 * link; hardware_id remains a fallback for a fleet where an operator happened
 * to type the hostname there, which is a coincidence worth honouring but never
 * relying on.
 *
 * A bridge with neither is simply absent from the map, and its device is then
 * graded on reachability alone.
 *
 * @param {Array<object>} rows ble_bridges rows
 * @returns {Map<string, object>} device name -> bridge row
 */
export function indexBridgesByDevice(rows) {
  const byName = new Map()
  for (const row of rows || []) {
    // Fallback first so an explicit link always wins, whatever the row order.
    if (row?.hardware_id && !byName.has(row.hardware_id)) byName.set(row.hardware_id, row)
  }
  for (const row of rows || []) {
    if (row?.tailscale_hostname) byName.set(row.tailscale_hostname, row)
  }
  return byName
}

/**
 * Grade one device.
 *
 * Two independent signals, because either alone misses a real failure:
 *
 *   reachability — Tailscale's connectedToControl. Covers every Pi with zero
 *                  device-side code, including the kiosks, which report
 *                  nothing to the CRM at all.
 *
 *   service      — for bridges only, deriveBridgeStatus() over the ble_bridges
 *                  row. On 2026-08-02 a freshly provisioned Pi joined the
 *                  tailnet, answered SSH and reported cloud-init done, with no
 *                  bridge installed. Reachability alone calls that healthy.
 *
 * Reusing deriveBridgeStatus means this alert, the admin badge and the TV
 * connection dot cannot disagree with each other.
 *
 * NOTE on lastSeen: Tailscale includes it ONLY when connectedToControl is
 * false. Its absence on a connected device is the healthy signal, not
 * "never seen" — reading it the other way would alert on every healthy device.
 *
 * FLEET-CMD.2 adds a THIRD signal, for kiosks: `last_render_at`, stamped when
 * the TV's own board poll reaches the CRM. This is what finally sees the
 * failure mode the other two are blind to — a Pi that is powered, on the
 * tailnet, answering SSH, and showing nothing. Reachability says it is fine and
 * there is no bridge service to grade.
 *
 * A kiosk with last_render_at NULL is NOT graded on it. That is what makes this
 * ship dark: a screen provisioned before the device-tagged URL existed has
 * simply never reported, which is not the same as having stopped.
 *
 * @param {object} device      Tailscale device row
 * @param {object|null} bridgeRow  matching ble_bridges row, or null for a kiosk
 * @param {number} nowMs
 * @param {object|null} fleetRow   fleet_devices row (role + last_render_at)
 *
 * `connected` is deliberately separate from `state`. A device that dropped off
 * the tailnet 30 seconds ago grades 'ok' — that is the whole point of
 * OFFLINE_AFTER_MS — but it is NOT in contact, and FLEET-CMD.1's maintenance
 * window has to tell those apart. Clearing a shutdown window on 'ok' alone
 * would clear it during the first 15 minutes after the shutdown, guaranteeing
 * an alert at minute 16.
 *
 * @returns {{ name: string|null, state: 'ok'|'unreachable'|'service_down',
 *             detail: string, since: string|null, connected: boolean }}
 */
export function gradeDevice(device, bridgeRow, nowMs = Date.now(), fleetRow = null) {
  const name = deviceNameOf(device)

  if (device?.connectedToControl === false) {
    const lastSeenMs = Date.parse(device?.lastSeen ?? '')
    // An unparseable lastSeen on a disconnected device means we cannot say how
    // long it has been gone. Treat it as freshly gone rather than alerting on
    // a value we do not understand; the next tick will judge it properly.
    const downMs = Number.isFinite(lastSeenMs) ? nowMs - lastSeenMs : 0
    if (downMs >= OFFLINE_AFTER_MS) {
      return {
        name,
        state: 'unreachable',
        detail: `off the tailnet for ${Math.round(downMs / 60000)} min`,
        since: device.lastSeen ?? null,
        connected: false,
      }
    }
    // Inside the window — almost certainly the nightly reboot. Healthy for
    // alerting purposes, but not in contact.
    return { name, state: 'ok', detail: '', since: null, connected: false }
  }

  // Reachable. For a bridge, is the service actually doing anything?
  if (bridgeRow) {
    const status = deriveBridgeStatus(bridgeRow, nowMs, SERVICE_DOWN_AFTER_MS)
    if (status !== 'online') {
      return {
        name,
        state: 'service_down',
        detail: status === 'error'
          ? 'on the tailnet, and the bridge service is reporting an error'
          : 'on the tailnet but the bridge service has stopped reporting',
        since: bridgeRow.last_seen_at ?? null,
        connected: true,
      }
    }
  }

  // Reachable kiosk: is the board actually on screen?
  //
  // Reported as `service_down` rather than a new state, because that is exactly
  // what it means — on the tailnet, but the thing the device exists to do is
  // not happening. For a bridge that is the HR service; for a kiosk it is the
  // board. Same condition, different role, and it keeps the state vocabulary
  // (and mig 472's CHECK constraint) as it is.
  if (fleetRow?.role === 'kiosk' && fleetRow.last_render_at) {
    const lastMs = Date.parse(fleetRow.last_render_at)
    if (Number.isFinite(lastMs) && nowMs - lastMs >= RENDER_STALE_AFTER_MS) {
      return {
        name,
        state: 'service_down',
        detail: `on the tailnet but the screen has not drawn for ${
          Math.round((nowMs - lastMs) / 60000)} min`,
        since: fleetRow.last_render_at,
        connected: true,
        // A dark board at 04:00 is nobody's emergency, and the nightly fleet
        // reboot lives in that window. Grade it honestly — the admin page still
        // shows it down — but do not wake anyone until the studio opens.
        quiet: isOvernight(new Date(nowMs)),
      }
    }
  }

  return { name, state: 'ok', detail: '', since: null, connected: true }
}

/**
 * Is alerting currently suppressed for this device? (FLEET-CMD.1)
 *
 * Set when an operator issues a shutdown from /admin/fleet — the device is off
 * because somebody turned it off, and paging them about it would be the
 * cry-wolf behaviour this whole feature depends on avoiding.
 *
 * Postgres stores 'infinity' for a shutdown, which `new Date()` cannot parse
 * (it yields NaN), so it is checked explicitly. Any other unparseable value
 * also counts as suppressed: failing closed here means a stuck window goes
 * quiet, which is recoverable, while failing open would mean paging every five
 * minutes about a device somebody deliberately switched off.
 *
 * @param {{ suppressed_until?: string|null }|null} prior
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isSuppressed(prior, nowMs = Date.now()) {
  const until = prior?.suppressed_until
  if (!until) return false
  if (until === 'infinity') return true
  const at = new Date(until).getTime()
  if (!Number.isFinite(at)) return true
  return at > nowMs
}

/**
 * Decide what to do about a graded device, given what we last recorded.
 *
 * Alerting needs memory or the cron pages every five minutes forever. The
 * caller persists `row` to fleet_device_health and sends `alert` if set.
 *
 * @param {{ name: string, state: string, detail: string }} graded
 * @param {{ state: string, state_since: string, alerted_at: string|null,
 *           suppressed_until?: string|null }|null} prior
 * @param {number} nowMs
 * @returns {{ alert: 'down'|'recovered'|null, row: object }}
 */
export function decideAlert(graded, prior, nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString()
  const changed = prior?.state !== graded.state

  const row = {
    device_name: graded.name,
    state: graded.state,
    state_since: changed || !prior ? now : prior.state_since,
    alerted_at: prior?.alerted_at ?? null,
    last_checked: now,
    suppressed_until: prior?.suppressed_until ?? null,
  }

  // A maintenance window ends when the device is genuinely back in contact —
  // NOT merely when it grades healthy. Those differ for the first 15 minutes
  // after a shutdown, when the device is off but still inside OFFLINE_AFTER_MS
  // and therefore grading 'ok'. Clearing then would drop the window precisely
  // when it is needed, and the device would alert as soon as the patience
  // lapsed. This is how an 'infinity' shutdown window really ends: somebody
  // walked over and power-cycled the Pi, and it rejoined the tailnet.
  if (graded.connected) row.suppressed_until = null

  // Healthy and stayed healthy, or first sighting and healthy — no news.
  if (graded.state === 'ok') {
    if (prior?.alerted_at) {
      row.alerted_at = null
      return { alert: 'recovered', row }
    }
    // Never told anyone it was down (e.g. it flapped inside one tick), so
    // announcing a recovery would be noise.
    row.alerted_at = null
    return { alert: null, row }
  }

  // Unhealthy, but either an operator caused it or it is not worth waking
  // anyone for right now. Stay quiet, and deliberately do NOT stamp alerted_at:
  // nothing was sent, so when the window lapses (or the studio opens) while the
  // device is still down, the next tick alerts properly instead of believing
  // somebody had already been told.
  if (isSuppressed(prior, nowMs) || graded.quiet) {
    return { alert: null, row }
  }

  // Unhealthy. Alert on entering a bad state, or on moving between two
  // different bad states — service_down -> unreachable is new information.
  if (changed || !prior?.alerted_at) {
    row.alerted_at = now
    return { alert: 'down', row }
  }

  // Still down, already told them.
  return { alert: null, row }
}
