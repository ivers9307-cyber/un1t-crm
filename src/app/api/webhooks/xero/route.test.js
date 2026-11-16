// XEROHOOK.1 — a Xero event that could not be recorded is dead-lettered for
// replay (200), and only one that could not even be kept asks Xero to retry.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/xero/webhooks', () => ({ verifyXeroSignature: () => true }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/xero/webhook-events', () => ({ processXeroInvoiceEvent: vi.fn() }))
vi.mock('@/lib/webhook-dead-letter', () => ({ deadLetterWebhook: vi.fn() }))

const { POST } = await import('./route.js')
const { processXeroInvoiceEvent } = await import('@/lib/xero/webhook-events')
const { deadLetterWebhook } = await import('@/lib/webhook-dead-letter')
const post = (events) => POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ events }), headers: { 'x-xero-signature': 'sig' } }))
const EV = { eventCategory: 'INVOICE', resourceId: 'inv-1', eventType: 'UPDATE' }

beforeEach(() => vi.clearAllMocks())

describe('POST /api/webhooks/xero', () => {
  it('counts processed and ignored events', async () => {
    processXeroInvoiceEvent.mockResolvedValueOnce({ status: 'processed' }).mockResolvedValueOnce({ status: 'ignored', reason: 'not_ours' })
    const body = await (await post([EV, EV])).json()
    expect(body).toMatchObject({ processed: 1, skipped: 1, dead_lettered: 0 })
  })

  it('a failed event is dead-lettered for replay and still answers 200', async () => {
    processXeroInvoiceEvent.mockResolvedValue({ status: 'failed', reason: 'xero_fetch_failed', error: new Error('token'), locationId: 'loc1' })
    deadLetterWebhook.mockResolvedValue({ id: 'dl1' })
    const res = await post([EV])
    expect(res.status).toBe(200)
    expect((await res.json()).dead_lettered).toBe(1)
    expect(deadLetterWebhook).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ provider: 'xero', payload: EV, locationId: 'loc1' }))
  })

  it('an event that could not even be kept asks Xero to retry (503)', async () => {
    processXeroInvoiceEvent.mockResolvedValue({ status: 'failed', reason: 'car_read_failed' })
    deadLetterWebhook.mockResolvedValue(null)
    expect((await post([EV])).status).toBe(503)
  })

  it('a handler that throws is treated as failed', async () => {
    processXeroInvoiceEvent.mockRejectedValue(new Error('boom'))
    deadLetterWebhook.mockResolvedValue({ id: 'dl1' })
    expect((await (await post([EV])).json()).dead_lettered).toBe(1)
  })
})
