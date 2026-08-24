// mobile/lib/physical-snapshot.test.js
import { describe, it, expect } from 'vitest'
import {
  parsePhysicalSnapshot,
  buildPhysicalSnapshot,
  freshVerdict,
  verdictFromResult,
  slimShiftsForCache,
  buildShiftsSnapshot,
  parseShiftsSnapshot,
  REGIONS_MAX_AGE_MS,
  VERDICT_MAX_AGE_MS,
  SHIFTS_MAX_AGE_MS,
} from './physical-snapshot'

const NOW = 1_700_000_000_000
const REGION = { location_id: 'loc-still', latitude: 53.2887, longitude: -6.197, radius_m: 150 }
const POSITION = { coords: { latitude: 53.2887, longitude: -6.197 }, timestamp: NOW - 1000 }
const EMPTY = { at: null, regions: null, position: null, verdict: null }

const snapshotJson = (over = {}) => JSON.stringify({
  at: NOW - 1000,
  regions: [REGION],
  position: POSITION,
  verdict: { locationId: 'loc-still', at: NOW - 1000 },
  ...over,
})

describe('parsePhysicalSnapshot — unusable input', () => {
  it('returns all-nulls for null/empty/malformed JSON rather than throwing', () => {
    expect(parsePhysicalSnapshot(null, NOW)).toEqual(EMPTY)
    expect(parsePhysicalSnapshot('', NOW)).toEqual(EMPTY)
    expect(parsePhysicalSnapshot('{not json', NOW)).toEqual(EMPTY)
    expect(parsePhysicalSnapshot('[1,2,3]', NOW)).toEqual(EMPTY)
    expect(parsePhysicalSnapshot('"a string"', NOW)).toEqual(EMPTY)
    expect(parsePhysicalSnapshot('42', NOW)).toEqual(EMPTY)
  })
  it('returns all-nulls when nowMs is not a finite number (cannot age anything)', () => {
    expect(parsePhysicalSnapshot(snapshotJson(), NaN)).toEqual(EMPTY)
    expect(parsePhysicalSnapshot(snapshotJson(), undefined)).toEqual(EMPTY)
    expect(parsePhysicalSnapshot(snapshotJson(), null)).toEqual(EMPTY)
  })
  it('drops everything age-gated when `at` is missing or non-finite (absent is not zero)', () => {
    const r = parsePhysicalSnapshot(snapshotJson({ at: undefined }), NOW)
    expect(r.at).toBe(null)
    expect(r.regions).toBe(null)
    // The position is NOT gated on the snapshot's `at` — it carries its own
    // timestamp, which pickPosition gates at use time.
    expect(r.position).toEqual(POSITION)
    // The verdict carries its own `at` too, so it survives.
    expect(r.verdict).toEqual({ locationId: 'loc-still', at: NOW - 1000 })
    expect(parsePhysicalSnapshot(snapshotJson({ at: '1700000000000' }), NOW).regions).toBe(null)
  })
})

describe('parsePhysicalSnapshot — valid round trip', () => {
  it('returns the regions, position and verdict of a fresh snapshot', () => {
    expect(parsePhysicalSnapshot(snapshotJson(), NOW)).toEqual({
      at: NOW - 1000,
      regions: [REGION],
      position: POSITION,
      verdict: { locationId: 'loc-still', at: NOW - 1000 },
    })
  })
  it('accepts an already-parsed object as well as a JSON string', () => {
    expect(parsePhysicalSnapshot(JSON.parse(snapshotJson()), NOW).regions).toEqual([REGION])
  })
  it('round-trips what buildPhysicalSnapshot writes', () => {
    const built = buildPhysicalSnapshot({
      regions: [REGION],
      position: POSITION,
      result: { status: 'at_studio', location: { id: 'loc-still', name: 'Stillorgan' } },
      nowMs: NOW,
    })
    expect(parsePhysicalSnapshot(JSON.stringify(built), NOW + 1000)).toEqual({
      at: NOW,
      regions: [REGION],
      position: POSITION,
      verdict: { locationId: 'loc-still', at: NOW },
    })
  })
})

describe('parsePhysicalSnapshot — regions freshness + shape', () => {
  it('keeps regions just inside 24h and drops them just outside', () => {
    const inside = parsePhysicalSnapshot(snapshotJson({ at: NOW - REGIONS_MAX_AGE_MS }), NOW)
    expect(inside.regions).toEqual([REGION])
    const outside = parsePhysicalSnapshot(snapshotJson({ at: NOW - REGIONS_MAX_AGE_MS - 1 }), NOW)
    expect(outside.regions).toBe(null)
    // …and the rest of the snapshot survives the regions being dropped.
    expect(outside.position).toEqual(POSITION)
  })
  it('drops regions written in the future beyond the window (a clock change must not look fresh)', () => {
    expect(parsePhysicalSnapshot(snapshotJson({ at: NOW + REGIONS_MAX_AGE_MS + 1 }), NOW).regions).toBe(null)
    expect(parsePhysicalSnapshot(snapshotJson({ at: NOW + 1000 }), NOW).regions).toEqual([REGION])
  })
  it('skips malformed regions instead of coercing them (absent is not zero)', () => {
    const bad = { location_id: 'x', latitude: null, longitude: undefined, radius_m: '150' }
    expect(parsePhysicalSnapshot(snapshotJson({ regions: [bad, REGION] }), NOW).regions).toEqual([REGION])
    expect(parsePhysicalSnapshot(snapshotJson({ regions: [bad] }), NOW).regions).toBe(null)
    expect(parsePhysicalSnapshot(snapshotJson({ regions: [{ ...REGION, location_id: '' }] }), NOW).regions).toBe(null)
  })
  it('drops a regions value that is not an array, and an empty one', () => {
    expect(parsePhysicalSnapshot(snapshotJson({ regions: {} }), NOW).regions).toBe(null)
    expect(parsePhysicalSnapshot(snapshotJson({ regions: [] }), NOW).regions).toBe(null)
    expect(parsePhysicalSnapshot(snapshotJson({ regions: undefined }), NOW).regions).toBe(null)
  })
  it('normalises regions to the four fields the resolver reads (keeps the blob small)', () => {
    const fat = { ...REGION, name: 'Stillorgan gym floor', created_at: '2026-01-01', notes: 'x'.repeat(500) }
    expect(parsePhysicalSnapshot(snapshotJson({ regions: [fat] }), NOW).regions).toEqual([REGION])
  })
})

describe('parsePhysicalSnapshot — position shape', () => {
  it('keeps a position with a stale timestamp (pickPosition owns that gate, not this one)', () => {
    const old = { coords: { latitude: 1, longitude: 2 }, timestamp: NOW - 10 * 60 * 60 * 1000 }
    expect(parsePhysicalSnapshot(snapshotJson({ position: old }), NOW).position).toEqual(old)
  })
  it('drops a position with non-finite coords or no usable timestamp', () => {
    const drop = (position) => parsePhysicalSnapshot(snapshotJson({ position }), NOW).position
    expect(drop({ coords: { latitude: null, longitude: 2 }, timestamp: NOW })).toBe(null)
    expect(drop({ coords: { latitude: 1, longitude: undefined }, timestamp: NOW })).toBe(null)
    expect(drop({ coords: { latitude: 1, longitude: 2 } })).toBe(null)
    expect(drop({ coords: { latitude: 1, longitude: 2 }, timestamp: 'now' })).toBe(null)
    expect(drop({ timestamp: NOW })).toBe(null)
    expect(drop(null)).toBe(null)
  })
  it('normalises the position to coords + timestamp only', () => {
    const fat = { coords: { latitude: 1, longitude: 2, accuracy: 5, altitude: 30, heading: 12 }, timestamp: NOW, mocked: false }
    expect(parsePhysicalSnapshot(snapshotJson({ position: fat }), NOW).position)
      .toEqual({ coords: { latitude: 1, longitude: 2 }, timestamp: NOW })
  })
})

describe('parsePhysicalSnapshot — verdict freshness', () => {
  it('keeps a verdict just inside 30 minutes and drops it just outside', () => {
    const v = (at) => parsePhysicalSnapshot(snapshotJson({ verdict: { locationId: 'loc-still', at } }), NOW).verdict
    expect(v(NOW - VERDICT_MAX_AGE_MS)).toEqual({ locationId: 'loc-still', at: NOW - VERDICT_MAX_AGE_MS })
    expect(v(NOW - VERDICT_MAX_AGE_MS - 1)).toBe(null)
    expect(v(NOW + VERDICT_MAX_AGE_MS + 1)).toBe(null)
  })
  it('is aged on the verdict OWN `at`, not the snapshot `at`', () => {
    // Snapshot fresh, verdict old → no verdict.
    const r = parsePhysicalSnapshot(snapshotJson({ at: NOW, verdict: { locationId: 'l', at: NOW - VERDICT_MAX_AGE_MS - 1 } }), NOW)
    expect(r.at).toBe(NOW)
    expect(r.verdict).toBe(null)
    // Snapshot old (regions dropped), verdict fresh → verdict survives.
    const r2 = parsePhysicalSnapshot(snapshotJson({ at: NOW - REGIONS_MAX_AGE_MS - 1, verdict: { locationId: 'l', at: NOW - 60_000 } }), NOW)
    expect(r2.regions).toBe(null)
    expect(r2.verdict).toEqual({ locationId: 'l', at: NOW - 60_000 })
  })
  it('drops a verdict with no locationId, a non-string one, or a non-finite at', () => {
    const v = (verdict) => parsePhysicalSnapshot(snapshotJson({ verdict }), NOW).verdict
    expect(v({ at: NOW })).toBe(null)
    expect(v({ locationId: '', at: NOW })).toBe(null)
    expect(v({ locationId: 7, at: NOW })).toBe(null)
    expect(v({ locationId: 'l' })).toBe(null)
    expect(v({ locationId: 'l', at: 'now' })).toBe(null)
    expect(v(null)).toBe(null)
  })
})

const RESULT_AT_STUDIO_FIXTURE = { status: 'at_studio', location: { id: 'loc-still' } }

describe('buildPhysicalSnapshot', () => {
  const position = POSITION
  it('stamps a verdict ONLY for an at_studio result', () => {
    const at_studio = buildPhysicalSnapshot({
      regions: [REGION], position, result: { status: 'at_studio', location: { id: 'loc-still' } }, nowMs: NOW,
    })
    expect(at_studio.verdict).toEqual({ locationId: 'loc-still', at: NOW })
    for (const status of ['offsite', 'unknown', 'loading']) {
      // The location object is present on purpose: the STATUS is the only
      // thing that may decide this, never "did we happen to carry a location".
      const r = buildPhysicalSnapshot({ regions: [REGION], position, result: { status, location: { id: 'loc-still' } }, nowMs: NOW })
      // A CONFIRMED offsite must kill the optimistic paint, not leave the
      // previous verdict standing.
      expect(r.verdict).toBe(null)
    }
  })
  it('writes no verdict for an at_studio result with no location id', () => {
    const r = buildPhysicalSnapshot({ regions: [], position, result: { status: 'at_studio', location: null }, nowMs: NOW })
    expect(r.verdict).toBe(null)
  })
  it('normalises regions and position, and stamps `at`', () => {
    const r = buildPhysicalSnapshot({
      regions: [{ ...REGION, notes: 'x'.repeat(400) }, { location_id: 'bad' }],
      position: { coords: { latitude: 1, longitude: 2, accuracy: 9 }, timestamp: NOW, extra: 1 },
      result: { status: 'offsite', location: null },
      nowMs: NOW,
    })
    expect(r.at).toBe(NOW)
    expect(r.regions).toEqual([REGION])
    expect(r.position).toEqual({ coords: { latitude: 1, longitude: 2 }, timestamp: NOW })
  })
  it('stamps `at` with the regions\' OWN provenance when given one', () => {
    const obtained = NOW - 20 * 60 * 60 * 1000
    const r = buildPhysicalSnapshot({
      regions: [REGION], regionsAt: obtained, position, result: RESULT_AT_STUDIO_FIXTURE, nowMs: NOW,
    })
    // Regions age from when they were FETCHED …
    expect(r.at).toBe(obtained)
    // … while the verdict is stamped now, so re-persisting old regions does
    // not re-date them, and 4 more hours offline ages them out.
    expect(r.verdict).toEqual({ locationId: 'loc-still', at: NOW })
    expect(parsePhysicalSnapshot(JSON.stringify(r), NOW + 5 * 60 * 60 * 1000).regions).toBe(null)
  })
  it('falls back to nowMs when regionsAt is absent or not finite', () => {
    const args = { regions: [REGION], position, result: RESULT_AT_STUDIO_FIXTURE, nowMs: NOW }
    expect(buildPhysicalSnapshot(args).at).toBe(NOW)
    expect(buildPhysicalSnapshot({ ...args, regionsAt: null }).at).toBe(NOW)
    expect(buildPhysicalSnapshot({ ...args, regionsAt: 'yesterday' }).at).toBe(NOW)
  })
  it('tolerates a missing position/regions/result without throwing', () => {
    const r = buildPhysicalSnapshot({ regions: null, position: null, result: null, nowMs: NOW })
    expect(r).toEqual({ at: NOW, regions: [], position: null, verdict: null })
  })
})

describe('verdictFromResult', () => {
  it('stamps the detected location for at_studio only', () => {
    expect(verdictFromResult({ status: 'at_studio', location: { id: 'loc-still' } }, NOW))
      .toEqual({ locationId: 'loc-still', at: NOW })
    for (const status of ['offsite', 'unknown', 'loading', undefined]) {
      expect(verdictFromResult({ status, location: { id: 'loc-still' } }, NOW)).toBe(null)
    }
  })
  it('returns null for a missing location, a non-string id, or a non-finite clock', () => {
    expect(verdictFromResult({ status: 'at_studio', location: null }, NOW)).toBe(null)
    expect(verdictFromResult({ status: 'at_studio', location: { id: 7 } }, NOW)).toBe(null)
    expect(verdictFromResult({ status: 'at_studio', location: { id: 'l' } }, NaN)).toBe(null)
    expect(verdictFromResult(null, NOW)).toBe(null)
  })
})

describe('freshVerdict', () => {
  it('passes a verdict inside the window and rejects one outside it', () => {
    const v = { locationId: 'loc-still', at: NOW - VERDICT_MAX_AGE_MS }
    // Normalised, not passed through: extra fields are stripped on the way out.
    expect(freshVerdict({ ...v, stray: 'x' }, NOW)).toEqual(v)
    expect(freshVerdict({ locationId: 'loc-still', at: NOW - VERDICT_MAX_AGE_MS - 1 }, NOW)).toBe(null)
    expect(freshVerdict({ locationId: 'loc-still', at: NOW + VERDICT_MAX_AGE_MS + 1 }, NOW)).toBe(null)
  })
  it('rejects a malformed verdict and a non-finite clock', () => {
    expect(freshVerdict(null, NOW)).toBe(null)
    expect(freshVerdict({ locationId: 'l' }, NOW)).toBe(null)
    expect(freshVerdict({ at: NOW }, NOW)).toBe(null)
    expect(freshVerdict({ locationId: 'l', at: NOW }, NaN)).toBe(null)
  })
})

describe('slimShiftsForCache', () => {
  const fat = {
    id: 'a1',
    shift_date: '2026-08-24',
    start_time_override: '06:00:00',
    end_time_override: '14:00:00',
    location_id: 'loc-still',
    locations: { id: 'loc-still', name: 'Stillorgan', address: '…', timezone: 'Europe/Dublin' },
    shift_templates: { name: 'Coach AM', start_time: '06:00:00', end_time: '14:00:00', role_label: 'Coach', colour: '#fff' },
    profiles: { id: 'p1', full_name: 'Dean', email: 'dean@example.com', avatar_url: 'https://…' },
    notes: 'a very long note '.repeat(20),
    status: 'confirmed',
  }
  it('keeps only the fields Home renders', () => {
    expect(slimShiftsForCache([fat])).toEqual([{
      id: 'a1',
      shift_date: '2026-08-24',
      start_time_override: '06:00:00',
      end_time_override: '14:00:00',
      location_id: 'loc-still',
      locations: { id: 'loc-still', name: 'Stillorgan' },
      shift_templates: { name: 'Coach AM', start_time: '06:00:00', end_time: '14:00:00' },
    }])
  })
  it('drops absent optional branches rather than writing nulls for them', () => {
    const [row] = slimShiftsForCache([{ id: 'a', shift_date: '2026-08-24' }])
    expect(row).toEqual({ id: 'a', shift_date: '2026-08-24' })
    expect(Object.keys(row)).toEqual(['id', 'shift_date'])
  })
  it('drops rows with no usable shift_date, and tolerates a non-array', () => {
    expect(slimShiftsForCache([{ id: 'a' }, null, 7, fat])).toHaveLength(1)
    expect(slimShiftsForCache(null)).toEqual([])
    expect(slimShiftsForCache(undefined)).toEqual([])
    expect(slimShiftsForCache('nope')).toEqual([])
  })
  it('is much smaller than the raw row (that is the whole point)', () => {
    expect(JSON.stringify(slimShiftsForCache([fat])).length).toBeLessThan(JSON.stringify([fat]).length / 2)
  })
})

describe('parseShiftsSnapshot', () => {
  const raw = (over = {}) => JSON.stringify(buildShiftsSnapshot({
    profileId: 'p1',
    shifts: [{ id: 'a', shift_date: '2026-08-24' }],
    nowMs: NOW - 1000,
    ...over,
  }))

  it('round-trips its own writer for the SAME profile', () => {
    expect(parseShiftsSnapshot(raw(), { profileId: 'p1', nowMs: NOW }))
      .toEqual([{ id: 'a', shift_date: '2026-08-24' }])
  })
  it('refuses another user\'s cached shifts (a shared studio device)', () => {
    expect(parseShiftsSnapshot(raw(), { profileId: 'p2', nowMs: NOW })).toBe(null)
    expect(parseShiftsSnapshot(raw(), { profileId: '', nowMs: NOW })).toBe(null)
    expect(parseShiftsSnapshot(raw(), { profileId: null, nowMs: NOW })).toBe(null)
    expect(parseShiftsSnapshot(raw({ profileId: null }), { profileId: 'p1', nowMs: NOW })).toBe(null)
  })
  it('keeps a snapshot just inside 24h and drops one just outside', () => {
    expect(parseShiftsSnapshot(raw({ nowMs: NOW - SHIFTS_MAX_AGE_MS }), { profileId: 'p1', nowMs: NOW })).toHaveLength(1)
    expect(parseShiftsSnapshot(raw({ nowMs: NOW - SHIFTS_MAX_AGE_MS - 1 }), { profileId: 'p1', nowMs: NOW })).toBe(null)
    expect(parseShiftsSnapshot(raw({ nowMs: NOW + SHIFTS_MAX_AGE_MS + 1 }), { profileId: 'p1', nowMs: NOW })).toBe(null)
  })
  it('returns null for malformed JSON, a missing body, or a non-finite clock', () => {
    expect(parseShiftsSnapshot(null, { profileId: 'p1', nowMs: NOW })).toBe(null)
    expect(parseShiftsSnapshot('{oops', { profileId: 'p1', nowMs: NOW })).toBe(null)
    expect(parseShiftsSnapshot('[]', { profileId: 'p1', nowMs: NOW })).toBe(null)
    expect(parseShiftsSnapshot(raw(), { profileId: 'p1', nowMs: NaN })).toBe(null)
    expect(parseShiftsSnapshot(JSON.stringify({ profileId: 'p1', at: 'x', shifts: [] }), { profileId: 'p1', nowMs: NOW })).toBe(null)
  })
  it('returns [] for a cached EMPTY week (a real answer, not a cache miss)', () => {
    expect(parseShiftsSnapshot(raw({ shifts: [] }), { profileId: 'p1', nowMs: NOW })).toEqual([])
  })
  it('returns null when shifts is not an array, and re-slims what it reads', () => {
    expect(parseShiftsSnapshot(JSON.stringify({ profileId: 'p1', at: NOW, shifts: {} }), { profileId: 'p1', nowMs: NOW })).toBe(null)
    const dirty = JSON.stringify({ profileId: 'p1', at: NOW, shifts: [{ id: 'a', shift_date: '2026-08-24', notes: 'x'.repeat(50) }, { id: 'b' }] })
    expect(parseShiftsSnapshot(dirty, { profileId: 'p1', nowMs: NOW })).toEqual([{ id: 'a', shift_date: '2026-08-24' }])
  })
})
