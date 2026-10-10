// W1.M1 — the membership-source seam (src/lib/membership/source.js).
// locations.membership_source (mig 717) names the provider; this module
// resolves it and reports a four-state answer that never collapses a failed
// settings read into "no membership source".
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('./sources/glofox', () => ({
  glofoxSource: {
    key: 'glofox',
    label: 'Glofox',
    capabilities: { memberships: true, bookings: true, credits: true, invoices: true, schedule: true },
    isConfigured: vi.fn(async (_db, locationId) => (
      locationId === 'loc-ok' ? { configured: true }
        : locationId === 'loc-err' ? { configured: false, readError: 'GLOFOX_SETTINGS_UNREADABLE' }
          : { configured: false, missing: ['API Key'] }
    )),
  },
}))

import { logWarn } from '@/lib/log'
import {
  MEMBERSHIP_SOURCES, MEMBERSHIP_SOURCE_KEYS, providerFor, resolveMembershipSource, membershipSourceState,
} from './source'

const dbWith = (source, error = null) => ({
  from: (table) => {
    expect(table).toBe('locations')
    return {
      select: (cols) => {
        expect(cols).toBe('membership_source')
        return {
          eq: (col, id) => {
            expect(col).toBe('id')
            expect(id).toBeTruthy()
            return { maybeSingle: async () => (error ? { data: null, error } : { data: source === undefined ? null : { membership_source: source }, error: null }) }
          },
        }
      },
    }
  },
})

describe('membership source (W1.M1)', () => {
  it('registers none and glofox; un1t is a known key with no provider yet', () => {
    expect(Object.keys(MEMBERSHIP_SOURCES)).toEqual(['none', 'glofox'])
    expect(MEMBERSHIP_SOURCE_KEYS).toEqual(['none', 'glofox', 'un1t'])
    expect(MEMBERSHIP_SOURCES.none.capabilities).toEqual({ memberships: false, bookings: false, credits: false, invoices: false, schedule: false })
    expect(MEMBERSHIP_SOURCES.none.label).toBe('No membership source')
    expect(Object.isFrozen(MEMBERSHIP_SOURCES)).toBe(true)
  })

  it('every registered provider has the interface shape', () => {
    for (const p of Object.values(MEMBERSHIP_SOURCES)) {
      expect(typeof p.key).toBe('string')
      expect(typeof p.label).toBe('string')
      expect(Object.keys(p.capabilities).sort()).toEqual(['bookings', 'credits', 'invoices', 'memberships', 'schedule'])
      expect(typeof p.isConfigured).toBe('function')
    }
  })

  it('resolves the provider from locations.membership_source', async () => {
    expect((await resolveMembershipSource(dbWith('glofox'), 'loc-ok')).key).toBe('glofox')
    expect((await resolveMembershipSource(dbWith('none'), 'loc-ok')).key).toBe('none')
  })

  it('state: none | configured | unconfigured | unknown — a read error is never "none"', async () => {
    expect(await membershipSourceState(dbWith('none'), 'loc-ok')).toEqual({ source: 'none', state: 'none' })
    expect(await membershipSourceState(dbWith('glofox'), 'loc-ok')).toEqual({ source: 'glofox', state: 'configured' })
    expect(await membershipSourceState(dbWith('glofox'), 'loc-missing')).toEqual({ source: 'glofox', state: 'unconfigured', missing: ['API Key'] })
    expect(await membershipSourceState(dbWith('glofox'), 'loc-err')).toEqual({ source: 'glofox', state: 'unknown', readError: 'GLOFOX_SETTINGS_UNREADABLE' })
  })

  it('an unregistered value (a future "un1t" before its module lands) resolves to none with a warning, never throws', async () => {
    vi.mocked(logWarn).mockClear()
    expect((await resolveMembershipSource(dbWith('un1t'), 'loc-ok')).key).toBe('none')
    expect(logWarn).toHaveBeenCalledWith('membership-source', expect.stringMatching(/no provider/), expect.objectContaining({ key: 'un1t' }))
    expect(providerFor('made-up').key).toBe('none')
    expect(providerFor(null).key).toBe('none')
  })

  it('a failed locations read answers "unknown", not "none" (the column read is a claim, not a fact)', async () => {
    const state = await membershipSourceState(dbWith(undefined, { code: '57P01', message: 'terminating connection' }), 'loc-ok')
    expect(state).toEqual({ source: null, state: 'unknown', readError: 'MEMBERSHIP_SOURCE_UNREADABLE' })
    expect((await resolveMembershipSource(dbWith(undefined, { message: 'boom' }), 'loc-ok')).key).toBe('none')
  })

  it('a location that does not exist resolves to none (not an error)', async () => {
    expect((await resolveMembershipSource(dbWith(undefined), 'loc-gone')).key).toBe('none')
    expect(await membershipSourceState(dbWith(undefined), 'loc-gone')).toEqual({ source: 'none', state: 'none' })
  })

  it('refuses a missing db or location id without a query', async () => {
    expect((await resolveMembershipSource(null, 'loc-ok')).key).toBe('none')
    expect((await resolveMembershipSource(dbWith('glofox'), null)).key).toBe('none')
  })
})
