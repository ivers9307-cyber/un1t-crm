// PAGES.1 — POST /api/public/funnel-event with `page` + `studio`: the row's
// location is the page's resolved studio and it records the page. Telemetry
// never errors the client: a page that does not resolve is ignored (200).
// Without `page` the legacy location_path read is unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ rateLimit: vi.fn(), resolve: vi.fn(), inserted: vi.fn(), legacyRow: null, insertError: null }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: m.rateLimit, getClientIp: () => '1.2.3.4', rateLimitResponse: () => new Response('rate', { status: 429 }) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/landing-pages', async (orig) => ({ ...(await orig()), resolvePublicPageRequest: m.resolve }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      const q = {
        select: () => q, eq: () => q,
        maybeSingle: async () => ({ data: table === 'landing_page_settings' ? m.legacyRow : null, error: null }),
        insert: async (row) => { m.inserted(table, row); return { data: null, error: m.insertError } },
      }
      return q
    },
  }),
}))

import { POST } from './route'

const EVENT = { funnel: 'campaign_50plus', step: 'view', session_id: 'sess-12345678', utm_campaign: 'c1' }
const req = (body) => new Request('http://x/api/public/funnel-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const pageOk = () => ({ ok: true, pageId: 'page-50', page: { id: 'page-50', slug: '50plus' }, studioRow: {}, locationId: 'loc-s', publicPath: 'stillorgan', blocks: [], attribution: {} })

beforeEach(() => {
  vi.clearAllMocks()
  m.legacyRow = { location_id: 'loc-legacy' }
  m.insertError = null
  m.rateLimit.mockResolvedValue({ allowed: true })
})

describe('POST /api/public/funnel-event — page (PAGES.1)', () => {
  it('page+studio resolves location_id and stamps page_id', async () => {
    m.resolve.mockResolvedValueOnce(pageOk())
    const r = await POST(req({ ...EVENT, page: '50plus', studio: 'stillorgan', location_path: 'hatch-street' }))
    expect(await r.json()).toEqual({ success: true })
    expect(m.resolve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ page: '50plus', studio: 'stillorgan' }))
    expect(m.rateLimit).toHaveBeenCalledWith(expect.anything(), 'funnelevt:stillorgan:1.2.3.4', expect.anything())
    expect(m.inserted).toHaveBeenCalledWith('funnel_events', expect.objectContaining({ location_id: 'loc-s', page_id: 'page-50', step: 'view', session_id: 'sess-12345678' }))
  })

  it('a page that does not resolve is ignored, never an error', async () => {
    m.resolve.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    const r = await POST(req({ ...EVENT, page: 'gone' }))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ success: true, data: { ignored: true } })
    expect(m.inserted).not.toHaveBeenCalled()
  })

  it('a failed insert is logged and still answers success', async () => {
    const { logWarn } = await import('@/lib/log')
    m.resolve.mockResolvedValueOnce(pageOk())
    m.insertError = { code: '23502' }
    expect(await (await POST(req({ ...EVENT, page: '50plus' }))).json()).toEqual({ success: true })
    expect(logWarn).toHaveBeenCalledWith('funnel-event', 'insert failed', expect.objectContaining({ code: '23502' }))
  })

  it('legacy: location_path decides the studio and nothing records a page', async () => {
    const r = await POST(req({ ...EVENT, location_path: 'stillorgan' }))
    expect(await r.json()).toEqual({ success: true })
    expect(m.resolve).not.toHaveBeenCalled()
    expect(m.rateLimit).toHaveBeenCalledWith(expect.anything(), 'funnelevt:stillorgan:1.2.3.4', expect.anything())
    const row = m.inserted.mock.calls[0][1]
    expect(row.location_id).toBe('loc-legacy')
    expect(row).not.toHaveProperty('page_id')
  })
})
