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

import { POST } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { readGlofoxCredentialsByBranchId, glofoxFetch } from '@/lib/glofox'
import { applyMemberSync } from '@/lib/glofox-sync'
import { findGlofoxCrossoverContact } from '@/lib/glofox-crossover'
import { triggerSequencesForContactCreated } from '@/lib/sequences/triggers'
import { logError } from '@/lib/log'

// Records every write; contacts reads at the studio find nothing.
function makeFakeDb() {
  const calls = []
  const answer = (q) => {
    if (q.table === 'glofox_webhook_events' && q.op === 'upsert') return { data: { id: 'row-1', status: 'received' }, error: null }
    if (q.table === 'contacts') return { data: [], error: null }
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

const deliver = (type, { userId = 'member-1', email = 'craig@example.test' } = {}) => POST(new Request('http://localhost/api/webhooks/glofox', {
  method: 'POST',
  headers: { 'content-type': 'application/json', signature: 'sig' },
  body: JSON.stringify({
    Type: type,
    Metadata: { location_id: 'branch-1', trace_id: 'trace-1', version: 'v1' },
    Payload: { id: userId, user_id: userId, email },
    Timestamp: '2026-10-19T08:15:02.876Z',
  }),
}))

let db
const eventUpdate = () => db.calls.find((c) => c.table === 'glofox_webhook_events' && c.op === 'update')

beforeEach(() => {
  vi.clearAllMocks()
  db = makeFakeDb()
  createServerClient.mockReturnValue(db)
  readGlofoxCredentialsByBranchId.mockResolvedValue({ creds: { locationId: 'loc-stillorgan', webhookSecret: 'secret' }, error: null })
  glofoxFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { _id: 'member-1' } }) })
  findGlofoxCrossoverContact.mockResolvedValue({ contact: null })
})

describe('POST /api/webhooks/glofox — sibling-studio contact (GLOFOXSIBLING.1)', () => {
  it('MEMBER_UPDATED for a member whose contact lives at a sibling studio: applied, and the member sync runs (it links the contact)', async () => {
    findGlofoxCrossoverContact.mockResolvedValue({ contact: { id: 'c-hatch', last_booked_at: null }, how: 'email' })
    applyMemberSync.mockResolvedValue({ action: 'update', contact_id: 'c-hatch', crossover: { how: 'email' }, crossover_link: { linked: true } })
    const body = await (await deliver('MEMBER_UPDATED')).json()
    expect(body).toMatchObject({ status: 'applied', contact_id: 'c-hatch' })
    expect(findGlofoxCrossoverContact).toHaveBeenCalledWith(db, 'loc-stillorgan', expect.objectContaining({ glofoxMemberId: 'member-1' }))
    expect(applyMemberSync).toHaveBeenCalledTimes(1)
    expect(eventUpdate().payload).toMatchObject({ status: 'applied', result: expect.objectContaining({ crossover: 'email' }) })
    // not a new signup: no contact_created
    expect(triggerSequencesForContactCreated).not.toHaveBeenCalled()
  })

  it('two candidate contacts in the organisation: contact_ambiguous, nothing written to a contact', async () => {
    findGlofoxCrossoverContact.mockResolvedValue({ contact: null, conflict: { reason: 'Two contacts in the organisation hold this email', contact_ids: ['a', 'b'] } })
    const body = await (await deliver('MEMBER_UPDATED')).json()
    expect(body.status).toBe('contact_ambiguous')
    expect(eventUpdate().payload).toMatchObject({ status: 'contact_ambiguous', error_message: 'Two contacts in the organisation hold this email' })
    expect(applyMemberSync).not.toHaveBeenCalled()
  })

  it('a failed organisation lookup is a lookup error, not contact_not_found', async () => {
    findGlofoxCrossoverContact.mockResolvedValue({ contact: null, error: 'contacts by email: timeout' })
    const body = await (await deliver('MEMBER_UPDATED')).json()
    expect(body.status).toBe('lookup_error')
    expect(eventUpdate().payload).toMatchObject({ status: 'failed' })
    expect(eventUpdate().payload.error_message).toMatch(/timeout/)
  })

  it('MEMBER_CREATED whose create the database refused: failed with the reason, logged, never contact_not_found', async () => {
    applyMemberSync.mockResolvedValue({ action: 'create', error: 'duplicate key value violates unique constraint "contacts_email_org_unique"' })
    const body = await (await deliver('MEMBER_CREATED')).json()
    expect(body.status).toBe('member_sync_failed')
    expect(eventUpdate().payload).toMatchObject({ status: 'failed' })
    expect(eventUpdate().payload.error_message).toMatch(/contacts_email_org_unique/)
    expect(logError).toHaveBeenCalledWith('glofox-webhook', expect.stringMatching(/did not produce a contact/), expect.objectContaining({ action: 'create' }))
  })

  it('MEMBER_CREATED that attached a sibling studio contact fires contact_created AT this studio (joined)', async () => {
    applyMemberSync.mockResolvedValue({ action: 'update', contact_id: 'c-hatch', crossover: { how: 'email' }, crossover_link: { linked: true } })
    const body = await (await deliver('MEMBER_CREATED')).json()
    expect(body).toMatchObject({ status: 'applied', contact_id: 'c-hatch' })
    expect(triggerSequencesForContactCreated).toHaveBeenCalledWith('c-hatch', { locationId: 'loc-stillorgan' })
    // the 6b sync is reused; the member is not fetched and synced twice
    expect(applyMemberSync).toHaveBeenCalledTimes(1)
  })

  it('MEMBER_CREATED that matched an existing contact AT the studio fires no contact_created', async () => {
    applyMemberSync.mockResolvedValue({ action: 'update', contact_id: 'c-here' })
    await deliver('MEMBER_CREATED')
    expect(triggerSequencesForContactCreated).not.toHaveBeenCalled()
  })
})
