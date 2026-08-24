import { describe, it, expect, vi } from 'vitest'

vi.mock('../registry', () => ({
  viewerActiveLocationId: vi.fn(() => 'loc1'),
}))

import { agentRequestSubtitle, agentRequestsProvider } from './agent-requests'

function stubDb(rows = []) {
  // The provider now also runs the failed-retryable query (status eq
  // 'failed', with .in/.gte) — this stub answers it with an empty set so
  // the pending-mapping assertions stay focused.
  return {
    from: () => {
      let status = null
      const b = {
        select: () => b,
        eq(col, val) { if (col === 'status') status = val; return b },
        in: () => b,
        gte: () => b,
        order: () => b,
        limit: async () => ({ data: status === 'failed' ? [] : rows, error: null }),
      }
      return b
    },
  }
}

describe('agentRequestsProvider.fetchPending — AGENT-REQ-UX.1 decide-card fields', () => {
  it('exposes contact email/phone and retention flag for the inline card', async () => {
    const db = stubDb([{
      id: 'r1', kind: 'cancellation', details: { reason: 'moving away' },
      customer_note: null, created_at: '2026-08-24T10:00:00Z', location_id: 'loc1',
      channel: 'whatsapp', conversation_id: 'c1', retention_flagged: true,
      contact: { id: 'ct1', name: 'Kate Byrne', email: 'kate@example.com', phone: '+353870000000' },
    }])
    const { items } = await agentRequestsProvider.fetchPending(db, { activeLocation: { id: 'loc1' } })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      contactId: 'ct1',
      contactEmail: 'kate@example.com',
      contactPhone: '+353870000000',
      retentionFlagged: true,
      conversationId: 'c1',
      channel: 'whatsapp',
    })
  })

  it('nulls the contact fields when the embed is empty', async () => {
    const db = stubDb([{ id: 'r2', kind: 'class_booking', details: {}, created_at: '2026-08-24T10:00:00Z', location_id: 'loc1' }])
    const { items } = await agentRequestsProvider.fetchPending(db, { activeLocation: { id: 'loc1' } })
    expect(items[0]).toMatchObject({ contactId: null, contactEmail: null, contactPhone: null, retentionFlagged: false })
  })
})

describe('agentRequestSubtitle — paid class booking', () => {
  it('appends a paid marker when the booking was paid', () => {
    const s = agentRequestSubtitle({ kind: 'class_booking', details: { class_name: 'HIIT', class_time: 'Mon 6pm', paid: true, amount_cents: 2900, currency: 'EUR' } })
    expect(s).toBe('HIIT · Mon 6pm · 💳 Paid €29')
  })
  it('omits the marker for a free booking', () => {
    const s = agentRequestSubtitle({ kind: 'class_booking', details: { class_name: 'HIIT', class_time: 'Mon 6pm' } })
    expect(s).toBe('HIIT · Mon 6pm')
  })
})

// AGENT-RETRY.2 — failed executions ride the badge, in their own queue.
function stubDbTwoQueues({ pendingRows = [], failedRows = [] }) {
  // fetchPending/fetchRetryableFailed are distinguished by their status eq.
  return {
    from: () => {
      let status = null
      const b = {
        select: () => b,
        eq(col, val) { if (col === 'status') status = val; return b },
        in: () => b,
        gte: () => b,
        order: () => b,
        limit: async () => ({ data: status === 'failed' ? failedRows : pendingRows, error: null }),
      }
      return b
    },
  }
}

describe('agentRequestsProvider — failed-retryable queue (AGENT-RETRY.2)', () => {
  const user = { activeLocation: { id: 'loc1' } }
  const future = new Date(Date.now() + 3_600_000).toISOString()
  const past = new Date(Date.now() - 3_600_000).toISOString()
  const failedRow = (over = {}) => ({
    id: 'f1', kind: 'class_booking', status: 'failed',
    details: { class_name: 'ENG1NE', starts_at: future, result: { message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } },
    created_at: past, decided_at: past, location_id: 'loc1',
    contact: { id: 'ct1', name: 'Kate Byrne', email: 'k@x.com', phone: '1' },
    ...over,
  })

  it('ships retry-offered failed rows in failedItems (never items) and counts them', async () => {
    const db = stubDbTwoQueues({
      pendingRows: [{ id: 'p1', kind: 'class_booking', details: {}, created_at: past, location_id: 'loc1' }],
      failedRows: [failedRow()],
    })
    const { count, items, failedItems } = await agentRequestsProvider.fetchPending(db, user)
    expect(items.map(i => i.id)).toEqual(['p1'])
    expect(failedItems.map(i => i.id)).toEqual(['f1'])
    expect(failedItems[0]).toMatchObject({ failed: true, failedAt: past, contactEmail: 'k@x.com' })
    expect(count).toBe(2)
  })

  it('drops failed rows the retryOffered gate refuses (class already started)', async () => {
    const db = stubDbTwoQueues({
      failedRows: [failedRow({ details: { starts_at: past, result: {} } })],
    })
    const { count, failedItems } = await agentRequestsProvider.fetchPending(db, user)
    expect(failedItems).toEqual([])
    expect(count).toBe(0)
  })

  it('countPending agrees with the tab: pending head-count + offered retries', async () => {
    // head-count double: count comes back via the count property.
    const db = {
      from: () => {
        let status = null
        const b = {
          select: (_f, opts) => { b._head = !!opts?.head; return b },
          eq(col, val) { if (col === 'status') status = val; return b },
          in: () => b,
          gte: () => b,
          order: () => b,
          limit: async () => ({ data: status === 'failed' ? [failedRow()] : [], error: null }),
          then(resolve) { resolve({ count: 3, error: null }) }, // head-count await
        }
        return b
      },
    }
    const n = await agentRequestsProvider.countPending(db, user)
    expect(n).toBe(4)
  })
})
