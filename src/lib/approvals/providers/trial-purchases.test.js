import { describe, it, expect, vi } from 'vitest'
import { trialPurchasesProvider, toItem, reviewWhy, splitReviewError, grantMayHaveLanded } from './trial-purchases'

function dbReturning(rows, count = rows.length) {
  const calls = []
  const chain = {
    select: vi.fn(function (cols, opts) { calls.push(['select', cols, opts]); return chain }),
    eq: vi.fn(function (c, v) { calls.push(['eq', c, v]); return chain }),
    in: vi.fn(function (c, v) { calls.push(['in', c, v]); return chain }),
    order: vi.fn(function (c, o) { calls.push(['order', c, o]); return chain }),
    limit: vi.fn(() => chain),
    then: (res) => res(Promise.resolve({ data: rows, count, error: null })),
  }
  return { db: { from: vi.fn(() => chain) }, calls }
}

const ROW = {
  id: 'tp1', customer_name: 'Richard I', customer_email: 'r@example.com', customer_phone: '+353…',
  product_name: 'The 14 Day Reset', amount_cents: 3900, currency: 'EUR', duration_days: 14,
  paid_at: '2026-10-21T22:06:32Z', created_at: '2026-10-21T22:00:00Z', status: 'needs_review', last_error: 'grant_refused: NO_CREDITS',
  grant: { stage: 'purchasing', ok: false }, glofox_member_id: 'gm1', contact_id: 'c1', attempts: 1,
  location_id: 'loc1', location: { id: 'loc1', name: 'Stillorgan' },
}

describe('trialPurchasesProvider (PAIDTRIAL.2)', () => {
  it('declares the web-only surface on the offer_purchases grant', () => {
    expect(trialPurchasesProvider.key).toBe('trial_purchases')
    expect(trialPurchasesProvider.permissionKey).toBe('approvals_offer_purchases')
    expect(trialPurchasesProvider.noPhoneSurface).toBe(true)
  })

  it('lists both kinds at the active studio only', async () => {
    const { db, calls } = dbReturning([ROW])
    const res = await trialPurchasesProvider.fetchPending(db, { activeLocation: { id: 'loc1' } })
    expect(res.count).toBe(1)
    expect(res.items[0]).toMatchObject({ id: 'tp1', title: 'Richard I', meta: 'Stillorgan', amount: 39, currency: 'EUR' })
    expect(res.items[0].subtitle).toContain('14 Day Reset')
    expect(calls).toContainEqual(['in', 'status', ['needs_review', 'help_requested']])
    expect(calls.some((c) => c[0] === 'eq' && c[1] === 'payment_status')).toBe(false)
    expect(calls).toContainEqual(['eq', 'location_id', 'loc1'])
    expect(calls).toContainEqual(['order', 'created_at', { ascending: false }])
  })

  it('lists help_requested rows as kind help with their reasons, and still lists needs_review as grant', async () => {
    const HELP = {
      ...ROW, id: 'tp2', status: 'help_requested', paid_at: null, payment_status: null,
      last_error: 'trial_used: membership_status=trial, glofox_trial_claim', grant: null,
    }
    const { db } = dbReturning([ROW, HELP])
    const res = await trialPurchasesProvider.fetchPending(db, { activeLocation: { id: 'loc1' } })
    expect(res.count).toBe(2)
    const [grant, help] = res.items
    expect(grant.kind).toBe('grant')
    expect(grant.submittedAt).toBe('2026-10-21T22:06:32Z')
    expect(help.kind).toBe('help')
    expect(help.reasons).toEqual(['membership_status=trial', 'glofox_trial_claim'])
    expect(help.why).toBe('The buyer already had a trial here and asked for help.')
    expect(help.submittedAt).toBe('2026-10-21T22:00:00Z')
  })

  it('a help row with no detail, or an unknown prefix, still yields a sentence and a reasons array', () => {
    const item = toItem({ ...ROW, status: 'help_requested', last_error: 'un1t_checkout_refused' })
    expect(item.reasons).toEqual([])
    expect(item.why).toBe('un1t.online refused the checkout.')
    expect(toItem({ ...ROW, status: 'help_requested', last_error: 'weird: a, b' }).why).toBe('Stopped with: weird')
    expect(toItem({ ...ROW, status: 'help_requested', last_error: null }).reasons).toEqual([])
  })

  it('no active studio → nothing, no query', async () => {
    const { db } = dbReturning([ROW])
    expect(await trialPurchasesProvider.fetchPending(db, {})).toEqual({ count: 0, items: [] })
    expect(await trialPurchasesProvider.countPending(db, {})).toBe(0)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('counts both kinds', async () => {
    const { db, calls } = dbReturning([], 3)
    expect(await trialPurchasesProvider.countPending(db, { activeLocation: { id: 'loc1' } })).toBe(3)
    expect(calls).toContainEqual(['in', 'status', ['needs_review', 'help_requested']])
    expect(calls.some((c) => c[0] === 'eq' && c[1] === 'payment_status')).toBe(false)
    expect(calls).toContainEqual(['eq', 'location_id', 'loc1'])
  })

  it('explains the reason in operator words, with Glofox\'s detail', () => {
    expect(splitReviewError('grant_refused: NO_CREDITS')).toEqual({ reason: 'grant_refused', detail: 'NO_CREDITS' })
    expect(splitReviewError('glofox_not_configured')).toEqual({ reason: 'glofox_not_configured', detail: '' })
    expect(reviewWhy(ROW)).toBe('Glofox refused the plan purchase. (NO_CREDITS)')
    expect(reviewWhy({ last_error: null })).toBe('The plan was not put on the account.')
    expect(reviewWhy({ last_error: 'something_else' })).toBe('Stopped with: something_else')
  })

  it('flags a purchase Glofox may already hold (marker without outcome, or outcome unknown)', () => {
    expect(grantMayHaveLanded({ grant: { stage: 'purchasing', at: 'x' } })).toBe(true)
    expect(grantMayHaveLanded({ grant: { stage: 'purchasing', ok: null, outcome_unknown: true } })).toBe(true)
    expect(grantMayHaveLanded({ grant: { stage: 'purchasing', ok: false } })).toBe(false)
    expect(grantMayHaveLanded({ grant: null })).toBe(false)
    expect(toItem(ROW).mayHaveLanded).toBe(false)
  })
})
