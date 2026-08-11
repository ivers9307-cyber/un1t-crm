// WEBVIEW.1 — the public hosted-copy route.

import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-signing-secret'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { GET } from './route'
import { signCampaignViewToken } from '@/lib/campaign-web-view'

const CAMPAIGN_ID = '11111111-2222-4333-8444-555555555555'
const TOKEN = signCampaignViewToken(CAMPAIGN_ID)

const SENT = {
  id: CAMPAIGN_ID,
  status: 'sent',
  subject: 'Last chance',
  location_id: 'loc-1',
  html_content: '<html><body><h1>Sale</h1><p>Hi {{first_name}}, we hold {{email}}.</p></body></html>',
  locations: { name: 'UN1T Stillorgan' },
}

function makeDb(campaign) {
  const filters = []
  const api = {
    select() { return api },
    eq(col, val) { filters.push([col, val]); return api },
    single: async () => (campaign ? { data: campaign, error: null } : { data: null, error: { message: 'no rows' } }),
  }
  return { db: { from: () => api }, filters }
}

const props = (token) => ({ params: Promise.resolve({ token }) })
const req = () => new Request('https://crm.example/view-email/x')

beforeEach(() => vi.clearAllMocks())

describe('serving a sent campaign', () => {
  it('returns the campaign HTML as a full document', async () => {
    createServerClient.mockReturnValue(makeDb(SENT).db)
    const res = await GET(req(), props(TOKEN))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    expect(await res.text()).toContain('<h1>Sale</h1>')
  })

  it('resolves the token to the campaign the token names', async () => {
    const { db, filters } = makeDb(SENT)
    createServerClient.mockReturnValue(db)
    await GET(req(), props(TOKEN))
    expect(filters).toContainEqual(['id', CAMPAIGN_ID])
  })

  it('leaks no recipient PII — personal merge tags render blank', async () => {
    createServerClient.mockReturnValue(makeDb(SENT).db)
    const body = await (await GET(req(), props(TOKEN))).text()
    expect(body).not.toContain('{{first_name}}')
    expect(body).not.toContain('{{email}}')
    expect(body).toContain('Hi , we hold .')
  })

  it('serves a campaign still sending, because the link is already in inboxes', async () => {
    createServerClient.mockReturnValue(makeDb({ ...SENT, status: 'sending' }).db)
    expect((await GET(req(), props(TOKEN))).status).toBe(200)
  })
})

describe('everything else is an indistinguishable 404', () => {
  it('404s a forged signature', async () => {
    createServerClient.mockReturnValue(makeDb(SENT).db)
    const [payload] = TOKEN.split('.')
    expect((await GET(req(), props(`${payload}.AAAA`))).status).toBe(404)
  })

  it('404s a raw campaign id — the URL is not enumerable', async () => {
    createServerClient.mockReturnValue(makeDb(SENT).db)
    expect((await GET(req(), props(CAMPAIGN_ID))).status).toBe(404)
  })

  it.each(['draft', 'scheduled', 'queued', 'cancelled', 'failed'])(
    '404s a %s campaign — unsent content is not public',
    async (status) => {
      createServerClient.mockReturnValue(makeDb({ ...SENT, status }).db)
      expect((await GET(req(), props(TOKEN))).status).toBe(404)
    },
  )

  it('404s a campaign that no longer exists', async () => {
    createServerClient.mockReturnValue(makeDb(null).db)
    expect((await GET(req(), props(TOKEN))).status).toBe(404)
  })

  it('404s a sent campaign with no html at all', async () => {
    createServerClient.mockReturnValue(makeDb({ ...SENT, html_content: null }).db)
    expect((await GET(req(), props(TOKEN))).status).toBe(404)
  })

  it('does not query at all for a malformed token', async () => {
    const { db } = makeDb(SENT)
    const spy = vi.spyOn(db, 'from')
    createServerClient.mockReturnValue(db)
    await GET(req(), props('nonsense'))
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('response hardening', () => {
  it('is not framable, not sniffable, and does not leak its own URL as a referrer', async () => {
    createServerClient.mockReturnValue(makeDb(SENT).db)
    const res = await GET(req(), props(TOKEN))
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    // The URL IS the capability, so it must not travel in a Referer header to
    // whatever host the design loads its images from.
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })
})
