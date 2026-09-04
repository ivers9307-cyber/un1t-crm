// HOST-EMAIL.10 — POST /api/host/emails/[id]/send-test.
//
// The host analog of /api/campaigns/[id]/send-test. Hosts had no way to see a
// draft in their own inbox before sending it to the whole list, so the only
// review surface was the composer preview — which does NOT run the sanitizer
// (it strips <style>/<meta>, so a pasted Canva/Unlayer export loses every
// media query) and does NOT show the injected unsubscribe footer.
//
// Contract, mirroring the real send so the test is faithful:
//   - host session or 401; own campaign or 404 (.eq('host_id') tenancy)
//   - the sender_domain_verified kill switch still applies — a test send is a
//     real email from the host's domain, so it must not bypass the gate
//   - renders through renderHostCampaignHtml (sanitizer + footer), subject
//     prefixed "[TEST] ", From/Reply-To identical to the real send
//   - writes NOTHING: no status change, no host_campaign_sends rows, no
//     daily-cap consumption. A test must never move the campaign's state.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('@/lib/postmark', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: 'pm-test-1' })) }
})

import { POST } from './route.js'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { sendEmail } from '@/lib/postmark'

const HOST_ID = 'b0000000-0000-0000-0000-0000000000b1'
const CAMPAIGN_ID = 'a0000000-0000-0000-0000-0000000000a1'

const HOST_ROW = {
  id: HOST_ID,
  name: 'Pride Training Club',
  email: 'colm@example.com',
  sender_domain_verified: true,
  sender_email: 'ptc@un1tdublin.com',
  sender_name: 'Colm',
  reply_to_email: 'studio@un1t.com',
}

const CAMPAIGN_ROW = {
  id: CAMPAIGN_ID,
  host_id: HOST_ID,
  status: 'draft',
  subject: 'Session 6 & 7 are live',
  body_html: '<!DOCTYPE html><html><body><p>Hi {{first_name}}</p><style>.x{color:red}</style></body></html>',
  email_type: 'marketing',
}

function makeDb(cfg = {}) {
  const statements = []
  const db = {
    from(table) {
      const state = { table, ops: [] }
      statements.push(state)
      const b = new Proxy({}, {
        get(_, method) {
          if (method === 'then') {
            const p = Promise.resolve(resolve(state) ?? {})
            return p.then.bind(p)
          }
          return (...args) => { state.ops.push({ method, args }); return b }
        },
      })
      return b
    },
  }
  function resolve(state) {
    if (state.table === 'host_campaigns') {
      return { data: 'campaign' in cfg ? cfg.campaign : CAMPAIGN_ROW, error: null }
    }
    if (state.table === 'event_hosts') {
      return { data: 'host' in cfg ? cfg.host : HOST_ROW, error: null }
    }
    return { data: null, error: null }
  }
  return { db, statements }
}

const props = { params: Promise.resolve({ id: CAMPAIGN_ID }) }

function post(body = { to: 'richard@example.com' }) {
  return POST(new Request('http://test.local/api/host/emails/x/send-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), props)
}

let statements

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentHost.mockResolvedValue({ host: { id: HOST_ID }, authUserId: 'u1', email: 'colm@example.com' })
  const made = makeDb()
  statements = made.statements
  createServerClient.mockReturnValue(made.db)
})

describe('POST /api/host/emails/[id]/send-test', () => {
  it('401s without a host session', async () => {
    getCurrentHost.mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('404s when the campaign is not this host\'s', async () => {
    const made = makeDb({ campaign: null })
    createServerClient.mockReturnValue(made.db)
    const res = await post()
    expect(res.status).toBe(404)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('scopes the campaign lookup by host_id', async () => {
    await post()
    const campaignStmt = statements.find((s) => s.table === 'host_campaigns')
    const eqArgs = campaignStmt.ops.filter((o) => o.method === 'eq').map((o) => o.args)
    expect(eqArgs).toContainEqual(['host_id', HOST_ID])
  })

  it('409s when the sending domain is not verified', async () => {
    const made = makeDb({ host: { ...HOST_ROW, sender_domain_verified: false } })
    createServerClient.mockReturnValue(made.db)
    const res = await post()
    expect(res.status).toBe(409)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('400s when the campaign has no subject or body', async () => {
    const made = makeDb({ campaign: { ...CAMPAIGN_ROW, body_html: '' } })
    createServerClient.mockReturnValue(made.db)
    const res = await post()
    expect(res.status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('400s on a malformed recipient address', async () => {
    const res = await post({ to: 'not-an-email' })
    expect(res.status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('sends one email to the requested address with a [TEST] subject prefix', async () => {
    const res = await post({ to: 'richard@example.com' })
    expect(res.status).toBe(200)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const arg = sendEmail.mock.calls[0][0]
    expect(arg.to).toBe('richard@example.com')
    expect(arg.subject).toBe('[TEST] Session 6 & 7 are live')
  })

  it('falls back to the host session email when no recipient is given', async () => {
    await POST(new Request('http://test.local/x', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }), props)
    expect(sendEmail.mock.calls[0][0].to).toBe('colm@example.com')
  })

  it('uses the host sender identity and reply-to, exactly like the real send', async () => {
    await post()
    const arg = sendEmail.mock.calls[0][0]
    expect(arg.from).toBe('"Colm" <ptc@un1tdublin.com>')
    expect(arg.replyTo).toBe('studio@un1t.com')
    expect(arg.stream).toBe('broadcast')
  })

  it('rides the outbound stream for a utility campaign, like the real send', async () => {
    const made = makeDb({ campaign: { ...CAMPAIGN_ROW, email_type: 'utility' } })
    createServerClient.mockReturnValue(made.db)
    await post()
    expect(sendEmail.mock.calls[0][0].stream).toBe('outbound')
  })

  it('renders through the host renderer so the unsubscribe footer is present', async () => {
    await post()
    const html = sendEmail.mock.calls[0][0].htmlBody
    expect(html).toContain('Unsubscribe')
    expect(html).toContain('Pride Training Club')
  })

  it('runs the sanitizer, so a style block in the body never reaches the inbox', async () => {
    await post()
    expect(sendEmail.mock.calls[0][0].htmlBody).not.toContain('<style')
  })

  it('substitutes merge tags rather than shipping the raw token', async () => {
    await post()
    const html = sendEmail.mock.calls[0][0].htmlBody
    expect(html).not.toContain('{{first_name}}')
  })

  it('writes nothing — no status change and no send rows', async () => {
    await post()
    const writes = statements.filter((s) =>
      s.ops.some((o) => ['update', 'insert', 'upsert', 'delete'].includes(o.method)))
    expect(writes).toEqual([])
    expect(statements.some((s) => s.table === 'host_campaign_sends')).toBe(false)
  })

  it('502s when Postmark rejects the send', async () => {
    sendEmail.mockRejectedValueOnce(new Error('postmark down'))
    const res = await post()
    expect(res.status).toBe(502)
  })
})
