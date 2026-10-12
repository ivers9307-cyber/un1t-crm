// POST /api/webhooks/postmark — MessageID handling (PMSUBCHANGE.1).
//
// Postmark sends MessageID NULL on a SubscriptionChange made by the account
// (API or UI, Origin "Customer"), by Postmark ("Admin"), and on every
// reactivation. The route answered those with a silent 400 "Missing
// MessageID"; on 12 Oct 2026 the consent-drift cron pushed 355 suppressions to
// the new tenant server, all 355 webhooks failed, and Postmark disabled the
// server's webhook. These tests pin that such an event is queued, and that
// every message-bound record type still needs a MessageID.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/webhook-events', () => ({
  recordWebhookEvent: vi.fn(),
  WEBHOOK_PROVIDERS: { POSTMARK: 'postmark' },
}))
vi.mock('@/lib/webhook-dead-letter', () => ({
  deadLetterWebhook: vi.fn(),
  resolveEmailSendLocation: vi.fn(),
}))
vi.mock('@/lib/qstash', () => ({ publishQueuePush: vi.fn(), POSTMARK_WORKER_PATH: '/api/worker' }))

import { POST } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { recordWebhookEvent } from '@/lib/webhook-events'

const TOKEN = 'test-webhook-token'

function makeRequest(body) {
  return new Request('http://localhost/api/webhooks/postmark', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-token': TOKEN },
    body: JSON.stringify(body),
  })
}

function makeDb() {
  const inserts = []
  return {
    inserts,
    from: vi.fn(() => ({
      insert: (row) => {
        inserts.push(row)
        return { select: () => ({ single: async () => ({ data: { id: 'q-1' }, error: null }) }) }
      },
    })),
  }
}

// What Postmark sent for each address the consent-drift cron suppressed.
const CUSTOMER_SUPPRESSION = {
  RecordType: 'SubscriptionChange',
  MessageID: null,
  ServerID: 21100951,
  MessageStream: 'broadcast',
  ChangedAt: '2026-10-12T06:00:50Z',
  Recipient: 'someone@example.test',
  Origin: 'Customer',
  SuppressSending: true,
  SuppressionReason: 'ManualSuppression',
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('POSTMARK_WEBHOOK_TOKEN', TOKEN)
  db = makeDb()
  createServerClient.mockReturnValue(db)
  recordWebhookEvent.mockResolvedValue({ seen: false })
})

describe('POST /api/webhooks/postmark — MessageID (PMSUBCHANGE.1)', () => {
  it('queues a SubscriptionChange whose MessageID is null', async () => {
    const res = await POST(makeRequest(CUSTOMER_SUPPRESSION))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, queued: true })
    expect(db.inserts).toEqual([{ payload: CUSTOMER_SUPPRESSION }])
    expect(recordWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'SubscriptionChange:none:21100951:broadcast:someone@example.test:2026-10-12T06:00:50Z:true',
    }))
  })

  it('queues a reactivation whose MessageID is absent altogether', async () => {
    const { MessageID: _omit, ...absent } = { ...CUSTOMER_SUPPRESSION, SuppressSending: false }
    const res = await POST(makeRequest(absent))
    expect(res.status).toBe(200)
    expect(db.inserts).toHaveLength(1)
  })

  it('still refuses a message-bound record type with no MessageID', async () => {
    for (const RecordType of ['Delivery', 'Open', 'Click', 'Bounce', 'SpamComplaint']) {
      const res = await POST(makeRequest({ RecordType, MessageID: null }))
      expect(res.status).toBe(400)
    }
    expect(db.inserts).toEqual([])
  })

  it('a message-bound SubscriptionChange is unchanged', async () => {
    const res = await POST(makeRequest({ ...CUSTOMER_SUPPRESSION, MessageID: 'pm-1', Origin: 'Recipient' }))
    expect(res.status).toBe(200)
    expect(recordWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'SubscriptionChange:pm-1' }))
  })
})
