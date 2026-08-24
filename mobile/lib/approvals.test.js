import { describe, it, expect } from 'vitest'
import {
  mobileApprovalSections, approvalsBadgeCount, MOBILE_APPROVAL_KEYS,
  customerQueue, urgencyChip, itemDeadline, teamNavTiles,
  customerBadgeCount, teamBadgeCount,
} from './approvals'

const prov = (key, n, items) => ({
  key, label: key, count: n,
  items: items || Array.from({ length: n }, (_, i) => ({ id: `${key}-${i}` })),
})

describe('MOBILE_APPROVAL_KEYS', () => {
  it('is the five inline-actionable categories in order', () => {
    expect(MOBILE_APPROVAL_KEYS).toEqual(['host_events', 'time_off', 'shift_swaps', 'fte_expenses', 'contractor_invoices'])
  })
})

describe('mobileApprovalSections', () => {
  it('keeps only the four inline categories, fixed order, drops empties + unknowns', () => {
    const providers = [
      prov('contractor_invoices', 1),
      prov('issues', 3),       // nav tile, not a section
      prov('time_off', 2),
      prov('shift_swaps', 0),  // empty → dropped
      prov('fte_expenses', 1),
    ]
    expect(mobileApprovalSections(providers).map((s) => s.key))
      .toEqual(['time_off', 'fte_expenses', 'contractor_invoices'])
  })
  it('tolerates non-arrays', () => {
    expect(mobileApprovalSections(null)).toEqual([])
    expect(mobileApprovalSections(undefined)).toEqual([])
  })
})

// APPROVALS-STUDIO.1 — Customers tab ordering: soonest class first, then
// oldest-waiting; nothing can sink quietly.
describe('customerQueue', () => {
  const NOW = Date.UTC(2026, 6, 28, 12, 0, 0)
  const iso = (h) => new Date(NOW + h * 3600000).toISOString()
  it('deadline items lead (soonest first), then oldest-waiting', () => {
    const items = [
      { id: 'old', submittedAt: new Date(NOW - 30 * 3600000).toISOString(), details: {} },
      { id: 'soon', submittedAt: new Date(NOW - 1 * 3600000).toISOString(), details: { starts_at: iso(1) } },
      { id: 'later', submittedAt: new Date(NOW - 2 * 3600000).toISOString(), details: { starts_at: iso(20) } },
      { id: 'new', submittedAt: new Date(NOW - 600000).toISOString(), details: {} },
    ]
    const q = customerQueue([prov('agent_requests', 4, items)], NOW)
    expect(q.map((i) => i.id)).toEqual(['soon', 'later', 'old', 'new'])
  })
  it('empty without an agent_requests provider', () => {
    expect(customerQueue([prov('time_off', 2)], NOW)).toEqual([])
    expect(customerQueue(null, NOW)).toEqual([])
  })
})

describe('urgencyChip', () => {
  const NOW = Date.UTC(2026, 6, 28, 12, 0, 0)
  const at = (h) => new Date(NOW + h * 3600000).toISOString()
  it('counts down to a known class time, escalating tone', () => {
    expect(urgencyChip({ details: { starts_at: at(0.75) } }, NOW)).toEqual({ label: 'class in 45 min', tone: 'danger' })
    expect(urgencyChip({ details: { starts_at: at(9) } }, NOW)).toEqual({ label: 'class in 9h', tone: 'warn' })
    expect(urgencyChip({ details: { starts_at: at(-1) } }, NOW)).toEqual({ label: 'class passed', tone: 'danger' })
  })
  it('falls back to waiting-age with a 24h escalation', () => {
    expect(urgencyChip({ submittedAt: new Date(NOW - 26 * 3600000).toISOString() }, NOW)).toEqual({ label: 'waiting 26h', tone: 'warn' })
    expect(urgencyChip({ submittedAt: new Date(NOW - 2 * 3600000).toISOString() }, NOW)).toEqual({ label: '2h ago', tone: 'muted' })
  })
  it('ignores unparseable/missing times', () => {
    expect(itemDeadline({ details: { starts_at: 'not-a-date' } }, NOW)).toBeNull()
    expect(urgencyChip({}, NOW).label).toBeNull()
  })
})

describe('teamNavTiles', () => {
  it('maps the linked categories to their routes, non-empty only', () => {
    const tiles = teamNavTiles([prov('invoices_queue', 3), prov('issues', 0), prov('hyrox_sessions', 1), prov('time_off', 2)])
    expect(tiles).toEqual([
      { key: 'invoices_queue', label: 'invoices_queue', count: 3, route: '/invoices/inbox' },
      { key: 'hyrox_sessions', label: 'hyrox_sessions', count: 1, route: '/hyrox' },
    ])
  })
})

describe('badges', () => {
  it('tile badge = customers + everything else (inline and nav tiles)', () => {
    const providers = [prov('agent_requests', 2), prov('time_off', 2), prov('issues', 5), prov('fte_expenses', 1), prov('rosters', 1)]
    expect(customerBadgeCount(providers)).toBe(2)
    expect(teamBadgeCount(providers)).toBe(9)
    expect(approvalsBadgeCount(providers)).toBe(11)
  })
  it('is 0 for none / non-array', () => {
    expect(approvalsBadgeCount([])).toBe(0)
    expect(approvalsBadgeCount(null)).toBe(0)
  })
})

// AGENT-RETRY.2 — the failed-execution queue (provider ships failedItems).
import { failedQueue } from './approvals'

describe('failedQueue', () => {
  const NOW = Date.UTC(2026, 6, 28, 12, 0, 0)
  const iso = (h) => new Date(NOW + h * 3600000).toISOString()

  it('reads failedItems (never items) and urgency-sorts them', () => {
    const provider = {
      key: 'agent_requests', label: 'Agent requests', count: 3,
      items: [{ id: 'pending-1' }],
      failedItems: [
        { id: 'f-later', failed: true, submittedAt: iso(-2), details: { starts_at: iso(20) } },
        { id: 'f-soon', failed: true, submittedAt: iso(-1), details: { starts_at: iso(1) } },
      ],
    }
    expect(failedQueue([provider], NOW).map((i) => i.id)).toEqual(['f-soon', 'f-later'])
  })

  it('empty when the provider has no failedItems (older API) or is absent', () => {
    expect(failedQueue([{ key: 'agent_requests', count: 1, items: [{ id: 'p' }] }], NOW)).toEqual([])
    expect(failedQueue([], NOW)).toEqual([])
    expect(failedQueue(null, NOW)).toEqual([])
  })
})
