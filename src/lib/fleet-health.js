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
import { dublinTimeLabel } from '@/lib/dublin-time'

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

// ── BRIDGE-BLIND.1 — "online but blind" ─────────────────────────────
//
// 2026-08-12: the Stillorgan bridge heartbeated healthily for 2.5 hours and
// ingested ZERO samples across two full classes. Reachability said fine.
// deriveBridgeStatus said fine. Both were telling the truth — the process was
// alive and talking — and the gym recorded nothing all morning. The three
// signals above cover "is it there" and "is it running"; none of them covers
// "is it actually reading anything".
//
// Two new grades, of deliberately different strength:
//
//   adapter_down — the bridge SAYS a radio is not ready
//                  (adapters.ble.powered_on false, which is what a `noble
//                  state unauthorized` Pi reports, or adapters.ant
//                  .stick_present false). This is near-certain and would have
//                  caught the 08-12 defect on day one. It is a standing
//                  configuration fault, not an outage, so it is graded apart
//                  from service_down: the box is up and doing all it can, and
//                  it must alert ONCE, not once per class.
//
//   blind        — the weaker, inferential claim: a class is genuinely running
//                  right now, the radios look fine, and no heart-rate sample
//                  has landed. Consistent with a wedged scanner — and equally
//                  consistent with a class where nobody put a strap on. The
//                  copy therefore reports what was observed and asserts
//                  nothing about hardware.

// How far back "no samples have landed" looks. Long enough that a normal gap
// between decimated sample flushes cannot read as silence, short enough to
// catch a dead class inside its own hour.
export const SAMPLE_SILENCE_MS = 10 * 60 * 1000

// How far INTO a class we wait before the blind grade is allowed to fire.
//
// LOAD-BEARING, same argument as OFFLINE_AFTER_MS. Classes start with a
// warm-up, coaches pair straps in the first minutes, and `class_occurrences`
// carries the Glofox scheduled start, not the moment the room actually began.
// Firing at minute zero would page on the beginning of every single class.
// Ten minutes in, a class with zero samples is genuinely worth a look.
export const CLASS_GRACE_MS = 10 * 60 * 1000

// ── BRIDGE-UNDELIVERED.1 — "reading fine, cannot deliver" ────────
//
// The third failure, and the one every grade above certifies as HEALTHY. The
// bridge keeps heartbeating, `status` stays 'online', `last_seen_at` stays
// fresh, the radios report ready — and its local flush queue backs up because
// the samples are not reaching us (network path down, token rejected, /samples
// erroring). Reachability, service health, adapter health and blind all pass.
//
// It is also the only grade with a DEADLINE. champ-bridge buffers to
// BRIDGE_BUFFER_CAP and then drops the oldest sample per new one, so this is
// not "something is wrong somewhere" — it is "heart-rate data starts being
// destroyed at a rate we can compute". Everything below is set against that.
//
// And unlike `blind`, nothing here is inferred. The bridge is TELLING us it is
// holding data it could not send; we are only judging for how long.

// champ-bridge's MAX_BUFFER (`src/buffer.js`), mirrored so the alert copy can
// tell an operator how much runway is left.
//
// A MIRRORED CONSTANT, so say so: if champ-bridge changes MAX_BUFFER this
// number is wrong and nothing here will notice. It is used ONLY for copy and
// for the at-capacity wording — never as a gate — so drift makes a sentence
// inaccurate, it does not make the alert fire or not fire.
export const BRIDGE_BUFFER_CAP = 5000

// The floor a reported queue must clear before it counts as a BACKLOG rather
// than an ordinary flush in progress.
//
// LOAD-BEARING — this is what stops the grade firing on healthy busy classes.
// `pending_samples` is sampled at a heartbeat instant, and a working bridge is
// nearly always mid-cycle: it flushes every 3s (BATCH_INTERVAL_MS) while a
// full room of 30 straps pushes ~30 samples/s, so a perfectly healthy queue
// reads ~90 at any moment, and every reading in a busy hour can be non-zero
// purely by sampling luck. A marker armed on `> 0` would then be hours old
// during a normal class and time alone would alert on it.
//
// 1,000 is champ-bridge's SERVER_BATCH_CAP: exactly the number a single
// successful flush POST clears. So a queue at or above it has failed at least
// one whole round trip's worth of delivery — it cannot be reached by ordinary
// accumulation, which would need >333 straps in the room against a hard
// capacity of 30. It is also 20% of BRIDGE_BUFFER_CAP, so we are judging early
// in the runway rather than at the cliff.
//
// Known cost, accepted: a bridge chronically hovering either side of 1,000
// will flip ok <-> undelivered and re-alert on each crossing, because
// gradeDevice is pure and has no prior state to apply hysteresis with. A
// bridge permanently a thousand samples behind has earned the noise.
export const PENDING_BACKLOG_MIN = 1000

// How long the queue must have been continuously non-empty before we say so.
//
// LOAD-BEARING, same argument as OFFLINE_AFTER_MS — and unusually, the number
// is squeezed from BOTH sides, so here is the arithmetic rather than a feel.
//
// FROM BELOW, what makes it credible: the flush loop runs every 3s, so ten
// minutes of a continuously non-empty queue is ~200 consecutive failed flush
// attempts. Unlike a reboot (~90s) there is no benign event of that shape — a
// healthy bridge empties its buffer in a single POST. The fleet-health cron
// ticks every 5 min, so anything under that is not observable anyway.
//
// FROM ABOVE, the deadline: a stalled queue grows at the room's sample rate
// and the cap is BRIDGE_BUFFER_CAP, so time-to-first-dropped-sample is
// 5,000 / (straps × 1Hz):
//
//     30 straps   2.8 min      5 straps  16.7 min
//     10 straps   8.3 min      3 straps  27.8 min
//                              1 strap   83   min
//
// With a 5-minute cron the worst-case detection latency is threshold + 5 min.
// At 10 minutes that is 10-15 min, which lands BEFORE the first drop for the
// occupancies this studio actually runs — the 14-day measurement behind
// BRIDGE-BLIND.2 found only 17 of 84 classes had ANY strap at all, so the
// live rates are the bottom of that table, not the top.
//
// State the part we cannot fix rather than pretending: a FULL 30-strap room
// fills the buffer in 2.8 minutes, which no 5-minute cron can beat. Alerting
// after the first drop still beats the alternative — the samples already lost
// are gone either way, and every minute after that is more of them.
//
// 10 min also matches SAMPLE_SILENCE_MS / CLASS_GRACE_MS / RENDER_STALE_AFTER_MS:
// this file's unit for "long enough to be real, short enough to catch inside a
// single class".
export const PENDING_STUCK_AFTER_MS = 10 * 60 * 1000

// How far back the cron looks for heart-rate sessions to count samples
// against. Sessions open at the top of a class and can run long; a few hours of
// slack costs nothing (a location opens single-digit sessions per class) and
// removes any chance of missing the session a sample belongs to.
export const SESSION_LOOKBACK_MS = 6 * 60 * 60 * 1000

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
 * Which radios the bridge itself is reporting as not ready. (BRIDGE-BLIND.1)
 *
 * NULL/undefined is NOT a fault — it means a bridge on software older than
 * mig 531, or an adapter this box does not run. Reading absence as a fault
 * would alert on every bridge the moment this merged, which is the cry-wolf
 * behaviour the whole feature depends on avoiding. Only an explicit `false`
 * counts, because only an explicit `false` is the bridge telling us.
 *
 * @param {{ last_ant_ok?: boolean|null, last_ble_ok?: boolean|null }|null} bridgeRow
 * @returns {string[]} human-facing radio names, empty when nothing is wrong
 */
export function downAdapters(bridgeRow) {
  const down = []
  if (bridgeRow?.last_ant_ok === false) down.push('ANT+')
  if (bridgeRow?.last_ble_ok === false) down.push('Bluetooth')
  return down
}

/**
 * Deterministic thousands separator — no Intl, so the alert copy is a stable
 * string across Node ICU builds and the tests can assert it. Same reason
 * report-generator.js carries its own private copy; not worth a shared module
 * for one regex, and importing the report generator into fleet health would be
 * a worse dependency than duplicating it.
 */
function withThousands(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * The "reading fine, cannot deliver" line, or null when we must not make the
 * claim. (BRIDGE-UNDELIVERED.1)
 *
 * THREE conditions, all required, each closing a different way to be wrong:
 *
 *   marker is old enough      PENDING_STUCK_AFTER_MS — the queue has been
 *                             continuously non-empty long enough that the 3s
 *                             flush loop cannot explain it.
 *   queue is a real backlog   PENDING_BACKLOG_MIN — otherwise a healthy busy
 *                             class, whose queue is never observed empty, would
 *                             hold the marker open indefinitely and age into an
 *                             alert on nothing at all. See that constant.
 *   the bridge is STILL       the marker is only ever written by a heartbeat.
 *   saying it                 A bridge that stops reporting leaves it frozen,
 *                             and a frozen timestamp gets older on its own —
 *                             so age would keep "increasing" for a box that has
 *                             said nothing for a week. Requiring a fresh
 *                             `last_telemetry_at` means we alert on what the
 *                             bridge is claiming NOW, never on a stale claim.
 *                             (service_down outranks this anyway when the whole
 *                             bridge goes quiet; this covers the narrower case
 *                             of a bridge still touching last_seen_at while its
 *                             TELEMETRY has gone away — e.g. downgraded to
 *                             pre-mig-531 software.)
 *
 * NULL/unparseable anywhere returns null. As everywhere in this file, an
 * unknown must never terminate in an alert.
 *
 * @param {{ pending_stuck_since?: string|null, last_pending_samples?: number|null,
 *           last_telemetry_at?: string|null }|null} bridgeRow
 * @param {number} nowMs
 * @returns {string|null}
 */
export function undeliveredDetail(bridgeRow, nowMs = Date.now()) {
  const since = Date.parse(bridgeRow?.pending_stuck_since ?? '')
  if (!Number.isFinite(since)) return null

  const pending = bridgeRow?.last_pending_samples
  if (!Number.isFinite(pending) || pending < PENDING_BACKLOG_MIN) return null

  const toldAt = Date.parse(bridgeRow?.last_telemetry_at ?? '')
  if (!Number.isFinite(toldAt) || nowMs - toldAt > SERVICE_DOWN_AFTER_MS) return null

  const stuckMs = nowMs - since
  if (stuckMs < PENDING_STUCK_AFTER_MS) return null

  // Observation, then consequence, and no guess at the cause. We know the
  // bridge is holding samples and how long for; we do NOT know whether the
  // network is down, the token is being rejected, or the CRM is erroring, and
  // an alert that picks one sends someone to the wrong place.
  const consequence = pending >= BRIDGE_BUFFER_CAP
    ? `That is its whole ${withThousands(BRIDGE_BUFFER_CAP)}-sample buffer, so it is already dropping the oldest readings to make room.`
    : `It can hold ${withThousands(BRIDGE_BUFFER_CAP)} before it starts dropping the oldest, so heart-rate data will begin to be lost.`

  return `bridge online and reading straps, but it reports ${withThousands(pending)} sample${
    pending === 1 ? '' : 's'} it has not been able to send for ${
    Math.round(stuckMs / 60000)} min. ${consequence}`
}

/** 'CONVOY 09:30' — name plus Dublin wall-clock start, for an alert line. */
export function describeClass(occ) {
  const name = typeof occ?.name === 'string' && occ.name.trim()
    ? occ.name.trim()
    : (typeof occ?.program === 'string' && occ.program.trim() ? occ.program.trim() : 'a class')
  const at = dublinTimeLabel(occ?.starts_at)
  return at ? `${name} ${at}` : name
}

/**
 * How many straps the bridge could see in the silence window.
 *
 * `ble_bridges.last_seen_straps` (mig 111) is a whole-column overwrite on every
 * POST /api/bridge/scan, each entry stamped with the server time of that scan.
 * It costs no extra query and it is the difference between two very different
 * stories to tell an operator:
 *
 *   straps seen, no samples  — the radios are receiving and the data is not
 *                              arriving. Something is genuinely wrong.
 *   no straps seen           — either the radios are dead, or nobody in the
 *                              room is wearing one. We cannot tell which, and
 *                              the alert must not pretend otherwise.
 *
 * Reported, never used as a gate: gating on "straps seen" would have MISSED
 * the 08-12 incident outright, because a wedged scanner sees nothing either.
 *
 * @returns {number|null} count, or null when the column says nothing usable
 */
export function strapsSeenWithin(bridgeRow, windowMs, nowMs = Date.now()) {
  const straps = bridgeRow?.last_seen_straps
  if (!Array.isArray(straps)) return null
  let n = 0
  for (const s of straps) {
    const at = Date.parse(s?.seen_at ?? '')
    if (Number.isFinite(at) && nowMs - at <= windowMs) n++
  }
  return n
}

/**
 * The "online but blind" line, or null when we must not make the claim.
 *
 * Returns null — i.e. says nothing — whenever ANY of these is true, and each
 * one is a deliberate refusal rather than an oversight:
 *
 *   no class running          nobody expects samples outside a class
 *   class started < grace ago warm-up and strap pairing; see CLASS_GRACE_MS
 *   sample count unknown      the probe failed, or was never run. FAILS OPEN:
 *                             an unknown must never terminate in an alert
 *                             (same rule the sequence auto-exit checks follow)
 *   samples arrived           the bridge is demonstrably working
 *
 * @param {object|null} bridgeRow      ble_bridges row, for the strap evidence
 * @param {{ classNow: object|null, sampleCount: number|null }|null} visibility
 * @param {number} nowMs
 * @returns {string|null}
 */
export function blindDetail(bridgeRow, visibility, nowMs = Date.now()) {
  const occ = visibility?.classNow
  if (!occ) return null

  const count = visibility?.sampleCount
  if (!Number.isFinite(count) || count > 0) return null

  // THE DROPOUT REQUIREMENT (BRIDGE-BLIND.2, 2026-08-12 evening).
  //
  // The first cut of this grade fired on "class running + zero samples", which
  // measurement then showed to be the ORDINARY state of this studio: over the
  // 14 days to 2026-08-12, only 17 of 84 classes had ANY strap at all. That
  // predicate would have raised roughly five false alerts a day and trained
  // the reader to ignore the very channel that caught TV2's outage that
  // morning — a strictly worse outcome than no alert.
  //
  // So require evidence that straps WERE reporting in THIS class and then went
  // quiet. An empty room cannot produce that; a wedged scanner is exactly it.
  // The cost is honest and worth stating: a bridge that dies BETWEEN classes,
  // or before the first strap of a class connects, is not caught by this grade
  // — `adapter_down` and the unreachable/service_down grades carry that load.
  const prior = visibility?.priorCount
  if (!Number.isFinite(prior) || prior <= 0) return null

  const startMs = Date.parse(occ?.starts_at ?? '')
  if (!Number.isFinite(startMs)) return null
  const intoMs = nowMs - startMs
  if (intoMs < CLASS_GRACE_MS) return null

  const intoMin = Math.floor(intoMs / 60000)
  const windowMin = Math.round(SAMPLE_SILENCE_MS / 60000)
  const seen = strapsSeenWithin(bridgeRow, SAMPLE_SILENCE_MS, nowMs)

  // Still phrased as an observation. The dropout makes this a much stronger
  // claim than the original predicate, but "the last member took their strap
  // off early" remains a real, innocent explanation.
  const evidence = seen === null
    ? ''
    : seen > 0
      ? ` The bridge can still see ${seen} strap${seen === 1 ? '' : 's'}, so the readings are not reaching the CRM.`
      : ' The bridge can no longer see any strap either.'

  return `bridge online and was receiving heart-rate data earlier in ${
    describeClass(occ)} (${prior} sample${prior === 1 ? '' : 's'}), but nothing for the last ${
    windowMin} min while the class is still running (${intoMin} min in).${evidence}`
}

/**
 * Which locations are worth running the (blind) visibility probe for.
 *
 * Purely to avoid pointless queries: a bridge that is unreachable, silent, or
 * already admitting a dead radio has a truthful grade without asking the
 * database anything, and those grades all outrank `blind`. Lives here rather
 * than in the cron so the route holds no grading logic of its own — the two
 * could otherwise disagree about who gets probed and who gets graded.
 *
 * @param {Array<object>} fleet tagged Tailscale devices
 * @param {Map<string, object>} bridgeByName from indexBridgesByDevice
 * @param {number} nowMs
 * @returns {string[]} distinct location ids
 */
export function locationsNeedingVisibilityProbe(fleet, bridgeByName, nowMs = Date.now()) {
  const out = new Set()
  for (const device of fleet || []) {
    const name = deviceNameOf(device)
    if (!name) continue
    if (device?.connectedToControl === false) continue
    const row = bridgeByName?.get(name)
    if (!row?.location_id) continue
    if (deriveBridgeStatus(row, nowMs, SERVICE_DOWN_AFTER_MS) !== 'online') continue
    if (undeliveredDetail(row, nowMs)) continue
    if (downAdapters(row).length > 0) continue
    out.add(row.location_id)
  }
  return [...out]
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
 * BRIDGE-BLIND.1 adds a FOURTH and FIFTH, for bridges: the radios the bridge
 * reports (adapter_down) and whether any samples landed while a class was
 * actually running (blind). See the constants above for the incident.
 *
 * BRIDGE-UNDELIVERED.1 adds a SIXTH, also for bridges, and it is the one every
 * signal above certifies as healthy: the bridge is reachable, heartbeating and
 * reading straps, and the readings are piling up in its local buffer instead of
 * reaching us (undelivered). Graded from `pending_stuck_since` (mig 538).
 *
 * @param {object} device      Tailscale device row
 * @param {object|null} bridgeRow  matching ble_bridges row, or null for a kiosk
 * @param {number} nowMs
 * @param {object|null} fleetRow   fleet_devices row (role + last_render_at)
 * @param {{ classNow: object|null, sampleCount: number|null }|null} visibility
 *   what the cron observed at this bridge's location. NULL (probe skipped or
 *   failed) means the blind grade is simply not considered — never an alert.
 *
 * `connected` is deliberately separate from `state`. A device that dropped off
 * the tailnet 30 seconds ago grades 'ok' — that is the whole point of
 * OFFLINE_AFTER_MS — but it is NOT in contact, and FLEET-CMD.1's maintenance
 * window has to tell those apart. Clearing a shutdown window on 'ok' alone
 * would clear it during the first 15 minutes after the shutdown, guaranteeing
 * an alert at minute 16.
 *
 * @returns {{ name: string|null,
 *             state: 'ok'|'unreachable'|'service_down'|'undelivered'
 *                    |'adapter_down'|'blind',
 *             detail: string, since: string|null, connected: boolean }}
 */
export function gradeDevice(device, bridgeRow, nowMs = Date.now(), fleetRow = null, visibility = null) {
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

    // BRIDGE-UNDELIVERED.1 — the bridge is up and talking. Is what it reads
    // actually REACHING us?
    //
    // Ranked first of the three "online but not working" grades, and the
    // position is deliberate:
    //
    //   * It is the strongest claim available. adapter_down infers a fault
    //     from a flag; blind infers one from an absence of rows. This one is
    //     the bridge stating that it is holding data it could not deliver.
    //     The other two say "no data is being produced"; this says "data
    //     exists and we are losing it".
    //   * It is the only grade on a CLOCK. Every minute past the cap is more
    //     heart-rate data destroyed, so it must not sit behind a standing
    //     configuration fault. Ranking adapter_down first would mean a bridge
    //     with one dead radio reported ADAPTER for weeks while its other radio's
    //     readings drained away unmentioned — the two co-exist happily, and
    //     the wrong one would win every time.
    //   * It cannot be ranked above service_down: the marker is only ever
    //     written by a heartbeat, so a bridge that has gone quiet leaves a
    //     frozen timestamp that merely gets older. "Not talking" has to be
    //     settled first. (undeliveredDetail also demands a fresh
    //     last_telemetry_at, so this holds twice.)
    //
    // No flip-flop risk against adapter_down, which is what the equivalent
    // ordering note on that grade is about: these two do not alternate with
    // the class schedule. undelivered tracks delivery health only, so the one
    // bad->bad transition it can produce (delivery recovers, dead radio
    // remains) is a state change worth hearing about.
    const undelivered = undeliveredDetail(bridgeRow, nowMs)
    if (undelivered) {
      return {
        name,
        state: 'undelivered',
        detail: undelivered,
        since: bridgeRow.pending_stuck_since ?? null,
        connected: true,
        // Quiet overnight like the other two. The studio is shut, so nothing
        // new is being read and nothing new is being lost; and the 04:00 fleet
        // reboot restarts the process, which discards the in-memory buffer and
        // clears the marker on the next heartbeat. If it is still stuck at
        // opening, decideAlert has stamped nothing and the morning tick says so.
        quiet: isOvernight(new Date(nowMs)),
      }
    }

    // BRIDGE-BLIND.1 — is it READING anything?
    //
    // adapter_down is checked BEFORE blind, and the order is load-bearing.
    // When a radio is admittedly dead, "no samples during a class" is a
    // consequence of a fault we already know about, not news. Ranking blind
    // first would flip the state every class — adapter_down between them,
    // blind during them — and decideAlert re-alerts on every bad→bad
    // transition, so one known, unfixed fault would page twice a class,
    // forever. This way it pages once and then waits to be fixed.
    const down = downAdapters(bridgeRow)
    if (down.length > 0) {
      return {
        name,
        state: 'adapter_down',
        detail: `bridge online, but it reports its ${down.join(' and ')} radio${
          down.length > 1 ? 's are' : ' is'} not ready — it cannot read straps over ${
          down.join(' or ')}`,
        since: bridgeRow.last_telemetry_at ?? null,
        connected: true,
        // A dead radio at 03:00 is a job for the morning, and the alert lands
        // at opening because decideAlert deliberately does not stamp
        // alerted_at while quiet.
        quiet: isOvernight(new Date(nowMs)),
      }
    }

    const blind = blindDetail(bridgeRow, visibility, nowMs)
    if (blind) {
      return {
        name,
        state: 'blind',
        detail: blind,
        since: visibility?.classNow?.starts_at ?? null,
        connected: true,
        quiet: isOvernight(new Date(nowMs)),
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
