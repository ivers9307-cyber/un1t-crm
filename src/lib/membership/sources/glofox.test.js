// W1.M1 — the Glofox provider answers isConfigured off the registry-first
// credentials read, and carries readError through (never "not configured").
import { describe, it, expect, vi, beforeEach } from 'vitest'

const creds = vi.fn()
vi.mock('@/lib/glofox', async () => {
  const actual = await vi.importActual('@/lib/glofox')
  return { ...actual, glofoxCredentialsForLocation: (...a) => creds(...a) }
})

import { glofoxSource } from './glofox'

const full = { branchId: 'b1', apiKey: 'k', apiToken: 't', namespace: null, trainerNames: null, hiddenClassKeywords: null, webhookSecret: null, readError: null }

describe('glofoxSource (W1.M1)', () => {
  beforeEach(() => creds.mockReset())

  it('is the glofox provider with every capability', () => {
    expect(glofoxSource.key).toBe('glofox')
    expect(glofoxSource.label).toBe('Glofox')
    expect(glofoxSource.capabilities).toEqual({ memberships: true, bookings: true, credits: true, invoices: true, schedule: true })
    expect(Object.isFrozen(glofoxSource)).toBe(true)
    expect(Object.isFrozen(glofoxSource.capabilities)).toBe(true)
  })

  it('configured when all three credentials are present', async () => {
    creds.mockResolvedValue(full)
    const db = {}
    expect(await glofoxSource.isConfigured(db, 'loc-1')).toEqual({ configured: true })
    expect(creds).toHaveBeenCalledWith(db, 'loc-1')
  })

  it('unconfigured lists the missing credentials by their operator names', async () => {
    creds.mockResolvedValue({ ...full, apiKey: null, apiToken: null })
    expect(await glofoxSource.isConfigured({}, 'loc-1')).toEqual({ configured: false, missing: ['API Key', 'API Token'] })
  })

  it('a failed settings read is readError, never "missing"', async () => {
    creds.mockResolvedValue({ ...full, branchId: null, apiKey: null, apiToken: null, readError: 'GLOFOX_SETTINGS_UNREADABLE' })
    expect(await glofoxSource.isConfigured({}, 'loc-1')).toEqual({ configured: false, readError: 'GLOFOX_SETTINGS_UNREADABLE' })
  })
})
