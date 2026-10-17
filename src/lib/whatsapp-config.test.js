// WA-MULTI.1 — config resolver contract tests.
//
// Resolution order:
//   1. whatsapp_numbers row for location, is_default=true (or any
//      is_active row if no default exists)
//   2. n/a — tier 1 fall-through into "any active row, newest first"
//      is in the same Supabase query (is_default DESC, updated_at DESC)
//   Nothing else: WACONFIGFALLBACK.1 retired the global env tier. A
//   location with no row gets a WhatsAppNumberMissingError, never the
//   WHATSAPP_* env number, even when those env vars are set (the tests
//   below set them to prove they are ignored).

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { WhatsAppNumberMissingError, isWhatsAppNumberMissing } = await import('./whatsapp-number-missing.js')
const {
  getWhatsAppConfig,
  getWhatsAppConfigById,
  getLocationWhatsAppNumberConfig,
  getLocationNumberForWaba,
  resolveWhatsAppNumberByPhoneNumberId,
  classifyInboundOwner,
  studiosUsingNumbers,
  locationsWithWhatsApp,
} = await import('./whatsapp-config.js')
const { fakeWhatsAppDb, link } = await import('./whatsapp-numbers-fake-db.test-helpers.js')

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

describe('getWhatsAppConfig — tier 1 (a number switched on at the studio)', () => {
  it('returns the default row when present', async () => {
    createServerClient.mockReturnValue(fakeWhatsAppDb({
      numbers: [{
        id: 'n1', location_id: 'loc-1', organization_id: 'org-1', label: 'Main',
        phone_number_id: 'PNI-123', business_account_id: 'WABA-456',
        app_id: 'APP-789', access_token: 'tok-default',
        display_phone: '+353 1 234 5678', source: 'cloud_api',
        is_default: true, is_active: true,
      }],
      links: [link('loc-1', 'n1', { is_default: true })],
    }))
    const cfg = await getWhatsAppConfig('loc-1')
    expect(cfg.source).toBe('db')
    expect(cfg.token).toBe('tok-default')
    expect(cfg.phoneNumberId).toBe('PNI-123')
    expect(cfg.businessAccountId).toBe('WABA-456')
    expect(cfg.appId).toBe('APP-789')
    expect(cfg.sourceKind).toBe('cloud_api')
  })

  it('falls back to a switched-on active number when no link is the default', async () => {
    createServerClient.mockReturnValue(fakeWhatsAppDb({
      numbers: [{
        id: 'n2', location_id: 'loc-1', organization_id: 'org-1', label: 'Backup',
        phone_number_id: 'PNI-999', access_token: 'tok-active',
        source: 'cloud_api', is_default: false, is_active: true,
      }],
      links: [link('loc-1', 'n2')],
    }))
    const cfg = await getWhatsAppConfig('loc-1')
    expect(cfg.source).toBe('db')
    expect(cfg.token).toBe('tok-active')
  })
})

// WACONFIGFALLBACK.1 — the env tier is retired. With the env vars SET, a
// location with no row still refuses: the old fallback sent from another
// studio's number (and replies routed to that studio's inbox and Mia).
describe('getWhatsAppConfig — no own number → typed refusal, never the env number', () => {
  it('no rows for the location → WhatsAppNumberMissingError, env vars ignored', async () => {
    createServerClient.mockReturnValue(mockDb({ rows: [] }))
    process.env.WHATSAPP_ACCESS_TOKEN = 'env-token'
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-pni'
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = 'env-waba'

    const err = await getWhatsAppConfig('loc-with-no-rows').catch((e) => e)
    expect(err).toBeInstanceOf(WhatsAppNumberMissingError)
    expect(isWhatsAppNumberMissing(err)).toBe(true)
    expect(err.locationId).toBe('loc-with-no-rows')
    expect(err.message).toBe('No WhatsApp number is connected at this location.')
  })

  it('no location id → WhatsAppNumberMissingError without a query (a caller that named no location)', async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = 'env-token'
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-pni'

    const err = await getWhatsAppConfig(null).catch((e) => e)
    expect(isWhatsAppNumberMissing(err)).toBe(true)
    expect(err.locationId).toBeNull()
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('a failed lookup throws a plain error, never the typed refusal (a blip is not "no number")', async () => {
    createServerClient.mockReturnValue(mockDb({ error: { message: 'db down' } }))
    const err = await getWhatsAppConfig('loc-1').catch((e) => e)
    expect(err.message).toMatch(/Failed to load WhatsApp config for location loc-1: db down/)
    expect(isWhatsAppNumberMissing(err)).toBe(false)
  })
})

// WAROLE.1 — the location's OWN number, never the env tier. A write that
// changes what Meta shows on "this studio's number" (chat openers) must not
// land on the legacy global number when the studio has none of its own.
describe('getLocationWhatsAppNumberConfig — the location tier only (WAROLE.1)', () => {
  it("returns the location's switched-on active number, default first", async () => {
    createServerClient.mockReturnValue(fakeWhatsAppDb({
      numbers: [{ id: 'n1', location_id: 'loc-1', organization_id: 'org-1', label: 'Main', phone_number_id: 'PNI-123', access_token: 'tok-default', source: 'cloud_api', is_default: true, is_active: true }],
      links: [link('loc-1', 'n1', { is_default: true })],
    }))
    const cfg = await getLocationWhatsAppNumberConfig('loc-1')
    expect(cfg).toMatchObject({ source: 'db', id: 'n1', locationId: 'loc-1', homeLocationId: 'loc-1', organizationId: 'org-1', viaSibling: false, phoneNumberId: 'PNI-123', token: 'tok-default' })
  })

  it('no row at the location → null, even with the global env number set (never the env tier)', async () => {
    createServerClient.mockReturnValue(mockDb({ rows: [] }))
    process.env.WHATSAPP_ACCESS_TOKEN = 'env-token'
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-pni'
    expect(await getLocationWhatsAppNumberConfig('loc-with-no-rows')).toBeNull()
  })

  it('a failed lookup throws (never read as "no number")', async () => {
    createServerClient.mockReturnValue(mockDb({ error: { message: 'boom' } }))
    process.env.WHATSAPP_ACCESS_TOKEN = 'env-token'
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-pni'
    await expect(getLocationWhatsAppNumberConfig('loc-1')).rejects.toThrow(/boom/)
  })

  it('no location id → null without a query (there is no "this location")', async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = 'env-token'
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-pni'
    expect(await getLocationWhatsAppNumberConfig(null)).toBeNull()
    expect(createServerClient).not.toHaveBeenCalled()
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
    expect(cfg?.homeLocationId).toBe('loc-1')
  })

  it('WACONFIGFALLBACK.1 — an id equal to the (ignored) env number with no row → null (unknown), never an env config', async () => {
    createServerClient.mockReturnValue(mockDb({ rows: [] }))
    process.env.WHATSAPP_ACCESS_TOKEN = 'env-token'
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-pni-routed'

    expect(await resolveWhatsAppNumberByPhoneNumberId('env-pni-routed')).toBe(null)
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

// WA-TECHPROV.4b — transient lookup errors must never look like
// "unknown number". supabase-js never throws; errors come back as
// { error }, so returning null here would be indistinguishable from a
// genuinely unregistered number. The webhook drops BOTH (SAAS-2), but
// the throw keeps the two cases separately loggable.
describe('resolveWhatsAppNumberByPhoneNumberId — lookup errors (WA-TECHPROV.4b)', () => {
  it('lookup error → THROWS even when the id equals the (ignored) env number (webhook catch → drop + structured log)', async () => {
    createServerClient.mockReturnValue(mockDb({ error: { message: 'boom' } }))
    process.env.WHATSAPP_ACCESS_TOKEN = 'env-token'
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-pni-live'

    await expect(resolveWhatsAppNumberByPhoneNumberId('env-pni-live'))
      .rejects.toThrow(/lookup failed/)
  })

  it('lookup error + no env config at all → THROWS, never returns null', async () => {
    createServerClient.mockReturnValue(mockDb({ error: { message: 'boom' } }))

    await expect(resolveWhatsAppNumberByPhoneNumberId('any-pni'))
      .rejects.toThrow(/lookup failed/)
  })
})

// SAAS-2 — only an active whatsapp_numbers row may own inbound traffic.
// The first_location action is gone: routing a message we can't
// attribute into the first locations row was a cross-tenant leak.
describe('classifyInboundOwner — SAAS-2 strict tenant routing', () => {
  it('unknown phone_number_id (resolver returned null) → drop', () => {
    expect(classifyInboundOwner(null)).toEqual({ action: 'drop' })
  })
  it('a config with no location (the retired env shape) → drop, never a guessed tenant', () => {
    expect(classifyInboundOwner({ source: 'env', phoneNumberId: 'PNI-SYNTH' }))
      .toEqual({ action: 'drop' })
  })
  it('db row with a home studio → route to the number’s home studio (WAORGNUMBER.1: homeLocationId, not the studio a config was resolved for)', () => {
    expect(classifyInboundOwner({ source: 'db', locationId: 'L-for', homeLocationId: 'L9' }))
      .toEqual({ action: 'location', locationId: 'L9', numberId: null })
  })
  it('db row somehow missing its home studio → drop, never a guessed tenant', () => {
    expect(classifyInboundOwner({ source: 'db', locationId: 'L-for', homeLocationId: null }))
      .toEqual({ action: 'drop' })
  })
})

// WAORGNUMBER.1 (R2) — numbers belong to the organisation and are switched on
// per studio (location_whatsapp_numbers, mig 736). A config is resolved FOR a
// studio: locationId is that studio, homeLocationId the number's own studio.
describe('WAORGNUMBER.1 — the resolver reads location_whatsapp_numbers', () => {
  const STILL = 'a0000000-0000-4000-8000-000000000001'
  const HATCH = 'a0000000-0000-4000-8000-000000000002'
  const OTHER = 'a0000000-0000-4000-8000-000000000003'
  const n = (id, extra = {}) => ({
    id, location_id: STILL, organization_id: 'org-1', label: id, phone_number_id: `PNI-${id}`,
    business_account_id: 'WABA-1', access_token: `tok-${id}`, source: 'cloud_api', is_default: false, is_active: true, ...extra,
  })

  it('resolves the link default before a newer non-default', async () => {
    createServerClient.mockReturnValue(fakeWhatsAppDb({
      numbers: [n('n-default'), n('n-newer')],
      links: [
        link(STILL, 'n-default', { is_default: true, created_at: '2026-01-01T00:00:00Z' }),
        link(STILL, 'n-newer', { created_at: '2026-10-01T00:00:00Z' }),
      ],
    }))
    expect((await getLocationWhatsAppNumberConfig(STILL)).id).toBe('n-default')
  })

  it('with no link default, the most recently switched-on number', async () => {
    createServerClient.mockReturnValue(fakeWhatsAppDb({
      numbers: [n('n-old'), n('n-newer')],
      links: [link(STILL, 'n-old', { created_at: '2026-01-01T00:00:00Z' }), link(STILL, 'n-newer', { created_at: '2026-10-01T00:00:00Z' })],
    }))
    expect((await getLocationWhatsAppNumberConfig(STILL)).id).toBe('n-newer')
  })

  it('a number that is not switched on at the studio is not resolved there, even at its home', async () => {
    createServerClient.mockReturnValue(fakeWhatsAppDb({ numbers: [n('n-1')], links: [link(HATCH, 'n-1', { is_default: true })] }))
    expect(await getLocationWhatsAppNumberConfig(STILL)).toBeNull()
    await expect(getWhatsAppConfig(STILL)).rejects.toSatisfy(isWhatsAppNumberMissing)
  })

  it('inactive number is not resolved even when switched on', async () => {
    createServerClient.mockReturnValue(fakeWhatsAppDb({
      numbers: [n('n-off', { is_active: false })],
      links: [link(STILL, 'n-off', { is_default: true })],
    }))
    expect(await getLocationWhatsAppNumberConfig(STILL)).toBeNull()
  })

  it('config carries locationId = the studio asked for and homeLocationId = the number’s home', async () => {
    createServerClient.mockReturnValue(fakeWhatsAppDb({
      numbers: [n('n-still', { organization_id: 'org-1' })],
      links: [link(STILL, 'n-still', { is_default: true }), link(HATCH, 'n-still', { is_default: true })],
    }))
    const cfg = await getLocationWhatsAppNumberConfig(HATCH)
    expect(cfg).toMatchObject({ id: 'n-still', locationId: HATCH, homeLocationId: STILL, organizationId: 'org-1', viaSibling: false })
    expect((await getWhatsAppConfig(STILL))).toMatchObject({ locationId: STILL, homeLocationId: STILL })
  })

  it('getLocationNumberForWaba picks the number on that WABA', async () => {
    createServerClient.mockReturnValue(fakeWhatsAppDb({
      numbers: [n('n-a', { business_account_id: 'WABA-1' }), n('n-b', { business_account_id: 'WABA-2' })],
      links: [link(STILL, 'n-a', { is_default: true }), link(STILL, 'n-b')],
    }))
    expect((await getLocationNumberForWaba(STILL, 'WABA-2')).id).toBe('n-b')
    expect((await getLocationNumberForWaba(STILL, 'WABA-1')).id).toBe('n-a')
    expect(await getLocationNumberForWaba(STILL, 'WABA-9')).toBeNull()
    expect((await getLocationNumberForWaba(STILL, null)).id).toBe('n-a')
    expect(await getLocationNumberForWaba(HATCH, 'WABA-2')).toBeNull()
  })

  it('getLocationNumberForWaba throws on a failed read', async () => {
    createServerClient.mockReturnValue(fakeWhatsAppDb({ faults: { location_whatsapp_numbers: { message: 'boom' } } }))
    await expect(getLocationNumberForWaba(STILL, 'WABA-1')).rejects.toThrow(/boom/)
  })

  it('locationsWithWhatsApp returns only studios with an active switched-on number', async () => {
    const db = fakeWhatsAppDb({
      numbers: [n('n-on'), n('n-off', { is_active: false })],
      links: [link(STILL, 'n-on', { is_default: true }), link(HATCH, 'n-off', { is_default: true })],
    })
    const got = await locationsWithWhatsApp(db, [STILL, HATCH, OTHER])
    expect(got).toBeInstanceOf(Set)
    expect([...got]).toEqual([STILL])
    expect([...(await locationsWithWhatsApp(db, []))]).toEqual([])
  })

  it('locationsWithWhatsApp throws on a failed read', async () => {
    const db = fakeWhatsAppDb({ faults: { location_whatsapp_numbers: { message: 'boom' } } })
    await expect(locationsWithWhatsApp(db, [STILL])).rejects.toThrow(/boom/)
  })

  it('studiosUsingNumbers returns every studio linked to the number', async () => {
    const db = fakeWhatsAppDb({
      numbers: [n('n-1'), n('n-2')],
      links: [link(STILL, 'n-1', { is_default: true }), link(HATCH, 'n-1'), link(OTHER, 'n-2', { is_default: true })],
    })
    expect((await studiosUsingNumbers(db, ['n-1'])).sort()).toEqual([STILL, HATCH].sort())
    expect((await studiosUsingNumbers(db, ['n-1', 'n-2'])).sort()).toEqual([STILL, HATCH, OTHER].sort())
    expect(await studiosUsingNumbers(db, [])).toEqual([])
  })

  it('studiosUsingNumbers throws on a failed read', async () => {
    const db = fakeWhatsAppDb({ faults: { location_whatsapp_numbers: { message: 'boom' } } })
    await expect(studiosUsingNumbers(db, ['n-1'])).rejects.toThrow(/boom/)
  })

  it('getWhatsAppConfigById names the number’s home studio', async () => {
    createServerClient.mockReturnValue(fakeWhatsAppDb({ numbers: [n('n-1', { location_id: HATCH })] }))
    expect(await getWhatsAppConfigById('n-1')).toMatchObject({ id: 'n-1', locationId: HATCH, homeLocationId: HATCH, viaSibling: false })
  })
})

// Restore env after the suite to avoid leaking into other tests.
afterAll(() => {
  process.env = { ...ORIGINAL_ENV }
})
