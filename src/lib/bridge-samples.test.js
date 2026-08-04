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
  deriveBridgeStatus,
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

  // Mock DB modelling the reads/writes insertHrSamples now performs:
  //   hr_samples.upsert(...)                                   → upsertResult
  //   hr_samples.select().eq().order().range(...)              → full-recompute page read
  //   heart_rate_sessions.select().eq().maybeSingle()          → the session row (running state)
  //   heart_rate_sessions.update({...}).eq()                   → the aggregate write
  // `sessionsById` seeds the current running state per session; `allSamplesById`
  // seeds the full persisted sample set the fallback pages. Every update is
  // captured on the session's `updates[]`.
  function makeDb({ upsertResult = { error: null, count: 0 }, sessionsById = {}, allSamplesById = {}, locationsById = {}, sessionSelectError = null, sessionUpdateError = null } = {}) {
    const state = JSON.parse(JSON.stringify(sessionsById))
    const updates = []
    const upsert = vi.fn(() => Promise.resolve(upsertResult))

    const hrSamplesSelect = (sessionId) => {
      // .select('recorded_at, bpm').eq('session_id', id).order(...).range(from,to)
      const all = allSamplesById[sessionId] || []
      const chain = {
        eq: () => chain,
        order: () => chain,
        range: (from, to) => Promise.resolve({ data: all.slice(from, to + 1), error: null }),
      }
      // capture session id at .eq()
      chain.eq = (col, val) => { chain._sid = val; return chain }
      chain.range = (from, to) => {
        const arr = allSamplesById[chain._sid] || []
        return Promise.resolve({ data: arr.slice(from, to + 1), error: null })
      }
      return chain
    }

    const sessionsSelect = () => {
      const chain = {}
      chain.eq = (col, id) => { chain._id = id; return chain }
      chain.maybeSingle = () => Promise.resolve({
        data: sessionSelectError ? null : (state[chain._id] || null),
        error: sessionSelectError,
      })
      return chain
    }

    const sessionsUpdate = (patch) => ({
      eq: (col, id) => {
        updates.push({ id, patch })
        if (state[id]) Object.assign(state[id], patch)
        return Promise.resolve({ error: sessionUpdateError })
      },
    })

    const locationsSelect = () => {
      const chain = {}
      chain.eq = (col, id) => { chain._id = id; return chain }
      chain.maybeSingle = () => Promise.resolve({ data: locationsById[chain._id] || null, error: null })
      return chain
    }

    return {
      from: vi.fn((table) => {
        if (table === 'hr_samples') return { upsert, select: () => hrSamplesSelect() }
        if (table === 'heart_rate_sessions') return { select: sessionsSelect, update: sessionsUpdate }
        if (table === 'locations') return { select: locationsSelect }
        throw new Error(`unexpected table ${table}`)
      }),
      _updates: updates,
      _state: state,
      _spies: { upsert },
    }
  }

  const updatesFor = (db, id) => db._updates.filter((u) => u.id === id)

  it('upserts with onConflict ignoreDuplicates', async () => {
    const db = makeDb({
      upsertResult: { error: null, count: 3 },
      sessionsById: { s: { id: 's', max_hr_used: 200 } },
    })
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

  it('writes the running aggregate + advances last_sample_at on a fresh session (fast path)', async () => {
    const db = makeDb({
      upsertResult: { error: null, count: 3 },
      sessionsById: { s: { id: 's', max_hr_used: 200 } }, // no live_* state yet
    })
    // 145 bpm = Z3 at max 200. 3 samples 1s apart.
    const rows = [
      { session_id: 's', recorded_at: '2026-05-21T16:00:00.000Z', bpm: 145 },
      { session_id: 's', recorded_at: '2026-05-21T16:00:01.000Z', bpm: 145 },
      { session_id: 's', recorded_at: '2026-05-21T16:00:02.000Z', bpm: 145 },
    ]
    await insertHrSamples(db, rows)
    const u = updatesFor(db, 's')
    expect(u).toHaveLength(1)
    const p = u[0].patch
    // Two 1s gaps counted; last sample pending (0). Z3 = 2s so far.
    expect(p.zones_seconds[3]).toBe(2)
    expect(p.live_sample_count).toBe(3)
    expect(p.live_sum_bpm).toBe(435)
    expect(p.avg_hr_bpm).toBe(145)
    expect(p.peak_hr_bpm).toBe(145)
    expect(p.live_last_bpm).toBe(145)
    expect(p.live_last_at).toBe('2026-05-21T16:00:02.000Z')
    expect(p.last_sample_at).toBe('2026-05-21T16:00:02.000Z')
  })

  it('scores the running aggregate with the LOCATION\'s zone_points, not defaults (re-audit A4)', async () => {
    // Operator sets Zone 3 to 30 pts/min. 2 counted seconds in Z3 → floor(2·30/60)
    // = 1 point; the default 3 pts/min would floor to 0. Uses a unique location
    // id so the module-level 60s zone-points cache can't leak across tests.
    const db = makeDb({
      upsertResult: { error: null, count: 3 },
      sessionsById: { s: { id: 's', max_hr_used: 200 } },
      locationsById: { 'loc-a4-zp': { settings: { scoring: { zone_points: { 3: 30 } } } } },
    })
    const rows = [
      { session_id: 's', recorded_at: '2026-05-21T16:00:00.000Z', bpm: 145 },
      { session_id: 's', recorded_at: '2026-05-21T16:00:01.000Z', bpm: 145 },
      { session_id: 's', recorded_at: '2026-05-21T16:00:02.000Z', bpm: 145 },
    ]
    await insertHrSamples(db, rows, { locationId: 'loc-a4-zp' })
    const u = updatesFor(db, 's')
    expect(u).toHaveLength(1)
    expect(u[0].patch.zones_seconds[3]).toBe(2)
    expect(u[0].patch.effort_points).toBe(1) // custom 30/min, NOT the default-scored 0
    expect(db.from).toHaveBeenCalledWith('locations')
  })

  it('scores with defaults (and never reads locations) when no locationId is passed', async () => {
    const db = makeDb({
      upsertResult: { error: null, count: 3 },
      sessionsById: { s: { id: 's', max_hr_used: 200 } },
    })
    const rows = [
      { session_id: 's', recorded_at: '2026-05-21T16:00:00.000Z', bpm: 145 },
      { session_id: 's', recorded_at: '2026-05-21T16:00:01.000Z', bpm: 145 },
      { session_id: 's', recorded_at: '2026-05-21T16:00:02.000Z', bpm: 145 },
    ]
    await insertHrSamples(db, rows)
    const u = updatesFor(db, 's')
    expect(u[0].patch.effort_points).toBe(0) // default Z3 = 3/min → floor(2·3/60) = 0
    expect(db.from).not.toHaveBeenCalledWith('locations')
  })

  it('continues the fold from persisted running state (second in-order batch)', async () => {
    // Session already has one pending sample at :02 (145 bpm), Z3=2s, count 3.
    const db = makeDb({
      upsertResult: { error: null, count: 2 },
      sessionsById: {
        s: {
          id: 's', max_hr_used: 200,
          zones_seconds: { 1: 0, 2: 0, 3: 2, 4: 0, 5: 0 },
          live_sum_bpm: 435, live_sample_count: 3,
          live_last_bpm: 145, live_last_at: '2026-05-21T16:00:02.000Z',
        },
      },
    })
    const rows = [
      { session_id: 's', recorded_at: '2026-05-21T16:00:03.000Z', bpm: 145 },
      { session_id: 's', recorded_at: '2026-05-21T16:00:04.000Z', bpm: 145 },
    ]
    await insertHrSamples(db, rows)
    const p = updatesFor(db, 's')[0].patch
    // Pending :02 now gets its 1s gap → Z3 3s; :03 gets 1s → Z3 4s; :04 pending.
    expect(p.zones_seconds[3]).toBe(4)
    expect(p.live_sample_count).toBe(5)
    expect(p.live_last_at).toBe('2026-05-21T16:00:04.000Z')
  })

  it('falls back to a FULL recompute when a batch is out-of-order / a duplicate retry', async () => {
    // live_last_at is :05, but the incoming batch starts at :02 (older) — a
    // retry of already-folded samples. Fold-again would double-count, so we
    // recompute from all persisted samples instead.
    const persisted = [
      { recorded_at: '2026-05-21T16:00:00.000Z', bpm: 145 },
      { recorded_at: '2026-05-21T16:00:01.000Z', bpm: 145 },
      { recorded_at: '2026-05-21T16:00:02.000Z', bpm: 145 },
    ]
    const db = makeDb({
      upsertResult: { error: null, count: 0 }, // duplicates → nothing inserted
      sessionsById: {
        s: {
          id: 's', max_hr_used: 200,
          zones_seconds: { 1: 0, 2: 0, 3: 99, 4: 0, 5: 0 }, // deliberately wrong
          live_sum_bpm: 9999, live_sample_count: 99,
          live_last_bpm: 145, live_last_at: '2026-05-21T16:00:05.000Z',
        },
      },
      allSamplesById: { s: persisted },
    })
    const rows = [
      { session_id: 's', recorded_at: '2026-05-21T16:00:01.000Z', bpm: 145 },
      { session_id: 's', recorded_at: '2026-05-21T16:00:02.000Z', bpm: 145 },
    ]
    await insertHrSamples(db, rows)
    const p = updatesFor(db, 's')[0].patch
    // Recompute from the 3 persisted samples: two 1s gaps folded, last pending → Z3 2s.
    expect(p.zones_seconds[3]).toBe(2)
    expect(p.live_sample_count).toBe(3)
    expect(p.live_sum_bpm).toBe(435)
    expect(p.avg_hr_bpm).toBe(145)
  })

  it('handles a batch spanning MULTIPLE sessions independently', async () => {
    const db = makeDb({
      upsertResult: { error: null, count: 4 },
      sessionsById: {
        sA: { id: 'sA', max_hr_used: 200 },
        sB: { id: 'sB', max_hr_used: 200 },
      },
    })
    const rows = [
      { session_id: 'sA', recorded_at: '2026-05-21T16:00:00.000Z', bpm: 145 },
      { session_id: 'sA', recorded_at: '2026-05-21T16:00:02.000Z', bpm: 145 },
      { session_id: 'sA', recorded_at: '2026-05-21T16:00:01.000Z', bpm: 145 }, // out of input order
      { session_id: 'sB', recorded_at: '2026-05-21T16:00:00.000Z', bpm: 130 },
    ]
    await insertHrSamples(db, rows)
    // sA sorted → :00,:01,:02 → two 1s gaps → Z3 2s, last_sample_at :02.
    const pA = updatesFor(db, 'sA')[0].patch
    expect(pA.zones_seconds[3]).toBe(2)
    expect(pA.last_sample_at).toBe('2026-05-21T16:00:02.000Z')
    // sB single sample → pending, 0 zone seconds yet, last_sample_at :00.
    const pB = updatesFor(db, 'sB')[0].patch
    expect(pB.last_sample_at).toBe('2026-05-21T16:00:00.000Z')
    expect(pB.live_sample_count).toBe(1)
  })

  it('still returns inserted, and advances last_sample_at, on an aggregate failure (best-effort)', async () => {
    // The session read fails → aggregate throws internally → we still touch
    // last_sample_at and never fail the ack.
    const db = makeDb({
      upsertResult: { error: null, count: 1 },
      sessionSelectError: { message: 'boom' },
    })
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
  const makeDb = ({ occRows, existingAnon = null, reselectAnon, captureInsert, insertResult } = {}) => {
    // The existing-open lookup AND the post-23505 re-select share the same
    // chain shape. First call returns `existingAnon` (drives the create path);
    // if `reselectAnon` is set, subsequent calls (the re-select) return it.
    let lookupCalls = 0
    const anonLookup = () => Promise.resolve({ data: lookupCalls++ === 0 ? existingAnon : (reselectAnon ?? existingAnon) })
    return ({
    from: vi.fn((table) => {
      if (table === 'strap_assignments') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ is: vi.fn(() => ({ not: vi.fn(() => Promise.resolve({ data: [] })) })) })) })) }
      }
      if (table === 'contact_devices') {
        return { select: vi.fn(() => ({ in: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: [], error: null })) })) })) })) }
      }
      if (table === 'class_occurrences') {
        // resolveCurrentOccurrence: .eq().gte().lte().is(cancelled_at, null).order()
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ gte: vi.fn(() => ({ lte: vi.fn(() => ({ is: vi.fn(() => ({ order: vi.fn(() => Promise.resolve({ data: occRows })) })) })) })) })) })) }
      }
      if (table === 'heart_rate_sessions') {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ is: vi.fn(() => ({ is: vi.fn(() => ({ order: vi.fn(() => ({ limit: vi.fn(() => ({ maybeSingle: vi.fn(anonLookup) })) })) })) })) })) })) })),
          insert: vi.fn((row) => { if (captureInsert) captureInsert(row); return { select: vi.fn(() => ({ single: vi.fn(() => Promise.resolve(insertResult || { data: { id: 'anon-1' }, error: null })) })) } }),
        }
      }
      throw new Error(`unexpected ${table}`)
    }),
  })
  }

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

  it('recovers from a 23505 on anon insert by re-selecting the racing session', async () => {
    // Two overlapping batches: our SELECT saw no open anon session, but a
    // concurrent request inserted one first. The mig 343 unique index rejects
    // our insert with 23505; we must re-select the winner, not return null.
    const db = makeDb({
      occRows: [liveOcc],
      insertResult: { data: null, error: { code: '23505' } },
      reselectAnon: { id: 'anon-race-winner' },
    })
    const map = await resolveStrapsForBatch(db, { bridgeId: 'b', locationId: 'loc1', deviceKeys: ['ant:999'], nowMs: NOW })
    expect(map.get('ant:999')).toMatchObject({ sessionId: 'anon-race-winner', contactId: null, via: 'anon' })
  })
})

describe('resolveStrapsForBatch: registered booking-first + test mode', () => {
  const NOW = Date.parse('2026-06-27T07:45:00Z')
  const occ8 = { glofox_event_id: 'e8', name: 'TEMPO', starts_at: '2026-06-27T08:00:00Z', ends_at: '2026-06-27T09:00:00Z' }

  function makeDb({ bookings = [], occs = [], existingOpen = null, reselectOpen, existingClass = null, testModeUntil = null, captureInsert, captureUpdate, insertResult } = {}) {
    // The (a) existing-open lookup and the post-23505 re-select share the same
    // chain shape. First call returns `existingOpen` (so the create path runs);
    // later calls (the re-select) return `reselectOpen` when set.
    let openCalls = 0
    const openLookup = () => Promise.resolve({ data: openCalls++ === 0 ? existingOpen : (reselectOpen ?? existingOpen) })
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
                // resolveBookedOccurrenceForMember: .in().is(cancelled_at, null)
                in: vi.fn(() => ({ is: vi.fn(() => Promise.resolve({ data: occs })) })),
                // resolveCurrentOccurrence: .gte().lte().is(cancelled_at, null).order()
                gte: vi.fn(() => ({ lte: vi.fn(() => ({ is: vi.fn(() => ({ order: vi.fn(() => Promise.resolve({ data: [] })) })) })) })),
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
                  is: vi.fn(() => ({ order: vi.fn(() => ({ limit: vi.fn(() => ({ maybeSingle: vi.fn(openLookup) })) })) })),
                  order: vi.fn(() => ({ limit: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: existingClass })) })) })),
                })),
              })),
            })),
            insert: vi.fn((row) => { if (captureInsert) captureInsert(row); return { select: vi.fn(() => ({ single: vi.fn(() => Promise.resolve(insertResult || { data: { id: 'new-1' }, error: null })) })) } }),
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
    // Item 3 — a test-mode create is born tagged so the reward cascade skips it.
    expect(inserted.raw_metadata).toEqual({ test_mode: true })
  })

  it('does NOT tag raw_metadata for a normal (non-test) class create', async () => {
    let inserted = null
    const db = makeDb({ bookings: [{ glofox_event_id: 'e8', status: 'BOOKED', starts_at: occ8.starts_at }], occs: [occ8], captureInsert: (r) => { inserted = r } })
    await resolveStrapsForBatch(db, { bridgeId: 'b', locationId: 'loc1', deviceKeys: ['ant:12511'], nowMs: NOW })
    // Non-test create → raw_metadata is null (no test flag).
    expect(inserted.raw_metadata).toBeNull()
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

  it('recovers from a 23505 on member insert by re-selecting the racing open session', async () => {
    // Test-mode create path (c): our (a) SELECT saw no open session, but a
    // concurrent overlapping batch inserted one first. The mig 343 unique index
    // rejects our insert with 23505; we must re-select the winner, not null.
    const db = makeDb({
      bookings: [], occs: [],
      testModeUntil: new Date(NOW + 3600_000).toISOString(),
      insertResult: { data: null, error: { code: '23505' } },
      reselectOpen: { id: 'member-race-winner' },
    })
    const map = await resolveStrapsForBatch(db, { bridgeId: 'b', locationId: 'loc1', deviceKeys: ['ant:12511'], nowMs: NOW })
    expect(map.get('ant:12511')).toMatchObject({ sessionId: 'member-race-winner', contactId: 'c1', via: 'auto' })
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

// ── Item 1: back-to-back classes supersede a stale open session ──────
// A member's 09:00 session stays OPEN (closing waits on silence). At 10:05 the
// bridge sees their strap again; they're now resolved to the 10:00 class. The
// old 09:00 session (ended past grace) must be CLOSED and a fresh session opened
// for the 10:00 class — not have the 10:00 samples absorbed into the 09:00 row.
describe('resolveStrapsForBatch: back-to-back class supersede (item 1)', () => {
  const NOW = Date.parse('2026-06-27T10:05:00Z')
  const occNew = { glofox_event_id: 'e-new', name: 'TEMPO', starts_at: '2026-06-27T10:00:00Z', ends_at: '2026-06-27T11:00:00Z' }

  function makeDb({ existingOpen, oldOccEndsAt, testModeUntil = null, captureClose, captureInsert }) {
    let openCalls = 0
    // path (a) existing-open lookup returns existingOpen; the post-supersede (b)
    // priorForClass lookup returns null (no session yet for the NEW class).
    const openLookup = () => Promise.resolve({ data: openCalls++ === 0 ? existingOpen : null })
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
        if (table === 'contacts') {
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: { glofox_member_id: 'g1', max_hr_override: null, dob: null } })) })) })) }
        }
        if (table === 'class_bookings') {
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ gte: vi.fn(() => ({ lte: vi.fn(() => Promise.resolve({ data: [{ glofox_event_id: 'e-new', status: 'BOOKED', starts_at: occNew.starts_at }] })) })) })) })) })) }
        }
        if (table === 'class_occurrences') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                // resolveBookedOccurrenceForMember: .in(glofox_event_id).is(cancelled_at)
                in: vi.fn(() => ({ is: vi.fn(() => Promise.resolve({ data: [occNew] })) })),
                // resolveCurrentOccurrence: .gte().lte().is().order()
                gte: vi.fn(() => ({ lte: vi.fn(() => ({ is: vi.fn(() => ({ order: vi.fn(() => Promise.resolve({ data: [] })) })) })) })),
                // OLD-class ends_at lookup (item 1): .eq(glofox_event_id).is(cancelled_at).maybeSingle()
                eq: vi.fn(() => ({ is: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: { ends_at: oldOccEndsAt } })) })) })),
              })),
            })),
          }
        }
        if (table === 'bookings') {
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ in: vi.fn(() => ({ gte: vi.fn(() => ({ lte: vi.fn(() => Promise.resolve({ data: [] })) })) })) })) })) })) }
        }
        if (table === 'heart_rate_sessions') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  is: vi.fn(() => ({ order: vi.fn(() => ({ limit: vi.fn(() => ({ maybeSingle: vi.fn(openLookup) })) })) })),
                  order: vi.fn(() => ({ limit: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: null })) })) })),
                })),
              })),
            })),
            update: vi.fn((patch) => {
              if (captureClose) captureClose(patch)
              return { eq: vi.fn(() => ({ is: vi.fn(() => Promise.resolve({ error: null })) })) }
            }),
            insert: vi.fn((row) => { if (captureInsert) captureInsert(row); return { select: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: { id: 'fresh-1' }, error: null })) })) } }),
          }
        }
        throw new Error(`unexpected ${table}`)
      }),
    }
  }

  it('closes the stale open session and creates a fresh one for the new class', async () => {
    let closed = null, inserted = null
    const db = makeDb({
      existingOpen: { id: 'old-sess', glofox_event_id: 'e-old' },
      oldOccEndsAt: '2026-06-27T09:00:00Z', // old class ended 09:00; now 10:05 → past grace
      captureClose: (p) => { closed = p },
      captureInsert: (r) => { inserted = r },
    })
    const map = await resolveStrapsForBatch(db, { bridgeId: 'b', locationId: 'loc1', deviceKeys: ['ant:12511'], nowMs: NOW })
    // Fresh session for the NEW class, not the stale one.
    expect(map.get('ant:12511')).toMatchObject({ sessionId: 'fresh-1', via: 'auto' })
    expect(closed).toMatchObject({ ended_at: expect.any(String) }) // old session closed
    expect(inserted).toMatchObject({ glofox_event_id: 'e-new', device_identifier: 'ant:12511' })
  })

  it('KEEPS the open session (returns it) when the older class is still live', async () => {
    let inserted = null
    const db = makeDb({
      existingOpen: { id: 'old-sess', glofox_event_id: 'e-old' },
      oldOccEndsAt: '2026-06-27T10:30:00Z', // old class ends 10:30, now 10:05 within grace → still live
      captureInsert: (r) => { inserted = r },
    })
    const map = await resolveStrapsForBatch(db, { bridgeId: 'b', locationId: 'loc1', deviceKeys: ['ant:12511'], nowMs: NOW })
    expect(map.get('ant:12511')).toMatchObject({ sessionId: 'old-sess', via: 'auto' })
    expect(inserted).toBeNull() // no fresh session created
  })
})

describe('deriveBridgeStatus', () => {
  const now = new Date('2026-06-17T18:00:00.000Z').getTime()
  const ago = (ms) => new Date(now - ms).toISOString()

  it('reports offline when the heartbeat is stale, whatever the column says', () => {
    // The bug this exists for: the Stillorgan bridge sat at status='online'
    // for 17 days after it died, because nothing ever writes 'offline' — a
    // Pi that loses power cannot send a final heartbeat. The admin badge
    // rendered the raw column and read ONLINE next to "Last seen 15 days ago".
    const dead = { status: 'online', last_seen_at: ago(15 * 24 * 60 * 60 * 1000) }
    expect(deriveBridgeStatus(dead, now)).toBe('offline')
  })

  it('reports online when the heartbeat is fresh', () => {
    expect(deriveBridgeStatus({ status: 'online', last_seen_at: ago(5_000) }, now)).toBe('online')
  })

  it('preserves a self-reported error while the bridge is still alive', () => {
    // 'error' is set by the bridge itself and is meaningful — freshness must
    // not overwrite it, only outrank it once the bridge goes quiet.
    expect(deriveBridgeStatus({ status: 'error', last_seen_at: ago(5_000) }, now)).toBe('error')
  })

  it('outranks a stale error with offline', () => {
    expect(deriveBridgeStatus({ status: 'error', last_seen_at: ago(60 * 60 * 1000) }, now)).toBe('offline')
  })

  it('reports offline for a bridge that has never connected', () => {
    expect(deriveBridgeStatus({ status: 'offline', last_seen_at: null }, now)).toBe('offline')
    expect(deriveBridgeStatus({ status: 'online', last_seen_at: null }, now)).toBe('offline')
  })

  it('uses the same freshness window as the TV connection dot', () => {
    const justInside = { status: 'online', last_seen_at: ago(BRIDGE_ONLINE_WINDOW_MS - 1_000) }
    const justOutside = { status: 'online', last_seen_at: ago(BRIDGE_ONLINE_WINDOW_MS + 1_000) }
    expect(deriveBridgeStatus(justInside, now)).toBe('online')
    expect(deriveBridgeStatus(justOutside, now)).toBe('offline')
  })

  it('tolerates a missing or malformed row', () => {
    expect(deriveBridgeStatus(null, now)).toBe('offline')
    expect(deriveBridgeStatus({ status: 'online', last_seen_at: 'not-a-date' }, now)).toBe('offline')
  })
})
