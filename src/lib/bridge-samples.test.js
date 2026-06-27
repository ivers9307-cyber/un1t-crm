// Tests for bridge-samples.js — protocol-aware identifier helpers,
// the pure buildHrSampleRows, and DB-mocked getActiveStrapMap +
// insertHrSamples.

import { describe, it, expect, vi } from 'vitest'
import {
  canonicaliseMac,
  canonicaliseAntId,
  makeDeviceKey,
  parseDeviceKey,
  canonicaliseDeviceKey,
  buildHrSampleRows,
  getActiveStrapMap,
  insertHrSamples,
  isBridgeOnline,
  latestBridgeSeenMs,
  BRIDGE_ONLINE_WINDOW_MS,
  dublinWallClockToMs,
  resolveStrapsForBatch,
  maskStrapLabel,
} from './bridge-samples.js'

// ── canonicaliseMac ──────────────────────────────────────────────

describe('canonicaliseMac', () => {
  it('canonicalises every accepted MAC form', () => {
    expect(canonicaliseMac('aa:bb:cc:dd:ee:ff')).toBe('AA:BB:CC:DD:EE:FF')
    expect(canonicaliseMac('aabbccddeeff')).toBe('AA:BB:CC:DD:EE:FF')
    expect(canonicaliseMac('AA-BB-CC-DD-EE-FF')).toBe('AA:BB:CC:DD:EE:FF')
  })
  it('returns null for bad input', () => {
    expect(canonicaliseMac('AA:BB:CC')).toBe(null)
    expect(canonicaliseMac('')).toBe(null)
    expect(canonicaliseMac(null)).toBe(null)
    expect(canonicaliseMac(123)).toBe(null)
  })
})

// ── canonicaliseAntId ────────────────────────────────────────────

describe('canonicaliseAntId', () => {
  it('accepts 16-bit device numbers, strips leading zeros', () => {
    expect(canonicaliseAntId('12345')).toBe('12345')
    expect(canonicaliseAntId(42)).toBe('42')
    expect(canonicaliseAntId('00042')).toBe('42')
    expect(canonicaliseAntId('65535')).toBe('65535')
  })
  it('rejects out-of-range / non-numeric', () => {
    expect(canonicaliseAntId('0')).toBe(null)
    expect(canonicaliseAntId('65536')).toBe(null)
    expect(canonicaliseAntId('abc')).toBe(null)
    expect(canonicaliseAntId('')).toBe(null)
    expect(canonicaliseAntId(null)).toBe(null)
  })
})

// ── makeDeviceKey / parseDeviceKey / canonicaliseDeviceKey ───────

describe('device_key helpers', () => {
  it('makeDeviceKey builds ble + ant keys', () => {
    expect(makeDeviceKey('ble', 'aabbccddeeff')).toBe('ble:AA:BB:CC:DD:EE:FF')
    expect(makeDeviceKey('ant', 12345)).toBe('ant:12345')
    expect(makeDeviceKey('ble', 'nope')).toBe(null)
    expect(makeDeviceKey('zigbee', '1')).toBe(null)
  })
  it('parseDeviceKey splits a ble key on the first colon only', () => {
    expect(parseDeviceKey('ble:AA:BB:CC:DD:EE:FF')).toEqual({
      protocol: 'ble', deviceId: 'AA:BB:CC:DD:EE:FF',
    })
    expect(parseDeviceKey('ant:12345')).toEqual({ protocol: 'ant', deviceId: '12345' })
    expect(parseDeviceKey('nocolon')).toBe(null)
    expect(parseDeviceKey('ble:bad')).toBe(null)
    expect(parseDeviceKey(null)).toBe(null)
  })
  it('canonicaliseDeviceKey round-trips into canonical form', () => {
    expect(canonicaliseDeviceKey('ble:aa-bb-cc-dd-ee-ff')).toBe('ble:AA:BB:CC:DD:EE:FF')
    expect(canonicaliseDeviceKey('ant:00042')).toBe('ant:42')
    expect(canonicaliseDeviceKey('garbage')).toBe(null)
    // A bare MAC is NOT a device_key — it has no protocol prefix.
    expect(canonicaliseDeviceKey('AA:BB:CC:DD:EE:FF')).toBe(null)
  })
})

// ── buildHrSampleRows ────────────────────────────────────────────

describe('buildHrSampleRows', () => {
  const strapMap = new Map([
    ['ble:AA:BB:CC:DD:EE:FF', { sessionId: 'sess-1', contactId: 'c-1' }],
    ['ant:12345', { sessionId: 'sess-2', contactId: 'c-2' }],
  ])

  it('builds rows for paired straps on either protocol', () => {
    const samples = [
      { device_key: 'ble:AA:BB:CC:DD:EE:FF', recorded_at: '2026-05-21T16:00:00Z', bpm: 145 },
      { device_key: 'ant:12345', recorded_at: '2026-05-21T16:00:00Z', bpm: 132 },
    ]
    const { rows, stats } = buildHrSampleRows(samples, strapMap)
    expect(rows).toEqual([
      { session_id: 'sess-1', recorded_at: '2026-05-21T16:00:00.000Z', bpm: 145 },
      { session_id: 'sess-2', recorded_at: '2026-05-21T16:00:00.000Z', bpm: 132 },
    ])
    expect(stats).toEqual({ received: 2, accepted: 2, dropped_unpaired: 0, dropped_invalid: 0 })
  })

  it('canonicalises non-canonical device keys before matching', () => {
    const samples = [
      { device_key: 'ble:aa-bb-cc-dd-ee-ff', recorded_at: '2026-05-21T16:00:00Z', bpm: 140 },
      { device_key: 'ant:00012345', recorded_at: '2026-05-21T16:00:01Z', bpm: 141 },
    ]
    const { rows, stats } = buildHrSampleRows(samples, strapMap)
    expect(rows).toHaveLength(2)
    expect(stats.accepted).toBe(2)
  })

  it('drops unpaired straps', () => {
    const samples = [
      { device_key: 'ant:99', recorded_at: '2026-05-21T16:00:00Z', bpm: 145 },
    ]
    const { rows, stats } = buildHrSampleRows(samples, strapMap)
    expect(rows).toHaveLength(0)
    expect(stats.dropped_unpaired).toBe(1)
  })

  it('drops samples with invalid bpm or device_key', () => {
    const samples = [
      { device_key: 'ble:AA:BB:CC:DD:EE:FF', recorded_at: '2026-05-21T16:00:00Z', bpm: 25 },
      { device_key: 'ble:AA:BB:CC:DD:EE:FF', recorded_at: '2026-05-21T16:00:01Z', bpm: 250 },
      { device_key: 'not-a-key', recorded_at: '2026-05-21T16:00:02Z', bpm: 145 },
      { device_key: 'ble:AA:BB:CC:DD:EE:FF', recorded_at: '2026-05-21T16:00:03Z', bpm: 145 },
    ]
    const { rows, stats } = buildHrSampleRows(samples, strapMap)
    expect(rows).toHaveLength(1)
    expect(stats).toEqual({ received: 4, accepted: 1, dropped_unpaired: 0, dropped_invalid: 3 })
  })

  it('drops samples with invalid recorded_at', () => {
    const samples = [
      { device_key: 'ble:AA:BB:CC:DD:EE:FF', recorded_at: 'not-a-date', bpm: 145 },
      { device_key: 'ble:AA:BB:CC:DD:EE:FF', recorded_at: null, bpm: 145 },
    ]
    const { rows, stats } = buildHrSampleRows(samples, strapMap)
    expect(rows).toHaveLength(0)
    expect(stats.dropped_invalid).toBe(2)
  })

  it('rounds non-integer bpm', () => {
    const samples = [
      { device_key: 'ble:AA:BB:CC:DD:EE:FF', recorded_at: '2026-05-21T16:00:00Z', bpm: 145.7 },
    ]
    const { rows } = buildHrSampleRows(samples, strapMap)
    expect(rows[0].bpm).toBe(146)
  })

  it('returns empty rows for empty/null input', () => {
    expect(buildHrSampleRows([], strapMap).rows).toEqual([])
    expect(buildHrSampleRows(null, strapMap).rows).toEqual([])
    expect(buildHrSampleRows(undefined, strapMap).rows).toEqual([])
  })
})

// ── getActiveStrapMap ────────────────────────────────────────────

describe('getActiveStrapMap', () => {
  function dbReturning({ data, error }) {
    return {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            is: vi.fn(() => ({
              not: vi.fn(() => Promise.resolve({ data, error })),
            })),
          })),
        })),
      })),
    }
  }

  it('returns empty map when DB errors', async () => {
    const map = await getActiveStrapMap(dbReturning({ data: null, error: { message: 'boom' } }), 'bridge-1')
    expect(map.size).toBe(0)
  })

  it('builds map from rows, canonicalising both protocols', async () => {
    const rows = [
      { strap_identifier: 'ble:aa:bb:cc:dd:ee:ff', contact_id: 'c-1', heart_rate_session_id: 'sess-1' },
      { strap_identifier: 'ant:00777', contact_id: 'c-2', heart_rate_session_id: 'sess-2' },
    ]
    const map = await getActiveStrapMap(dbReturning({ data: rows, error: null }), 'bridge-1')
    expect(map.get('ble:AA:BB:CC:DD:EE:FF')).toEqual({ sessionId: 'sess-1', contactId: 'c-1' })
    expect(map.get('ant:777')).toEqual({ sessionId: 'sess-2', contactId: 'c-2' })
  })

  it('skips rows without a usable strap_identifier or session_id', async () => {
    const rows = [
      { strap_identifier: null, contact_id: 'c-1', heart_rate_session_id: 'sess-1' },
      { strap_identifier: 'ble:AA:BB:CC:DD:EE:FF', contact_id: 'c-2', heart_rate_session_id: null },
    ]
    const map = await getActiveStrapMap(dbReturning({ data: rows, error: null }), 'bridge-1')
    expect(map.size).toBe(0)
  })
})

// ── insertHrSamples ─────────────────────────────────────────────

describe('insertHrSamples', () => {
  it('skips when rows is empty', async () => {
    const db = { from: vi.fn() }
    const out = await insertHrSamples(db, [])
    expect(out).toEqual({ inserted: 0, error: null })
    expect(db.from).not.toHaveBeenCalled()
  })

  function makeDb({ upsertResult = { error: null, count: 0 }, sessionUpdateError = null } = {}) {
    const upsert = vi.fn(() => Promise.resolve(upsertResult))
    const sessionEq = vi.fn(() => Promise.resolve({ error: sessionUpdateError }))
    const sessionUpdate = vi.fn(() => ({ eq: sessionEq }))
    return {
      from: vi.fn((table) => {
        if (table === 'hr_samples') return { upsert }
        if (table === 'heart_rate_sessions') return { update: sessionUpdate }
        throw new Error(`unexpected table ${table}`)
      }),
      _spies: { upsert, sessionUpdate, sessionEq },
    }
  }

  it('upserts with onConflict ignoreDuplicates', async () => {
    const db = makeDb({ upsertResult: { error: null, count: 3 } })
    const rows = [
      { session_id: 's', recorded_at: '2026-05-21T16:00:00.000Z', bpm: 145 },
      { session_id: 's', recorded_at: '2026-05-21T16:00:01.000Z', bpm: 146 },
      { session_id: 's', recorded_at: '2026-05-21T16:00:02.000Z', bpm: 147 },
    ]
    const out = await insertHrSamples(db, rows)
    expect(out).toEqual({ inserted: 3, error: null })
    expect(db._spies.upsert).toHaveBeenCalledWith(rows, expect.objectContaining({
      onConflict: 'session_id,recorded_at',
      ignoreDuplicates: true,
    }))
  })

  it('touches last_sample_at to the LATEST recorded_at per session', async () => {
    const db = makeDb({ upsertResult: { error: null, count: 4 } })
    const rows = [
      { session_id: 'sA', recorded_at: '2026-05-21T16:00:00.000Z', bpm: 145 },
      { session_id: 'sA', recorded_at: '2026-05-21T16:00:02.000Z', bpm: 147 },
      { session_id: 'sA', recorded_at: '2026-05-21T16:00:01.000Z', bpm: 146 },
      { session_id: 'sB', recorded_at: '2026-05-21T16:00:00.000Z', bpm: 130 },
    ]
    await insertHrSamples(db, rows)
    expect(db._spies.sessionUpdate).toHaveBeenCalledTimes(2)
    expect(db._spies.sessionUpdate).toHaveBeenCalledWith({ last_sample_at: '2026-05-21T16:00:02.000Z' })
    expect(db._spies.sessionUpdate).toHaveBeenCalledWith({ last_sample_at: '2026-05-21T16:00:00.000Z' })
  })

  it('still returns inserted on a touch failure (best-effort)', async () => {
    const db = makeDb({ upsertResult: { error: null, count: 1 }, sessionUpdateError: { message: 'rls' } })
    const out = await insertHrSamples(db, [{ session_id: 's', recorded_at: '2026-05-21T16:00:00.000Z', bpm: 145 }])
    expect(out.error).toBe(null)
    expect(out.inserted).toBe(1)
  })

  it('returns error from supabase rather than throwing', async () => {
    const db = makeDb({ upsertResult: { error: { message: 'rls' }, count: 0 } })
    const out = await insertHrSamples(db, [{ session_id: 's', recorded_at: '2026-05-21T16:00:00.000Z', bpm: 145 }])
    expect(out.error).toBeTruthy()
    expect(out.inserted).toBe(0)
  })
})

// ── bridge liveness (TV connection dot) ──────────────────────────

describe('latestBridgeSeenMs', () => {
  it('returns 0 for no bridges / all null', () => {
    expect(latestBridgeSeenMs([])).toBe(0)
    expect(latestBridgeSeenMs(null)).toBe(0)
    expect(latestBridgeSeenMs([{ last_seen_at: null }, {}])).toBe(0)
  })

  it('returns the max epoch ms across bridges', () => {
    const older = '2026-06-17T17:00:00.000Z'
    const newer = '2026-06-17T17:30:00.000Z'
    expect(latestBridgeSeenMs([{ last_seen_at: older }, { last_seen_at: newer }]))
      .toBe(new Date(newer).getTime())
  })

  it('ignores unparseable timestamps', () => {
    const good = '2026-06-17T17:00:00.000Z'
    expect(latestBridgeSeenMs([{ last_seen_at: 'not-a-date' }, { last_seen_at: good }]))
      .toBe(new Date(good).getTime())
  })
})

describe('isBridgeOnline', () => {
  const now = new Date('2026-06-17T18:00:00.000Z').getTime()

  it('is false when no bridge has ever been seen', () => {
    expect(isBridgeOnline([], now)).toBe(false)
    expect(isBridgeOnline([{ last_seen_at: null }], now)).toBe(false)
  })

  it('is true when a bridge was seen within the window', () => {
    const seen = new Date(now - 5_000).toISOString() // 5s ago
    expect(isBridgeOnline([{ last_seen_at: seen }], now)).toBe(true)
  })

  it('is false when the freshest bridge is older than the window', () => {
    const seen = new Date(now - 5 * 60 * 1000).toISOString() // 5min ago
    expect(isBridgeOnline([{ last_seen_at: seen }], now)).toBe(false)
  })

  it('is online if ANY bridge at the location is fresh', () => {
    const stale = new Date(now - 10 * 60 * 1000).toISOString()
    const fresh = new Date(now - 10_000).toISOString()
    expect(isBridgeOnline([{ last_seen_at: stale }, { last_seen_at: fresh }], now)).toBe(true)
  })

  it('treats exactly-at-window as offline (strict <)', () => {
    const seen = new Date(now - BRIDGE_ONLINE_WINDOW_MS).toISOString()
    expect(isBridgeOnline([{ last_seen_at: seen }], now)).toBe(false)
  })
})

// ── dublinWallClockToMs (HR-CLASS-ALLOC.1) ───────────────────────
// bookings.booking_date + start_time are Dublin wall-clock with NO tz.
// The conversion must add the Dublin offset (BST +1h Mar–Oct, GMT +0
// otherwise) — the naive `T${time}Z` parse was off by the BST offset.
describe('dublinWallClockToMs', () => {
  it('summer (BST): 06:00 Dublin = 05:00 UTC', () => {
    expect(dublinWallClockToMs('2026-06-18', '06:00')).toBe(Date.parse('2026-06-18T05:00:00Z'))
  })

  it('winter (GMT): 06:00 Dublin = 06:00 UTC', () => {
    expect(dublinWallClockToMs('2026-01-15', '06:00')).toBe(Date.parse('2026-01-15T06:00:00Z'))
  })

  it('honours a seconds component', () => {
    expect(dublinWallClockToMs('2026-06-18', '06:00:30')).toBe(Date.parse('2026-06-18T05:00:30Z'))
  })

  it('is NOT a naive UTC parse in summer (guards the BST regression)', () => {
    expect(dublinWallClockToMs('2026-06-18', '06:00')).not.toBe(Date.parse('2026-06-18T06:00:00Z'))
  })

  it('returns NaN for malformed input', () => {
    expect(dublinWallClockToMs('not-a-date', '06:00')).toBeNaN()
    expect(dublinWallClockToMs('2026-06-18', '6pm')).toBeNaN()
    expect(dublinWallClockToMs(null, null)).toBeNaN()
    expect(dublinWallClockToMs('2026-06-18', '')).toBeNaN()
  })
})

// ── maskStrapLabel ───────────────────────────────────────────────

describe('maskStrapLabel', () => {
  it('shows the ANT+ device number', () => {
    expect(maskStrapLabel('ant:12511')).toBe('Strap 12511')
  })
  it('masks a BLE MAC to the last 4 hex', () => {
    expect(maskStrapLabel('ble:AA:BB:CC:DD:EE:FF')).toBe('Strap ••EEFF')
  })
  it('falls back to a generic label on a bad key', () => {
    expect(maskStrapLabel('garbage')).toBe('Strap')
    expect(maskStrapLabel(null)).toBe('Strap')
  })
})

// ── anonymous walk-in sessions (HR-CLASS-ALLOC.2) ────────────────
describe('resolveStrapsForBatch: anonymous straps', () => {
  const NOW = Date.parse('2026-06-18T05:30:00Z') // mid a 05:00–06:00Z class
  const liveOcc = { glofox_event_id: 'ev1', name: 'WALKIN', starts_at: '2026-06-18T05:00:00Z', ends_at: '2026-06-18T06:00:00Z' }

  // db mock: no overrides, no contact_devices, a live (or no) class, and a
  // heart_rate_sessions branch handling the anon existing-lookup + insert.
  const makeDb = ({ occRows, existingAnon = null, captureInsert } = {}) => ({
    from: vi.fn((table) => {
      if (table === 'strap_assignments') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ is: vi.fn(() => ({ not: vi.fn(() => Promise.resolve({ data: [] })) })) })) })) }
      }
      if (table === 'contact_devices') {
        return { select: vi.fn(() => ({ in: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: [], error: null })) })) })) })) }
      }
      if (table === 'class_occurrences') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ gte: vi.fn(() => ({ lte: vi.fn(() => ({ order: vi.fn(() => Promise.resolve({ data: occRows })) })) })) })) })) }
      }
      if (table === 'heart_rate_sessions') {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ is: vi.fn(() => ({ is: vi.fn(() => ({ order: vi.fn(() => ({ limit: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: existingAnon })) })) })) })) })) })) })) })),
          insert: vi.fn((row) => { if (captureInsert) captureInsert(row); return { select: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: { id: 'anon-1' }, error: null })) })) } }),
        }
      }
      throw new Error(`unexpected ${table}`)
    }),
  })

  it('creates an anonymous session for an unmatched strap during a live class', async () => {
    let inserted = null
    const db = makeDb({ occRows: [liveOcc], captureInsert: (r) => { inserted = r } })
    const map = await resolveStrapsForBatch(db, { bridgeId: 'b', locationId: 'loc1', deviceKeys: ['ant:999'], nowMs: NOW })
    expect(map.get('ant:999')).toMatchObject({ sessionId: 'anon-1', contactId: null, via: 'anon' })
    expect(inserted).toMatchObject({ contact_id: null, device_identifier: 'ant:999', glofox_event_id: 'ev1', class_link_source: 'presence' })
  })

  it('drops an unmatched strap when no class is live', async () => {
    const db = makeDb({ occRows: [] })
    const map = await resolveStrapsForBatch(db, { bridgeId: 'b', locationId: 'loc1', deviceKeys: ['ant:999'], nowMs: NOW })
    expect(map.has('ant:999')).toBe(false)
  })

  it('reuses an existing open anon session (no duplicate)', async () => {
    let inserted = null
    const db = makeDb({ occRows: [liveOcc], existingAnon: { id: 'anon-existing' }, captureInsert: (r) => { inserted = r } })
    const map = await resolveStrapsForBatch(db, { bridgeId: 'b', locationId: 'loc1', deviceKeys: ['ant:999'], nowMs: NOW })
    expect(map.get('ant:999')).toMatchObject({ sessionId: 'anon-existing', via: 'anon' })
    expect(inserted).toBeNull()
  })
})

describe('resolveStrapsForBatch: registered booking-first + test mode', () => {
  const NOW = Date.parse('2026-06-27T07:45:00Z')
  const occ8 = { glofox_event_id: 'e8', name: 'TEMPO', starts_at: '2026-06-27T08:00:00Z', ends_at: '2026-06-27T09:00:00Z' }

  function makeDb({ bookings = [], occs = [], existingOpen = null, existingClass = null, testModeUntil = null, captureInsert, captureUpdate } = {}) {
    return {
      from: vi.fn((table) => {
        if (table === 'ble_bridges') {
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: { test_mode_until: testModeUntil } })) })) })) }
        }
        if (table === 'strap_assignments') {
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ is: vi.fn(() => ({ not: vi.fn(() => Promise.resolve({ data: [] })) })) })) })) }
        }
        if (table === 'contact_devices') {
          return { select: vi.fn(() => ({ in: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: [{ identifier: 'ant:12511', contact_id: 'c1', contacts: { id: 'c1', location_id: 'loc1' } }], error: null })) })) })) })) }
        }
        if (table === 'class_bookings') {
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ gte: vi.fn(() => ({ lte: vi.fn(() => Promise.resolve({ data: bookings })) })) })) })) })) }
        }
        if (table === 'bookings') {
          // Native CRM booking fallback (path d) — no native bookings in these cases.
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ in: vi.fn(() => ({ gte: vi.fn(() => ({ lte: vi.fn(() => Promise.resolve({ data: [] })) })) })) })) })) })) }
        }
        if (table === 'class_occurrences') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                in: vi.fn(() => Promise.resolve({ data: occs })),
                gte: vi.fn(() => ({ lte: vi.fn(() => ({ order: vi.fn(() => Promise.resolve({ data: [] })) })) })),
              })),
            })),
          }
        }
        if (table === 'contacts') {
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: { glofox_member_id: 'g1', max_hr_override: null, dob: null } })) })) })) }
        }
        if (table === 'heart_rate_sessions') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  is: vi.fn(() => ({ order: vi.fn(() => ({ limit: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: existingOpen })) })) })) })),
                  order: vi.fn(() => ({ limit: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: existingClass })) })) })),
                })),
              })),
            })),
            insert: vi.fn((row) => { if (captureInsert) captureInsert(row); return { select: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: { id: 'new-1' }, error: null })) })) } }),
            update: vi.fn((patch) => { if (captureUpdate) captureUpdate(patch); return { eq: vi.fn(() => Promise.resolve({ error: null })) } }),
          }
        }
        throw new Error(`unexpected ${table}`)
      }),
    }
  }

  it('maps a booked member to their booked class (booking-first, label=booked)', async () => {
    let inserted = null
    const db = makeDb({ bookings: [{ glofox_event_id: 'e8', status: 'BOOKED', starts_at: occ8.starts_at }], occs: [occ8], captureInsert: (r) => { inserted = r } })
    const map = await resolveStrapsForBatch(db, { bridgeId: 'b', locationId: 'loc1', deviceKeys: ['ant:12511'], nowMs: NOW })
    expect(map.get('ant:12511')).toMatchObject({ sessionId: 'new-1', contactId: 'c1', via: 'auto' })
    expect(inserted).toMatchObject({ glofox_event_id: 'e8', class_link_source: 'booked', device_identifier: 'ant:12511' })
  })

  it('creates nothing for an unbooked member with no live class and test mode off', async () => {
    const db = makeDb({ bookings: [], occs: [] })
    const map = await resolveStrapsForBatch(db, { bridgeId: 'b', locationId: 'loc1', deviceKeys: ['ant:12511'], nowMs: NOW })
    expect(map.has('ant:12511')).toBe(false)
  })

  it('creates a presence-less session when the bridge is in test mode', async () => {
    let inserted = null
    const db = makeDb({ bookings: [], occs: [], testModeUntil: new Date(NOW + 3600_000).toISOString(), captureInsert: (r) => { inserted = r } })
    const map = await resolveStrapsForBatch(db, { bridgeId: 'b', locationId: 'loc1', deviceKeys: ['ant:12511'], nowMs: NOW })
    expect(map.get('ant:12511')).toMatchObject({ sessionId: 'new-1', via: 'auto' })
    expect(inserted).toMatchObject({ device_identifier: 'ant:12511', glofox_event_id: null, class_link_source: null })
  })

  it('reopens a closed session for the same class while the class is still live', async () => {
    let updated = null
    const db = makeDb({
      bookings: [{ glofox_event_id: 'e8', status: 'BOOKED', starts_at: occ8.starts_at }],
      occs: [occ8],
      existingClass: { id: 'cls-1', ended_at: '2026-06-27T07:40:00Z' },
      captureUpdate: (p) => { updated = p },
    })
    const map = await resolveStrapsForBatch(db, { bridgeId: 'b', locationId: 'loc1', deviceKeys: ['ant:12511'], nowMs: NOW })
    expect(map.get('ant:12511')).toMatchObject({ sessionId: 'cls-1', via: 'auto' })
    expect(updated).toMatchObject({ ended_at: null })
  })

  it('skips (no new session) when the class has ended past grace', async () => {
    const AFTER = Date.parse('2026-06-27T09:30:00Z') // class ended 09:00; past +10m grace, within booking +30m
    const db = makeDb({
      bookings: [{ glofox_event_id: 'e8', status: 'BOOKED', starts_at: occ8.starts_at }],
      occs: [occ8],
      existingClass: { id: 'cls-1', ended_at: '2026-06-27T08:55:00Z' },
    })
    const map = await resolveStrapsForBatch(db, { bridgeId: 'b', locationId: 'loc1', deviceKeys: ['ant:12511'], nowMs: AFTER })
    expect(map.has('ant:12511')).toBe(false)
  })
})
