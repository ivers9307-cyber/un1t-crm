import { describe, it, expect, vi } from 'vitest'
import { corpPromoClaimsProvider, claimWhy, toItem } from './corp-promo-claims'

const user = { activeLocation: { id: 'loc-h' } }
function db(rows, error = null) {
  const filters = []
  const q = {
    select: () => q, order: () => q, limit: () => q,
    eq: (c, v) => { filters.push([c, v]); return q },
    then: (ok, no) => Promise.resolve({ data: rows, error, count: rows?.length ?? 0 }).then(ok, no),
  }
  return { from: vi.fn(() => q), filters }
}

describe('corpPromoClaimsProvider', () => {
  it('lists help_requested claims at the viewer active studio only', async () => {
    const d = db([{ id: 'c1', first_name: 'Ann', last_name: 'Byrne', promo_key: 'hatch-3-free', reason: 'un1t_promo_unverified', created_at: '2026-10-28T10:00:00Z' }])
    const out = await corpPromoClaimsProvider.fetchPending(d, user)
    expect(out.count).toBe(1)
    expect(out.items[0]).toMatchObject({ id: 'c1', title: 'Ann Byrne', kind: 'help' })
    expect(d.filters).toEqual(expect.arrayContaining([['status', 'help_requested'], ['location_id', 'loc-h']]))
  })

  it('no active studio: nothing', async () => {
    expect(await corpPromoClaimsProvider.fetchPending(db([]), {})).toEqual({ count: 0, items: [] })
    expect(await corpPromoClaimsProvider.countPending(db([]), {})).toBe(0)
  })

  it('a read error throws (the registry reports it), never an empty tab', async () => {
    await expect(corpPromoClaimsProvider.fetchPending(db(null, { message: 'boom' }), user)).rejects.toThrow('corp_promo_claims')
  })

  it('says why in plain words', () => {
    expect(claimWhy('un1t_promo_failed:NOPE')).toContain('(NOPE)')
    expect(claimWhy('un1t_account_refused: account_ambiguous')).toContain('account_ambiguous')
    expect(toItem({ id: 'x', customer_email: 'a@b.ie', promo_key: 'p' }).title).toBe('a@b.ie')
  })
})
