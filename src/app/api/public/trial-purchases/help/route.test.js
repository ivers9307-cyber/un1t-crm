// TRIALSTUDIO.5 — POST /api/public/trial-purchases/help: the "I need help"
// button on a refused /trial buyer. Files ONE help_requested row (a Needs a
// call card) with the eligibility reasons, alerts staff once, and a second
// press reuses the open row.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(), contact: vi.fn(), studios: vi.fn(), history: vi.fn(), hatch: vi.fn(), alert: vi.fn(),
  contactRow: vi.fn(), openRow: vi.fn(), inserted: vi.fn(), logError: vi.fn(), entry: vi.fn(), resolve: vi.fn(),
}))
vi.mock('@/lib/landing-pages', async (orig) => ({ ...(await orig()), resolvePublicPageRequest: mocks.resolve }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: mocks.rateLimit, getClientIp: () => '1.2.3.4', rateLimitResponse: () => new Response('rate', { status: 429 }) }))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: mocks.contact }))
vi.mock('@/lib/trial-studios', async (orig) => ({ ...(await orig()), loadTrialStudios: mocks.studios, trialEntryFromRow: mocks.entry }))
vi.mock('@/lib/trial-eligibility', async (orig) => ({ ...(await orig()), stillorganTrialHistory: mocks.history, hatchActiveMembership: mocks.hatch }))
vi.mock('@/lib/trial-purchase-processor', () => ({ alertTrialPurchaseStaff: mocks.alert }))
vi.mock('@/lib/log', () => ({ logError: mocks.logError, logWarn: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      if (table === 'contacts') return { select: () => ({ eq: () => ({ maybeSingle: mocks.contactRow }) }) }
      if (table === 'trial_purchases') {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ limit: mocks.openRow }) }) }) }),
          insert: (row) => ({ select: () => ({ single: async () => mocks.inserted(row) }) }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

import { POST } from './route'

const GLOFOX = { provider: 'glofox', productName: '2 Week Trial', priceCents: 3900, currency: 'EUR', durationDays: 14, membershipId: 'm1', planCode: 'p1', un1tProductId: null, helpSentText: 'Thanks, we will call you.' }
const UN1T = { provider: 'un1t_online', productName: 'Hatch Trial', priceCents: 4500, currency: 'EUR', durationDays: 14, membershipId: null, planCode: null, un1tProductId: 'u1', helpSentText: 'Thanks, we will call you.' }
const STUDIOS = [
  { key: 'stillorgan', publicPath: 'stillorgan', locationId: 'loc1', config: GLOFOX, sellable: true },
  { key: 'hatch', publicPath: 'hatch-street', locationId: 'loc2', config: UN1T, sellable: true },
]
const BODY = { studio: 'stillorgan', first_name: 'Ava', last_name: 'Byrne', email: 'Ava@Example.com', phone: '0851234567' }
const req = (body) => new Request('http://x/api/public/trial-purchases/help', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.rateLimit.mockResolvedValue({ allowed: true })
  mocks.studios.mockResolvedValue(STUDIOS)
  mocks.contact.mockResolvedValue('c1')
  mocks.contactRow.mockResolvedValue({ data: { id: 'c1', glofox_member_id: 'g1', glofox_membership_status: 'trial', glofox_membership_plan: null }, error: null })
  mocks.history.mockResolvedValue({ ok: true, hadTrial: true, reasons: ['membership_status=trial', 'glofox_trial_claim'] })
  mocks.hatch.mockResolvedValue({ ok: true, active: true, reasons: ['contact_membership_active'] })
  mocks.openRow.mockResolvedValue({ data: [], error: null })
  mocks.inserted.mockImplementation(async (row) => ({ data: { id: 'tp1', ...row }, error: null }))
  mocks.alert.mockResolvedValue(undefined)
})

describe('POST /api/public/trial-purchases/help', () => {
  it('400s an unknown studio before any read', async () => {
    const r = await POST(req({ ...BODY, studio: 'HATCH' }))
    expect(r.status).toBe(400)
    expect((await r.json()).code).toBe('unknown_studio')
    expect(mocks.rateLimit).not.toHaveBeenCalled()
    expect(mocks.studios).not.toHaveBeenCalled()
    expect(mocks.contact).not.toHaveBeenCalled()
  })

  it('files one help_requested row with the reasons and alerts staff', async () => {
    const r = await POST(req(BODY))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ success: true, data: { message: 'Thanks, we will call you.', purchaseId: 'tp1' } })
    expect(mocks.rateLimit).toHaveBeenCalledWith(expect.anything(), 'trialhelp:stillorgan:1.2.3.4', { max: 5, windowMs: 15 * 60_000 })
    expect(mocks.contact).toHaveBeenCalledWith(expect.objectContaining({
      locationId: 'loc1', email: 'ava@example.com', restrictToOrg: true,
      insertFields: expect.objectContaining({ source: 'paid_trial_help', first_name: 'Ava', last_name: 'Byrne' }),
    }))
    expect(mocks.history).toHaveBeenCalledWith(expect.anything(), { locationId: 'loc1', contact: expect.objectContaining({ id: 'c1', glofox_member_id: 'g1' }) })
    expect(mocks.inserted).toHaveBeenCalledTimes(1)
    const inserted = mocks.inserted.mock.calls[0][0]
    expect(inserted).toMatchObject({
      location_id: 'loc1', contact_id: 'c1', landing_path: 'stillorgan', customer_name: 'Ava Byrne', first_name: 'Ava', last_name: 'Byrne',
      customer_email: 'ava@example.com', customer_phone: '0851234567', product_name: '2 Week Trial', amount_cents: 3900, currency: 'EUR', duration_days: 14,
      status: 'help_requested', payment_provider: null, membership_id: 'm1', plan_code: 'p1', un1t_product_id: null,
      last_error: 'trial_used: membership_status=trial, glofox_trial_claim',
    })
    expect(inserted.last_error.startsWith('trial_used:')).toBe(true)
    expect(inserted.payment_status).toBeNull()
    expect(mocks.alert).toHaveBeenCalledTimes(1)
    expect(mocks.alert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'tp1', status: 'help_requested' }), 'trial_used', 'membership_status=trial, glofox_trial_claim')
  })

  it('files a Hatch active-member card with the un1t.online product', async () => {
    const r = await POST(req({ ...BODY, studio: 'hatch' }))
    expect(r.status).toBe(200)
    expect(mocks.hatch).toHaveBeenCalledWith(expect.anything(), { locationId: 'loc2', contactId: 'c1' })
    expect(mocks.history).not.toHaveBeenCalled()
    expect(mocks.inserted.mock.calls[0][0]).toMatchObject({
      location_id: 'loc2', landing_path: 'hatch-street', payment_provider: 'un1t_online', un1t_product_id: 'u1', membership_id: null, plan_code: null,
      status: 'help_requested', last_error: 'active_member: contact_membership_active',
    })
    expect(mocks.alert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'help_requested' }), 'active_member', 'contact_membership_active')
  })

  it('still files the card, with none_found, when the re-run shows no reason', async () => {
    mocks.history.mockResolvedValue({ ok: true, hadTrial: false, reasons: [] })
    expect((await POST(req(BODY))).status).toBe(200)
    expect(mocks.inserted.mock.calls[0][0].last_error).toBe('trial_used: none_found')
    expect(mocks.alert).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'trial_used', 'none_found')
  })

  it('a second press reuses the open row (no insert, no second alert)', async () => {
    mocks.openRow.mockResolvedValue({ data: [{ id: 'tp0' }], error: null })
    const r = await POST(req(BODY))
    expect(r.status).toBe(200)
    expect((await r.json()).data).toEqual({ message: 'Thanks, we will call you.', purchaseId: 'tp0' })
    expect(mocks.inserted).not.toHaveBeenCalled()
    expect(mocks.alert).not.toHaveBeenCalled()
  })

  // Final review F6 — two presses that both read "no open row": the unique
  // index refuses the second insert and the route answers with the open row.
  it('a 23505 on the insert (a raced double press) answers with the open row, no alert', async () => {
    mocks.openRow
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [{ id: 'tpRaced' }], error: null })
    mocks.inserted.mockResolvedValue({ data: null, error: { code: '23505', details: 'Key (location_id, contact_id)=(loc1, c1) already exists.' } })
    const r = await POST(req(BODY))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ success: true, data: { message: 'Thanks, we will call you.', purchaseId: 'tpRaced' } })
    expect(mocks.openRow).toHaveBeenCalledTimes(2)
    expect(mocks.alert).not.toHaveBeenCalled()
  })

  it('a 23505 whose open row cannot be re-read is a 500, no alert', async () => {
    mocks.openRow
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: null, error: { code: '57014' } })
    mocks.inserted.mockResolvedValue({ data: null, error: { code: '23505' } })
    expect((await POST(req(BODY))).status).toBe(500)
    expect(mocks.alert).not.toHaveBeenCalled()
  })

  // Final review M5 — the insert failure is logged with ids and the code only.
  it('a failed insert is a 500 logged with ids and the code, never the error details', async () => {
    mocks.inserted.mockResolvedValue({ data: null, error: { code: '23502', details: 'Failing row contains (ava@example.com, 0851234567)' } })
    expect((await POST(req(BODY))).status).toBe(500)
    expect(mocks.logError).toHaveBeenCalledWith('trialhelp', 'help row insert failed', { code: '23502', contactId: 'c1', locationId: 'loc1' })
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('ava@example.com')
    expect(mocks.alert).not.toHaveBeenCalled()
  })

  it('503s, not not_configured, when the loader flags the studio unreadable', async () => {
    mocks.studios.mockResolvedValue([{ ...STUDIOS[0], locationId: null, config: null, sellable: false, unreadable: true }, STUDIOS[1]])
    const r = await POST(req(BODY))
    expect(r.status).toBe(503)
    expect((await r.json()).code).toBe('unavailable')
    expect(mocks.contact).not.toHaveBeenCalled()
  })

  it('400s not_configured for a studio with nothing sellable', async () => {
    mocks.studios.mockResolvedValue([{ ...STUDIOS[0], config: null, sellable: false }, STUDIOS[1]])
    const r = await POST(req(BODY))
    expect(r.status).toBe(400)
    expect((await r.json()).code).toBe('not_configured')
    expect(mocks.contact).not.toHaveBeenCalled()
  })

  it('503s when an eligibility read cannot be made, and files nothing', async () => {
    mocks.history.mockResolvedValue({ ok: false, reason: 'glofox_push_events_unreadable' })
    const r = await POST(req(BODY))
    expect(r.status).toBe(503)
    expect(mocks.inserted).not.toHaveBeenCalled()
    expect(mocks.alert).not.toHaveBeenCalled()
  })

  it('does not fail the response when the staff alert throws', async () => {
    mocks.alert.mockRejectedValue(new Error('mail down'))
    expect((await POST(req(BODY))).status).toBe(200)
  })

  it('429s when rate-limited, and 400s a malformed body', async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false })
    expect((await POST(req(BODY))).status).toBe(429)
    expect((await POST(req({ ...BODY, phone: 'nope' }))).status).toBe(400)
  })
})

// PAGES.1 — `page` + `studio`: the studio's entry comes from the page's studio
// row (trialEntryFromRow on the merged block); the row records the page.
describe('POST /api/public/trial-purchases/help — page (PAGES.1)', () => {
  const ROW = { page_id: 'page-trial', location_id: 'loc2', enabled: true, offer: {}, attribution: {}, locations: { membership_source: 'un1t_online', settings: {} } }
  const BLOCK = { id: 'pt', type: 'paid_trial', un1t_product_id: 'u1' }
  const ok = () => ({ ok: true, pageId: 'page-trial', page: { id: 'page-trial', slug: 'trial', offer_type: 'paid_trial' }, studioRow: ROW, locationId: 'loc2', publicPath: 'hatch-street', blocks: [BLOCK], attribution: { tag: 't', lead_source: 'l' } })

  it('files the card at the page studio with the row entry and page_id', async () => {
    mocks.resolve.mockResolvedValueOnce(ok())
    mocks.entry.mockResolvedValueOnce({ key: 'hatch', publicPath: 'hatch-street', locationId: 'loc2', membershipSource: 'un1t_online', config: UN1T, sellable: true })
    const r = await POST(req({ ...BODY, studio: 'hatch-street', page: 'trial' }))
    expect(r.status).toBe(200)
    expect(mocks.resolve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ page: 'trial', studio: 'hatch-street' }))
    expect(mocks.entry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ row: ROW, publicPath: 'hatch-street', mergedBlock: expect.objectContaining({ type: 'paid_trial', un1t_product_id: 'u1' }) }))
    expect(mocks.studios).not.toHaveBeenCalled()
    expect(mocks.rateLimit).toHaveBeenCalledWith(expect.anything(), 'trialhelp:hatch:1.2.3.4', { max: 5, windowMs: 15 * 60_000 })
    expect(mocks.hatch).toHaveBeenCalledWith(expect.anything(), { locationId: 'loc2', contactId: 'c1' })
    expect(mocks.inserted.mock.calls[0][0]).toMatchObject({ page_id: 'page-trial', location_id: 'loc2', landing_path: 'hatch-street', payment_provider: 'un1t_online', last_error: 'active_member: contact_membership_active' })
  })

  it('refuses a page request the resolver refuses, before any capture', async () => {
    mocks.resolve.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    expect((await POST(req({ ...BODY, studio: 'galway', page: 'trial' }))).status).toBe(404)
    mocks.resolve.mockResolvedValueOnce({ ok: false, reason: 'unreadable' })
    expect((await POST(req({ ...BODY, page: 'trial' }))).status).toBe(503)
    expect(mocks.contact).not.toHaveBeenCalled()
  })
})
