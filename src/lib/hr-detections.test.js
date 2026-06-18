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
