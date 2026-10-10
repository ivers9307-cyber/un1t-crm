// W1.M3b — locationsWithSource: the crons' discovery of the locations a
// membership source serves. Through the seam only (listLocationsByMembershipSource
// + membershipSourceState); never settings->'glofox'. A failed read is an error
// with every list null, never "no locations".
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('./sources/glofox', () => ({
  glofoxSource: {
    key: 'glofox',
    label: 'Glofox',
    capabilities: { memberships: true, bookings: true, credits: true, invoices: true, schedule: true },
    isConfigured: vi.fn(async (_db, locationId) => (
      locationId === 'loc-missing' ? { configured: false, missing: ['API Key'] }
        : locationId === 'loc-err' ? { configured: false, readError: 'GLOFOX_SETTINGS_UNREADABLE' }
          : { configured: true }
    )),
  },
}))

import { logWarn, logError } from '@/lib/log'
import { fakeDb } from '@/lib/time-off.test-helpers'
import { answerLocations, locationRow, FULL_GLOFOX_SLICE } from './locations-for-source.test-helpers'
import { locationsWithSource, skippedSummary, noSourceLocationIds } from './locations-for-source'

const ROWS = [
  locationRow({ id: 'loc-a', name: 'Stillorgan', source: 'glofox', settings: FULL_GLOFOX_SLICE }),
  locationRow({ id: 'loc-b', name: 'Hatch', source: 'none', settings: FULL_GLOFOX_SLICE }), // slice says yes, column says no
  locationRow({ id: 'loc-err', name: 'Blip', source: 'glofox' }),
  locationRow({ id: 'loc-inactive', name: 'Closed', source: 'glofox', active: false }),
  locationRow({ id: 'loc-missing', name: 'Half set up', source: 'glofox' }),
  locationRow({ id: 'loc-registry', name: 'Registry only', source: 'glofox', settings: null }),
]
const dbOf = (rows = ROWS, { listError = null } = {}) => fakeDb((q) => {
  if (q.table !== 'locations') throw new Error(`unexpected ${q.action} on ${q.table}`)
  if (listError && q.eq.membership_source) return { data: null, error: listError }
  return answerLocations(q, rows)
})

beforeEach(() => vi.clearAllMocks())

describe('locationsWithSource (W1.M3b)', () => {
  it('returns only ACTIVE locations on that source, each with its state; eligible = configured, the rest skipped', async () => {
    const out = await locationsWithSource(dbOf(), 'glofox', { module: 'test-cron' })
    expect(out.error).toBeNull()
    expect(out.locations.map((l) => l.id)).toEqual(['loc-a', 'loc-err', 'loc-missing', 'loc-registry'])
    expect(out.eligible.map((l) => l.id)).toEqual(['loc-a', 'loc-registry'])
    expect(out.eligible[0]).toEqual({ id: 'loc-a', name: 'Stillorgan', source: 'glofox', state: 'configured' })
    expect(out.skipped).toEqual([
      { id: 'loc-err', name: 'Blip', source: 'glofox', state: 'unknown', readError: 'GLOFOX_SETTINGS_UNREADABLE' },
      { id: 'loc-missing', name: 'Half set up', source: 'glofox', state: 'unconfigured', missing: ['API Key'] },
    ])
  })

  it('a location whose settings.glofox slice is complete but whose membership_source is none is NOT listed (discovery no longer sniffs the slice)', async () => {
    const out = await locationsWithSource(dbOf(), 'glofox')
    expect(out.locations.find((l) => l.id === 'loc-b')).toBeUndefined()
  })

  it('a registry-only location (no legacy slice) IS listed when its source says glofox', async () => {
    const out = await locationsWithSource(dbOf(), 'glofox')
    expect(out.eligible.map((l) => l.id)).toContain('loc-registry')
  })

  it('logs every skip loudly: unconfigured at warn, unknown at error, tagged with the caller module', async () => {
    await locationsWithSource(dbOf(), 'glofox', { module: 'glofox-sync' })
    expect(logWarn).toHaveBeenCalledWith('glofox-sync', expect.stringMatching(/not configured/), expect.objectContaining({ locationId: 'loc-missing', state: 'unconfigured', missing: ['API Key'] }))
    expect(logError).toHaveBeenCalledWith('glofox-sync', expect.stringMatching(/unknown/), expect.objectContaining({ locationId: 'loc-err', readError: 'GLOFOX_SETTINGS_UNREADABLE' }))
  })

  it('a failed list read is an error with every list null, never "no locations"', async () => {
    const out = await locationsWithSource(dbOf(ROWS, { listError: { message: 'boom' } }), 'glofox')
    expect(out).toEqual({ locations: null, eligible: null, skipped: null, error: { message: 'boom' } })
  })

  it('a failed row read (names) is an error too', async () => {
    const db = fakeDb((q) => (q.calls.some(([op]) => op === 'in') ? { data: null, error: { message: 'rows down' } } : answerLocations(q, ROWS)))
    const out = await locationsWithSource(db, 'glofox', { module: 'm' })
    expect(out.locations).toBeNull()
    expect(out.error).toEqual({ message: 'rows down' })
    expect(logError).toHaveBeenCalledWith('m', expect.stringMatching(/unreadable/), expect.objectContaining({ key: 'glofox' }))
  })

  it('no location on the source is an empty list, not an error', async () => {
    const out = await locationsWithSource(dbOf([locationRow({ id: 'x', source: 'none' })]), 'glofox')
    expect(out).toEqual({ locations: [], eligible: [], skipped: [], error: null })
  })

  it('skippedSummary counts by state', () => {
    expect(skippedSummary([{ state: 'unknown' }, { state: 'unconfigured' }, { state: 'unconfigured' }])).toEqual({ skipped_unconfigured: 2, skipped_unknown: 1 })
    expect(skippedSummary(null)).toEqual({ skipped_unconfigured: 0, skipped_unknown: 0 })
  })
})

describe('noSourceLocationIds (W1.M3b)', () => {
  it('is the set of membership_source = none ids', async () => {
    const out = await noSourceLocationIds(dbOf())
    expect(out.error).toBeNull()
    expect([...out.ids]).toEqual(['loc-b'])
  })

  it('a failed read is ids null with the error — never an empty set', async () => {
    const out = await noSourceLocationIds(dbOf(ROWS, { listError: { message: 'boom' } }))
    expect(out).toEqual({ ids: null, error: { message: 'boom' } })
  })
})
