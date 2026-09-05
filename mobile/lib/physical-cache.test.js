// mobile/lib/physical-cache.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map()
let failWrites = false
// Simulates the process being killed part-way through a multi-key write:
// the Nth setItemAsync (1-based) and everything after it never lands.
let killWritesFrom = 0
let writeCount = 0
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (k) => (store.has(k) ? store.get(k) : null)),
  setItemAsync: vi.fn(async (k, v) => {
    writeCount += 1
    // SecureStore rejects values over its ~2 KB limit — the menu-cache
    // idiom this module copies treats that as "no speed-up", never a crash.
    if (failWrites) throw new Error('value too large')
    if (killWritesFrom && writeCount >= killWritesFrom) throw new Error('process killed')
    store.set(k, v)
  }),
  deleteItemAsync: vi.fn(async (k) => { store.delete(k) }),
}))

const mod = await import('./physical-cache.js')

const NOW = 1_700_000_000_000
const REGION = { location_id: 'loc-still', latitude: 53.2887, longitude: -6.197, radius_m: 150 }
const POSITION = { coords: { latitude: 53.2887, longitude: -6.197 }, timestamp: NOW - 1000 }
const RESULT_AT_STUDIO = { status: 'at_studio', location: { id: 'loc-still', name: 'Stillorgan' } }
// The location rides along deliberately: only the STATUS may decide whether a
// verdict is written.
const RESULT_OFFSITE = { status: 'offsite', location: { id: 'loc-still' } }

beforeEach(() => { store.clear(); failWrites = false; killWritesFrom = 0; writeCount = 0 })

describe('physical-location snapshot', () => {
  it('reads all-nulls when nothing has ever been written', async () => {
    expect(await mod.readPhysicalSnapshot(NOW)).toEqual({ at: null, regions: null, position: null, verdict: null })
  })
  it('round-trips regions, position and an at_studio verdict', async () => {
    await mod.writePhysicalSnapshot({ regions: [REGION], position: POSITION, result: RESULT_AT_STUDIO, nowMs: NOW })
    expect(await mod.readPhysicalSnapshot(NOW + 1000)).toEqual({
      at: NOW,
      regions: [REGION],
      position: POSITION,
      verdict: { locationId: 'loc-still', at: NOW },
    })
  })
  it('an OFFSITE resolve overwrites the verdict with null (a confirmed offsite kills the optimistic paint)', async () => {
    await mod.writePhysicalSnapshot({ regions: [REGION], position: POSITION, result: RESULT_AT_STUDIO, nowMs: NOW })
    await mod.writePhysicalSnapshot({ regions: [REGION], position: POSITION, result: RESULT_OFFSITE, nowMs: NOW + 1 })
    const read = await mod.readPhysicalSnapshot(NOW + 2)
    expect(read.verdict).toBe(null)
    expect(read.regions).toEqual([REGION])
  })
  it('applies the freshness rules on read (a 31-minute-old verdict is gone)', async () => {
    await mod.writePhysicalSnapshot({ regions: [REGION], position: POSITION, result: RESULT_AT_STUDIO, nowMs: NOW })
    const read = await mod.readPhysicalSnapshot(NOW + 31 * 60 * 1000)
    expect(read.verdict).toBe(null)
    expect(read.regions).toEqual([REGION]) // still inside 24h
  })
  it('carries the regions\' provenance through, so re-persisting does not re-date them', async () => {
    const obtained = NOW - 23 * 60 * 60 * 1000
    await mod.writePhysicalSnapshot({ regions: [REGION], regionsAt: obtained, position: POSITION, result: RESULT_AT_STUDIO, nowMs: NOW })
    expect((await mod.readPhysicalSnapshot(NOW)).regions).toEqual([REGION])
    // An hour later the same stored regions have aged past 24h — they would
    // not have if the write had stamped them `now`.
    expect((await mod.readPhysicalSnapshot(NOW + 61 * 60 * 1000)).regions).toBe(null)
  })
  it('an UNKNOWN resolve leaves the stored verdict and position alone', async () => {
    await mod.writePhysicalSnapshot({ regions: [REGION], position: POSITION, result: RESULT_AT_STUDIO, nowMs: NOW })
    // The offline / permission-denied / GPS-timeout launch: no regions, no
    // position, status unknown. It must not cost the next launch its head start.
    await mod.writePhysicalSnapshot({ regions: [], position: null, result: { status: 'unknown', location: null }, nowMs: NOW + 1000 })
    const read = await mod.readPhysicalSnapshot(NOW + 2000)
    expect(read.verdict).toEqual({ locationId: 'loc-still', at: NOW })
    expect(read.position).toEqual(POSITION)
  })
  it('but a carried verdict still expires on its own 30-minute clock', async () => {
    await mod.writePhysicalSnapshot({ regions: [REGION], position: POSITION, result: RESULT_AT_STUDIO, nowMs: NOW })
    // Carried forward 20 minutes later by an unknown resolve…
    await mod.writePhysicalSnapshot({ regions: [], position: null, result: { status: 'unknown' }, nowMs: NOW + 20 * 60 * 1000 })
    // …and still gone at 31 minutes: carrying it does not re-date it.
    expect((await mod.readPhysicalSnapshot(NOW + 31 * 60 * 1000)).verdict).toBe(null)
  })
  it('skips the write entirely when the caller says its generation is stale', async () => {
    await mod.writePhysicalSnapshot({
      regions: [REGION], position: POSITION, result: RESULT_AT_STUDIO, nowMs: NOW, isStale: () => true,
    })
    expect(store.size).toBe(0)
  })
  it('writes when isStale says otherwise, and when none is given', async () => {
    await mod.writePhysicalSnapshot({ regions: [REGION], position: POSITION, result: RESULT_AT_STUDIO, nowMs: NOW, isStale: () => false })
    expect((await mod.readPhysicalSnapshot(NOW)).verdict).not.toBe(null)
  })
  it('survives a corrupt value on disk', async () => {
    store.set('physical_location_snapshot_v1', '{ half a blob')
    expect(await mod.readPhysicalSnapshot(NOW)).toEqual({ at: null, regions: null, position: null, verdict: null })
  })
  it('never throws when the write fails (the >2 KB silent-failure case)', async () => {
    failWrites = true
    await expect(
      mod.writePhysicalSnapshot({ regions: [REGION], position: POSITION, result: RESULT_AT_STUDIO, nowMs: NOW }),
    ).resolves.toBeUndefined()
    expect(await mod.readPhysicalSnapshot(NOW)).toEqual({ at: null, regions: null, position: null, verdict: null })
  })
  it('a real snapshot is far inside the ~2 KB SecureStore value limit', async () => {
    const regions = [REGION, { ...REGION, location_id: 'loc-hatch' }]
    await mod.writePhysicalSnapshot({ regions, position: POSITION, result: RESULT_AT_STUDIO, nowMs: NOW })
    expect(store.get('physical_location_snapshot_v1').length).toBeLessThan(600)
  })
})

describe('shifts cache', () => {
  const SHIFTS = [{ id: 'a', shift_date: '2026-08-24', shift_templates: { name: 'AM', start_time: '06:00', end_time: '14:00' } }]

  it('round-trips one profile\'s shifts, slimmed', async () => {
    await mod.writeShiftsCache('p1', [{ ...SHIFTS[0], notes: 'x'.repeat(80), profiles: { full_name: 'Alex' } }], NOW)
    expect(await mod.readShiftsCache('p1', NOW + 1000)).toEqual(SHIFTS)
  })
  it('refuses to hand one user another user\'s shifts', async () => {
    await mod.writeShiftsCache('p1', SHIFTS, NOW)
    expect(await mod.readShiftsCache('p2', NOW)).toBe(null)
    expect(await mod.readShiftsCache('', NOW)).toBe(null)
    expect(await mod.readShiftsCache(null, NOW)).toBe(null)
  })
  it('drops a cache older than 24h', async () => {
    await mod.writeShiftsCache('p1', SHIFTS, NOW)
    expect(await mod.readShiftsCache('p1', NOW + 24 * 60 * 60 * 1000)).toEqual(SHIFTS)
    expect(await mod.readShiftsCache('p1', NOW + 24 * 60 * 60 * 1000 + 1)).toBe(null)
  })
  it('writes nothing for a falsy profile id', async () => {
    await mod.writeShiftsCache('', SHIFTS, NOW)
    await mod.writeShiftsCache(null, SHIFTS, NOW)
    expect(store.size).toBe(0)
  })
  it('never throws when the write fails', async () => {
    failWrites = true
    await expect(mod.writeShiftsCache('p1', SHIFTS, NOW)).resolves.toBeUndefined()
    expect(await mod.readShiftsCache('p1', NOW)).toBe(null)
  })
  it('indexes the key BEFORE writing it, so a mid-write kill cannot orphan a value', async () => {
    // Kill the process after the first of the two writes. Index-first means
    // the survivor is an index entry pointing at nothing (a benign delete);
    // value-first would leave a value no teardown can find, and on a shared
    // studio device that value outlives the sign-out that was meant to wipe it.
    killWritesFrom = 2
    await mod.writeShiftsCache('p1', SHIFTS, NOW)
    await mod.clearPhysicalCaches()
    expect(await mod.readShiftsCache('p1', NOW)).toBe(null)
    expect(store.size).toBe(0)
  })
  it('caches an empty week as a real answer, distinct from a miss', async () => {
    await mod.writeShiftsCache('p1', [], NOW)
    expect(await mod.readShiftsCache('p1', NOW)).toEqual([])
    expect(await mod.readShiftsCache('p2', NOW)).toBe(null)
  })
})

describe('clearPhysicalCaches (the sign-out teardown)', () => {
  it('wipes the snapshot AND every cached user\'s shifts', async () => {
    await mod.writePhysicalSnapshot({ regions: [REGION], position: POSITION, result: RESULT_AT_STUDIO, nowMs: NOW })
    await mod.writeShiftsCache('p1', [{ id: 'a', shift_date: '2026-08-24' }], NOW)
    await mod.writeShiftsCache('p2', [{ id: 'b', shift_date: '2026-08-24' }], NOW)
    await mod.clearPhysicalCaches()
    expect(await mod.readPhysicalSnapshot(NOW)).toEqual({ at: null, regions: null, position: null, verdict: null })
    expect(await mod.readShiftsCache('p1', NOW)).toBe(null)
    expect(await mod.readShiftsCache('p2', NOW)).toBe(null)
    // Nothing left behind — including the index itself.
    expect(store.size).toBe(0)
  })
  it('resolves even with nothing stored', async () => {
    await expect(mod.clearPhysicalCaches()).resolves.toBeUndefined()
  })
})
