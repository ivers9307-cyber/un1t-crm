import { describe, it, expect } from 'vitest'
import { recordBcaPageView, recordBcaDownload, recordBcaPostmarkEvent } from './bca-events.js'

// Mock db: records rpc() calls; from() supports insert / select-eq-single / update-eq.
function mockDb() {
  const rpcCalls = []
  const db = {
    rpc(name, args) { rpcCalls.push({ name, args }); return Promise.resolve({ data: null, error: null }) },
    from() {
      const chain = {
        insert() { return Promise.resolve({ error: null }) },
        select() { return chain },
        eq() { return chain },
        single() { return Promise.resolve({ data: {} }) },
        update() { return { eq() { return Promise.resolve({ error: null }) } } },
      }
      return chain
    },
  }
  return { db, rpcCalls }
}

describe('bca-events → record_bca_event', () => {
  it('page view records a view event', async () => {
    const { db, rpcCalls } = mockDb()
    await recordBcaPageView(db, 'sub1', {})
    expect(rpcCalls).toContainEqual({ name: 'record_bca_event', args: { p_submission_id: 'sub1', p_event: 'view' } })
  })

  it('merged download records a download_merged event', async () => {
    const { db, rpcCalls } = mockDb()
    await recordBcaDownload(db, 'sub1', { type: 'merged' })
    expect(rpcCalls).toContainEqual({ name: 'record_bca_event', args: { p_submission_id: 'sub1', p_event: 'download_merged' } })
  })

  it('non-merged download does NOT roll up to the submission', async () => {
    const { db, rpcCalls } = mockDb()
    await recordBcaDownload(db, 'sub1', { type: 'file', slug: 'x' })
    expect(rpcCalls).toHaveLength(0)
  })

  it('postmark Open records an open event at ReceivedAt', async () => {
    const { db, rpcCalls } = mockDb()
    await recordBcaPostmarkEvent(db, 'sub1', { RecordType: 'Open', ReceivedAt: '2026-06-26T10:00:00Z' })
    expect(rpcCalls).toContainEqual({ name: 'record_bca_event', args: { p_submission_id: 'sub1', p_event: 'open', p_at: '2026-06-26T10:00:00Z' } })
  })

  it('postmark Click records a click event', async () => {
    const { db, rpcCalls } = mockDb()
    await recordBcaPostmarkEvent(db, 'sub1', { RecordType: 'Click', ReceivedAt: '2026-06-26T10:00:00Z' })
    expect(rpcCalls).toContainEqual({ name: 'record_bca_event', args: { p_submission_id: 'sub1', p_event: 'click', p_at: '2026-06-26T10:00:00Z' } })
  })

  it('postmark Delivery does NOT call record_bca_event', async () => {
    const { db, rpcCalls } = mockDb()
    await recordBcaPostmarkEvent(db, 'sub1', { RecordType: 'Delivery', DeliveredAt: '2026-06-26T10:00:00Z' })
    expect(rpcCalls).toHaveLength(0)
  })
})
