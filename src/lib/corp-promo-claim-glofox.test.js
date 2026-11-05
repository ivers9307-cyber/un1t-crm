// NEWSTART.1c — fulfilGlofoxCorpPromoClaim: account, live-plan check,
// write-ahead marker, the €0 plan purchase (never re-sent), stamp, tell.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { fulfilGlofoxCorpPromoClaim } from './corp-promo-claim-glofox'
import { resolveCorpPromo, corpPromoCopyFromBlocks } from './corp-promos'
import { TRIAL_PURCHASE_BODY } from './trial-purchase-processor'
import { logError, logWarn } from '@/lib/log'

const PROMO = resolveCorpPromo('stillorgan-newstart')
const COPY = corpPromoCopyFromBlocks([], PROMO.key, { platform: 'glofox' })
const PLAN = { membershipId: 'mem-ns', planCode: 'plan-ns', planName: 'New Start' }
const CREDS = { branchId: 'br-1', apiKey: 'k', apiToken: 't', readError: null }

/**
 * A fake service-role client: records every update chain (patch + filters).
 * `markerRows` is how many rows the write-ahead marker stamp touches.
 */
function fakeDb({ markerRows = 1, markerError = null, updateError = null } = {}) {
  const updates = []
  const db = {
    from: (table) => ({
      update: (patch) => {
        const filters = []
        let selected = null
        const q = {
          eq: (c, v) => { filters.push(['eq', c, v]); return q },
          is: (c, v) => { filters.push(['is', c, v]); return q },
          select: (cols) => { selected = cols; return q },
          then: (ok, no) => {
            updates.push({ table, patch, filters, selected })
            const isMarker = patch.grant?.stage === 'purchasing' && !('status' in patch)
            let res
            if (isMarker) res = { data: markerError ? null : Array.from({ length: markerRows }, () => ({ id: 'claim-1' })), error: markerError }
            else res = { data: selected ? [{ id: 'claim-1' }] : null, error: typeof updateError === 'function' ? updateError(patch) : updateError }
            return Promise.resolve(res).then(ok, no)
          },
        }
        return q
      },
    }),
  }
  return { db, updates }
}

const claim = {
  id: 'claim-1', location_id: 'loc-s', contact_id: 'c-1', promo_key: 'stillorgan-newstart', status: 'processing',
  first_name: 'Ann', last_name: 'Byrne', customer_email: 'ann@work.ie', customer_phone: '0871234567',
}
const location = { id: 'loc-s', name: 'UN1T Stillorgan', organization_id: 'org-1' }
const contact = { id: 'c-1', email: 'ann@work.ie', first_name: 'Ann', last_name: 'Byrne', phone: '0871234567', glofox_member_id: null }

function deps(over = {}) {
  return {
    glofoxPlanForPromo: vi.fn(() => PLAN),
    glofoxCredentialsForLocation: vi.fn(async () => CREDS),
    findOrCreateGlofoxMember: vi.fn(async () => ({ status: 'created', glofox_member_id: 'gm-new', passcode: 'SECRET-PASS' })),
    fetchMemberResult: vi.fn(async () => ({ ok: true, member: { _id: 'gm-1', membership: { type: 'payg', status: 'ACTIVE' } }, refused: false, messageCode: null })),
    fetchUserCreditsResult: vi.fn(async () => ({ ok: true, credits: [] })),
    purchaseGlofoxMembership: vi.fn(async () => ({ ok: true, http_status: 200, message_code: null, purchase_status: 'SUCCESS', invoice_id: 'inv-1' })),
    queueFundedClassBooking: vi.fn(async () => ({ queued: true, id: 'cbr-1' })),
    placeContactNow: vi.fn(async () => ({ placed: true })),
    sendCorpPromoEmail: vi.fn(async () => ({ sent: true })),
    sendOpsAlert: vi.fn(async () => {}),
    mapMembershipStatus: vi.fn(() => 'lead'),
    now: () => new Date('2026-11-05T10:00:00Z'),
    ...over,
  }
}
const run = (d, { db = fakeDb().db, c = claim, ct = contact } = {}) =>
  fulfilGlofoxCorpPromoClaim(db, { claim: c, location, contact: ct, promo: PROMO, copy: COPY, zone: 'Europe/Dublin' }, d)
const statusPatches = (updates) => updates.filter((u) => u.patch.status).map((u) => u.patch)
const lastStatus = (updates) => statusPatches(updates).at(-1)

beforeEach(() => vi.clearAllMocks())

describe('fulfilGlofoxCorpPromoClaim — a new account', () => {
  it('registers, skips the live-plan read, buys once with the complimentary body, stamps granted, then books, places and emails', async () => {
    const f = fakeDb()
    const d = deps()
    const withClass = { ...claim, page_id: 'p-1', class_event_id: 'ev-1', class_name: 'RALLY', class_starts_at: '2099-01-07T18:00:00.000Z' }
    const r = await run(d, { db: f.db, c: withClass })

    expect(r).toEqual({ kind: 'granted', credits: 3, expiresAt: null })
    expect(d.findOrCreateGlofoxMember).toHaveBeenCalledWith(expect.objectContaining({
      db: f.db, locationId: 'loc-s', contact, source: 'corp_promo', createIfMissing: true, attachTrial: false, phoneMatchPolicy: 'review',
    }))
    expect(d.fetchMemberResult).not.toHaveBeenCalled()
    expect(d.fetchUserCreditsResult).not.toHaveBeenCalled()
    expect(d.purchaseGlofoxMembership).toHaveBeenCalledTimes(1)
    expect(d.purchaseGlofoxMembership).toHaveBeenCalledWith(CREDS, 'gm-new', 'mem-ns', 'plan-ns', { body: TRIAL_PURCHASE_BODY })

    // The marker went first, guarded on processing + no grant, judged on rows.
    const marker = f.updates.find((u) => u.patch.grant?.stage === 'purchasing')
    expect(marker.patch).toEqual({
      grant: { stage: 'purchasing', at: '2026-11-05T10:00:00.000Z', glofox_member_id: 'gm-new', membership_id: 'mem-ns', plan_code: 'plan-ns' },
      glofox_member_id: 'gm-new',
    })
    expect(marker.filters).toEqual(expect.arrayContaining([['eq', 'id', 'claim-1'], ['eq', 'status', 'processing'], ['is', 'grant', null]]))
    expect(marker.selected).toBe('id')
    expect(f.updates.indexOf(marker)).toBeLessThan(f.updates.findIndex((u) => u.patch.status === 'granted'))

    expect(lastStatus(f.updates)).toMatchObject({
      status: 'granted', reason: null, glofox_member_id: 'gm-new', credits: 3, expires_at: null,
      grant: expect.objectContaining({ ok: true, at: '2026-11-05T10:00:00.000Z', invoice_id: 'inv-1', purchase_status: 'SUCCESS', glofox_member_id: 'gm-new' }),
    })

    expect(d.queueFundedClassBooking).toHaveBeenCalledWith(f.db, expect.objectContaining({
      fundedBy: 'corp_promo', fundedById: 'claim-1', locationId: 'loc-s', contactId: 'c-1', eventId: 'ev-1', className: 'RALLY',
    }))
    expect(d.placeContactNow).toHaveBeenCalledWith(f.db, { locationId: 'loc-s', contactId: 'c-1' })
    expect(d.sendCorpPromoEmail).toHaveBeenCalledTimes(1)
    expect(d.sendCorpPromoEmail).toHaveBeenCalledWith(f.db, expect.objectContaining({
      copy: COPY, studioName: 'UN1T Stillorgan', zone: 'Europe/Dublin', appLinks: null,
      claim: expect.objectContaining({ id: 'claim-1', credits: 3, expires_at: null, contact_id: 'c-1' }),
    }))
    expect(d.sendOpsAlert).not.toHaveBeenCalled()
  })

  it('never logs or alerts the new account password', async () => {
    const d = deps({ purchaseGlofoxMembership: vi.fn(async () => ({ ok: false, message_code: 'X', error: 'no' })) })
    await run(d)
    const everything = JSON.stringify([d.sendOpsAlert.mock.calls, logError.mock.calls, logWarn.mock.calls])
    expect(everything).not.toContain('SECRET-PASS')
  })

  it('a claim with no class queues nothing and is still granted', async () => {
    const d = deps()
    expect((await run(d)).kind).toBe('granted')
    expect(d.queueFundedClassBooking).not.toHaveBeenCalled()
  })
})

describe('fulfilGlofoxCorpPromoClaim — an existing account', () => {
  it('a contact already linked is used as is: no search, the live plan is read', async () => {
    const d = deps()
    const r = await run(d, { ct: { ...contact, glofox_member_id: 'gm-1' } })
    expect(r.kind).toBe('granted')
    expect(d.findOrCreateGlofoxMember).not.toHaveBeenCalled()
    expect(d.fetchMemberResult).toHaveBeenCalledWith(CREDS, 'gm-1')
    expect(d.fetchUserCreditsResult).toHaveBeenCalledWith(CREDS, 'gm-1')
    expect(d.purchaseGlofoxMembership).toHaveBeenCalledWith(CREDS, 'gm-1', 'mem-ns', 'plan-ns', { body: TRIAL_PURCHASE_BODY })
  })

  it('a linked account (skipped, with an id) on a live Glofox trial → help live_plan: trial, nothing bought', async () => {
    const f = fakeDb()
    const d = deps({
      findOrCreateGlofoxMember: vi.fn(async () => ({ status: 'skipped', glofox_member_id: 'gm-1', error: 'already linked' })),
      mapMembershipStatus: vi.fn(() => 'trial'),
    })
    const r = await run(d, { db: f.db })
    expect(r).toEqual({ kind: 'help_filed' })
    expect(d.fetchMemberResult).toHaveBeenCalledWith(CREDS, 'gm-1')
    expect(d.purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(lastStatus(f.updates)).toMatchObject({ status: 'help_requested', reason: 'live_plan: trial', glofox_member_id: 'gm-1' })
    expect(d.sendOpsAlert).toHaveBeenCalledTimes(1)
  })

  it.each(['member', 'credit_member', 'classpass_payg'])('a live %s plan → help, nothing bought', async (status) => {
    const f = fakeDb()
    const d = deps({ findOrCreateGlofoxMember: vi.fn(async () => ({ status: 'linked', glofox_member_id: 'gm-1' })), mapMembershipStatus: vi.fn(() => status) })
    expect(await run(d, { db: f.db })).toEqual({ kind: 'help_filed' })
    expect(lastStatus(f.updates).reason).toBe(`live_plan: ${status}`)
    expect(d.purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('an ex-member or a lead with nothing live is bought for (the real status mapper)', async () => {
    const d = deps({ findOrCreateGlofoxMember: vi.fn(async () => ({ status: 'linked', glofox_member_id: 'gm-1' })) })
    delete d.mapMembershipStatus
    d.fetchMemberResult = vi.fn(async () => ({ ok: true, member: { _id: 'gm-1', membership: { type: 'payg' } }, refused: false, messageCode: null }))
    expect((await run(d)).kind).toBe('granted')
    expect(d.purchaseGlofoxMembership).toHaveBeenCalledTimes(1)
  })

  it('credits remaining (2) → help live_plan: credits, nothing bought', async () => {
    const f = fakeDb()
    const d = deps({
      findOrCreateGlofoxMember: vi.fn(async () => ({ status: 'linked', glofox_member_id: 'gm-1' })),
      fetchUserCreditsResult: vi.fn(async () => ({ ok: true, credits: [{ active: true, available: 2 }] })),
    })
    expect(await run(d, { db: f.db })).toEqual({ kind: 'help_filed' })
    expect(lastStatus(f.updates).reason).toBe('live_plan: credits')
    expect(d.purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('a failed member read is unknown, never "nothing live": help glofox_read_failed, nothing bought', async () => {
    const f = fakeDb()
    const d = deps({
      findOrCreateGlofoxMember: vi.fn(async () => ({ status: 'linked', glofox_member_id: 'gm-1' })),
      fetchMemberResult: vi.fn(async () => ({ ok: false, member: null, refused: false, messageCode: null })),
    })
    expect(await run(d, { db: f.db })).toEqual({ kind: 'help_filed' })
    expect(lastStatus(f.updates).reason).toBe('glofox_read_failed')
    expect(d.fetchUserCreditsResult).not.toHaveBeenCalled()
    expect(d.purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('a failed credits read → help glofox_read_failed, nothing bought', async () => {
    const f = fakeDb()
    const d = deps({
      findOrCreateGlofoxMember: vi.fn(async () => ({ status: 'linked', glofox_member_id: 'gm-1' })),
      fetchUserCreditsResult: vi.fn(async () => ({ ok: false, credits: [] })),
    })
    expect(await run(d, { db: f.db })).toEqual({ kind: 'help_filed' })
    expect(lastStatus(f.updates).reason).toBe('glofox_read_failed')
    expect(d.purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('a member read that throws is a failed read too', async () => {
    const f = fakeDb()
    const d = deps({ findOrCreateGlofoxMember: vi.fn(async () => ({ status: 'linked', glofox_member_id: 'gm-1' })), fetchMemberResult: vi.fn(async () => { throw new Error('boom') }) })
    expect(await run(d, { db: f.db })).toEqual({ kind: 'help_filed' })
    expect(lastStatus(f.updates).reason).toBe('glofox_read_failed')
    expect(d.purchaseGlofoxMembership).not.toHaveBeenCalled()
  })
})

describe('fulfilGlofoxCorpPromoClaim — the account step', () => {
  it('needs_review → help account_needs_review: <error>, nothing bought', async () => {
    const f = fakeDb()
    const d = deps({ findOrCreateGlofoxMember: vi.fn(async () => ({ status: 'needs_review', error: 'phone_match_no_link' })) })
    expect(await run(d, { db: f.db })).toEqual({ kind: 'help_filed' })
    expect(lastStatus(f.updates)).toMatchObject({ status: 'help_requested', reason: 'account_needs_review: phone_match_no_link' })
    expect(d.purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(d.sendOpsAlert).toHaveBeenCalledTimes(1)
  })

  it('failed, no id, or a throw → help account_create_failed: <msg>', async () => {
    for (const impl of [
      async () => ({ status: 'failed', error: 'missing first_name or last_name' }),
      async () => ({ status: 'skipped' }),
      async () => { throw new Error('kaboom') },
    ]) {
      const f = fakeDb()
      const d = deps({ findOrCreateGlofoxMember: vi.fn(impl) })
      expect(await run(d, { db: f.db })).toEqual({ kind: 'help_filed' })
      expect(lastStatus(f.updates).reason).toMatch(/^account_create_failed: /)
      expect(d.purchaseGlofoxMembership).not.toHaveBeenCalled()
    }
  })
})

describe('fulfilGlofoxCorpPromoClaim — plan and credentials', () => {
  it('no plan ids yet → unavailable, row failed plan_missing, nothing else', async () => {
    const f = fakeDb()
    const d = deps({ glofoxPlanForPromo: vi.fn(() => null) })
    expect(await run(d, { db: f.db })).toEqual({ kind: 'unavailable' })
    expect(lastStatus(f.updates)).toEqual({ status: 'failed', reason: 'plan_missing' })
    expect(d.glofoxCredentialsForLocation).not.toHaveBeenCalled()
    expect(d.sendOpsAlert).not.toHaveBeenCalled()
  })

  it('unreadable settings → unavailable, row failed, no account step', async () => {
    const f = fakeDb()
    const d = deps({ glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: null, apiKey: null, apiToken: null, readError: 'glofox_settings_unreadable' })) })
    expect(await run(d, { db: f.db })).toEqual({ kind: 'unavailable' })
    expect(lastStatus(f.updates).status).toBe('failed')
    expect(d.findOrCreateGlofoxMember).not.toHaveBeenCalled()
  })

  it('no credentials at the studio → help glofox_not_configured', async () => {
    const f = fakeDb()
    const d = deps({ glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'br', apiKey: null, apiToken: null, readError: null })) })
    expect(await run(d, { db: f.db })).toEqual({ kind: 'help_filed' })
    expect(lastStatus(f.updates).reason).toBe('glofox_not_configured')
    expect(d.findOrCreateGlofoxMember).not.toHaveBeenCalled()
  })
})

describe('fulfilGlofoxCorpPromoClaim — the write-ahead purchase', () => {
  it('a marker stamp that touches 0 rows → help grant_unrecorded, nothing bought', async () => {
    const f = fakeDb({ markerRows: 0 })
    const d = deps()
    expect(await run(d, { db: f.db })).toEqual({ kind: 'help_filed' })
    expect(lastStatus(f.updates).reason).toBe('grant_unrecorded')
    expect(lastStatus(f.updates)).not.toHaveProperty('grant')
    expect(d.purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('a marker stamp that errors → help grant_unrecorded, nothing bought', async () => {
    const f = fakeDb({ markerError: { code: '57014', message: 'timeout' } })
    const d = deps()
    expect(await run(d, { db: f.db })).toEqual({ kind: 'help_filed' })
    expect(lastStatus(f.updates).reason).toBe('grant_unrecorded')
    expect(d.purchaseGlofoxMembership).not.toHaveBeenCalled()
  })

  it('outcome_unknown → help grant_unverified, bought exactly once, the marker kept with outcome_unknown', async () => {
    const f = fakeDb()
    const d = deps({ purchaseGlofoxMembership: vi.fn(async () => ({ ok: false, outcome_unknown: true, http_status: 502, message_code: null, error: 'Glofox HTTP 502' })) })
    expect(await run(d, { db: f.db })).toEqual({ kind: 'help_filed' })
    expect(d.purchaseGlofoxMembership).toHaveBeenCalledTimes(1)
    const p = lastStatus(f.updates)
    expect(p).toMatchObject({ status: 'help_requested', reason: 'grant_unverified' })
    expect(p.grant).toMatchObject({ stage: 'purchasing', glofox_member_id: 'gm-new', membership_id: 'mem-ns', plan_code: 'plan-ns', outcome_unknown: true })
    expect(d.sendOpsAlert.mock.calls[0][0].htmlBody).toMatch(/invoice/i)
    expect(d.sendCorpPromoEmail).not.toHaveBeenCalled()
    expect(d.queueFundedClassBooking).not.toHaveBeenCalled()
  })

  it('a purchase call that throws is outcome unknown too, never re-sent', async () => {
    const f = fakeDb()
    const d = deps({ purchaseGlofoxMembership: vi.fn(async () => { throw new Error('socket') }) })
    expect(await run(d, { db: f.db })).toEqual({ kind: 'help_filed' })
    expect(d.purchaseGlofoxMembership).toHaveBeenCalledTimes(1)
    expect(lastStatus(f.updates).reason).toBe('grant_unverified')
  })

  it('refused YOU_HAVE_NO_CREDITS_LEFT → help grant_refused: YOU_HAVE_NO_CREDITS_LEFT', async () => {
    const f = fakeDb()
    const d = deps({ purchaseGlofoxMembership: vi.fn(async () => ({ ok: false, http_status: 200, message_code: 'YOU_HAVE_NO_CREDITS_LEFT', error: 'no credits' })) })
    expect(await run(d, { db: f.db })).toEqual({ kind: 'help_filed' })
    expect(d.purchaseGlofoxMembership).toHaveBeenCalledTimes(1)
    const p = lastStatus(f.updates)
    expect(p).toMatchObject({ status: 'help_requested', reason: 'grant_refused: YOU_HAVE_NO_CREDITS_LEFT' })
    expect(p.grant).toMatchObject({ stage: 'purchasing', ok: false, glofox_message_code: 'YOU_HAVE_NO_CREDITS_LEFT' })
    expect(d.sendCorpPromoEmail).not.toHaveBeenCalled()
  })
})

describe('fulfilGlofoxCorpPromoClaim — after the grant, best-effort', () => {
  const withClass = { ...claim, class_event_id: 'ev-1' }
  it('a queue helper that throws never undoes the grant', async () => {
    const d = deps({ queueFundedClassBooking: vi.fn(async () => { throw new Error('down') }) })
    const r = await run(d, { c: withClass })
    expect(r.kind).toBe('granted')
    expect(d.placeContactNow).toHaveBeenCalledTimes(1)
    expect(d.sendCorpPromoEmail).toHaveBeenCalledTimes(1)
  })
  it('placement and email failures never undo the grant either', async () => {
    const d = deps({ placeContactNow: vi.fn(async () => { throw new Error('x') }), sendCorpPromoEmail: vi.fn(async () => { throw new Error('y') }) })
    expect((await run(d, { c: withClass })).kind).toBe('granted')
  })
  it('a granted stamp that fails is logged and the person is still told (the plan is bought)', async () => {
    const f = fakeDb({ updateError: (patch) => (patch.status === 'granted' ? { code: '57014' } : null) })
    const d = deps()
    expect((await run(d, { db: f.db })).kind).toBe('granted')
    expect(logError).toHaveBeenCalled()
    expect(d.sendCorpPromoEmail).toHaveBeenCalledTimes(1)
  })
})

describe('fulfilGlofoxCorpPromoClaim — the staff alert', () => {
  it('names the claim id and the reason, escaped, to the organisation', async () => {
    const d = deps({ findOrCreateGlofoxMember: vi.fn(async () => ({ status: 'needs_review', error: '<script>x</script>' })) })
    await run(d, { c: { ...claim, first_name: 'Ann<b>' } })
    const alert = d.sendOpsAlert.mock.calls[0][0]
    expect(alert.organizationId).toBe('org-1')
    expect(alert.locationId).toBe('loc-s')
    expect(alert.htmlBody).toContain('claim-1')
    expect(alert.htmlBody).toContain('account_needs_review: &lt;script&gt;')
    expect(alert.htmlBody).not.toContain('<script>')
    expect(alert.htmlBody).not.toContain('Ann<b>')
  })
  it('an alert that throws still answers help_filed', async () => {
    const d = deps({ sendOpsAlert: vi.fn(async () => { throw new Error('smtp') }), findOrCreateGlofoxMember: vi.fn(async () => ({ status: 'needs_review', error: 'x' })) })
    expect(await run(d)).toEqual({ kind: 'help_filed' })
  })
})
