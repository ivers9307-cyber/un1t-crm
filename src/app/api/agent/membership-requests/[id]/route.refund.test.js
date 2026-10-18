// UN1TWRITE.8 — a refund_request card is RECORD-ONLY. Approving it writes
// 'actioned' with { ok: true, record_only: true } and calls nothing in
// un1t.online or Glofox: the refund itself is done by hand in the un1t.online
// owner console. Declining it sends the customer nothing (Mia's
// refund_request_text already answered in the thread).
//
// Fictional ids only: the repo is public.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => ({ id: 'staff-1' })) }))
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  createBooking: vi.fn(),
  cancelBooking: vi.fn(),
  purchaseGlofoxMembership: vi.fn(),
  fetchUserCreditsResult: vi.fn(),
  glofoxFetch: vi.fn(),
}))
vi.mock('@/lib/agent/notify', () => ({
  sendAgentThreadMessage: vi.fn(async () => ({ ok: true })),
  buildDeclineNoticeText: vi.fn(() => 'Sorry, we could not complete that request.'),
  buildBookingConfirmationText: vi.fn(() => 'Booked!'),
  buildCancellationConfirmationText: vi.fn(() => 'Cancelled.'),
  agentConfirmationTemplates: vi.fn(async () => ({})),
}))

import * as glofox from '@/lib/glofox'
import { sendAgentThreadMessage } from '@/lib/agent/notify'
import { PATCH } from './route.js'

const ROW = {
  id: 'r1',
  location_id: 'L1',
  kind: 'refund_request',
  status: 'pending',
  details: {
    provider: 'un1t_online', un1t_user_id: 'usr-1', reason: 'double_payment', booking_id: 'bk-1',
    transaction_ids: ['tx-1'], amount_cents: 1500, currency: 'EUR', origin: 'mia', origin_ref: 'turn-1', record_only: true,
  },
  contact_id: 'c1',
  channel: 'whatsapp',
  conversation_id: 'conv1',
}

function makeDbFor(row, updates) {
  return {
    from(table) {
      let patch = null
      const b = {
        select: () => b,
        eq: () => b,
        neq: () => b,
        contains: () => b,
        insert: () => b,
        is: () => b,
        limit: () => b,
        then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject) },
        update(p) { patch = p; updates.push({ table, patch: p }); return b },
        async maybeSingle() {
          if (patch) return { data: { id: row.id }, error: null }
          return { data: row, error: null }
        },
        async single() {
          return { data: { id: row.id, status: patch?.status, decided_at: null, decision_note: null, details: patch?.details }, error: null }
        },
      }
      return b
    },
  }
}

const decide = (status, extra = {}) => PATCH(
  new Request('http://localhost/api/agent/membership-requests/r1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status, ...extra }),
  }),
  { params: Promise.resolve({ id: 'r1' }) },
)

let updates
let fetchSpy
beforeEach(() => {
  vi.clearAllMocks()
  updates = []
  db = makeDbFor(ROW, updates)
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('test: no network') })
})

describe('PATCH refund_request — record only', () => {
  it('approving records actioned with result { ok: true, record_only: true } and calls nothing in un1t.online or Glofox', async () => {
    const res = await decide('approved')
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.executed).toEqual({ ok: true, record_only: true })
    const final = updates.at(-1).patch
    expect(final.status).toBe('actioned')
    expect(final.details.result).toEqual({ ok: true, record_only: true })
    expect(final.details.record_only).toBe(true)
    // The marker is closed out like any executing kind.
    expect(final.details.execution).toMatchObject({ stage: 'done' })

    expect(fetchSpy).not.toHaveBeenCalled()
    for (const [name, fn] of Object.entries(glofox)) {
      if (typeof fn?.mock?.calls?.length === 'number') expect(fn, `glofox.${name}`).not.toHaveBeenCalled()
    }
  })

  it('approving sends the customer nothing: Mia already answered in the thread', async () => {
    const json = await (await decide('approved')).json()
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
    expect(json.customer_notified).toBeNull()
  })

  it('declining keeps status declined and sends the customer no notice', async () => {
    const res = await decide('declined', { decision_note: 'not a refund case' })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.executed).toBeNull()
    expect(updates.at(-1).patch.status).toBe('declined')
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('declining another kind with a conversation still sends the decline notice (the carve-out is refund_request only)', async () => {
    db = makeDbFor({ ...ROW, kind: 'pause', details: {} }, updates)
    await decide('declined')
    expect(sendAgentThreadMessage).toHaveBeenCalledOnce()
  })

  it('an already-decided refund card still 409s', async () => {
    db = makeDbFor({ ...ROW, status: 'actioned' }, updates)
    const res = await decide('approved')
    expect(res.status).toBe(409)
  })
})
