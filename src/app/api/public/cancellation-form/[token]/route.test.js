// CANCEL-FORM.3 — the public token route. Uniform 404 for every failure,
// validate-before-rate-limit on POST, single-use, and the GET never leaks
// more than a first name + plan name.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => dbMock) }))
vi.mock('@/lib/cancellation-form/links', () => ({
  resolveLink: vi.fn(), markOpened: vi.fn(), claimLink: vi.fn(), unclaimLink: vi.fn(), attachRequest: vi.fn(),
}))
vi.mock('@/lib/consent-token-guard', () => ({
  guardBeforeTokenLookup: vi.fn(async () => ({ allowed: true })),
  penaliseInvalidToken: vi.fn(async () => ({ allowed: true })),
  guardResolvedToken: vi.fn(async () => ({ allowed: true })),
}))
vi.mock('@/lib/rate-limit', () => ({
  getClientIp: () => '1.2.3.4',
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  rateLimitResponse: () => new Response(JSON.stringify({ success: false, error: 'rate' }), { status: 429 }),
}))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T Stillorgan', logoUrl: 'https://l/logo.png' })) }))
vi.mock('@/lib/agent/approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => {}) }))
vi.mock('@/lib/dublin-time', async (orig) => ({ ...(await orig()), dublinTodayStr: () => '2026-09-05' }))

import { GET, POST } from './route'
import { resolveLink, markOpened, claimLink, unclaimLink, attachRequest } from '@/lib/cancellation-form/links'
import { penaliseInvalidToken, guardResolvedToken } from '@/lib/consent-token-guard'
import { checkRateLimit } from '@/lib/rate-limit'
import { notifyAgentApprovalRequest } from '@/lib/agent/approval-notify'

let dbMock
let inserted
let insertError
const LINK = { id: 'l-1', location_id: 'loc-1', contact_id: 'c-1', channel: 'email', conversation_id: null, used_at: null, request_id: null }
const CONTACT = { id: 'c-1', first_name: 'Aoife', name: 'Aoife Byrne', location_id: 'loc-1', glofox_membership_plan: 'Unlimited' }

beforeEach(() => {
  vi.clearAllMocks()
  inserted = null
  insertError = null
  dbMock = {
    from: (table) => {
      const c = {
        select() { return c }, eq() { return c },
        maybeSingle: () => Promise.resolve(
          table === 'locations'
            ? { data: { name: 'Stillorgan', settings: { customer_agent: { cancellation_form: { notice_days: 30 } } } }, error: null }
            : table === 'agent_membership_requests' ? { data: { kind: 'pause' }, error: null } : { data: null, error: null }),
        insert(p) { inserted = p; return c },
        single: () => Promise.resolve(insertError ? { data: null, error: insertError } : { data: { id: 'req-1' }, error: null }),
      }
      return c
    },
  }
})

const params = { params: Promise.resolve({ token: 'tok.sig' }) }
const get = () => GET(new Request('http://x/api/public/cancellation-form/tok.sig'), params)
const post = (body) => POST(new Request('http://x/api/public/cancellation-form/tok.sig', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), params)

describe('GET', () => {
  it('404s uniformly and penalises the IP when the token does not resolve', async () => {
    resolveLink.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Not found' })
    expect(penaliseInvalidToken).toHaveBeenCalledWith(expect.anything(), 'cancel-form', '1.2.3.4')
    expect(markOpened).not.toHaveBeenCalled()
  })

  it('returns first name, plan, branding, rendered copy and options for a live link, marking it opened', async () => {
    resolveLink.mockResolvedValue({ link: LINK, contact: CONTACT })
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toMatch(/no-store/)
    const body = await res.json()
    expect(body.data.state).toBe('open')
    expect(body.data.first_name).toBe('Aoife')
    expect(body.data.plan_name).toBe('Unlimited')
    expect(body.data.branding.companyName).toBe('UN1T Stillorgan')
    expect(body.data.copy.form_intro).toBe('Hi Aoife. Use this page to pause or cancel your Unlimited membership. Nothing changes until the team confirms it with you.')
    expect(body.data.options.min_end_date).toBe('2026-10-05')
    expect(body.data.options.reasons).toHaveLength(8)
    expect(guardResolvedToken).toHaveBeenCalledWith(expect.anything(), 'cancel-form', 'tok.sig')
    expect(markOpened).toHaveBeenCalledWith(expect.anything(), 'l-1')
    // No PII beyond first name + plan.
    const flat = JSON.stringify(body)
    // ('price' is a reason CODE here, so the money check is on the column name.)
    for (const leak of ['Byrne', 'c-1', 'loc-1', 'email', 'phone', 'price_cents', 'glofox_', 'credits']) expect(flat.includes(leak), leak).toBe(false)
  })

  it('reports an already-submitted link with the kind it produced', async () => {
    resolveLink.mockResolvedValue({ link: { ...LINK, used_at: '2026-09-05T09:00:00Z', request_id: 'req-1' }, contact: CONTACT })
    const body = await (await get()).json()
    expect(body.data.state).toBe('submitted')
    expect(body.data.submitted_kind).toBe('pause')
  })
})

describe('POST', () => {
  const cancelBody = { choice: 'cancel', reason_code: 'price', reason_text: 'Too dear', requested_end_date: '2026-10-10', confirm: true }

  it('validates the body BEFORE spending the rate limit or resolving the token', async () => {
    const res = await post({ choice: 'refund' })
    expect(res.status).toBe(400)
    expect(checkRateLimit).not.toHaveBeenCalled()
    expect(resolveLink).not.toHaveBeenCalled()
  })

  it('files a cancellation on the link channel, attaches it, notifies staff once', async () => {
    resolveLink.mockResolvedValue({ link: LINK, contact: CONTACT })
    claimLink.mockResolvedValue(true)
    const res = await post(cancelBody)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, data: { state: 'submitted', kind: 'cancellation' } })
    expect(checkRateLimit).toHaveBeenCalledWith(expect.anything(), 'cancelform:submit:1.2.3.4', expect.objectContaining({ max: 10 }))
    expect(inserted).toMatchObject({
      location_id: 'loc-1', contact_id: 'c-1', kind: 'cancellation', channel: 'email', conversation_id: null,
      status: 'pending', retention_flagged: true, customer_note: 'Too dear',
      details: { source: 'cancellation_form', link_id: 'l-1', delivered_via: 'email', reason_code: 'price', requested_end_date: '2026-10-10' },
    })
    expect(attachRequest).toHaveBeenCalledWith(expect.anything(), 'l-1', 'req-1')
    expect(notifyAgentApprovalRequest).toHaveBeenCalledTimes(1)
    expect(notifyAgentApprovalRequest.mock.calls[0][1]).toMatchObject({ requestId: 'req-1', locationId: 'loc-1', kind: 'cancellation', customerName: 'Aoife Byrne' })
  })

  it('files a pause with retention_flagged false', async () => {
    resolveLink.mockResolvedValue({ link: LINK, contact: CONTACT })
    claimLink.mockResolvedValue(true)
    const res = await post({ choice: 'pause', start_date: '2026-09-10', end_date: '2026-10-01' })
    expect(res.status).toBe(200)
    expect(inserted).toMatchObject({ kind: 'pause', retention_flagged: false, details: { pause_taken: true, start_date: '2026-09-10', end_date: '2026-10-01' } })
  })

  it('rejects a semantic-rule breach with the field named (end date inside the notice period)', async () => {
    resolveLink.mockResolvedValue({ link: LINK, contact: CONTACT })
    const res = await post({ ...cancelBody, requested_end_date: '2026-09-20' })
    expect(res.status).toBe(400)
    expect((await res.json()).field).toBe('requested_end_date')
    expect(claimLink).not.toHaveBeenCalled()
  })

  it('a second submit (claim lost) answers submitted without inserting again', async () => {
    resolveLink.mockResolvedValue({ link: LINK, contact: CONTACT })
    claimLink.mockResolvedValue(false)
    const res = await post(cancelBody)
    expect(res.status).toBe(200)
    expect((await res.json()).data.state).toBe('submitted')
    expect(inserted).toBeNull()
    expect(notifyAgentApprovalRequest).not.toHaveBeenCalled()
  })

  it('releases the claim and 500s when the request insert fails', async () => {
    resolveLink.mockResolvedValue({ link: LINK, contact: CONTACT })
    claimLink.mockResolvedValue(true)
    insertError = { message: 'db down' }
    const res = await post(cancelBody)
    expect(res.status).toBe(500)
    expect(unclaimLink).toHaveBeenCalledWith(expect.anything(), 'l-1')
    expect(notifyAgentApprovalRequest).not.toHaveBeenCalled()
  })

  it('404s uniformly when the token does not resolve', async () => {
    resolveLink.mockResolvedValue(null)
    const res = await post(cancelBody)
    expect(res.status).toBe(404)
    expect(penaliseInvalidToken).toHaveBeenCalled()
  })
})
