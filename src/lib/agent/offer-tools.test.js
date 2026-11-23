import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../tests/helpers/fake-db'

vi.mock('./offer-read', () => ({ readCurrentOffers: vi.fn() }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://studio.test') }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { readCurrentOffers } from './offer-read'
import { OFFER_TOOLS, OFFER_TOOL_NAMES, executeOfferTool } from './offer-tools'

const ORG = '00000000-0000-4000-8000-0000000000a1'
const LOC = '00000000-0000-4000-8000-0000000000b1'
const db = () => createFakeDb({ tables: { locations: [{ id: LOC, name: 'UN1T Stillorgan', slug: 'un1t-stillorgan', organization_id: ORG, timezone: 'Europe/Dublin' }] } })

beforeEach(() => { vi.mocked(readCurrentOffers).mockReset() })

describe('list_current_offers', () => {
  it('is one tool with no parameters and dash-free text', () => {
    expect(OFFER_TOOLS).toHaveLength(1)
    expect(OFFER_TOOLS[0].name).toBe('list_current_offers')
    expect(OFFER_TOOLS[0].input_schema).toEqual({ type: 'object', properties: {} })
    expect(OFFER_TOOLS[0].description).not.toMatch(/[—–]/)
    expect(OFFER_TOOL_NAMES.has('list_current_offers')).toBe(true)
  })

  it("reads for the thread studio's organisation, with the customer-facing origin", async () => {
    const studios = [{ studio: 'UN1T Stillorgan', this_conversation: true, pages: [{ title: '14 Day Reset' }], store: [] }]
    vi.mocked(readCurrentOffers).mockResolvedValue({ ok: true, studios })
    const d = db()
    expect(await executeOfferTool('list_current_offers', {}, { db: d, locationId: LOC })).toEqual({ studios })
    expect(readCurrentOffers).toHaveBeenCalledWith(d, { organizationId: ORG, threadLocationId: LOC, baseUrl: 'https://studio.test' })
  })

  it('an empty list says so and tells Mia not to invent an offer', async () => {
    vi.mocked(readCurrentOffers).mockResolvedValue({ ok: true, studios: [] })
    const res = await executeOfferTool('list_current_offers', {}, { db: db(), locationId: LOC })
    expect(res.studios).toEqual([])
    expect(res.message).toMatch(/Nothing is on offer online right now/)
  })

  it('a failed read, a throw, or an unknown studio is "unreadable", never "no offers"', async () => {
    vi.mocked(readCurrentOffers).mockResolvedValue({ ok: false })
    expect(await executeOfferTool('list_current_offers', {}, { db: db(), locationId: LOC })).toMatchObject({ error: 'offers_unreadable' })
    vi.mocked(readCurrentOffers).mockRejectedValue(new Error('boom'))
    const thrown = await executeOfferTool('list_current_offers', {}, { db: db(), locationId: LOC })
    expect(thrown.error).toBe('offers_unreadable')
    expect(thrown.message).toMatch(/Never say there are no offers/)
    expect(thrown.message).not.toMatch(/[—–]/)
    const unknown = await executeOfferTool('list_current_offers', {}, { db: db(), locationId: '00000000-0000-4000-8000-0000000000ff' })
    expect(unknown.error).toBe('offers_unreadable')
    expect(await executeOfferTool('list_current_offers', {}, {})).toMatchObject({ error: 'offers_unreadable' })
  })

  it('refuses a name it does not own', async () => {
    expect(await executeOfferTool('something_else', {}, { db: db(), locationId: LOC })).toMatchObject({ error: 'unknown_tool' })
    expect(readCurrentOffers).not.toHaveBeenCalled()
  })
})
