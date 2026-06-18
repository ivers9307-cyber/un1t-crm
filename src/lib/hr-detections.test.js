// src/lib/hr-detections.test.js
import { describe, it, expect } from 'vitest'
import {
  DETECTION_VISIT_GAP_MS,
  aggregateSamplesByDevice,
  planDetectionWrites,
} from './hr-detections'

const NOW_MS = 1781784000000          // fixed clock
const NOW_ISO = new Date(NOW_MS).toISOString()

// Deterministic id generator for tests.
function counterId() {
  let n = 0
  return () => `id-${++n}`
}

describe('aggregateSamplesByDevice', () => {
  it('groups by canonical device_key with peak + latest bpm + count', () => {
    const out = aggregateSamplesByDevice([
      { device_key: 'ant:45075', recorded_at: '2026-06-18T10:00:00Z', bpm: 120 },
      { device_key: 'ant:45075', recorded_at: '2026-06-18T10:00:05Z', bpm: 150 },
      { device_key: 'ant:45075', recorded_at: '2026-06-18T10:00:02Z', bpm: 90 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ deviceKey: 'ant:45075', latestBpm: 150, peakBpm: 150, count: 3 })
    expect(out[0].latestAt).toBe('2026-06-18T10:00:05Z')
  })

  it('drops samples with an unparseable device_key', () => {
    const out = aggregateSamplesByDevice([
      { device_key: 'garbage', bpm: 100 },
      { device_key: 'ble:AA:BB:CC:DD:EE:FF', recorded_at: '2026-06-18T10:00:00Z', bpm: 110 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].deviceKey).toBe('ble:AA:BB:CC:DD:EE:FF')
  })

  it('counts a null-bpm sample as a detection without setting bpm', () => {
    const out = aggregateSamplesByDevice([{ device_key: 'ant:1', recorded_at: '2026-06-18T10:00:00Z' }])
    expect(out[0]).toMatchObject({ deviceKey: 'ant:1', latestBpm: null, peakBpm: null, count: 1 })
  })
})

describe('planDetectionWrites — new device (samples)', () => {
  it('inserts a registry row + opens visit #1', () => {
    const { registryRows, visitRows } = planDetectionWrites({
      existingDetections: [], existingVisits: [],
      entries: [{ deviceKey: 'ant:45075', latestBpm: 150, peakBpm: 150, count: 4, name: null, rssi: null }],
      locationId: 'loc1', nowMs: NOW_MS, nowIso: NOW_ISO,
      liveClass: { glofox_event_id: 'ev1', class_name: 'RIDE' }, bridgeId: 'br1',
      touchVisits: true, newId: counterId(),
    })
    expect(registryRows).toHaveLength(1)
    expect(registryRows[0]).toMatchObject({
      location_id: 'loc1', device_key: 'ant:45075', protocol: 'ant',
      first_seen_at: NOW_ISO, last_seen_at: NOW_ISO, last_bpm: 150, last_bridge_id: 'br1',
      visit_count: 1,
    })
    expect(registryRows[0].current_visit_id).toBe(visitRows[0].id)
    expect(visitRows).toHaveLength(1)
    expect(visitRows[0]).toMatchObject({
      detection_id: registryRows[0].id, location_id: 'loc1', device_key: 'ant:45075',
      started_at: NOW_ISO, last_sample_at: NOW_ISO, peak_bpm: 150, last_bpm: 150,
      sample_count: 4, glofox_event_id: 'ev1', class_name: 'RIDE',
    })
  })
})

describe('planDetectionWrites — existing device, visit boundary', () => {
  const existingDetections = [{
    id: 'det1', device_key: 'ant:1', first_seen_at: '2026-06-01T00:00:00Z',
    last_seen_at: NOW_ISO, last_bpm: 100, last_name: 'Polar', last_rssi: -50,
    visit_count: 2, current_visit_id: 'v9',
  }]

  it('extends the open visit when within the gap', () => {
    const existingVisits = [{
      id: 'v9', detection_id: 'det1',
      started_at: '2026-06-18T09:00:00Z',
      last_sample_at: new Date(NOW_MS - 60_000).toISOString(),  // 1 min ago
      peak_bpm: 140, last_bpm: 120, sample_count: 30, glofox_event_id: 'ev1', class_name: 'RIDE',
    }]
    const { registryRows, visitRows } = planDetectionWrites({
      existingDetections, existingVisits,
      entries: [{ deviceKey: 'ant:1', latestBpm: 160, peakBpm: 160, count: 5, name: null, rssi: null }],
      locationId: 'loc1', nowMs: NOW_MS, nowIso: NOW_ISO, touchVisits: true, newId: counterId(),
    })
    expect(registryRows[0].visit_count).toBe(2)                 // unchanged
    expect(registryRows[0].current_visit_id).toBe('v9')
    expect(visitRows[0]).toMatchObject({
      id: 'v9', started_at: '2026-06-18T09:00:00Z',            // preserved
      last_sample_at: NOW_ISO, peak_bpm: 160, last_bpm: 160, sample_count: 35,
      glofox_event_id: 'ev1', class_name: 'RIDE',
    })
  })

  it('opens a new visit when the gap is exceeded', () => {
    const existingVisits = [{
      id: 'v9', detection_id: 'det1',
      started_at: '2026-06-18T08:00:00Z',
      last_sample_at: new Date(NOW_MS - (DETECTION_VISIT_GAP_MS + 60_000)).toISOString(),
      peak_bpm: 140, last_bpm: 120, sample_count: 30,
    }]
    const { registryRows, visitRows } = planDetectionWrites({
      existingDetections, existingVisits,
      entries: [{ deviceKey: 'ant:1', latestBpm: 130, peakBpm: 130, count: 2, name: null, rssi: null }],
      locationId: 'loc1', nowMs: NOW_MS, nowIso: NOW_ISO, touchVisits: true, newId: counterId(),
    })
    expect(registryRows[0].visit_count).toBe(3)                 // incremented
    expect(visitRows[0].id).toBe('id-1')                        // fresh id
    expect(registryRows[0].current_visit_id).toBe('id-1')
    expect(visitRows[0]).toMatchObject({ started_at: NOW_ISO, last_sample_at: NOW_ISO, sample_count: 2 })
  })

  it('does not clobber last_bpm / first_seen_at with nulls', () => {
    const { registryRows } = planDetectionWrites({
      existingDetections, existingVisits: [{ id: 'v9', last_sample_at: NOW_ISO, started_at: NOW_ISO }],
      entries: [{ deviceKey: 'ant:1', latestBpm: null, peakBpm: null, count: 1, name: null, rssi: null }],
      locationId: 'loc1', nowMs: NOW_MS, nowIso: NOW_ISO, touchVisits: true, newId: counterId(),
    })
    expect(registryRows[0].last_bpm).toBe(100)                  // kept
    expect(registryRows[0].first_seen_at).toBe('2026-06-01T00:00:00Z')
  })
})

describe('planDetectionWrites — scan enrich (touchVisits=false)', () => {
  it('updates registry metadata without producing visit rows', () => {
    const { registryRows, visitRows } = planDetectionWrites({
      existingDetections: [{ id: 'det1', device_key: 'ble:AA:BB:CC:DD:EE:FF', first_seen_at: '2026-06-01T00:00:00Z', visit_count: 1, current_visit_id: 'v1', last_bpm: 100 }],
      existingVisits: [],
      entries: [{ deviceKey: 'ble:AA:BB:CC:DD:EE:FF', latestBpm: null, peakBpm: null, count: 0, name: 'Polar H10', rssi: -42 }],
      locationId: 'loc1', nowMs: NOW_MS, nowIso: NOW_ISO, touchVisits: false, newId: counterId(),
    })
    expect(visitRows).toHaveLength(0)
    expect(registryRows[0]).toMatchObject({ last_name: 'Polar H10', last_rssi: -42, last_seen_at: NOW_ISO, visit_count: 1 })
    expect(registryRows[0].last_bpm).toBe(100)                  // preserved
  })
})

import { recordDetections, recordScanMetadata, resolveDetectionLinks } from './hr-detections'
import { vi } from 'vitest'

// Minimal supabase-js builder fake. Every chain method returns the builder; the
// builder is a thenable that resolves `handlers(ctx)`. Records upserts.
function makeDb(handlers) {
  return {
    from(table) {
      const ctx = { table, op: 'select', filters: {} }
      const b = {
        select(cols) { ctx.cols = cols; return b },
        upsert(rows, opts) { ctx.op = 'upsert'; ctx.rows = rows; ctx.opts = opts; return b },
        update(patch) { ctx.op = 'update'; ctx.patch = patch; return b },
        insert(rows) { ctx.op = 'insert'; ctx.rows = rows; return b },
        eq(c, v) { ctx.filters[c] = v; return b },
        is(c, v) { ctx.filters[c] = v; return b },
        in(c, v) { ctx.filters[c] = v; return b },
        not() { return b },
        gte() { return b },
        lte() { return b },
        order() { return b },
        limit() { return b },
        maybeSingle() { ctx.single = true; return b },
        single() { ctx.single = true; return b },
        then(resolve, reject) {
          try { resolve(handlers(ctx) ?? { data: null, error: null }) } catch (e) { reject(e) }
        },
      }
      return b
    },
  }
}

describe('recordDetections (IO)', () => {
  it('reads registry + current visits, then upserts planned rows', async () => {
    const calls = []
    const db = makeDb((ctx) => {
      calls.push({ table: ctx.table, op: ctx.op })
      if (ctx.table === 'hr_detections' && ctx.op === 'select') return { data: [], error: null }
      if (ctx.table === 'hr_detection_visits' && ctx.op === 'select') return { data: [], error: null }
      if (ctx.table === 'class_occurrences') return { data: [], error: null }   // no live class
      if (ctx.op === 'upsert') return { error: null }
      return { data: null, error: null }
    })
    const out = await recordDetections(db, {
      locationId: 'loc1', bridgeId: 'br1',
      samples: [{ device_key: 'ant:45075', recorded_at: '2026-06-18T10:00:00Z', bpm: 150 }],
      nowMs: NOW_MS,
    })
    expect(out).toMatchObject({ ok: true, recorded: 1 })
    expect(calls.some((c) => c.table === 'hr_detections' && c.op === 'upsert')).toBe(true)
    expect(calls.some((c) => c.table === 'hr_detection_visits' && c.op === 'upsert')).toBe(true)
  })

  it('no-ops on an empty batch', async () => {
    const db = makeDb(() => ({ data: [], error: null }))
    expect(await recordDetections(db, { locationId: 'loc1', bridgeId: 'br1', samples: [], nowMs: NOW_MS })).toEqual({ ok: true, recorded: 0 })
  })

  it('degrades gracefully (returns ok:false, does not throw) on a read error', async () => {
    const db = makeDb((ctx) => {
      if (ctx.table === 'hr_detections' && ctx.op === 'select') return { data: null, error: { message: 'boom' } }
      return { data: [], error: null }
    })
    const out = await recordDetections(db, {
      locationId: 'loc1', bridgeId: 'br1',
      samples: [{ device_key: 'ant:1', bpm: 100, recorded_at: '2026-06-18T10:00:00Z' }], nowMs: NOW_MS,
    })
    expect(out).toEqual({ ok: false })
  })
})

describe('recordScanMetadata (IO)', () => {
  it('upserts registry only — never visits', async () => {
    const tables = []
    const db = makeDb((ctx) => {
      if (ctx.op === 'upsert') tables.push(ctx.table)
      if (ctx.table === 'hr_detections' && ctx.op === 'select') return { data: [], error: null }
      return { data: null, error: null }
    })
    const out = await recordScanMetadata(db, {
      locationId: 'loc1', bridgeId: 'br1',
      straps: [{ device_key: 'ble:AA:BB:CC:DD:EE:FF', name: 'Polar', rssi: -50, last_bpm: 120, seen_at: NOW_ISO }],
      nowMs: NOW_MS,
    })
    expect(out).toEqual({ ok: true })
    expect(tables).toEqual(['hr_detections'])
  })
})

describe('resolveDetectionLinks (IO)', () => {
  it('attaches linked_contact + live_now', async () => {
    const db = makeDb((ctx) => {
      if (ctx.table === 'contact_devices') {
        return { data: [{ identifier: 'ant:1', contact_id: 'c1', contacts: { id: 'c1', name: 'Jo B', location_id: 'loc1' } }], error: null }
      }
      if (ctx.table === 'heart_rate_sessions') {
        return { data: [{ device_identifier: 'ant:2' }], error: null }
      }
      return { data: [], error: null }
    })
    const out = await resolveDetectionLinks(db, {
      locationId: 'loc1',
      detections: [{ device_key: 'ant:1' }, { device_key: 'ant:2' }, { device_key: 'ant:3' }],
    })
    expect(out[0]).toMatchObject({ device_key: 'ant:1', linked_contact: { id: 'c1', name: 'Jo B' }, live_now: false })
    expect(out[1]).toMatchObject({ device_key: 'ant:2', linked_contact: null, live_now: true })
    expect(out[2]).toMatchObject({ device_key: 'ant:3', linked_contact: null, live_now: false })
  })

  it('returns [] for no detections', async () => {
    const db = makeDb(() => ({ data: [], error: null }))
    expect(await resolveDetectionLinks(db, { locationId: 'loc1', detections: [] })).toEqual([])
  })
})
