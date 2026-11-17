import { describe, it, expect, vi } from 'vitest'
import { corpPromoClaimsProvider, claimWhy, toItem } from './corp-promo-claims'

const user = { activeLocation: { id: 'loc-h' } }
// promos: the corp_promos rows the fallback read answers; promoError fails it.
function db(rows, error = null, { promos = [], promoError = null } = {}) {
  const filters = []
  const promoReads = []
  const from = vi.fn((table) => {
    const own = []
    const q = {
      select: () => q, order: () => q, limit: () => q, range: () => q,
      eq: (c, v) => { (table === 'corp_promos' ? own : filters).push([c, v]); return q },
      then: (ok, no) => {
        if (table === 'corp_promos') {
          promoReads.push(own)
          return Promise.resolve(promoError ? { data: null, error: promoError } : { data: promos, error: null }).then(ok, no)
        }
        return Promise.resolve({ data: rows, error, count: rows?.length ?? 0 }).then(ok, no)
      },
    }
    return q
  })
  return { from, filters, promoReads }
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

  it('maps every Glofox reason, naming Glofox and whether anything was bought', () => {
    expect(claimWhy('live_plan: member')).toMatch(/Glofox.*Nothing was bought\./)
    expect(claimWhy('live_plan: credits')).toContain('Nothing was bought.')
    expect(claimWhy('glofox_read_failed')).toMatch(/Glofox.*Nothing was bought\./)
    expect(claimWhy('grant_refused: NOPE')).toMatch(/Glofox refused.*\(NOPE\).*Nothing was bought/)
    expect(claimWhy('grant_unrecorded')).toContain('nothing was bought')
    expect(claimWhy('glofox_not_configured')).toContain('Glofox is not connected')
    expect(claimWhy('account_needs_review: several match')).toMatch(/Glofox account.*several match.*Nothing was bought/)
    expect(claimWhy('account_create_failed: boom')).toMatch(/Glofox account.*boom.*Nothing was bought/)
    expect(claimWhy('grant_unverified')).toContain('may have gone through')
    expect(claimWhy('stalled', { stage: 'purchasing' })).toContain('may have gone through')
    expect(claimWhy('stalled', { outcome: 'x' })).toContain('may have gone through')
    expect(claimWhy('stalled')).toBe('The claim stopped before anything was bought. Nothing was bought.')
    expect(claimWhy('stalled', {})).toContain('Nothing was bought.')
    expect(claimWhy('grant_unrecorded')).toContain('Glofox purchase')
  })

  it('item carries the Glofox member, platform and the invoice-check flag', () => {
    const it1 = toItem({ id: 'g', promo_key: 'stillorgan-newstart', platform: 'glofox', reason: 'grant_unverified', glofox_member_id: 'gm1' })
    expect(it1).toMatchObject({ glofoxMemberId: 'gm1', platform: 'glofox', checkInvoice: true })
    expect(toItem({ id: 's', promo_key: 'p', reason: 'stalled', grant: null }).checkInvoice).toBe(false)
    expect(toItem({ id: 's', promo_key: 'p', reason: 'stalled', grant: { stage: 'purchasing' } }).checkInvoice).toBe(true)
    expect(toItem({ id: 'u', promo_key: 'p', reason: 'un1t_promo_unverified' }).checkInvoice).toBe(false)
  })

  // WAYSIN.2 — the platform is the claim's own column; a row written before it
  // was stamped falls back to one read of the studio's promos.
  it('platform from the claim row; no promo read when every row carries one and none is Glofox', async () => {
    const d = db([{ id: 'c1', promo_key: 'hatch-3-free', platform: 'un1t_online', reason: 'stalled' }])
    const out = await corpPromoClaimsProvider.fetchPending(d, user)
    expect(out.items[0].platform).toBe('un1t_online')
    expect(d.promoReads).toEqual([])
  })

  // OPENWEEK.5 — a Glofox card names the promo's own plan, never "New Start".
  it('claimWhy names the plan it was given, and a neutral plan without one', () => {
    const plan = { planName: '2) Black Friday Open Week.' }
    expect(claimWhy('grant_refused: ERROR_X', null, plan)).toBe('Glofox refused the 2) Black Friday Open Week. plan (ERROR_X). Nothing was bought.')
    expect(claimWhy('grant_refused: ERROR_X')).toBe("Glofox refused the promo's plan (ERROR_X). Nothing was bought.")
    expect(claimWhy('live_plan: trial', null, plan)).toContain('add 2) Black Friday Open Week. by hand')
    expect(claimWhy('grant_unverified', null, plan)).toContain('€0 2) Black Friday Open Week. invoice')
    for (const r of ['grant_refused: X', 'live_plan: trial', 'grant_unverified', 'stalled']) {
      expect(claimWhy(r, { stage: 'purchasing' })).not.toContain('New Start')
      expect(claimWhy(r, { stage: 'purchasing' }, plan)).not.toContain('New Start')
    }
  })

  it('a Glofox card takes its plan name from one read of the studio\'s promos', async () => {
    const promos = [{ id: 'p', location_id: 'loc-h', key: 'stillorgan-open-week', name: 'Open Week (Stillorgan)', platform: 'glofox', credits: 5, expires_in_days: 14, live: true, tag: 't', lead_source: 'corp_promo', glofox_membership_id: 'm', glofox_plan_code: 'c', glofox_plan_name: '2) Black Friday Open Week.' }]
    const d = db([{ id: 'c1', promo_key: 'stillorgan-open-week', platform: 'glofox', reason: 'grant_refused: ERROR_X' }], null, { promos })
    const out = await corpPromoClaimsProvider.fetchPending(d, user)
    expect(out.items[0].why).toBe('Glofox refused the 2) Black Friday Open Week. plan (ERROR_X). Nothing was bought.')
    expect(d.promoReads).toHaveLength(1)
  })

  it('an unstamped row takes the platform from one batch read of the studio\'s promos', async () => {
    const promos = [{ id: 'p', location_id: 'loc-h', key: 'hatch-3-free', name: 'H', platform: 'un1t_online', credits: 3, expires_in_days: 7, live: true, tag: 't', lead_source: 'corp_promo' }]
    const d = db([
      { id: 'c1', promo_key: 'hatch-3-free', platform: null, reason: 'un1t_promo_unverified' },
      { id: 'c2', promo_key: 'hatch-3-free', platform: null, reason: 'un1t_promo_unverified' },
      { id: 'c3', promo_key: 'gone', platform: null, reason: 'x' },
    ], null, { promos })
    const out = await corpPromoClaimsProvider.fetchPending(d, user)
    expect(out.items.map((i) => i.platform)).toEqual(['un1t_online', 'un1t_online', null])
    expect(d.promoReads).toEqual([[['location_id', 'loc-h']]])
  })

  it('a failed fallback read leaves platform unknown on those cards, never the tab empty', async () => {
    const d = db([{ id: 'c1', promo_key: 'hatch-3-free', platform: null, reason: 'x' }], null, { promoError: { message: 'boom' } })
    const out = await corpPromoClaimsProvider.fetchPending(d, user)
    expect(out.count).toBe(1)
    expect(out.items[0].platform).toBeNull()
  })
})
