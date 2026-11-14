// HOST-APPROVALS.1 — host events pending review, scoped to the viewer's org.
import { describe, it, expect, vi } from 'vitest'

vi.mock('../registry', () => ({
  viewerActiveLocationId: vi.fn(() => 'loc1'),
  // TENANT.8 (item 4) — identity pass-through here; the real filter's
  // behaviour is exercised end-to-end (unmocked) in
  // host-events-bundle-gate.test.js.
  filterRowsByLocationBundle: vi.fn(async (_db, rows) => rows),
}))

import { hostEventsProvider } from './host-events'

const ROWS = [
  { id: 'e1', name: 'Pride Training Club', kind: 'masterclass', race_date: '2026-09-20', venue_name: 'Phoenix Park', non_member_fee_cents: 2550, status: 'pending_review', submitted_at: '2026-07-27T07:20:00Z', created_at: '2026-07-27T07:20:00Z', location_id: 'loc-a', host: { id: 'h1', name: 'Pride Training Club', organization_id: 'org-un1t' } },
  { id: 'e2', name: 'Other Org Event', kind: 'race', race_date: '2026-10-01', status: 'pending_review', submitted_at: null, created_at: '2026-07-28T09:00:00Z', location_id: 'loc-b', host: { id: 'h2', name: 'Elsewhere', organization_id: 'org-other' } },
]

function makeDb(rows = ROWS) {
  const b = {
    select: () => b, eq: () => b, not: () => b, order: () => b,
    limit: async () => ({ data: rows, error: null }),
  }
  return { from: () => b }
}

describe('hostEventsProvider', () => {
  it('is visible only to reviewer roles', () => {
    expect(hostEventsProvider.isVisible({ role: 'master' })).toBe(true)
    expect(hostEventsProvider.isVisible({ role: 'owner' })).toBe(true)
    expect(hostEventsProvider.isVisible({ role: 'staff', rolesByLocation: { loc1: 'staff' } })).toBe(false)
    expect(hostEventsProvider.isVisible({ role: 'staff', rolesByLocation: { loc1: 'manager' } })).toBe(true)
  })

  it('returns only events whose host belongs to the viewer org', async () => {
    const user = { role: 'master', activeOrganization: { id: 'org-un1t' } }
    const { count, items } = await hostEventsProvider.fetchPending(makeDb(), user)
    expect(count).toBe(1)
    expect(items[0]).toMatchObject({
      id: 'e1',
      title: 'Pride Training Club — Pride Training Club',
      subtitle: '2026-09-20 · masterclass',
      reviewUrl: '/settings/hosts',
      venue: 'Phoenix Park',
      priceLabel: '€25.50',
    })
  })

  it('no venue is null and a missing or zero price reads Free', async () => {
    const user = { role: 'master', activeOrganization: { id: 'org-un1t' } }
    const row = { ...ROWS[0], venue_name: '  ', non_member_fee_cents: null }
    const { items } = await hostEventsProvider.fetchPending(makeDb([row]), user)
    expect(items[0].venue).toBeNull()
    expect(items[0].priceLabel).toBe('Free')
    const zero = { ...ROWS[0], non_member_fee_cents: 0 }
    expect((await hostEventsProvider.fetchPending(makeDb([zero]), user)).items[0].priceLabel).toBe('Free')
  })

  it('empty without an org', async () => {
    expect(await hostEventsProvider.fetchPending(makeDb(), {})).toEqual({ count: 0, items: [] })
    expect(await hostEventsProvider.countPending(makeDb(), {})).toBe(0)
  })
})
