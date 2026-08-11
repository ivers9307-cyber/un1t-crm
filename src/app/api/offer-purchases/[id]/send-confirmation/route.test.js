import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = { user: null, row: null }

vi.mock('@/lib/auth', () => ({
  getCurrentUser: async () => state.user,
  assertLocationAccessOr404: (user, locationId) => {
    const ok = (user?.locations || []).some((l) => l.id === locationId)
    return ok ? null : new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
  },
}))
vi.mock('@/lib/permissions', () => ({ hasPermission: (u, k) => Boolean(u?.perms?.[k]) }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from() { return this }, select() { return this }, eq() { return this },
    maybeSingle: async () => ({ data: state.row }),
  }),
}))
const sendOfferPurchaseEmail = vi.fn(async () => ({ status: 'sent' }))
vi.mock('@/lib/offer-purchase-emails', () => ({ sendOfferPurchaseEmail: (...a) => sendOfferPurchaseEmail(...a) }))

import { POST } from './route'

const props = { params: Promise.resolve({ id: 'p1' }) }
const approver = { id: 'u1', locations: [{ id: 'loc1' }], perms: { approvals_offer_purchases: true } }
const paidRow = { id: 'p1', state: 'paid', location_id: 'loc1', buyer_email: 'sam@example.com', offer: { name: '20 Class Pack' } }

beforeEach(() => {
  state.user = approver
  state.row = paidRow
  sendOfferPurchaseEmail.mockClear()
  sendOfferPurchaseEmail.mockResolvedValue({ status: 'sent' })
})

describe('POST /api/offer-purchases/[id]/send-confirmation', () => {
  it('sends the ready email and reports the address', async () => {
    const json = await (await POST(new Request('http://t'), props)).json()
    expect(json).toEqual({ success: true, data: { sent: true, to: 'sam@example.com' } })
    expect(sendOfferPurchaseEmail.mock.calls[0][1].kind).toBe('ready')
  })

  it('401 with no session, 403 without the grant', async () => {
    state.user = null
    expect((await POST(new Request('http://t'), props)).status).toBe(401)
    state.user = { ...approver, perms: {} }
    expect((await POST(new Request('http://t'), props)).status).toBe(403)
    expect(sendOfferPurchaseEmail).not.toHaveBeenCalled()
  })

  it('404s for unknown ids and for purchases outside the caller locations', async () => {
    state.row = null
    expect((await POST(new Request('http://t'), props)).status).toBe(404)
    state.row = { ...paidRow, location_id: 'other' }
    expect((await POST(new Request('http://t'), props)).status).toBe(404)
  })

  it('409s on an unpaid purchase', async () => {
    state.row = { ...paidRow, state: 'created' }
    expect((await POST(new Request('http://t'), props)).status).toBe(409)
    expect(sendOfferPurchaseEmail).not.toHaveBeenCalled()
  })

  it('surfaces a skip reason rather than claiming success', async () => {
    sendOfferPurchaseEmail.mockResolvedValueOnce({ status: 'skipped', reason: 'opted_out_administrative_email' })
    const res = await POST(new Request('http://t'), props)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('opted_out_administrative_email')
  })
})
