// CAMPFILTER.1 — opened / clicked a campaign, scoped to the audience's studio.
import { describe, it, expect } from 'vitest'
import { resolveVirtualIdSets, InvalidAudienceFilterError } from './audience-filter'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const OTHER = 'a0000000-0000-4000-8000-000000000002'
const CAMP = 'c0000000-0000-4000-8000-000000000001'

function fakeDb({ campaign, recipients }) {
  const calls = []
  return {
    calls,
    from(table) {
      const c = { table, filters: [] }
      calls.push(c)
      const b = {
        select: () => b, order: () => b,
        eq: (...a) => { c.filters.push(['eq', ...a]); return b },
        not: (...a) => { c.filters.push(['not', ...a]); return b },
        or: (...a) => { c.filters.push(['or', ...a]); return b },
        maybeSingle: () => Promise.resolve({ data: campaign, error: null }),
        range: (from) => Promise.resolve({ data: from === 0 ? recipients : [], error: null }),
      }
      return b
    },
  }
}
const f = (field, op) => ({ logic: 'and', filters: [{ field, op, value: CAMP }] })

describe('campaign_opened / campaign_clicked (CAMPFILTER.1)', () => {
  it('clicked eq keeps the clickers of that campaign', async () => {
    const db = fakeDb({ campaign: { id: CAMP, location_id: LOC }, recipients: [{ contact_id: 'c1' }, { contact_id: 'c2' }] })
    const sets = await resolveVirtualIdSets({ db, filter: f('campaign_clicked', 'eq'), locationId: LOC })
    expect([...sets.include].sort()).toEqual(['c1', 'c2'])
    const rec = db.calls.find((c) => c.table === 'campaign_recipients')
    expect(rec.filters).toContainEqual(['not', 'clicked_at', 'is', null])
  })

  it('opened counts a click as an open too, and neq excludes', async () => {
    const db = fakeDb({ campaign: { id: CAMP, location_id: LOC }, recipients: [{ contact_id: 'c1' }] })
    const sets = await resolveVirtualIdSets({ db, filter: f('campaign_opened', 'neq'), locationId: LOC })
    expect(sets.include).toBe(null)
    expect([...sets.exclude]).toEqual(['c1'])
    const rec = db.calls.find((c) => c.table === 'campaign_recipients')
    expect(rec.filters).toContainEqual(['or', 'opened_at.not.is.null,clicked_at.not.is.null'])
  })

  it("refuses another studio's campaign without reading its recipients", async () => {
    const db = fakeDb({ campaign: { id: CAMP, location_id: OTHER }, recipients: [{ contact_id: 'c1' }] })
    await expect(resolveVirtualIdSets({ db, filter: f('campaign_clicked', 'eq'), locationId: LOC })).rejects.toBeInstanceOf(InvalidAudienceFilterError)
    expect(db.calls.some((c) => c.table === 'campaign_recipients')).toBe(false)
  })
})
