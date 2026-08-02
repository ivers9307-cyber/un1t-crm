import { describe, it, expect } from 'vitest'
import {
  OFFLINE_AFTER_MS,
  isFleetDevice,
  deviceNameOf,
  gradeDevice,
  decideAlert,
  indexBridgesByDevice,
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
