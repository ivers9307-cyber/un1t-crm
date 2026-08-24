import { describe, it, expect, vi } from 'vitest'

vi.mock('../registry', () => ({
  viewerActiveLocationId: vi.fn(() => 'loc1'),
}))

import { agentRequestSubtitle, agentRequestsProvider } from './agent-requests'

function stubDb(rows = []) {
  const b = {
    select: () => b,
    eq: () => b,
    order: () => b,
    limit: async () => ({ data: rows, error: null }),
  }
  return { from: () => b }
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
