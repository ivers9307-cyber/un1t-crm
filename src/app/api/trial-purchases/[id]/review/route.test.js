import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  user: vi.fn(), access: vi.fn(), anyLoc: vi.fn(), forLoc: vi.fn(), publish: vi.fn(), email: vi.fn(),
  row: null, updates: [], updateResult: null,
}))

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.user, assertLocationAccessOr404: mocks.access }))
vi.mock('@/lib/permissions', () => ({ hasPermissionAtAnyLocation: mocks.anyLoc, hasPermissionForLocation: mocks.forLoc }))
vi.mock('@/lib/qstash', () => ({ publishQueuePush: mocks.publish, TRIAL_PURCHASES_WORKER_PATH: '/api/webhooks/qstash/trial-purchases' }))
vi.mock('@/lib/trial-purchase-emails', () => ({ sendTrialPurchaseEmail: mocks.email }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mocks.row, error: null }) }) }),
      update: (fields) => {
        mocks.updates.push(fields)
        return { eq: () => ({ eq: () => ({ select: async () => mocks.updateResult || { data: [{ id: 'tp1' }], error: null } }) }) }
      },
    }),
  }),
}))

import { POST } from './route'

const req = (body) => new Request('http://x/api/trial-purchases/tp1/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const props = { params: Promise.resolve({ id: 'tp1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.updates.length = 0
  mocks.updateResult = null
  mocks.user.mockResolvedValue({ id: 'u1' })
  mocks.access.mockReturnValue(null)
  mocks.anyLoc.mockReturnValue(true)
  mocks.forLoc.mockReturnValue(true)
  mocks.publish.mockResolvedValue({ ok: true })
  mocks.email.mockResolvedValue({ status: 'sent' })
  mocks.row = { id: 'tp1', status: 'needs_review', payment_status: 'paid', location_id: 'loc1', grant: { stage: 'purchasing', ok: false }, customer_email: 'r@x.com' }
})

describe('POST /api/trial-purchases/[id]/review (PAIDTRIAL.2)', () => {
  it('401 without a session, 403 without the grant anywhere', async () => {
    mocks.user.mockResolvedValueOnce(null)
    expect((await POST(req({ action: 'retry' }), props)).status).toBe(401)
    mocks.anyLoc.mockReturnValueOnce(false)
    expect((await POST(req({ action: 'retry' }), props)).status).toBe(403)
  })

  it('400 on an unknown action', async () => {
    expect((await POST(req({ action: 'refund' }), props)).status).toBe(400)
  })

  it('404 for an unknown row and for a row outside the caller\'s studios', async () => {
    mocks.row = null
    expect((await POST(req({ action: 'retry' }), props)).status).toBe(404)
    mocks.row = { id: 'tp1', status: 'needs_review', payment_status: 'paid', location_id: 'other' }
    mocks.access.mockReturnValueOnce(new Response(null, { status: 404 }))
    expect((await POST(req({ action: 'retry' }), props)).status).toBe(404)
  })

  it('403 when the grant is held elsewhere but not at the purchase\'s studio', async () => {
    mocks.forLoc.mockReturnValueOnce(false)
    expect((await POST(req({ action: 'retry' }), props)).status).toBe(403)
    expect(mocks.updates).toHaveLength(0)
  })

  it('409 when the row is unpaid, or the processor holds it', async () => {
    mocks.row.payment_status = 'pending'
    expect((await POST(req({ action: 'retry' }), props)).status).toBe(409)
    mocks.row.payment_status = 'paid'
    mocks.row.status = 'processing'
    const r = await POST(req({ action: 'resolve' }), props)
    expect(r.status).toBe(409)
    expect((await r.json()).error).toBe('in_progress')
    expect(mocks.updates).toHaveLength(0)
  })

  it('already granted → 200 { already: true } with no write', async () => {
    mocks.row.status = 'granted'
    const r = await POST(req({ action: 'retry' }), props)
    expect(r.status).toBe(200)
    expect((await r.json()).data).toEqual({ already: true, status: 'granted' })
    expect(mocks.updates).toHaveLength(0)
  })

  it('retry re-queues, resets attempts, KEEPS the grant marker, and nudges the worker', async () => {
    const r = await POST(req({ action: 'retry' }), props)
    expect(r.status).toBe(200)
    expect((await r.json()).data).toEqual({ status: 'queued' })
    expect(mocks.updates[0]).toEqual({ status: 'queued', attempts: 0, last_error: null })
    expect(mocks.updates[0]).not.toHaveProperty('grant')
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/webhooks/qstash/trial-purchases', body: { id: 'tp1' } }))
    expect(mocks.email).not.toHaveBeenCalled()
  })

  it('a retry that loses the race (row moved on) answers 409 and does not nudge', async () => {
    mocks.updateResult = { data: [], error: null }
    expect((await POST(req({ action: 'retry' }), props)).status).toBe(409)
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('resolve marks it granted by hand (marker kept, manual stamp) and emails the buyer', async () => {
    const r = await POST(req({ action: 'resolve' }), props)
    expect(r.status).toBe(200)
    expect((await r.json()).data).toEqual({ status: 'granted', emailed: true })
    const u = mocks.updates[0]
    expect(u.status).toBe('granted')
    expect(u.granted_at).toBeTruthy()
    expect(u.last_error).toBeNull()
    expect(u.grant).toMatchObject({ stage: 'purchasing', ok: true, manual: true, by: 'u1' })
    expect(mocks.email).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'granted' }))
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it("handled closes a help_requested row and sends no email", async () => {
    mocks.row = { id: 'tp1', status: 'help_requested', payment_status: null, location_id: 'loc1', customer_email: 'r@x.com' }
    const r = await POST(req({ action: 'handled' }), props)
    expect(r.status).toBe(200)
    expect((await r.json()).data).toEqual({ status: 'handled' })
    expect(mocks.updates).toEqual([{ status: 'handled', last_error: null }])
    expect(mocks.email).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it("handled on a needs_review row is 409 in_progress; retry on a help row is 409", async () => {
    let r = await POST(req({ action: 'handled' }), props)
    expect(r.status).toBe(409)
    expect((await r.json()).error).toBe('in_progress')
    mocks.row = { id: 'tp1', status: 'help_requested', payment_status: null, location_id: 'loc1' }
    expect((await POST(req({ action: 'retry' }), props)).status).toBe(409)
    expect((await POST(req({ action: 'resolve' }), props)).status).toBe(409)
    expect(mocks.updates).toHaveLength(0)
  })

  it('handled on a row that is already handled is a no-op 200; losing the race is 409', async () => {
    mocks.row = { id: 'tp1', status: 'handled', payment_status: null, location_id: 'loc1' }
    const r = await POST(req({ action: 'handled' }), props)
    expect(r.status).toBe(200)
    expect((await r.json()).data).toEqual({ already: true, status: 'handled' })
    mocks.row = { id: 'tp1', status: 'help_requested', payment_status: null, location_id: 'loc1' }
    mocks.updateResult = { data: [], error: null }
    expect((await POST(req({ action: 'handled' }), props)).status).toBe(409)
  })

  it('resolve still succeeds when the email is skipped or throws', async () => {
    mocks.email.mockResolvedValueOnce({ status: 'skipped', reason: 'no_email_address' })
    let r = await POST(req({ action: 'resolve' }), props)
    expect((await r.json()).data).toEqual({ status: 'granted', emailed: false })
    mocks.email.mockRejectedValueOnce(new Error('smtp down'))
    r = await POST(req({ action: 'resolve' }), props)
    expect(r.status).toBe(200)
    expect((await r.json()).data.emailed).toBe(false)
  })
})
