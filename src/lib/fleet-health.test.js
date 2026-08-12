import { describe, it, expect } from 'vitest'
import {
  OFFLINE_AFTER_MS,
  isFleetDevice,
  deviceNameOf,
  gradeDevice,
  decideAlert,
  isSuppressed,
  RENDER_STALE_AFTER_MS,
  indexBridgesByDevice,
  downAdapters,
  describeClass,
  strapsSeenWithin,
  locationsNeedingVisibilityProbe,
  CLASS_GRACE_MS,
  SAMPLE_SILENCE_MS,
} from './fleet-health.js'

// Tailscale's List Devices response shape. `lastSeen` is present ONLY when
// connectedToControl is false — absence of lastSeen on a connected device is
// the healthy signal, not "never seen".
const NOW = new Date('2026-08-02T12:00:00.000Z').getTime()
const ago = (ms) => new Date(NOW - ms).toISOString()

const online = (name, tags = ['tag:un1t-pi']) => ({
  name: `${name}.tail23a156.ts.net.`,
  hostname: name,
  tags,
  connectedToControl: true,
})

const offline = (name, sinceMs, tags = ['tag:un1t-pi']) => ({
  name: `${name}.tail23a156.ts.net.`,
  hostname: name,
  tags,
  connectedToControl: false,
  lastSeen: ago(sinceMs),
})

// ── device identity ──────────────────────────────────────────────

describe('isFleetDevice', () => {
  it('accepts a device carrying the fleet tag', () => {
    expect(isFleetDevice(online('stillorgan-tv1'))).toBe(true)
  })

  it('rejects devices outside the fleet', () => {
    // Richard's laptop is on the same tailnet and must never be alerted on.
    expect(isFleetDevice({ hostname: 'richards-laptop', tags: [] })).toBe(false)
    expect(isFleetDevice({ hostname: 'richards-laptop' })).toBe(false)
    expect(isFleetDevice(online('other', ['tag:something-else']))).toBe(false)
  })

  it('tolerates a malformed device row', () => {
    expect(isFleetDevice(null)).toBe(false)
    expect(isFleetDevice({})).toBe(false)
  })
})

describe('deviceNameOf', () => {
  it('prefers hostname, which matches the fleet.yaml device name', () => {
    expect(deviceNameOf(online('stillorgan-tv1'))).toBe('stillorgan-tv1')
  })

  it('falls back to the first label of the MagicDNS name', () => {
    expect(deviceNameOf({ name: 'stillorgan-tv2.tail23a156.ts.net.' })).toBe('stillorgan-tv2')
  })

  it('returns null when it cannot identify the device', () => {
    expect(deviceNameOf({})).toBe(null)
    expect(deviceNameOf(null)).toBe(null)
  })
})

// ── bridge → device mapping ──────────────────────────────────────

describe('indexBridgesByDevice', () => {
  // These are the REAL prod values as of 2026-08-02. The first version of this
  // feature keyed on hardware_id, which matches nothing — the service-health
  // half of the alert was dead code that looked like it worked. mig 473 added
  // the explicit link.
  const LIVE_ROW = {
    id: '9acc6318-0d73-4bbc-bd4d-c98b0f613179',
    name: 'Stillorgan Studio Bridge',
    hardware_id: 'stillorgan-pi-hr',
    tailscale_hostname: 'stillorgan-bridge',
  }

  it('maps the live bridge to the Tailscale device that actually runs it', () => {
    const map = indexBridgesByDevice([LIVE_ROW])
    expect(map.get('stillorgan-bridge')).toBe(LIVE_ROW)
  })

  it('does not rely on hardware_id resembling the hostname', () => {
    // The regression guard. hardware_id is an auth identifier an operator
    // typed; it is unrelated to the network name and the two do not match in
    // prod. If this ever passes by accident it is a coincidence, not a link.
    expect(deviceNameOf({ hostname: 'stillorgan-bridge' })).not.toBe(LIVE_ROW.hardware_id)
  })

  it('still honours hardware_id when it happens to be the hostname', () => {
    const row = { hardware_id: 'hatch-bridge', tailscale_hostname: null }
    expect(indexBridgesByDevice([row]).get('hatch-bridge')).toBe(row)
  })

  it('lets an explicit link win over another row using it as hardware_id', () => {
    // Row order must not decide this.
    const linked = { id: 'a', hardware_id: 'x', tailscale_hostname: 'stillorgan-bridge' }
    const collides = { id: 'b', hardware_id: 'stillorgan-bridge', tailscale_hostname: null }
    expect(indexBridgesByDevice([linked, collides]).get('stillorgan-bridge')).toBe(linked)
    expect(indexBridgesByDevice([collides, linked]).get('stillorgan-bridge')).toBe(linked)
  })

  it('omits a bridge with no usable key, leaving it graded on reachability', () => {
    expect(indexBridgesByDevice([{ id: 'c' }]).size).toBe(0)
  })

  it('tolerates missing input', () => {
    expect(indexBridgesByDevice(null).size).toBe(0)
    expect(indexBridgesByDevice([]).size).toBe(0)
  })
})

// ── grading ──────────────────────────────────────────────────────

describe('gradeDevice', () => {
  it('grades a connected device ok', () => {
    const g = gradeDevice(online('stillorgan-tv1'), null, NOW)
    expect(g.state).toBe('ok')
    expect(g.name).toBe('stillorgan-tv1')
  })

  it('does not treat a missing lastSeen as never-seen', () => {
    // Tailscale omits lastSeen entirely while connectedToControl is true.
    // Reading absence as "never seen" would alert on every healthy device.
    const device = online('stillorgan-tv2')
    expect(device.lastSeen).toBeUndefined()
    expect(gradeDevice(device, null, NOW).state).toBe('ok')
  })

  it('tolerates a nightly reboot without alerting', () => {
    // THE most important case here. Every Pi reboots at 04:00 by fleet
    // standard and provisioning ends with a power_state reboot. A reboot takes
    // ~90s. An alert that fires six times a night gets muted within a week,
    // and then the 17-day failure is possible again.
    expect(gradeDevice(offline('stillorgan-tv1', 90 * 1000), null, NOW).state).toBe('ok')
    expect(gradeDevice(offline('stillorgan-tv1', 5 * 60 * 1000), null, NOW).state).toBe('ok')
  })

  it('grades a device offline past the threshold as unreachable', () => {
    const g = gradeDevice(offline('stillorgan-tv1', 20 * 60 * 1000), null, NOW)
    expect(g.state).toBe('unreachable')
    expect(g.since).toBe(ago(20 * 60 * 1000))
  })

  it('grades a reachable bridge with a stale heartbeat as service_down', () => {
    // The 2026-08-02 failure: a freshly provisioned Pi joined the tailnet,
    // answered SSH and reported cloud-init done — with no bridge installed.
    // Reachability alone calls that healthy.
    const bridgeRow = { status: 'online', last_seen_at: ago(17 * 24 * 60 * 60 * 1000) }
    const g = gradeDevice(online('stillorgan-bridge'), bridgeRow, NOW)
    expect(g.state).toBe('service_down')
    expect(g.detail).toMatch(/bridge/i)
  })

  it('grades a reachable bridge with a fresh heartbeat as ok', () => {
    const bridgeRow = { status: 'online', last_seen_at: ago(10 * 1000) }
    expect(gradeDevice(online('stillorgan-bridge'), bridgeRow, NOW).state).toBe('ok')
  })

  it('rides out a brief heartbeat gap instead of alerting on it', () => {
    // deriveBridgeStatus defaults to a 60s window, which is right for a BADGE
    // and far too twitchy for an ALERT: a 3-minute wifi blip would push, email,
    // and then send a recovery notice, by the same channel that carries the
    // reachability alert. This is the cry-wolf guard on the service signal.
    const blip = { status: 'online', last_seen_at: ago(3 * 60 * 1000) }
    expect(gradeDevice(online('stillorgan-bridge'), blip, NOW).state).toBe('ok')
  })

  it('alerts immediately on a self-reported error, without waiting out the window', () => {
    // An 'error' is a state the bridge deliberately reported while still
    // heartbeating — real information, not a timing artefact.
    const erroring = { status: 'error', last_seen_at: ago(10 * 1000) }
    const g = gradeDevice(online('stillorgan-bridge'), erroring, NOW)
    expect(g.state).toBe('service_down')
    expect(g.detail).toMatch(/error/i)
  })

  it('reports unreachable ahead of service_down when both are true', () => {
    // A powered-off bridge is unreachable AND has a stale heartbeat. Saying
    // "unreachable" is the more useful, more actionable of the two.
    const bridgeRow = { status: 'online', last_seen_at: ago(60 * 60 * 1000) }
    expect(gradeDevice(offline('stillorgan-bridge', 60 * 60 * 1000), bridgeRow, NOW).state)
      .toBe('unreachable')
  })

  it('does not grade a kiosk on service health, having no signal for it', () => {
    // Kiosks report nothing to the CRM. A kiosk that is up with a dead browser
    // reads ok — an accepted gap, documented in the spec.
    expect(gradeDevice(online('stillorgan-tv1'), null, NOW).state).toBe('ok')
  })
})

// ── alert decisions ──────────────────────────────────────────────

describe('decideAlert', () => {
  const bad = { name: 'stillorgan-tv1', state: 'unreachable', detail: 'offline 20m' }
  const good = { name: 'stillorgan-tv1', state: 'ok', detail: '' }

  it('alerts the first time a device goes bad', () => {
    const d = decideAlert(bad, null, NOW)
    expect(d.alert).toBe('down')
    expect(d.row.state).toBe('unreachable')
    expect(d.row.alerted_at).toBe(new Date(NOW).toISOString())
  })

  it('does not alert again while the device stays bad', () => {
    const prior = { state: 'unreachable', state_since: ago(60 * 60 * 1000), alerted_at: ago(60 * 60 * 1000) }
    const d = decideAlert(bad, prior, NOW)
    expect(d.alert).toBe(null)
    expect(d.row.state_since).toBe(prior.state_since)
    expect(d.row.alerted_at).toBe(prior.alerted_at)
  })

  it('alerts recovery and clears the stamp so the next outage alerts again', () => {
    const prior = { state: 'unreachable', state_since: ago(60 * 60 * 1000), alerted_at: ago(60 * 60 * 1000) }
    const d = decideAlert(good, prior, NOW)
    expect(d.alert).toBe('recovered')
    expect(d.row.state).toBe('ok')
    expect(d.row.alerted_at).toBe(null)
  })

  it('stays silent for a device that was already ok', () => {
    const prior = { state: 'ok', state_since: ago(24 * 60 * 60 * 1000), alerted_at: null }
    expect(decideAlert(good, prior, NOW).alert).toBe(null)
  })

  it('does not announce recovery for a device that never alerted', () => {
    // Went bad, came back inside one 5-minute tick — nobody was ever told it
    // was down, so telling them it recovered is noise.
    const prior = { state: 'unreachable', state_since: ago(60 * 1000), alerted_at: null }
    const d = decideAlert(good, prior, NOW)
    expect(d.alert).toBe(null)
    expect(d.row.state).toBe('ok')
  })

  it('re-alerts when a device changes from one bad state to another', () => {
    // service_down → unreachable is new information worth sending.
    const prior = { state: 'service_down', state_since: ago(60 * 60 * 1000), alerted_at: ago(60 * 60 * 1000) }
    const d = decideAlert(bad, prior, NOW)
    expect(d.alert).toBe('down')
    expect(d.row.state_since).toBe(new Date(NOW).toISOString())
  })

  it('treats a first sighting that is healthy as no news', () => {
    const d = decideAlert(good, null, NOW)
    expect(d.alert).toBe(null)
    expect(d.row.state).toBe('ok')
  })

  it('always advances last_checked', () => {
    const prior = { state: 'ok', state_since: ago(60 * 60 * 1000), alerted_at: null }
    expect(decideAlert(good, prior, NOW).row.last_checked).toBe(new Date(NOW).toISOString())
  })
})

describe('OFFLINE_AFTER_MS', () => {
  it('is comfortably longer than a Pi reboot', () => {
    // A reboot is ~90s. Anything under a few minutes flaps nightly.
    expect(OFFLINE_AFTER_MS).toBeGreaterThan(5 * 60 * 1000)
  })

  it('is short enough to catch an outage within a class', () => {
    expect(OFFLINE_AFTER_MS).toBeLessThanOrEqual(30 * 60 * 1000)
  })
})

// FLEET-CMD.1 — the maintenance window.
//
// reboot deliberately has NO window: OFFLINE_AFTER_MS is already 15 minutes,
// so a healthy ~90s reboot never grades unreachable, and a reboot that hangs
// past 15 minutes is a real outage worth paging for. Shutdown is the whole
// reason this exists.
describe('alert suppression', () => {
  const down = { name: 'stillorgan-tv2', state: 'unreachable', detail: 'offline', connected: false }
  // Genuinely back on the tailnet.
  const backOnline = { name: 'stillorgan-tv2', state: 'ok', detail: '', connected: true }
  // Powered off, but still inside OFFLINE_AFTER_MS — grades healthy, NOT in contact.
  const freshlyOff = { name: 'stillorgan-tv2', state: 'ok', detail: '', connected: false }

  describe('isSuppressed', () => {
    it('is false with no window', () => {
      expect(isSuppressed(null, NOW)).toBe(false)
      expect(isSuppressed({}, NOW)).toBe(false)
      expect(isSuppressed({ suppressed_until: null }, NOW)).toBe(false)
    })

    it('handles the infinity a shutdown writes', () => {
      // new Date('infinity') is NaN, so this has to be checked by hand.
      expect(isSuppressed({ suppressed_until: 'infinity' }, NOW)).toBe(true)
    })

    it('expires', () => {
      const until = new Date(NOW + 1000).toISOString()
      expect(isSuppressed({ suppressed_until: until }, NOW)).toBe(true)
      expect(isSuppressed({ suppressed_until: until }, NOW + 2000)).toBe(false)
    })

    it('fails closed on a value it cannot parse', () => {
      // Quiet is recoverable; paging every 5 minutes about a device somebody
      // deliberately switched off is what gets alerting muted for good.
      expect(isSuppressed({ suppressed_until: 'not-a-date' }, NOW)).toBe(true)
    })
  })

  it('stays silent about an outage the operator caused', () => {
    const prior = { state: 'ok', state_since: ago(60000), alerted_at: null, suppressed_until: 'infinity' }
    const { alert, row } = decideAlert(down, prior, NOW)
    expect(alert).toBeNull()
    // Still records the truth — a suppressed device reads as down in the UI.
    // Hiding the grade would be the lie BRIDGE-STATUS.1 existed to fix.
    expect(row.state).toBe('unreachable')
    expect(row.suppressed_until).toBe('infinity')
  })

  it('does not stamp alerted_at while suppressed', () => {
    // Load-bearing: stamping would make a later tick think somebody had
    // already been told, and the alert would never fire.
    const prior = { state: 'unreachable', state_since: ago(60000), alerted_at: null, suppressed_until: 'infinity' }
    const { row } = decideAlert(down, prior, NOW)
    expect(row.alerted_at).toBeNull()
  })

  it('alerts once a timed window lapses on a still-dead device', () => {
    const prior = {
      state: 'unreachable',
      state_since: ago(20 * 60 * 1000),
      alerted_at: null,
      suppressed_until: new Date(NOW - 1000).toISOString(),
    }
    const { alert } = decideAlert(down, prior, NOW)
    expect(alert).toBe('down')
  })

  it('clears the window when the device comes back', () => {
    // This is how an infinity shutdown window ends: somebody power-cycles it.
    const prior = { state: 'unreachable', state_since: ago(60000), alerted_at: null, suppressed_until: 'infinity' }
    const { alert, row } = decideAlert(backOnline, prior, NOW)
    expect(row.suppressed_until).toBeNull()
    // No recovery notice, because no outage notice was ever sent.
    expect(alert).toBeNull()
  })

  it('keeps the window through the patience period after a shutdown', () => {
    // THE BUG THIS PINS: for the first 15 minutes after a shutdown the device
    // is off but still inside OFFLINE_AFTER_MS, so gradeDevice returns 'ok'.
    // Clearing the window on a healthy GRADE (rather than on real contact)
    // dropped it exactly then, and the device alerted the moment the patience
    // lapsed — a suppression that looked like it worked while guaranteeing the
    // alert it was meant to prevent.
    const prior = { state: 'ok', state_since: ago(60000), alerted_at: null, suppressed_until: 'infinity' }
    const { alert, row } = decideAlert(freshlyOff, prior, NOW)
    expect(row.suppressed_until).toBe('infinity')
    expect(alert).toBeNull()
  })

  it('leaves an ordinary outage alerting exactly as before', () => {
    const prior = { state: 'ok', state_since: ago(60000), alerted_at: null, suppressed_until: null }
    const { alert, row } = decideAlert(down, prior, NOW)
    expect(alert).toBe('down')
    expect(row.alerted_at).toBe(new Date(NOW).toISOString())
  })
})

// FLEET-CMD.2 — the render heartbeat.
//
// This closes the blind spot that mattered most: a Pi that is powered, on the
// tailnet, answering SSH, and showing a black screen graded `ok`, because
// reachability is fine and a kiosk has no bridge service to grade.
describe('kiosk render heartbeat', () => {
  const kiosk = online('stillorgan-tv1')
  const stale = (ms) => ({ role: 'kiosk', last_render_at: new Date(NOW - ms).toISOString() })

  it('grades a reachable kiosk with a dark screen as service_down', () => {
    const g = gradeDevice(kiosk, null, NOW, stale(RENDER_STALE_AFTER_MS))
    expect(g.state).toBe('service_down')
    expect(g.detail).toMatch(/has not drawn/)
    // Still genuinely in contact — this is NOT a reachability problem, and the
    // maintenance window must not be cleared or held on the wrong signal.
    expect(g.connected).toBe(true)
  })

  it('leaves a freshly drawing kiosk alone', () => {
    expect(gradeDevice(kiosk, null, NOW, stale(30_000)).state).toBe('ok')
    expect(gradeDevice(kiosk, null, NOW, stale(RENDER_STALE_AFTER_MS - 1)).state).toBe('ok')
  })

  it('SHIPS DARK: a kiosk that has never reported is graded on reachability only', () => {
    // Load-bearing. Every existing kiosk has last_render_at NULL until it is
    // redeployed with the device-tagged URL; if null counted as stale, merging
    // this would alert on the whole fleet at once.
    expect(gradeDevice(kiosk, null, NOW, { role: 'kiosk', last_render_at: null }).state).toBe('ok')
    expect(gradeDevice(kiosk, null, NOW, null).state).toBe('ok')
  })

  it('never applies the render signal to a bridge', () => {
    // A bridge runs no browser, so a null/ancient render time means nothing.
    const g = gradeDevice(online('stillorgan-bridge'), null, NOW,
      { role: 'bridge', last_render_at: new Date(NOW - 86_400_000).toISOString() })
    expect(g.state).toBe('ok')
  })

  it('grades a dark screen overnight but does NOT wake anyone', () => {
    // 03:00 Dublin: the gym is shut, nobody is looking at the board, and the
    // 04:00 fleet reboot lives in this window. The row still records the truth
    // — the admin page shows it down — but the alert waits for opening time.
    const night = new Date('2026-08-02T02:00:00.000Z').getTime()
    const g = gradeDevice(kiosk, null, night, {
      role: 'kiosk', last_render_at: new Date(night - RENDER_STALE_AFTER_MS).toISOString(),
    })
    expect(g.state).toBe('service_down')
    expect(g.quiet).toBe(true)

    const { alert, row } = decideAlert(g, null, night)
    expect(alert).toBeNull()
    expect(row.state).toBe('service_down')
    // Nothing was sent, so nothing may claim it was — otherwise the 06:00 tick
    // would think somebody had already been told and stay silent for good.
    expect(row.alerted_at).toBeNull()
  })

  it('alerts on the same dark screen during opening hours', () => {
    const g = gradeDevice(kiosk, null, NOW, stale(RENDER_STALE_AFTER_MS))
    expect(g.quiet).toBe(false)
    expect(decideAlert(g, null, NOW).alert).toBe('down')
  })

  it('does not let a dark screen mask an outright outage', () => {
    // Unreachable wins: the device being gone is the bigger fact, and its
    // detail line is the one an operator needs.
    const g = gradeDevice(offline('stillorgan-tv1', 60 * 60 * 1000), null, NOW,
      stale(60 * 60 * 1000))
    expect(g.state).toBe('unreachable')
  })
})

// ── BRIDGE-BLIND.1 — "online but blind" ──────────────────────────
//
// 2026-08-12, Stillorgan: the bridge heartbeated healthily for 2.5 hours and
// ingested ZERO samples across two full classes. The process was alive, so
// every signal above graded it `ok` — and every one of them was telling the
// truth. These are the two grades that would have caught it.

describe('adapter_down — the bridge says a radio is not ready', () => {
  const bridge = online('stillorgan-bridge')
  const fresh = (extra) => ({ status: 'online', last_seen_at: ago(10 * 1000), ...extra })

  it('grades a bridge reporting powered_on false — the 2026-08-12 defect', () => {
    // `noble state unauthorized` on the Pi surfaces as exactly this. It was on
    // every heartbeat for 2.5 hours and the CRM discarded the payload.
    const g = gradeDevice(bridge, fresh({ last_ble_ok: false, last_ant_ok: true }), NOW)
    expect(g.state).toBe('adapter_down')
    expect(g.detail).toMatch(/Bluetooth/)
    expect(g.detail).not.toMatch(/ANT/)
    // On the tailnet and talking — this is a box to configure, not a box to
    // go and find, and the maintenance window must not be cleared on it.
    expect(g.connected).toBe(true)
  })

  it('grades a wedged ANT+ stick, and names both radios when both are down', () => {
    expect(gradeDevice(bridge, fresh({ last_ant_ok: false }), NOW).detail).toMatch(/ANT\+/)
    const both = gradeDevice(bridge, fresh({ last_ant_ok: false, last_ble_ok: false }), NOW)
    expect(both.detail).toMatch(/ANT\+ and Bluetooth/)
    expect(both.detail).toMatch(/radios are not ready/)
  })

  it('SHIPS DARK: never-reported adapters are NOT a fault', () => {
    // Load-bearing, exactly as for fleet_devices.last_render_at. Every bridge
    // has these NULL until it is on software that sends telemetry; if NULL
    // graded as a fault, merging this would alert on the whole fleet at once.
    expect(gradeDevice(bridge, fresh({}), NOW).state).toBe('ok')
    expect(gradeDevice(bridge, fresh({ last_ant_ok: null, last_ble_ok: null }), NOW).state).toBe('ok')
  })

  it('leaves a healthy pair alone', () => {
    expect(gradeDevice(bridge, fresh({ last_ant_ok: true, last_ble_ok: true }), NOW).state).toBe('ok')
  })

  it('does not outrank a bridge that is unreachable or silent', () => {
    // Being gone is the bigger, more actionable fact; so is a stopped service.
    const dead = { status: 'online', last_seen_at: ago(60 * 60 * 1000), last_ble_ok: false }
    expect(gradeDevice(offline('stillorgan-bridge', 60 * 60 * 1000), dead, NOW).state).toBe('unreachable')
    expect(gradeDevice(bridge, dead, NOW).state).toBe('service_down')
  })

  it('alerts once and then stays quiet while the fault persists', () => {
    // A standing configuration fault. Paging every 5 minutes about a box
    // nobody has got to yet is how alerting gets muted.
    const g = gradeDevice(bridge, fresh({ last_ble_ok: false }), NOW)
    const first = decideAlert(g, null, NOW)
    expect(first.alert).toBe('down')
    expect(decideAlert(g, first.row, NOW + 5 * 60 * 1000).alert).toBe(null)
    expect(decideAlert(g, first.row, NOW + 6 * 60 * 60 * 1000).alert).toBe(null)
  })

  it('is quiet overnight, and lands at opening time instead', () => {
    const night = new Date('2026-08-02T02:00:00.000Z').getTime()
    const g = gradeDevice(bridge, { status: 'online', last_seen_at: new Date(night - 10_000).toISOString(), last_ble_ok: false }, night)
    expect(g.state).toBe('adapter_down')
    expect(g.quiet).toBe(true)

    const { alert, row } = decideAlert(g, null, night)
    expect(alert).toBe(null)
    // Nothing was sent, so nothing claims it was — the morning tick alerts.
    expect(row.alerted_at).toBe(null)

    const morning = gradeDevice(bridge, { status: 'online', last_seen_at: ago(10 * 1000), last_ble_ok: false }, NOW)
    expect(decideAlert(morning, row, NOW).alert).toBe('down')
  })
})

describe('downAdapters', () => {
  it('reports only explicit falses', () => {
    expect(downAdapters({ last_ant_ok: false, last_ble_ok: true })).toEqual(['ANT+'])
    expect(downAdapters({ last_ant_ok: false, last_ble_ok: false })).toEqual(['ANT+', 'Bluetooth'])
    expect(downAdapters({})).toEqual([])
    expect(downAdapters(null)).toEqual([])
    expect(downAdapters({ last_ble_ok: null })).toEqual([])
    // A stray non-boolean is not a fault either.
    expect(downAdapters({ last_ble_ok: 0 })).toEqual([])
  })
})

describe('blind — a class is running and nothing is landing', () => {
  const bridge = online('stillorgan-bridge')
  const healthy = (extra) => ({
    status: 'online', last_seen_at: ago(10 * 1000),
    last_ant_ok: true, last_ble_ok: true, last_seen_straps: [], ...extra,
  })
  // 09:30 Dublin on the NOW day, so the label in the alert copy is stable.
  const classAt = (startedMsAgo) => ({
    name: 'CONVOY',
    starts_at: ago(startedMsAgo),
    ends_at: new Date(NOW + 30 * 60 * 1000).toISOString(),
  })
  // priorCount defaults to 8 — straps WERE reporting earlier in this class,
  // which is what makes zero-now a dropout rather than an empty room.
  const during = (startedMsAgo, sampleCount, priorCount = 8) =>
    ({ classNow: classAt(startedMsAgo), sampleCount, priorCount })

  it('fires when a class is well underway and no sample has landed', () => {
    const g = gradeDevice(bridge, healthy(), NOW, null, during(12 * 60 * 1000, 0))
    expect(g.state).toBe('blind')
    expect(g.detail).toMatch(/nothing for the last 10 min/)
    expect(g.detail).toMatch(/was receiving heart-rate data earlier/)
    expect(g.detail).toMatch(/CONVOY/)
    expect(g.detail).toMatch(/12 min in/)
    expect(g.connected).toBe(true)
  })

  it('states what was observed and does not assert a hardware failure', () => {
    // A class where genuinely nobody wears a strap reads identically. The copy
    // has to be honest about that or the alert stops being believed.
    const g = gradeDevice(bridge, healthy(), NOW, null, during(12 * 60 * 1000, 0))
    // No verb that asserts a defect...
    expect(g.detail).not.toMatch(/\b(has (failed|died|stopped)|is (broken|faulty|down|offline))\b/i)
    // ...and an explicit statement that the two explanations are indistinguishable.
    expect(g.detail).toMatch(/can no longer see any strap either/)
  })

  it('says so when the bridge CAN see straps — then the data is not reaching us', () => {
    const seen = healthy({
      last_seen_straps: [
        { device_key: 'ant:123', seen_at: ago(20 * 1000) },
        { device_key: 'ble:AA', seen_at: ago(20 * 1000) },
      ],
    })
    const g = gradeDevice(bridge, seen, NOW, null, during(15 * 60 * 1000, 0))
    expect(g.detail).toMatch(/can still see 2 straps/)
    expect(g.detail).toMatch(/not reaching the CRM/)
  })

  it('ignores a stale strap snapshot from before the window', () => {
    const stale = healthy({ last_seen_straps: [{ seen_at: ago(6 * 60 * 60 * 1000) }] })
    expect(gradeDevice(bridge, stale, NOW, null, during(15 * 60 * 1000, 0)).detail)
      .toMatch(/can no longer see any strap either/)
  })

  it('does NOT fire when no class is running', () => {
    // The gym is quiet. Nobody expects samples, and this cron must not invent
    // an outage out of an empty room.
    expect(gradeDevice(bridge, healthy(), NOW, null, { classNow: null, sampleCount: null, priorCount: null }).state).toBe('ok')
    expect(gradeDevice(bridge, healthy(), NOW, null, { classNow: null, sampleCount: 0, priorCount: 0 }).state).toBe('ok')
  })

  // BRIDGE-BLIND.2 regression — the false positive this grade actually
  // produced on its first evening (2026-08-12). Over the preceding 14 days
  // only 17 of 84 classes had ANY strap, so "class running + zero samples" is
  // the ORDINARY reading here, not a fault. Without the dropout requirement
  // this fired ~5x a day and would have trained the reader to ignore the
  // channel that had caught TV2's outage that same morning.
  it('does NOT fire when nobody wore a strap all class (the ordinary case)', () => {
    const g = gradeDevice(bridge, healthy(), NOW, null, during(45 * 60 * 1000, 0, 0))
    expect(g.state).toBe('ok')
  })

  it('does NOT fire when the prior-sample count is unknown', () => {
    // A failed/oddly-shaped count must never be read as "straps were flowing".
    const g = gradeDevice(bridge, healthy(), NOW, null, during(45 * 60 * 1000, 0, null))
    expect(g.state).toBe('ok')
  })

  it('does NOT fire inside the warm-up grace', () => {
    // Classes begin with a warm-up and coaches pair straps in the first
    // minutes; class_occurrences carries the SCHEDULED start, not the moment
    // the room actually began. Firing at minute zero would page on every class.
    expect(gradeDevice(bridge, healthy(), NOW, null, during(60 * 1000, 0)).state).toBe('ok')
    expect(gradeDevice(bridge, healthy(), NOW, null, during(CLASS_GRACE_MS - 1, 0)).state).toBe('ok')
    expect(gradeDevice(bridge, healthy(), NOW, null, during(CLASS_GRACE_MS, 0)).state).toBe('blind')
  })

  it('does NOT fire when samples are arriving', () => {
    expect(gradeDevice(bridge, healthy(), NOW, null, during(30 * 60 * 1000, 1)).state).toBe('ok')
    expect(gradeDevice(bridge, healthy(), NOW, null, during(30 * 60 * 1000, 4212)).state).toBe('ok')
  })

  it('FAILS OPEN when the sample count is unknown', () => {
    // The probe threw, or was never run. An unknown must never terminate in an
    // alert — the same rule the sequence auto-exit checks follow.
    expect(gradeDevice(bridge, healthy(), NOW, null, during(30 * 60 * 1000, null)).state).toBe('ok')
    expect(gradeDevice(bridge, healthy(), NOW, null, null).state).toBe('ok')
    expect(gradeDevice(bridge, healthy(), NOW, null, undefined).state).toBe('ok')
  })

  it('ignores an unparseable class start rather than guessing', () => {
    const g = gradeDevice(bridge, healthy(), NOW, null,
      { classNow: { name: 'CONVOY', starts_at: 'nonsense' }, sampleCount: 0, priorCount: 8 })
    expect(g.state).toBe('ok')
  })

  it('never applies to a kiosk, which has no bridge to be blind', () => {
    expect(gradeDevice(online('stillorgan-tv1'), null, NOW, { role: 'kiosk', last_render_at: ago(1000) },
      during(30 * 60 * 1000, 0)).state).toBe('ok')
  })

  it('yields to adapter_down, which is the root cause and not a guess', () => {
    // Ranking blind first would flip the state every class — adapter_down
    // between them, blind during them — and decideAlert re-alerts on every
    // bad→bad transition. One known fault would page twice a class, forever.
    const g = gradeDevice(bridge, healthy({ last_ble_ok: false }), NOW, null, during(30 * 60 * 1000, 0))
    expect(g.state).toBe('adapter_down')
  })

  it('alerts once per episode, not every 5 minutes', () => {
    const g = gradeDevice(bridge, healthy(), NOW, null, during(12 * 60 * 1000, 0))
    const first = decideAlert(g, null, NOW)
    expect(first.alert).toBe('down')
    const later = gradeDevice(bridge, healthy(), NOW + 5 * 60 * 1000, null, during(17 * 60 * 1000, 0))
    expect(decideAlert(later, first.row, NOW + 5 * 60 * 1000).alert).toBe(null)
  })

  it('is quiet overnight like every other grade', () => {
    const night = new Date('2026-08-02T02:00:00.000Z').getTime()
    const g = gradeDevice(bridge, {
      status: 'online', last_seen_at: new Date(night - 10_000).toISOString(),
      last_ant_ok: true, last_ble_ok: true,
    }, night, null, {
      classNow: { name: 'NIGHT', starts_at: new Date(night - 20 * 60 * 1000).toISOString() },
      sampleCount: 0,
      priorCount: 8,
    })
    expect(g.state).toBe('blind')
    expect(g.quiet).toBe(true)
    const { alert, row } = decideAlert(g, null, night)
    expect(alert).toBe(null)
    expect(row.alerted_at).toBe(null)
  })
})

describe('describeClass', () => {
  it('names the class and its Dublin start time', () => {
    // 08:30 UTC in August = 09:30 Dublin (IST). The label must not drift with
    // the server timezone.
    expect(describeClass({ name: 'CONVOY', starts_at: '2026-08-12T08:30:00.000Z' }))
      .toBe('CONVOY 09:30')
  })

  it('falls back to the program, then to a neutral phrase', () => {
    expect(describeClass({ program: 'UN1T 45', starts_at: '2026-08-12T08:30:00.000Z' }))
      .toBe('UN1T 45 09:30')
    expect(describeClass({ name: '   ' })).toBe('a class')
    expect(describeClass(null)).toBe('a class')
  })
})

describe('strapsSeenWithin', () => {
  it('counts only entries stamped inside the window', () => {
    const row = { last_seen_straps: [{ seen_at: ago(1000) }, { seen_at: ago(60 * 60 * 1000) }] }
    expect(strapsSeenWithin(row, SAMPLE_SILENCE_MS, NOW)).toBe(1)
  })

  it('returns null — not zero — when the column says nothing usable', () => {
    // Null would be read as "we cannot tell"; zero would be read as evidence.
    expect(strapsSeenWithin({}, SAMPLE_SILENCE_MS, NOW)).toBe(null)
    expect(strapsSeenWithin({ last_seen_straps: null }, SAMPLE_SILENCE_MS, NOW)).toBe(null)
    expect(strapsSeenWithin(null, SAMPLE_SILENCE_MS, NOW)).toBe(null)
    expect(strapsSeenWithin({ last_seen_straps: [] }, SAMPLE_SILENCE_MS, NOW)).toBe(0)
  })

  it('tolerates junk entries', () => {
    const row = { last_seen_straps: [{ seen_at: 'garbage' }, null, { seen_at: ago(1000) }] }
    expect(strapsSeenWithin(row, SAMPLE_SILENCE_MS, NOW)).toBe(1)
  })
})

describe('locationsNeedingVisibilityProbe', () => {
  const LOC = 'a0000000-0000-0000-0000-000000000001'
  const healthyRow = {
    tailscale_hostname: 'stillorgan-bridge', location_id: LOC,
    status: 'online', last_seen_at: ago(10 * 1000), last_ant_ok: true, last_ble_ok: true,
  }
  const index = (row) => indexBridgesByDevice([row])

  it('probes a location whose bridge is up, talking and reporting healthy radios', () => {
    expect(locationsNeedingVisibilityProbe([online('stillorgan-bridge')], index(healthyRow), NOW))
      .toEqual([LOC])
  })

  it('skips work the grade does not need', () => {
    const cases = [
      ['unreachable device', [offline('stillorgan-bridge', 60 * 60 * 1000)], healthyRow],
      ['silent service', [online('stillorgan-bridge')], { ...healthyRow, last_seen_at: ago(60 * 60 * 1000) }],
      ['already adapter_down', [online('stillorgan-bridge')], { ...healthyRow, last_ble_ok: false }],
      ['bridge with no location', [online('stillorgan-bridge')], { ...healthyRow, location_id: null }],
    ]
    for (const [label, devices, row] of cases) {
      expect(locationsNeedingVisibilityProbe(devices, index(row), NOW), label).toEqual([])
    }
  })

  it('ignores kiosks, which have no bridge row', () => {
    expect(locationsNeedingVisibilityProbe([online('stillorgan-tv1')], index(healthyRow), NOW)).toEqual([])
  })

  it('de-duplicates a location running more than one bridge, and tolerates junk', () => {
    const rows = indexBridgesByDevice([
      healthyRow,
      { ...healthyRow, tailscale_hostname: 'stillorgan-bridge2' },
    ])
    expect(locationsNeedingVisibilityProbe(
      [online('stillorgan-bridge'), online('stillorgan-bridge2'), {}], rows, NOW,
    )).toEqual([LOC])
    expect(locationsNeedingVisibilityProbe(null, rows, NOW)).toEqual([])
  })
})
