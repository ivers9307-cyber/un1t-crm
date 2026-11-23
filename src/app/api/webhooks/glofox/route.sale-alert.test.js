// SALEALERT.1 — the Glofox webhook hands each INVOICE_UPDATED to the sale alert
// (matched or not) without changing its answer.
// GLOFOXSIBLING.1 — a Glofox member whose one CRM contact lives at a sibling
// studio of the same organisation. Before: the studio-scoped lookup missed,
// every event was contact_not_found, and a MEMBER_CREATED whose insert the
// org email index refused was ALSO contact_not_found, with nothing logged.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  readGlofoxCredentialsByBranchId: vi.fn(),
  verifyGlofoxSignature: vi.fn(() => true),
  glofoxFetch: vi.fn(),
}))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/sequences/triggers', () => ({
  triggerSequencesForTagsAdded: vi.fn(),
  triggerSequencesForContactCreated: vi.fn(),
  triggerSequencesForMembershipStateChange: vi.fn(),
}))
vi.mock('@/lib/glofox-invoices', () => ({ applyInvoiceWebhook: vi.fn() }))
vi.mock('@/lib/glofox-services', () => ({ applyServiceWebhook: vi.fn() }))
vi.mock('@/lib/glofox-membership', () => ({ applyMembershipPauseWindow: vi.fn() }))
vi.mock('@/lib/dunning', () => ({ maybeEnrolDunning: vi.fn(), exitDunningForContact: vi.fn(), dunningActionFor: vi.fn() }))
vi.mock('@/lib/glofox-sync', () => ({ applyMemberSync: vi.fn() }))
vi.mock('@/lib/glofox-crossover', () => ({ findGlofoxCrossoverContact: vi.fn() }))
vi.mock('@/lib/webhook-dead-letter', () => ({ deadLetterWebhook: vi.fn() }))
vi.mock('@/lib/glofox-sale-alert', () => ({ alertGlofoxInvoiceSale: vi.fn() }))

import { POST } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { readGlofoxCredentialsByBranchId, glofoxFetch } from '@/lib/glofox'
import { findGlofoxCrossoverContact } from '@/lib/glofox-crossover'
import { applyInvoiceWebhook } from '@/lib/glofox-invoices'
import { alertGlofoxInvoiceSale } from '@/lib/glofox-sale-alert'

// Records every write; contacts reads at the studio find nothing.
let matched = false
function makeFakeDb() {
  const calls = []
  const answer = (q) => {
    if (q.table === 'glofox_webhook_events' && q.op === 'upsert') return { data: { id: 'row-1', status: 'received' }, error: null }
    if (q.table === 'contacts') return { data: matched ? [{ id: 'c-1', last_booked_at: null }] : [], error: null }
    if (q.table === 'contact_tags' && q.op === 'select') return { data: [], error: null }
    return { data: null, error: null }
  }
  const from = (table) => {
    const q = { table, op: 'select', payload: null, filters: [] }
    const chain = {}
    for (const m of ['select', 'order', 'limit', 'single', 'maybeSingle', 'ilike']) chain[m] = () => chain
    chain.eq = (col, val) => { q.filters.push([col, val]); return chain }
    for (const op of ['insert', 'update', 'upsert', 'delete']) {
      chain[op] = (payload) => { q.op = op; q.payload = payload; calls.push(q); return chain }
    }
    chain.then = (resolve, reject) => Promise.resolve(answer(q)).then(resolve, reject)
    return chain
  }
  return { from, calls }
}

const PAYLOAD = { id: 'inv-1', status: 'PAID', total: 5000, payment_method: 'CARD', user: { id: 'member-1', email: 'sam@example.test', first_name: 'Sam' }, line_items: [{ name: 'Sample Class Pack', sub_type: 'UPFRONT_PAYMENT', unit_price: 5000 }] }
const deliver = (type = 'INVOICE_UPDATED') => POST(new Request('http://localhost/api/webhooks/glofox', {
  method: 'POST',
  headers: { 'content-type': 'application/json', signature: 'sig' },
  body: JSON.stringify({ Type: type, Metadata: { location_id: 'branch-1', trace_id: 't', version: 'v1' }, Payload: PAYLOAD, Timestamp: '2026-11-23T08:15:02.876Z' }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  matched = false
  createServerClient.mockReturnValue(makeFakeDb())
  readGlofoxCredentialsByBranchId.mockResolvedValue({ creds: { locationId: 'loc-stillorgan', webhookSecret: 'secret' }, error: null })
  glofoxFetch.mockResolvedValue({ ok: true, json: async () => ({}) })
  findGlofoxCrossoverContact.mockResolvedValue({ contact: null })
  applyInvoiceWebhook.mockResolvedValue({ ok: true, invoice_id: 'inv-1', invoice_status: 'PAID', amount_cents: 5000, is_membership: false })
  alertGlofoxInvoiceSale.mockResolvedValue({ sent: true })
})

describe('POST /api/webhooks/glofox — new sale alert (SALEALERT.1)', () => {
  it('a matched member: rings once with the delivery location and contact, answer unchanged', async () => {
    matched = true
    const res = await deliver()
    expect(res.status).toBe(200)
    expect(alertGlofoxInvoiceSale).toHaveBeenCalledTimes(1)
    const [, args] = alertGlofoxInvoiceSale.mock.calls[0]
    expect(args).toMatchObject({ locationId: 'loc-stillorgan', contact: { id: 'c-1' } })
    expect(args.payload.Payload.id).toBe('inv-1')
  })

  it('an unmatched member still rings (no contact), and still answers contact_not_found', async () => {
    const res = await deliver()
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('contact_not_found')
    expect(alertGlofoxInvoiceSale).toHaveBeenCalledTimes(1)
    expect(alertGlofoxInvoiceSale.mock.calls[0][1]).toMatchObject({ locationId: 'loc-stillorgan', contact: null })
  })

  it('an alert that throws changes nothing about the answer', async () => {
    matched = true
    alertGlofoxInvoiceSale.mockRejectedValue(new Error('boom'))
    const res = await deliver()
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
  })

  it('other event types never ring', async () => {
    matched = true
    await deliver('MEMBERSHIP_CREATED')
    expect(alertGlofoxInvoiceSale).not.toHaveBeenCalled()
  })
})
