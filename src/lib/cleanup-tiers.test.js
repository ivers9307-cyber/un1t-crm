import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/postmark', () => ({ buildAudienceQueryAsync: vi.fn() }))

import { buildAudienceQueryAsync } from '@/lib/postmark'
import { countCleanupTiers, activeWithinClause } from './cleanup-tiers'

const NOW = new Date('2026-11-26T12:00:00Z')

// A thenable count query; `.or()` picks the window so each count can differ.
function queryFor(counts) {
  const q = {
    window: null,
    or(clause) { q.window = clause; return q },
    then(resolve) {
      const key = q.window == null ? 'all'
        : q.window.includes('last_attended_at.gte.2026-08-28') ? 90
        : q.window.includes('last_attended_at.gte.2026-05-30') ? 180
        : 365
      return resolve(counts.error ? { count: null, error: { message: 'boom' } } : { count: counts[key], error: null })
    },
  }
  return q
}

beforeEach(() => vi.clearAllMocks())

describe('countCleanupTiers (CLEANTIERS.1)', () => {
  it('splits the mailable list into nested windows that sum to it', async () => {
    const counts = { all: 1000, 90: 400, 180: 500, 365: 650 }
    buildAudienceQueryAsync.mockImplementation(async () => ({ query: queryFor(counts) }))
    const r = await countCleanupTiers({}, 'loc-1', { now: NOW })
    expect(r).toEqual({ ok: true, mailable: 1000, tiers: { keep: 400, less: 100, reengage: 150, seasonal: 350 } })
    const t = r.tiers
    expect(t.keep + t.less + t.reengage + t.seasonal).toBe(r.mailable)
  })

  it('counts from the send builder, with an empty filter, at the given studio', async () => {
    buildAudienceQueryAsync.mockImplementation(async () => ({ query: queryFor({ all: 0, 90: 0, 180: 0, 365: 0 }) }))
    await countCleanupTiers({}, 'loc-1', { now: NOW })
    expect(buildAudienceQueryAsync).toHaveBeenCalledWith({}, { logic: 'and', filters: [] }, 'loc-1', expect.objectContaining({ columns: 'id' }))
  })

  it('reports not ok instead of throwing when a count fails', async () => {
    buildAudienceQueryAsync.mockImplementation(async () => ({ query: queryFor({ error: true }) }))
    const r = await countCleanupTiers({}, 'loc-1', { now: NOW })
    expect(r.ok).toBe(false)
  })
})

describe('activeWithinClause', () => {
  it('counts members, visits, bookings, payments, clicks, new contacts and lightly mailed contacts, but never opens', () => {
    const c = activeWithinClause(NOW, 90)
    expect(c).toContain('glofox_membership_status.in.(member,credit_member)')
    for (const col of ['last_attended_at', 'last_booked_at', 'last_payment_at', 'last_email_click_at']) {
      expect(c).toContain(`${col}.gte.2026-08-28T12:00:00.000Z`)
    }
    expect(c).toContain('created_at.gte.2026-08-28T12:00:00.000Z')
    expect(c).toContain('total_emails_sent.lt.5')
    expect(c).not.toContain('open')
  })
})
