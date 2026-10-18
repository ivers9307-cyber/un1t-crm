// UN1TRADAR.1 — radar read APIs ask this before reading: a source whose
// provider lacks the memberships capability answers data:null + one skip log.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/membership/reads/index', () => ({ radarReadsFor: vi.fn() }))
vi.mock('@/lib/location-time', () => ({ getLocationZone: vi.fn(async () => 'Europe/Dublin') }))
vi.mock('@/lib/whatsapp-config', () => ({ getLocationWhatsAppNumberConfig: vi.fn() }))

import { logInfo } from '@/lib/log'
import { radarReadsFor } from '@/lib/membership/reads/index'
import { radarAvailability, RADAR_UNAVAILABLE, syncDataAsOf } from './radar-availability'
import { getLocationWhatsAppNumberConfig } from '@/lib/whatsapp-config'

const L = 'loc-1'

function runsDb(rows, { error = null } = {}) {
  const calls = []
  const api = {
    from(t) { calls.push(['from', t]); return api },
    select(c) { calls.push(['select', c]); return api },
    eq(c, v) { calls.push(['eq', c, v]); return api },
    not(c, op, v) { calls.push(['not', c, op, v]); return api },
    order(c, o) { calls.push(['order', c, o]); return api },
    limit(n) { calls.push(['limit', n]); return api },
    then(res, rej) { return Promise.resolve({ data: error ? null : rows, error }).then(res, rej) },
  }
  return { db: api, calls }
}

beforeEach(() => vi.clearAllMocks())

describe('radarAvailability', () => {
  it('capability false → unavailable, one skip log with locationId and source only', async () => {
    radarReadsFor.mockResolvedValue({ source: 'un1t_online', reads: {}, providesMemberships: false, pinArrears: false })
    const { db } = runsDb([])
    const a = await radarAvailability(db, L, { module: 'churn-radar' })
    expect(a).toEqual({ available: false, source: 'un1t_online', dataAsOf: null, dataAsOfZone: null })
    expect(logInfo).toHaveBeenCalledTimes(1)
    expect(logInfo).toHaveBeenCalledWith('churn-radar', 'radar skipped: source lacks memberships', { locationId: L, source: 'un1t_online' })
  })

  it('Glofox location → available, source "glofox", dataAsOf null, no sync read', async () => {
    radarReadsFor.mockResolvedValue({ source: 'glofox', reads: {}, providesMemberships: true, pinArrears: false })
    const { db, calls } = runsDb([])
    expect(await radarAvailability(db, L, { module: 'churn-radar' })).toEqual({ available: true, source: 'glofox', dataAsOf: null, dataAsOfZone: null })
    expect(calls).toEqual([])
    expect(logInfo).not.toHaveBeenCalled()
  })

  it('a un1t studio with the capability carries dataAsOf', async () => {
    radarReadsFor.mockResolvedValue({ source: 'un1t_online', reads: {}, providesMemberships: true, pinArrears: true })
    const { db } = runsDb([{ finished_at: '2026-10-18T11:45:00Z' }])
    expect(await radarAvailability(db, L, { module: 'lead-radar' })).toEqual({ available: true, source: 'un1t_online', dataAsOf: '2026-10-18T11:45:00Z', dataAsOfZone: null })
    expect(await radarAvailability(db, L, { module: 'churn-radar', withZone: true })).toEqual({ available: true, source: 'un1t_online', dataAsOf: '2026-10-18T11:45:00Z', dataAsOfZone: 'Europe/Dublin' })
  })

  it('an unreadable source throws (the route answers 500)', async () => {
    radarReadsFor.mockRejectedValue(Object.assign(new Error('x'), { code: 'MEMBERSHIP_SOURCE_UNREADABLE' }))
    await expect(radarAvailability({}, L, { module: 'churn-radar' })).rejects.toMatchObject({ code: 'MEMBERSHIP_SOURCE_UNREADABLE' })
  })

  it('RADAR_UNAVAILABLE is exact and frozen', () => {
    expect(RADAR_UNAVAILABLE).toEqual({ success: true, data: null, unavailable: 'memberships' })
    expect(Object.isFrozen(RADAR_UNAVAILABLE)).toBe(true)
  })
})

describe('syncDataAsOf', () => {
  it('dataAsOf is the newest ok un1t_sync_runs.finished_at at the location', async () => {
    const { db, calls } = runsDb([{ finished_at: '2026-10-18T11:45:00Z' }])
    expect(await syncDataAsOf(db, L)).toBe('2026-10-18T11:45:00Z')
    expect(calls).toContainEqual(['from', 'un1t_sync_runs'])
    expect(calls).toContainEqual(['eq', 'location_id', L])
    expect(calls).toContainEqual(['eq', 'status', 'ok'])
    expect(calls).toContainEqual(['order', 'finished_at', { ascending: false }])
    expect(calls).toContainEqual(['limit', 1])
  })
  it('no run, or a failed read, is null (the line is just not drawn)', async () => {
    expect(await syncDataAsOf(runsDb([]).db, L)).toBeNull()
    expect(await syncDataAsOf(runsDb([], { error: { message: 'boom' } }).db, L)).toBeNull()
  })
})

describe('radarAvailability withOutreach (UN1TRADAR.3)', () => {
  it('outreachAvailable: a number switched on at the studio → true; none → false; a failed read → false', async () => {
    radarReadsFor.mockResolvedValue({ source: 'glofox', reads: {}, providesMemberships: true, pinArrears: false })
    const { db } = runsDb([])
    getLocationWhatsAppNumberConfig.mockResolvedValueOnce({ phoneNumberId: 'p1' })
    expect((await radarAvailability(db, L, { module: 'churn-radar', withOutreach: true })).outreachAvailable).toBe(true)
    expect(getLocationWhatsAppNumberConfig).toHaveBeenCalledWith(L)
    getLocationWhatsAppNumberConfig.mockResolvedValueOnce(null)
    expect((await radarAvailability(db, L, { module: 'churn-radar', withOutreach: true })).outreachAvailable).toBe(false)
    getLocationWhatsAppNumberConfig.mockRejectedValueOnce(new Error('down'))
    expect((await radarAvailability(db, L, { module: 'churn-radar', withOutreach: true })).outreachAvailable).toBe(false)
  })
  it('not asked → no key and no read', async () => {
    radarReadsFor.mockResolvedValue({ source: 'glofox', reads: {}, providesMemberships: true, pinArrears: false })
    getLocationWhatsAppNumberConfig.mockClear()
    const a = await radarAvailability(runsDb([]).db, L, { module: 'churn-radar' })
    expect(Object.hasOwn(a, 'outreachAvailable')).toBe(false)
    expect(getLocationWhatsAppNumberConfig).not.toHaveBeenCalled()
  })
})
