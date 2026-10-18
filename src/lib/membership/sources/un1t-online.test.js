// UN1TSYNC.5 — the un1t.online provider: configured = an active registry row
// holding a token AND a studio id. A failed registry read is readError, never
// "missing" (REGISTRYREAD.1).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const read = vi.fn()
vi.mock('@/lib/connection-registry', () => ({ readConnection: (...a) => read(...a) }))

import { un1tOnlineSource } from './un1t-online'

const conn = (over = {}) => ({
  conn: { source: 'registry', platform: 'un1t_online', status: 'connected', accessToken: 'un1t_tok', externalAccountId: 'studio-9', ...over },
  error: null,
})

describe('un1tOnlineSource (UN1TSYNC.5)', () => {
  beforeEach(() => read.mockReset())

  it('is the un1t_online provider; invoices and credits are on (HATCHINV.1: payments, subscriptions and past-due rows are read from un1t_invoices; MIAHATCH.2: Mia reports a members credits)', () => {
    expect(un1tOnlineSource.key).toBe('un1t_online')
    expect(un1tOnlineSource.label).toBe('un1t.online')
    expect(un1tOnlineSource.capabilities).toEqual({ memberships: false, bookings: false, credits: true, invoices: true, schedule: false })
    expect(Object.isFrozen(un1tOnlineSource)).toBe(true)
    expect(Object.isFrozen(un1tOnlineSource.capabilities)).toBe(true)
  })

  it('configured with a token and a studio on the registry row', async () => {
    read.mockResolvedValue(conn())
    const db = {}
    expect(await un1tOnlineSource.isConfigured(db, 'loc-1')).toEqual({ configured: true })
    expect(read).toHaveBeenCalledWith(db, 'loc-1', 'un1t_online')
  })

  it('no row: both api_token and studio are missing', async () => {
    read.mockResolvedValue({ conn: { source: 'legacy', status: 'not_connected', isActive: false, accessToken: null, externalAccountId: null }, error: null })
    expect(await un1tOnlineSource.isConfigured({}, 'loc-1')).toEqual({ configured: false, missing: ['api_token', 'studio'] })
  })

  it('a row without a studio id names only the studio', async () => {
    read.mockResolvedValue(conn({ externalAccountId: null }))
    expect(await un1tOnlineSource.isConfigured({}, 'loc-1')).toEqual({ configured: false, missing: ['studio'] })
  })

  it('a row without a token names only the api_token', async () => {
    read.mockResolvedValue(conn({ accessToken: '' }))
    expect(await un1tOnlineSource.isConfigured({}, 'loc-1')).toEqual({ configured: false, missing: ['api_token'] })
  })

  it('a failed registry read is readError, never "missing"', async () => {
    read.mockResolvedValue({ conn: null, error: { message: 'boom' } })
    expect(await un1tOnlineSource.isConfigured({}, 'loc-1')).toEqual({ configured: false, readError: 'UN1T_ONLINE_CONNECTION_UNREADABLE' })
  })
})
