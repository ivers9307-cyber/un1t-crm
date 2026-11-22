// INVOICEPREP.1 — the inbound webhook releases its dedup claim on any failure
// (so the provider's retry is processed) and records mail that matches no studio.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/invoices-queue/ingest-email', () => ({ ingestInboundEmail: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/webhook-events', async () => ({
  ...(await vi.importActual('@/lib/webhook-events')),
  recordWebhookEvent: vi.fn(),
  releaseWebhookEvent: vi.fn(async () => {}),
}))

const { POST } = await import('./route.js')
const { ingestInboundEmail } = await import('@/lib/invoices-queue/ingest-email')
const { recordWebhookEvent, releaseWebhookEvent } = await import('@/lib/webhook-events')

const TOKEN = 'test-token'
const ctx = (token = TOKEN) => ({ params: Promise.resolve({ token }) })
const req = (body) => new Request('http://x', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
})
const email = (extra = {}) => ({
  MessageID: 'm1',
  To: 'north-invoices@mail.un1tdublin.com',
  From: 'sender@example.com',
  Subject: 'Invoice',
  Attachments: [],
  ...extra,
})
const strays = () => db.tables.invoice_inbound_strays || []
const OK = { ok: true, created: ['r1'], alreadyStored: 0, skippedInline: 0 }

let savedToken
beforeEach(() => {
  vi.clearAllMocks()
  savedToken = process.env.POSTMARK_INBOUND_WEBHOOK_TOKEN
  process.env.POSTMARK_INBOUND_WEBHOOK_TOKEN = TOKEN
  db = createFakeDb({ tables: { locations: [{ id: 'loc1', name: 'North', invoices_inbound_slug: 'north' }] } })
  recordWebhookEvent.mockResolvedValue({ seen: false })
  ingestInboundEmail.mockResolvedValue(OK)
})
afterEach(() => {
  if (savedToken === undefined) delete process.env.POSTMARK_INBOUND_WEBHOOK_TOKEN
  else process.env.POSTMARK_INBOUND_WEBHOOK_TOKEN = savedToken
})

describe('inbound invoice webhook', () => {
  it('stores the email through ingestInboundEmail and does not release on success', async () => {
    const res = await POST(req(email()), ctx())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, created: 1, ids: ['r1'] })
    expect(ingestInboundEmail).toHaveBeenCalledWith(db, expect.objectContaining({ location: expect.objectContaining({ id: 'loc1' }) }))
    expect(releaseWebhookEvent).not.toHaveBeenCalled()
  })

  it('releases the dedup claim and answers 500 when storing fails', async () => {
    ingestInboundEmail.mockResolvedValue({ ok: false, error: 'storage_upload_failed' })
    const res = await POST(req(email()), ctx())
    expect(res.status).toBe(500)
    expect(releaseWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'inbound-invoice:m1', provider: 'postmark' }))
  })

  it('releases the claim and answers 500 when ingest throws', async () => {
    ingestInboundEmail.mockRejectedValue(new Error('boom'))
    const res = await POST(req(email()), ctx())
    expect(res.status).toBe(500)
    expect(releaseWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'inbound-invoice:m1' }))
  })

  it('releases the claim when the studio lookup fails', async () => {
    db = createFakeDb({ errors: { locations: { select: { message: 'down' } } } })
    const res = await POST(req(email()), ctx())
    expect(res.status).toBe(500)
    expect(releaseWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'inbound-invoice:m1' }))
    expect(ingestInboundEmail).not.toHaveBeenCalled()
  })

  it('records a stray for an unknown address and answers 200', async () => {
    const res = await POST(req(email({ To: 'nowhere-invoices@mail.un1tdublin.com' })), ctx())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, ignored: 'unknown_slug', slug: 'nowhere' })
    expect(strays()).toEqual([expect.objectContaining({ reason: 'unknown_slug', slug: 'nowhere', email_message_id: 'm1' })])
    expect(ingestInboundEmail).not.toHaveBeenCalled()
    expect(releaseWebhookEvent).not.toHaveBeenCalled()
  })

  it('records a stray for an address it cannot parse', async () => {
    const res = await POST(req(email({ To: 'someone@example.com' })), ctx())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, ignored: 'unparseable_recipient' })
    expect(strays()).toEqual([expect.objectContaining({ reason: 'unparseable_recipient', slug: null, to_address: 'someone@example.com' })])
  })

  it('releases the claim and answers 500 when the stray cannot be written', async () => {
    db = createFakeDb({ errors: { invoice_inbound_strays: { insert: { message: 'down' } } } })
    const res = await POST(req(email({ To: 'someone@example.com' })), ctx())
    expect(res.status).toBe(500)
    expect(releaseWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'inbound-invoice:m1' }))
  })

  it('answers deduped for a delivery already claimed, without releasing', async () => {
    recordWebhookEvent.mockResolvedValue({ seen: true })
    const res = await POST(req(email()), ctx())
    expect(await res.json()).toEqual({ success: true, deduped: true })
    expect(ingestInboundEmail).not.toHaveBeenCalled()
    expect(releaseWebhookEvent).not.toHaveBeenCalled()
  })

  it('answers 404 on a wrong token and 400 without a MessageID, claiming nothing', async () => {
    expect((await POST(req(email()), ctx('wrong'))).status).toBe(404)
    expect((await POST(req(email({ MessageID: undefined })), ctx())).status).toBe(400)
    expect((await POST(req('not json'), ctx())).status).toBe(400)
    expect(recordWebhookEvent).not.toHaveBeenCalled()
    expect(releaseWebhookEvent).not.toHaveBeenCalled()
  })
})
