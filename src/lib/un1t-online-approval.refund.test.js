// UN1TWRITE.8 — fileRefundCard: a refund is never moved by the CRM. It files a
// pending, RECORD-ONLY `refund_request` card so a person does it by hand in the
// un1t.online owner console. The card is plain data on agent_membership_requests;
// nothing here reaches un1t.online or Glofox (the guard in
// tests/un1t-online-write-guard.test.js fences the imports).
//
// Fictional ids only: the repo is public.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/agent/approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => {}) }))

import { logError } from '@/lib/log'
import { notifyAgentApprovalRequest } from '@/lib/agent/approval-notify'
import { fileRefundCard } from './un1t-online-approval.js'

const LOC = 'a0000000-0000-0000-0000-000000000002'
const OTHER_LOC = 'a0000000-0000-0000-0000-000000000009'
const CONTACT = 'c0000000-0000-0000-0000-0000000000c1'
const CONVO = 'd0000000-0000-0000-0000-0000000000d1'

// A tiny in-memory agent_membership_requests: eq / is on a column or a
// details->>key path, limit, maybeSingle, and insert(...).select().maybeSingle().
// `failInsert` makes the insert answer an error; `failRead` the dedupe read.
function makeDb({ rows = [], failInsert = false, failRead = false, contactName = 'Aoife Test' } = {}) {
  const store = rows.map((r) => ({ ...r }))
  const inserts = []
  let seq = 0
  const valueAt = (row, col) => {
    if (col.startsWith('details->>')) {
      const v = row.details?.[col.slice('details->>'.length)]
      return v === undefined || v === null ? null : String(v)
    }
    return row[col] ?? null
  }
  return {
    store, inserts,
    from(table) {
      if (table === 'contacts') {
        const c = { select: () => c, eq: () => c, maybeSingle: async () => ({ data: { name: contactName }, error: null }) }
        return c
      }
      expect(table).toBe('agent_membership_requests')
      const filters = []
      let pending = null
      const b = {
        select: () => b,
        eq(col, val) { filters.push((r) => valueAt(r, col) === (val === null ? null : typeof val === 'string' ? val : String(val))); return b },
        is(col, val) { filters.push((r) => valueAt(r, col) === val); return b },
        order: () => b,
        limit: () => b,
        insert(row) { pending = row; inserts.push(row); return b },
        async maybeSingle() {
          if (pending) {
            if (failInsert) return { data: null, error: { message: 'insert refused', code: '23514' } }
            const row = { id: `req-${++seq}`, status: 'pending', ...pending }
            store.push(row)
            return { data: { id: row.id }, error: null }
          }
          if (failRead) return { data: null, error: { message: 'read refused' } }
          const hit = store.find((r) => filters.every((f) => f(r)))
          return { data: hit ? { id: hit.id } : null, error: null }
        },
      }
      return b
    },
  }
}

const ARGS = {
  locationId: LOC,
  contactId: CONTACT,
  un1tUserId: 'usr-1',
  reason: 'double_payment',
  bookingId: 'bk-1',
  transactionIds: ['tx-1', 'tx-2'],
  amountCents: 1500,
  currency: 'EUR',
  origin: 'mia',
  originRef: 'turn-1',
  conversationId: CONVO,
  channel: 'whatsapp',
}

let fetchSpy
beforeEach(() => {
  vi.clearAllMocks()
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('test: no network') })
})
afterEach(() => { fetchSpy.mockRestore() })

describe('fileRefundCard', () => {
  it('files a pending record-only refund_request card with provider un1t_online and every field', async () => {
    const db = makeDb()
    const out = await fileRefundCard(db, ARGS)

    expect(out).toEqual({ approvalId: 'req-1' })
    expect(db.inserts).toHaveLength(1)
    expect(db.inserts[0]).toMatchObject({
      location_id: LOC,
      contact_id: CONTACT,
      kind: 'refund_request',
      status: 'pending',
      channel: 'whatsapp',
      conversation_id: CONVO,
      details: {
        provider: 'un1t_online',
        un1t_user_id: 'usr-1',
        reason: 'double_payment',
        booking_id: 'bk-1',
        transaction_ids: ['tx-1', 'tx-2'],
        amount_cents: 1500,
        currency: 'EUR',
        origin: 'mia',
        origin_ref: 'turn-1',
        record_only: true,
      },
    })
  })

  it('fills the optional fields with null / [] so the card shape is always the same', async () => {
    const db = makeDb()
    await fileRefundCard(db, { locationId: LOC, contactId: null, un1tUserId: null, reason: 'member_request', origin: 'staff' })
    expect(db.inserts[0].details).toEqual({
      provider: 'un1t_online',
      un1t_user_id: null,
      reason: 'member_request',
      booking_id: null,
      transaction_ids: [],
      amount_cents: null,
      currency: null,
      origin: 'staff',
      origin_ref: null,
      record_only: true,
    })
    expect(db.inserts[0]).toMatchObject({ contact_id: null, channel: null, conversation_id: null })
  })

  it('makes no un1t.online request', async () => {
    await fileRefundCard(makeDb(), ARGS)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('notifies the approvers once, naming the Refund request kind', async () => {
    const db = makeDb()
    await fileRefundCard(db, ARGS)
    expect(notifyAgentApprovalRequest).toHaveBeenCalledOnce()
    expect(notifyAgentApprovalRequest.mock.calls[0][1]).toMatchObject({
      requestId: 'req-1', locationId: LOC, kind: 'refund_request', customerName: 'Aoife Test',
    })
  })

  it('a second fileRefundCard with the same contact, reason and originRef returns the pending card\'s id', async () => {
    const db = makeDb()
    const first = await fileRefundCard(db, ARGS)
    const second = await fileRefundCard(db, ARGS)

    expect(second).toEqual(first)
    expect(db.inserts).toHaveLength(1)
    expect(notifyAgentApprovalRequest).toHaveBeenCalledOnce()
  })

  it('a different originRef, reason, contact or studio files its own card', async () => {
    const db = makeDb()
    await fileRefundCard(db, ARGS)
    await fileRefundCard(db, { ...ARGS, originRef: 'turn-2' })
    await fileRefundCard(db, { ...ARGS, reason: 'late_cancel' })
    await fileRefundCard(db, { ...ARGS, contactId: 'c0000000-0000-0000-0000-0000000000c2' })
    await fileRefundCard(db, { ...ARGS, locationId: OTHER_LOC })
    expect(db.inserts).toHaveLength(5)
  })

  it('a decided card is not reused: a later request files a fresh one', async () => {
    const db = makeDb()
    const first = await fileRefundCard(db, ARGS)
    db.store.find((r) => r.id === first.approvalId).status = 'actioned'
    const second = await fileRefundCard(db, ARGS)
    expect(second.approvalId).not.toBe(first.approvalId)
    expect(db.inserts).toHaveLength(2)
  })

  it('with no originRef, the same contact and reason still dedupe', async () => {
    const db = makeDb()
    const a = await fileRefundCard(db, { ...ARGS, originRef: null })
    const b = await fileRefundCard(db, { ...ARGS, originRef: null })
    expect(b).toEqual(a)
    expect(db.inserts).toHaveLength(1)
  })

  it('with no contact, it dedupes on the un1t.online user and never merges two strangers', async () => {
    const db = makeDb()
    const noContact = { ...ARGS, contactId: null }
    const a = await fileRefundCard(db, noContact)
    const same = await fileRefundCard(db, noContact)
    const other = await fileRefundCard(db, { ...noContact, un1tUserId: 'usr-2' })
    const nobody = await fileRefundCard(db, { ...noContact, un1tUserId: null })
    const nobody2 = await fileRefundCard(db, { ...noContact, un1tUserId: null })
    expect(same).toEqual(a)
    expect(other.approvalId).not.toBe(a.approvalId)
    expect(nobody.approvalId).not.toBe(nobody2.approvalId)
  })

  it('a failed insert resolves { approvalId: null } and logs with the ids, never throwing', async () => {
    const db = makeDb({ failInsert: true })
    const out = await fileRefundCard(db, ARGS)

    expect(out).toEqual({ approvalId: null })
    expect(logError).toHaveBeenCalledOnce()
    const [module, , meta] = logError.mock.calls[0]
    expect(module).toBe('un1t-online-approval')
    expect(meta).toMatchObject({ locationId: LOC, contactId: CONTACT, un1tUserId: 'usr-1', reason: 'double_payment', origin: 'mia' })
    expect(notifyAgentApprovalRequest).not.toHaveBeenCalled()
  })

  it('a database that throws still resolves { approvalId: null }', async () => {
    const db = { from() { throw new Error('connection reset') } }
    await expect(fileRefundCard(db, ARGS)).resolves.toEqual({ approvalId: null })
    expect(logError).toHaveBeenCalled()
  })

  it('an unreadable dedupe lookup still files the card (a missed card is worse than a duplicate)', async () => {
    const db = makeDb({ failRead: true })
    const out = await fileRefundCard(db, ARGS)
    expect(out).toEqual({ approvalId: 'req-1' })
  })

  it('a notify failure never undoes the card', async () => {
    notifyAgentApprovalRequest.mockRejectedValueOnce(new Error('push down'))
    const out = await fileRefundCard(makeDb(), ARGS)
    expect(out).toEqual({ approvalId: 'req-1' })
  })

  it('refuses a call with no studio or no reason: nothing filed, logged', async () => {
    const db = makeDb()
    expect(await fileRefundCard(db, { ...ARGS, locationId: null })).toEqual({ approvalId: null })
    expect(await fileRefundCard(db, { ...ARGS, reason: '' })).toEqual({ approvalId: null })
    expect(db.inserts).toHaveLength(0)
    expect(logError).toHaveBeenCalledTimes(2)
  })
})
