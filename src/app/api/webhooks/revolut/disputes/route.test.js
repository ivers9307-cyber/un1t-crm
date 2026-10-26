import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyWebhookSignature = vi.fn(() => true)
const getDispute = vi.fn()
vi.mock('@/lib/revolut', () => ({
  verifyWebhookSignature: (...a) => verifyWebhookSignature(...a),
  getDispute: (...a) => getDispute(...a),
}))

const recordWebhookEvent = vi.fn(async () => ({ seen: false }))
const releaseWebhookEvent = vi.fn(async () => {})
vi.mock('@/lib/webhook-events', () => ({
  recordWebhookEvent: (...a) => recordWebhookEvent(...a),
  releaseWebhookEvent: (...a) => releaseWebhookEvent(...a),
  WEBHOOK_PROVIDERS: { REVOLUT_DISPUTE: 'revolut_dispute' },
}))

const resolveDisputeSource = vi.fn()
const upsertDispute = vi.fn()
const noteDisputeOnOrder = vi.fn(async () => true)
const alertStaffOfDispute = vi.fn(async () => ({ sent: true }))
vi.mock('@/lib/revolut-disputes', () => ({
  resolveDisputeSource: (...a) => resolveDisputeSource(...a),
  upsertDispute: (...a) => upsertDispute(...a),
  noteDisputeOnOrder: (...a) => noteDisputeOnOrder(...a),
  alertStaffOfDispute: (...a) => alertStaffOfDispute(...a),
}))

const logWarn = vi.fn()
const logError = vi.fn()
vi.mock('@/lib/log', () => ({ logWarn: (...a) => logWarn(...a), logError: (...a) => logError(...a) }))

const createServerClient = vi.fn(() => ({ tag: 'db' }))
vi.mock('@/lib/supabase', () => ({ createServerClient: (...a) => createServerClient(...a) }))

import { POST, GET } from './route'

function makeRequest(payload) {
  return new Request('http://test/api/webhooks/revolut/disputes', {
    method: 'POST',
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    headers: { 'revolut-signature': 'v1=abc', 'revolut-request-timestamp': '1' },
  })
}

const dispute = {
  id: 'dsp_1', state: 'needs_response', reason_description: 'Fraud', amount: 1500, currency: 'EUR',
  response_due_date: '2026-11-05T12:00:00Z', payment: { order_id: 'ord_1' },
}
const source = { source_type: 'trial_purchase', source_id: 't1', location_id: 'loc1', label: 'paid trial' }
const row = { dispute_id: 'dsp_1', order_id: 'ord_1', location_id: 'loc1', state: 'needs_response' }
const actionRequired = { event: 'DISPUTE_ACTION_REQUIRED', dispute_id: 'dsp_1' }

beforeEach(() => {
  vi.clearAllMocks()
  verifyWebhookSignature.mockReturnValue(true)
  getDispute.mockResolvedValue(dispute)
  recordWebhookEvent.mockResolvedValue({ seen: false })
  resolveDisputeSource.mockResolvedValue(source)
  upsertDispute.mockResolvedValue(row)
  noteDisputeOnOrder.mockResolvedValue(true)
  alertStaffOfDispute.mockResolvedValue({ sent: true })
  delete process.env.REVOLUT_DISPUTE_WEBHOOK_SECRET
  process.env.REVOLUT_WEBHOOK_SECRET = 'shared'
})

describe('POST /api/webhooks/revolut/disputes', () => {
  it('401 on a bad signature, before any DB call', async () => {
    verifyWebhookSignature.mockReturnValue(false)
    expect((await POST(makeRequest(actionRequired))).status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
    expect(recordWebhookEvent).not.toHaveBeenCalled()
  })

  it('verifies against the dedicated secret first, then the shared one', async () => {
    process.env.REVOLUT_DISPUTE_WEBHOOK_SECRET = 'dedicated'
    await POST(makeRequest(actionRequired))
    expect(verifyWebhookSignature.mock.calls[0][3]).toEqual({ secrets: ['dedicated', 'shared'] })
  })

  it('200 on an unparseable or id-less body without claiming anything', async () => {
    expect((await POST(makeRequest('not json'))).status).toBe(200)
    expect((await POST(makeRequest({ event: 'DISPUTE_WON' }))).status).toBe(200)
    expect(recordWebhookEvent).not.toHaveBeenCalled()
  })

  it('dedupes on event:dispute_id', async () => {
    recordWebhookEvent.mockResolvedValue({ seen: true })
    const res = await POST(makeRequest(actionRequired))
    expect(await res.json()).toMatchObject({ deduped: true })
    expect(recordWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({ provider: 'revolut_dispute', eventId: 'DISPUTE_ACTION_REQUIRED:dsp_1' }))
    expect(getDispute).not.toHaveBeenCalled()
  })

  it('records the dispute, resolves its sale and alerts on ACTION_REQUIRED', async () => {
    const res = await POST(makeRequest(actionRequired))
    expect(await res.json()).toMatchObject({ success: true, state: 'needs_response' })
    expect(resolveDisputeSource).toHaveBeenCalledWith(expect.anything(), 'ord_1')
    expect(upsertDispute).toHaveBeenCalledWith(expect.anything(), dispute, source)
    expect(noteDisputeOnOrder).toHaveBeenCalledWith(expect.anything(), 'ord_1', row)
    expect(alertStaffOfDispute).toHaveBeenCalledWith(expect.anything(), 'DISPUTE_ACTION_REQUIRED', row, source)
    expect(releaseWebhookEvent).not.toHaveBeenCalled()
  })

  it('alerts on LOST but not on UNDER_REVIEW or WON', async () => {
    await POST(makeRequest({ event: 'DISPUTE_LOST', dispute_id: 'dsp_1' }))
    expect(alertStaffOfDispute).toHaveBeenCalledTimes(1)
    await POST(makeRequest({ event: 'DISPUTE_UNDER_REVIEW', dispute_id: 'dsp_1' }))
    await POST(makeRequest({ event: 'DISPUTE_WON', dispute_id: 'dsp_1' }))
    expect(alertStaffOfDispute).toHaveBeenCalledTimes(1)
  })

  it('getDispute failure releases the claim and answers 200 deferred', async () => {
    getDispute.mockRejectedValue(new Error('boom'))
    const res = await POST(makeRequest(actionRequired))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ deferred: true })
    expect(releaseWebhookEvent).toHaveBeenCalledTimes(1)
    const claimed = recordWebhookEvent.mock.calls[0][0]
    expect(releaseWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({ provider: claimed.provider, eventId: claimed.eventId }))
    expect(upsertDispute).not.toHaveBeenCalled()
  })

  it('a failed dispute write releases the claim', async () => {
    upsertDispute.mockRejectedValue(new Error('db down'))
    const res = await POST(makeRequest(actionRequired))
    expect(await res.json()).toMatchObject({ deferred: true })
    expect(releaseWebhookEvent).toHaveBeenCalledTimes(1)
    expect(alertStaffOfDispute).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalled()
  })

  it('a failed sale lookup releases the claim', async () => {
    resolveDisputeSource.mockRejectedValue(new Error('read failed'))
    expect(await (await POST(makeRequest(actionRequired))).json()).toMatchObject({ deferred: true })
    expect(releaseWebhookEvent).toHaveBeenCalledTimes(1)
  })

  it('an unknown order still records the dispute, with a null source', async () => {
    resolveDisputeSource.mockResolvedValue(null)
    const res = await POST(makeRequest(actionRequired))
    expect(res.status).toBe(200)
    expect(upsertDispute).toHaveBeenCalledWith(expect.anything(), dispute, null)
    expect(releaseWebhookEvent).not.toHaveBeenCalled()
  })

  it('an alert failure does not release the claim', async () => {
    alertStaffOfDispute.mockRejectedValue(new Error('postmark down'))
    const res = await POST(makeRequest(actionRequired))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, state: 'needs_response' })
    expect(releaseWebhookEvent).not.toHaveBeenCalled()
  })

  it('an orders-ledger note failure neither releases nor skips the alert', async () => {
    noteDisputeOnOrder.mockRejectedValue(new Error('orders down'))
    await POST(makeRequest(actionRequired))
    expect(releaseWebhookEvent).not.toHaveBeenCalled()
    expect(alertStaffOfDispute).toHaveBeenCalledTimes(1)
  })

  it('GET answers 200', async () => {
    expect((await GET()).status).toBe(200)
  })
})
