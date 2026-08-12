// BRIDGE-BLIND.1 — parsing the telemetry the heartbeat route used to discard.
//
// The fixtures below are the REAL wire shape, taken from champ-bridge
// src/index.js buildTelemetry() + src/api.js postHeartbeat(): postHeartbeat
// SPREADS the telemetry across the top level, so nothing arrives under a
// `telemetry` key today. Getting that wrong fails silently — the columns stay
// NULL and the alerting built on them never fires — which is the exact failure
// class this change exists to end.

import { describe, it, expect } from 'vitest'
import { parseBridgeTelemetry, adapterHealth } from './bridge-telemetry.js'

/** What a healthy Stillorgan Pi actually POSTs. */
const HEALTHY = {
  software_version: '1.4.2',
  status: 'online',
  pending_samples: 0,
  uptime_s: 91_233,
  adapters: {
    ant: { protocol: 'ant', fake: false, stick_present: true, seen: 3 },
    ble: { protocol: 'ble', fake: false, powered_on: true, connections: 2 },
  },
}

/** 2026-08-12, Stillorgan: noble came up `unauthorized`. */
const BLE_UNAUTHORIZED = {
  ...HEALTHY,
  adapters: {
    ant: { protocol: 'ant', fake: false, stick_present: true, seen: 0 },
    ble: { protocol: 'ble', fake: false, powered_on: false, connections: 0 },
  },
}

describe('parseBridgeTelemetry — the shape actually sent', () => {
  it('reads the FLAT payload postHeartbeat sends', () => {
    const patch = parseBridgeTelemetry(HEALTHY)
    expect(patch.last_ant_ok).toBe(true)
    expect(patch.last_ble_ok).toBe(true)
    expect(patch.last_pending_samples).toBe(0)
    expect(patch.last_telemetry).toEqual({
      pending_samples: 0,
      uptime_s: 91_233,
      adapters: {
        ant: { protocol: 'ant', fake: false, stick_present: true, seen: 3 },
        ble: { protocol: 'ble', fake: false, powered_on: true, connections: 2 },
      },
    })
  })

  it('also reads a nested { telemetry } payload, should a bridge ever send one', () => {
    const { adapters, pending_samples, uptime_s } = HEALTHY
    const patch = parseBridgeTelemetry({
      software_version: '1.4.2', status: 'online',
      telemetry: { adapters, pending_samples, uptime_s },
    })
    expect(patch.last_ble_ok).toBe(true)
    expect(patch.last_telemetry.uptime_s).toBe(91_233)
  })

  it('catches the 2026-08-12 defect: BLE reporting powered_on false', () => {
    const patch = parseBridgeTelemetry(BLE_UNAUTHORIZED)
    expect(patch.last_ble_ok).toBe(false)
    expect(patch.last_ant_ok).toBe(true)
  })

  it('never stores the auth/version fields that ride in the same flat body', () => {
    // The flat shape means the whole heartbeat body is the parse source. Only
    // the three known telemetry keys may reach the jsonb column.
    const patch = parseBridgeTelemetry({ ...HEALTHY, secret: 'nope' })
    expect(Object.keys(patch.last_telemetry).sort()).toEqual(['adapters', 'pending_samples', 'uptime_s'])
  })
})

describe('parseBridgeTelemetry — missing telemetry is tolerated, not punished', () => {
  it('returns null for a bridge on older software', () => {
    // SHIPS DARK. Every bridge sends only these two until it is upgraded; if
    // that parsed as a fault, merging this would alert on the whole fleet.
    expect(parseBridgeTelemetry({ software_version: '1.0.0', status: 'online' })).toBe(null)
  })

  it('returns null for an empty or absent body', () => {
    expect(parseBridgeTelemetry({})).toBe(null)
    expect(parseBridgeTelemetry(null)).toBe(null)
    expect(parseBridgeTelemetry(undefined)).toBe(null)
    expect(parseBridgeTelemetry('not json')).toBe(null)
    expect(parseBridgeTelemetry([1, 2, 3])).toBe(null)
  })

  it('omits the adapter keys entirely when the payload said nothing about adapters', () => {
    // The caller spreads this patch, so an omitted key leaves the stored column
    // alone. One truncated heartbeat must not clear a live adapter_down alert.
    const patch = parseBridgeTelemetry({ pending_samples: 12 })
    expect(patch.last_pending_samples).toBe(12)
    expect('last_ant_ok' in patch).toBe(false)
    expect('last_ble_ok' in patch).toBe(false)
  })

  it('DOES clear an adapter the bridge has stopped listing', () => {
    // The other half of the rule above: `adapters` present but without `ble`
    // is the bridge saying it has no such radio. A stale `false` left pinned
    // there would be an alert nobody could ever clear.
    const patch = parseBridgeTelemetry({
      adapters: { ant: { stick_present: true } },
    })
    expect(patch.last_ant_ok).toBe(true)
    expect(patch.last_ble_ok).toBe(null)
  })

  it('treats a non-boolean adapter flag as "did not say", never as a fault', () => {
    const patch = parseBridgeTelemetry({
      adapters: { ant: { stick_present: 'yes' }, ble: { powered_on: null } },
    })
    expect(patch.last_ant_ok).toBe(null)
    expect(patch.last_ble_ok).toBe(null)
  })
})

describe('parseBridgeTelemetry — hostile and malformed payloads', () => {
  it('never throws, whatever it is handed', () => {
    const nasty = { get adapters() { throw new Error('boom') } }
    expect(() => parseBridgeTelemetry(nasty)).not.toThrow()
    expect(parseBridgeTelemetry(nasty)).toBe(null)
  })

  it('drops non-scalar adapter fields instead of storing them', () => {
    const patch = parseBridgeTelemetry({
      adapters: {
        ant: { stick_present: true, history: [1, 2, 3], nested: { a: 1 }, cb: undefined },
      },
    })
    expect(patch.last_telemetry.adapters.ant).toEqual({ stick_present: true })
  })

  it('ignores adapter entries that are not objects', () => {
    const patch = parseBridgeTelemetry({ adapters: { ant: 'up', ble: 7, usb: null } })
    expect(patch.last_telemetry.adapters).toEqual({})
    expect(patch.last_ant_ok).toBe(null)
  })

  it('bounds strings, adapter counts and field counts', () => {
    const many = {}
    for (let i = 0; i < 40; i++) many[`adapter${i}`] = { note: 'x'.repeat(500) }
    const patch = parseBridgeTelemetry({ adapters: many })
    const stored = patch.last_telemetry.adapters
    expect(Object.keys(stored).length).toBeLessThanOrEqual(8)
    for (const a of Object.values(stored)) expect(a.note.length).toBe(64)
  })

  it('clamps pending_samples into the int4 column, and rejects nonsense', () => {
    expect(parseBridgeTelemetry({ pending_samples: -5 }).last_pending_samples).toBe(0)
    expect(parseBridgeTelemetry({ pending_samples: 9e12 }).last_pending_samples).toBe(2_147_483_647)
    expect(parseBridgeTelemetry({ pending_samples: 12.7 }).last_pending_samples).toBe(13)
    // Not a number at all -> the key is simply absent, not a bogus 0.
    expect(parseBridgeTelemetry({ pending_samples: 'lots' })).toBe(null)
    expect(parseBridgeTelemetry({ pending_samples: NaN })).toBe(null)
  })

  it('carries a rising pending_samples through — a distinct fault worth seeing', () => {
    // Straps read fine, delivery is broken. Different problem from reading
    // nothing, and the column exists so the two are tellable apart.
    expect(parseBridgeTelemetry({ ...HEALTHY, pending_samples: 40_000 }).last_pending_samples)
      .toBe(40_000)
  })
})

describe('adapterHealth', () => {
  it('maps each adapter to its own health field', () => {
    expect(adapterHealth(HEALTHY.adapters, 'ant')).toBe(true)
    expect(adapterHealth(BLE_UNAUTHORIZED.adapters, 'ble')).toBe(false)
  })

  it('returns null for an unknown adapter or a missing map', () => {
    expect(adapterHealth(HEALTHY.adapters, 'usb')).toBe(null)
    expect(adapterHealth(null, 'ble')).toBe(null)
    expect(adapterHealth(undefined, 'ant')).toBe(null)
  })
})
