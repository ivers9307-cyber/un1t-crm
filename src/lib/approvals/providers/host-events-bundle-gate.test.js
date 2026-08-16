// TENANT.8 (item 4) — per-row approver bundle checks.
//
// host_events is the one provider in APPROVALS_PROVIDERS whose rows can
// span MULTIPLE locations within the org (every other provider is
// eq('location_id', activeId)-scoped to the viewer's own active location
// — see each provider file's APPROVALS-LOCATION-SCOPE comment). Before
// this fix the registry's isProviderVisible only checked the VIEWER'S
// active location's bundle state, so an approver browsing from a
// bundle-ON location could see (and act on) a pending event that lives
// at a bundle-OFF location.
//
// Unlike host-events.test.js (which mocks '../registry' entirely), this
// suite deliberately does NOT mock filterRowsByLocationBundle — it
// exercises the real registry.js function end-to-end against a fake db
// serving both `race_events` and `locations`, proving: a bundle-off row
// vanishes while a bundle-on row from a DIFFERENT location in the same
// org survives.

import { describe, it, expect } from 'vitest'
import { hostEventsProvider } from './host-events'

const ROWS = [
  {
    id: 'e-on', name: 'Bundle-on studio event', kind: 'masterclass', race_date: '2026-09-20',
    status: 'pending_review', submitted_at: '2026-07-27T07:20:00Z', created_at: '2026-07-27T07:20:00Z',
    location_id: 'loc-bundle-on',
    host: { id: 'h1', name: 'Host A', organization_id: 'org-un1t' },
  },
  {
    id: 'e-off', name: 'Bundle-off studio event', kind: 'race', race_date: '2026-10-01',
    status: 'pending_review', submitted_at: '2026-07-28T09:00:00Z', created_at: '2026-07-28T09:00:00Z',
    location_id: 'loc-bundle-off',
    host: { id: 'h2', name: 'Host B', organization_id: 'org-un1t' },
  },
  {
    id: 'e-other-org', name: 'Different org event', kind: 'race', race_date: '2026-11-01',
    status: 'pending_review', submitted_at: '2026-07-29T09:00:00Z', created_at: '2026-07-29T09:00:00Z',
    location_id: 'loc-bundle-on',
    host: { id: 'h3', name: 'Host C', organization_id: 'org-other' },
  },
]

const LOCATIONS = [
  { id: 'loc-bundle-on', features: {} },
  { id: 'loc-bundle-off', features: { bundle_members: false } },
]

function makeDb() {
  return {
    from(table) {
      if (table === 'race_events') {
        return {
          select: () => ({
            eq: () => ({
              not: () => ({
                order: () => ({ limit: async () => ({ data: ROWS, error: null }) }),
                // countPending's chain has no .order()
                limit: async () => ({ data: ROWS, error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'locations') {
        return {
          select: () => ({
            in: async (_col, ids) => ({ data: LOCATIONS.filter((l) => ids.includes(l.id)), error: null }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const user = { role: 'master', activeOrganization: { id: 'org-un1t' } }

describe('hostEventsProvider — per-row bundle filter (TENANT.8 item 4)', () => {
  it('fetchPending: a bundle-off row vanishes while a bundle-on row from another location survives', async () => {
    const { count, items } = await hostEventsProvider.fetchPending(makeDb(), user)
    const ids = items.map((i) => i.id)
    expect(ids).toContain('e-on')
    expect(ids).not.toContain('e-off')
    expect(ids).not.toContain('e-other-org') // still org-filtered too
    expect(count).toBe(1)
  })

  it('countPending matches fetchPending\'s filtered set', async () => {
    const count = await hostEventsProvider.countPending(makeDb(), user)
    expect(count).toBe(1)
  })

  it('fails OPEN (never hides a row) when the locations lookup errors', async () => {
    const db = {
      from(table) {
        if (table === 'race_events') {
          return {
            select: () => ({ eq: () => ({ not: () => ({ order: () => ({ limit: async () => ({ data: ROWS, error: null }) }) }) }) }),
          }
        }
        if (table === 'locations') {
          return { select: () => ({ in: async () => ({ data: null, error: { message: 'db down' } }) }) }
        }
        throw new Error(`unexpected table ${table}`)
      },
    }
    const { items } = await hostEventsProvider.fetchPending(db, user)
    // Fail-open: BOTH org-un1t rows survive when the bundle lookup itself fails.
    expect(items.map((i) => i.id).sort()).toEqual(['e-off', 'e-on'])
  })
})
