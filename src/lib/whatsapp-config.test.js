// WA-MULTI.1 — config resolver contract tests.
//
// Three tiers in priority order:
//   1. whatsapp_numbers row for location, is_default=true (or any
//      is_active row if no default exists)
//   2. n/a — tier 1 fall-through into "any active row, newest first"
//      is in the same Supabase query (is_default DESC, updated_at DESC)
//   3. Global env vars (WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, …)
//
// We mock @/lib/supabase and the env vars to lock the priority
// ordering. The fallback to env vars is the most security-sensitive
// path — every test asserts the resolver doesn't silently fall
// through when it shouldn't.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const {
  getWhatsAppConfig,
  getWhatsAppConfigById,
  resolveWhatsAppNumberByPhoneNumberId,
} = await import('./whatsapp-config.js')

// Build a mock Supabase client whose .from('whatsapp_numbers')
// chain resolves to the given rows.
function mockDb({ rows, error } = {}) {
  return {
    from: vi.fn(() => {
      const builder = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: rows?.[0] ?? null, error: error ?? null }),
        then: (onF) => Promise.resolve({ data: rows ?? [], error: error ?? null }).then(onF),
      }
      return builder
    }),
  }
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  createServerClient.mockReset()
  // Clear any leftover env from previous tests.
  delete process.env.WHATSAPP_ACCESS_TOKEN
  delete process.env.WHATSAPP_PHONE_NUMBER_ID
  delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID
  delete process.env.WHATSAPP_APP_ID
})

describe('getWhatsAppConfig — tier 1 (db row)', () => {
  it('returns the default row when present', async () => {
    createServerClient.mockReturnValue(mockDb({
      rows: [{
        id: 'n1', location_id: 'loc-1', label: 'Main',
        phone_number_id: 'PNI-123', business_account_id: 'WABA-456',
        app_id: 'APP-789', access_token: 'tok-default',
        display_phone: '+353 1 234 5678', source: 'cloud_api',
        is_default: true, is_active: true,
      }],
    }))
    const cfg = await getWhatsAppConfig('loc-1')
    expect(cfg.source).toBe('db')
    expect(cfg.token).toBe('tok-default')
    expect(cfg.phoneNumberId).toBe('PNI-123')
    expect(cfg.businessAccountId).toBe('WABA-456')
    expect(cfg.appId).toBe('APP-789')
    expect(cfg.sourceKind).toBe('cloud_api')
  })

  it('falls back to is_active=true row when no default exists', async () => {
    createServerClient.mockReturnValue(mockDb({
      rows: [{
        id: 'n2', location_id: 'loc-1', label: 'Backup',
        phone_number_id: 'PNI-999', access_token: 'tok-active',
        source: 'cloud_api', is_default: false, is_active: true,
      }],
    }))
    const cfg = await getWhatsAppConfig('loc-1')
    expect(cfg.source).toBe('db')
    expect(cfg.token).toBe('tok-active')
  })
})

describe('getWhatsAppConfig — tier 3 (env fallback)', () => {
  it('falls back to env vars when no rows exist for the location', async () => {
    createServerClient.mockReturnValue(mockDb({ rows: [] }))
    process.env.WHATSAPP_ACCESS_TOKEN = 'env-token'
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-pni'
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = 'env-waba'

    const cfg = await getWhatsAppConfig('loc-with-no-rows')
    expect(cfg.source).toBe('env')
    expect(cfg.token).toBe('env-token')
    expect(cfg.phoneNumberId).toBe('env-pni')
    expect(cfg.businessAccountId).toBe('env-waba')
  })

  it('falls back to env even when locationId is null/undefined (legacy callers)', async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = 'env-token'
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-pni'

    const cfg = await getWhatsAppConfig(null)
    expect(cfg.source).toBe('env')
    expect(cfg.phoneNumberId).toBe('env-pni')
    // createServerClient should not even be called when locationId is null
    expect(createServerClient).not.toHaveBeenCalled()
  })
})

describe('getWhatsAppConfig — no config anywhere', () => {
  it('throws a precise error when both DB + env are empty', async () => {
    createServerClient.mockReturnValue(mockDb({ rows: [] }))
    await expect(getWhatsAppConfig('loc-1')).rejects.toThrow(/WhatsApp not configured/)
  })

  it('surfaces the location id in the error message for debugging', async () => {
    createServerClient.mockReturnValue(mockDb({ rows: [] }))
    await expect(getWhatsAppConfig('loc-abc-123')).rejects.toThrow(/loc-abc-123/)
  })
})

describe('getWhatsAppConfigById', () => {
  it('loads a specific number id and returns the row config', async () => {
    createServerClient.mockReturnValue(mockDb({
      rows: [{
        id: 'specific-1', location_id: 'loc-x', label: 'Marketing',
        phone_number_id: 'PNI-x', access_token: 'tok-x', source: 'cloud_api',
        is_default: false, is_active: true,
      }],
    }))
    const cfg = await getWhatsAppConfigById('specific-1')
    expect(cfg.id).toBe('specific-1')
    expect(cfg.token).toBe('tok-x')
  })

  it('throws when the id is missing or inactive', async () => {
    createServerClient.mockReturnValue(mockDb({ rows: [] }))
    await expect(getWhatsAppConfigById('missing-id')).rejects.toThrow(/not found or inactive/)
  })

  it('throws when no id is passed', async () => {
    await expect(getWhatsAppConfigById('')).rejects.toThrow(/requires a numberId/)
  })
})

describe('resolveWhatsAppNumberByPhoneNumberId — inbound webhook routing', () => {
  it('returns the row matching the phone_number_id', async () => {
    createServerClient.mockReturnValue(mockDb({
      rows: [{
        id: 'r1', location_id: 'loc-1', label: 'L',
        phone_number_id: 'PNI-MATCH', access_token: 'tok',
        source: 'cloud_api', is_default: true, is_active: true,
      }],
    }))
    const cfg = await resolveWhatsAppNumberByPhoneNumberId('PNI-MATCH')
    expect(cfg?.locationId).toBe('loc-1')
  })

  it('falls back to env config when phone_number_id matches env\'s', async () => {
    createServerClient.mockReturnValue(mockDb({ rows: [] }))
    process.env.WHATSAPP_ACCESS_TOKEN = 'env-token'
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-pni-routed'

    const cfg = await resolveWhatsAppNumberByPhoneNumberId('env-pni-routed')
    expect(cfg?.source).toBe('env')
  })

  it('returns null when the phone_number_id is unknown', async () => {
    createServerClient.mockReturnValue(mockDb({ rows: [] }))
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'different-pni'

    const cfg = await resolveWhatsAppNumberByPhoneNumberId('unknown-pni')
    expect(cfg).toBe(null)
  })

  it('returns null on empty input rather than crashing', async () => {
    expect(await resolveWhatsAppNumberByPhoneNumberId('')).toBe(null)
    expect(await resolveWhatsAppNumberByPhoneNumberId(null)).toBe(null)
    expect(await resolveWhatsAppNumberByPhoneNumberId(undefined)).toBe(null)
  })
})

// Restore env after the suite to avoid leaking into other tests.
afterAll(() => {
  process.env = { ...ORIGINAL_ENV }
})
