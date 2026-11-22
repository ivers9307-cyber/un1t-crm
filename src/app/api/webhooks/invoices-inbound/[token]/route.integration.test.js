// INVOICEPREP.1 — the real route, real ingest and real webhook-events together.
// Only the database is faked, so this checks the promise the pieces make as a
// whole: whatever fails, the provider's retry finishes storing the email.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))

const { POST } = await import('./route.js')

const TOKEN = 'test-token'
const LOC = '11111111-1111-4111-8111-111111111111'
const ctx = () => ({ params: Promise.resolve({ token: TOKEN }) })
const req = (body) => new Request('http://x', {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
})
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n', 'latin1').toString('base64')
const email = (Attachments) => ({
  MessageID: 'msg-1',
  To: 'north-invoices@mail.un1tdublin.com',
  From: 'sender@example.com',
  Subject: 'Invoice',
  TextBody: 'hello',
  Attachments,
})
const pdf = (Name) => ({ Name, ContentType: 'application/pdf', Content: PDF })
const claims = () => (db.tables.webhook_events || []).filter((r) => r.event_id === 'inbound-invoice:msg-1')
const queue = () => db.tables.invoices_queue || []

let upload, savedToken
function makeDb(opts = {}) {
  const fake = createFakeDb({
    tables: { locations: [{ id: LOC, name: 'North', invoices_inbound_slug: 'north' }], invoices_queue: [], webhook_events: [] },
    ...opts,
  })
  // The fake does not enforce unique indexes; webhook_events has one on
  // (provider, event_id), and the held-claim case depends on it answering 23505.
  const realFrom = fake.from.bind(fake)
  fake.from = (table) => {
    const q = realFrom(table)
    if (table !== 'webhook_events') return q
    const realInsert = q.insert.bind(q)
    q.insert = (row, o) => {
      const taken = (fake.tables.webhook_events || []).some((r) => r.provider === row.provider && r.event_id === row.event_id)
      if (taken) return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } })
      return realInsert(row, o)
    }
    return q
  }
  fake.storage = { from: () => ({ upload }) }
  return fake
}

beforeEach(() => {
  savedToken = process.env.POSTMARK_INBOUND_WEBHOOK_TOKEN
  process.env.POSTMARK_INBOUND_WEBHOOK_TOKEN = TOKEN
  upload = vi.fn(async () => ({ error: null }))
  db = makeDb()
})
afterEach(() => {
  if (savedToken === undefined) delete process.env.POSTMARK_INBOUND_WEBHOOK_TOKEN
  else process.env.POSTMARK_INBOUND_WEBHOOK_TOKEN = savedToken
})

describe('inbound invoice webhook, end to end over the fake database', () => {
  it('a failed second upload answers 500 and frees the claim; the retry stores both', async () => {
    const body = email([pdf('a.pdf'), pdf('b.pdf')])
    upload.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: 'boom' } })
    const first = await POST(req(body), ctx())
    expect(first.status).toBe(500)
    expect(claims()).toHaveLength(0)

    const again = await POST(req(body), ctx())
    expect(again.status).toBe(200)
    expect(queue()).toHaveLength(2)
    expect(queue().every((r) => r.attachment_path && r.content_hash)).toBe(true)
  })

  it('stores the email when a claim was left held with nothing stored', async () => {
    await db.from('webhook_events').insert({ provider: 'postmark', event_id: 'inbound-invoice:msg-1' })
    expect(claims()).toHaveLength(1)
    const res = await POST(req(email([pdf('a.pdf')])), ctx())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, deduped: true, created: 1 })
    expect(queue()).toHaveLength(1)
    expect(queue()[0].attachment_path).toBeTruthy()
  })

  it('stores the email when the claim itself cannot be written', async () => {
    db = makeDb({ errors: { webhook_events: { insert: { message: 'down' } } } })
    const res = await POST(req(email([pdf('a.pdf')])), ctx())
    expect(res.status).toBe(200)
    expect(queue()).toHaveLength(1)
    expect(queue()[0].attachment_path).toBeTruthy()
  })
})
