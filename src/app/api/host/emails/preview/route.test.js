// src/app/api/host/emails/preview/route.test.js
// POST /api/host/emails/preview — HOST-EMAILS.2. Renders through the SAME
// renderHostCampaignHtml the queue and test send use, with sample merge
// values and the inert unsubscribe token. Stores nothing.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/host-campaign-email', () => ({ renderHostCampaignHtml: vi.fn() }))
vi.mock('@/lib/postmark', () => ({ applyMergeTags: vi.fn() }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: vi.fn(() => 'https://crm.repset.ie') }))

import { POST } from './route.js'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { renderHostCampaignHtml } from '@/lib/host-campaign-email'
import { applyMergeTags } from '@/lib/postmark'
import { getAppUrl } from '@/lib/app-url'

const HOST_ID = 'b0000000-0000-0000-0000-0000000000b1'
const HOST_ROW = { id: HOST_ID, name: 'Colm', sender_name: 'Colm Events', sender_email: 'news@runners.ie' }

let ops
function makeDb(cfg = {}) {
  ops = []
  const b = {
    select: vi.fn((...a) => { ops.push({ method: 'select', args: a }); return b }),
    eq: vi.fn((...a) => { ops.push({ method: 'eq', args: a }); return b }),
    insert: vi.fn((...a) => { ops.push({ method: 'insert', args: a }); return b }),
    update: vi.fn((...a) => { ops.push({ method: 'update', args: a }); return b }),
    maybeSingle: vi.fn(() => Promise.resolve(cfg.hostReadErr ? { data: null, error: cfg.hostReadErr } : { data: cfg.host === undefined ? HOST_ROW : cfg.host, error: null })),
  }
  return { from: vi.fn(() => b) }
}

function req(body) {
  return new Request('http://localhost/api/host/emails/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentHost.mockResolvedValue({ host: { id: HOST_ID }, email: 'test@runners.ie' })
  renderHostCampaignHtml.mockReturnValue('<html>{{first_name}}</html>')
  applyMergeTags.mockImplementation((html, contact) => html.replace('{{first_name}}', contact.first_name))
})

describe('POST /api/host/emails/preview', () => {
  it('401s without a session', async () => {
    getCurrentHost.mockResolvedValue(null)
    const res = await POST(req({ subject: 'Hi', body_html: '<p>x</p>' }))
    expect(res.status).toBe(401)
  })

  it('400s on invalid JSON', async () => {
    createServerClient.mockReturnValue(makeDb())
    const res = await POST(req('{nope'))
    expect(res.status).toBe(400)
  })

  it('400s on an empty body', async () => {
    createServerClient.mockReturnValue(makeDb())
    const res = await POST(req({ subject: 'Hi', body_html: '' }))
    expect(res.status).toBe(400)
  })

  it('400s on a body over 300000 chars', async () => {
    createServerClient.mockReturnValue(makeDb())
    const res = await POST(req({ subject: 'Hi', body_html: 'x'.repeat(300001) }))
    expect(res.status).toBe(400)
  })

  it('404s when the host read is null', async () => {
    createServerClient.mockReturnValue(makeDb({ host: null }))
    const res = await POST(req({ subject: 'Hi', body_html: '<p>x</p>' }))
    expect(res.status).toBe(404)
  })

  it('500s with the db message on a host read error', async () => {
    createServerClient.mockReturnValue(makeDb({ hostReadErr: { message: 'kaboom' } }))
    const res = await POST(req({ subject: 'Hi', body_html: '<p>x</p>' }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('kaboom')
  })

  it('renders through renderHostCampaignHtml with sample merge values and the inert unsubscribe token; stores nothing', async () => {
    createServerClient.mockReturnValue(makeDb())
    const res = await POST(req({ subject: 'Hi {{first_name}}', body_html: '<p>x</p>' }))
    expect(res.status).toBe(200)
    expect((await res.json()).data.html).toContain('Sample')
    expect(renderHostCampaignHtml).toHaveBeenCalledWith(expect.objectContaining({
      bodyHtml: '<p>x</p>',
      unsubscribeUrl: expect.stringContaining('/unsubscribe/host/test-token'),
    }))
    expect(ops.some((o) => o.method === 'insert' || o.method === 'update')).toBe(false)
  })

  it('falls back to an empty base URL if getAppUrl throws', async () => {
    getAppUrl.mockImplementationOnce(() => { throw new Error('not set') })
    createServerClient.mockReturnValue(makeDb())
    const res = await POST(req({ subject: 'Hi', body_html: '<p>x</p>' }))
    expect(res.status).toBe(200)
    expect(renderHostCampaignHtml).toHaveBeenCalledWith(expect.objectContaining({ unsubscribeUrl: '/unsubscribe/host/test-token' }))
  })
})
