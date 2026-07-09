import { describe, it, expect } from 'vitest'
import { aggregateOrgEventFees } from './org-event-fees'

describe('aggregateOrgEventFees', () => {
  const hosts = [{ id: 'h1', name: 'Acme' }, { id: 'h2', name: 'Beta' }]
  const events = [{ id: 'e1', host_id: 'h1' }, { id: 'e2', host_id: 'h2' }]
  const pays = [
    { race_event_id: 'e1', application_fee_cents: 200, status: 'completed', created_at: '2026-07-01T10:00:00Z' },
    { race_event_id: 'e1', application_fee_cents: 400, status: 'refunded', created_at: '2026-06-15T10:00:00Z' },
    { race_event_id: 'e2', application_fee_cents: null, status: 'completed', created_at: '2026-07-02T10:00:00Z' },
    { race_event_id: 'e1', application_fee_cents: 999, status: 'pending', created_at: '2026-07-03T10:00:00Z' },
  ]
  it('sums settled fees only (NULL fee = 0, pending excluded)', () => {
    const r = aggregateOrgEventFees(pays, events, hosts)
    expect(r.total_fee_cents).toBe(600)
    expect(r.paidCount).toBe(3)
  })
  it('per-host rollup with names', () => {
    const r = aggregateOrgEventFees(pays, events, hosts)
    expect(r.perHost).toEqual([
      { host_id: 'h1', name: 'Acme', fee_cents: 600, paidCount: 2 },
      { host_id: 'h2', name: 'Beta', fee_cents: 0, paidCount: 1 },
    ])
  })
  it('per-month buckets by created_at (UTC YYYY-MM), newest first', () => {
    const r = aggregateOrgEventFees(pays, events, hosts)
    expect(r.perMonth).toEqual([
      { month: '2026-07', fee_cents: 200 },
      { month: '2026-06', fee_cents: 400 },
    ])
  })
})
