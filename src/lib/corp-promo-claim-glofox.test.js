// NEWSTART.1c — fulfilGlofoxCorpPromoClaim: account, live-plan check,
// write-ahead marker, the €0 plan purchase (never re-sent), stamp, tell.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { fulfilGlofoxCorpPromoClaim } from './corp-promo-claim-glofox'
import { resolveSeededCorpPromo, corpPromoCopyFromBlocks } from './corp-promos'
import { TRIAL_PURCHASE_BODY } from './trial-purchase-processor'
import { logError, logWarn } from '@/lib/log'

const PROMO = resolveSeededCorpPromo('stillorgan-newstart')
const COPY = corpPromoCopyFromBlocks([], PROMO.key, { platform: 'glofox' })
const PLAN = { membershipId: 'mem-ns', planCode: 'plan-ns', planName: 'New Start' }
const CREDS = { branchId: 'br-1', apiKey: 'k', apiToken: 't', readError: null }

/**
 * A fake service-role client holding ONE corp_promo_claims row: an update
 * applies only when every filter matches the row (eq / is), and answers the
 * rows it touched when `.select()` is chained. `beforeMarker(row)` runs just
 * before the write-ahead marker lands: a concurrent run changing the row.
 */
function fakeDb({ row: start = {}, beforeMarker = null, markerError = null, updateError = null, readError = null } = {}) {
  const row = { id: 'claim-1', location_id: 'loc-s', status: 'processing', grant: null, ...start }
  const updates = []
  const reads = []
  const matches = (filters) => filters.every(([op, c, v]) => (op === 'eq' ? row[c] === v : op === 'is' ? row[c] == v : true))
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
            const isMarker = patch.grant?.stage === 'purchasing' && !('status' in patch)
            if (isMarker && beforeMarker) beforeMarker(row)
            const error = isMarker ? markerError : (typeof updateError === 'function' ? updateError(patch) : updateError)
            const hit = !error && matches(filters)
            if (hit) Object.assign(row, patch)
            updates.push({ table, patch, filters, selected, touched: hit ? 1 : 0 })
            return Promise.resolve({ data: error ? null : (selected ? (hit ? [{ id: row.id }] : []) : null), error }).then(ok, no)
          },
        }
        return q
      },
      select: (cols) => {
        const filters = []
        const q = {
          eq: (c, v) => { filters.push(['eq', c, v]); return q },
          maybeSingle: async () => {
            reads.push({ table, cols, filters })
            if (readError) return { data: null, error: readError }
            return { data: matches(filters) ? { ...row } : null, error: null }
          },
        }
        return q
      },
    }),
  }
  return { db, updates, reads, row }
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
  it('a marker refused because another run already GRANTED the row: no purchase, no help stamp, no alert', async () => {
    const f = fakeDb({ beforeMarker: (row) => Object.assign(row, { status: 'granted', grant: { ok: true, at: 'earlier' } }) })
    const d = deps()
    expect(await run(d, { db: f.db })).toEqual({ kind: 'unavailable' })
    expect(d.purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(f.updates.some((u) => u.patch.status)).toBe(false)
    expect(d.sendOpsAlert).not.toHaveBeenCalled()
    expect(f.row.status).toBe('granted')
    expect(f.reads).toHaveLength(1)
  })

  it("a marker refused because another run's purchasing marker is on the row: no purchase, no grant_unrecorded, no alert", async () => {
    const other = { stage: 'purchasing', at: 'earlier', glofox_member_id: 'gm-new' }
    const f = fakeDb({ beforeMarker: (row) => { row.grant = other } })
    const d = deps()
    expect(await run(d, { db: f.db })).toEqual({ kind: 'unavailable' })
    expect(d.purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(f.updates.some((u) => u.patch.reason === 'grant_unrecorded')).toBe(false)
    expect(f.row).toMatchObject({ status: 'processing', grant: other })
    expect(d.sendOpsAlert).not.toHaveBeenCalled()
  })

  it('a refused marker whose re-read fails → help with the "may have gone through" advice, never "nothing was bought"', async () => {
    const f = fakeDb({ markerError: { code: '57014' }, readError: { code: '08006' } })
    const d = deps()
    expect(await run(d, { db: f.db })).toEqual({ kind: 'help_filed' })
    expect(d.purchaseGlofoxMembership).not.toHaveBeenCalled()
    expect(f.row).toMatchObject({ status: 'help_requested', reason: 'grant_unverified', grant: null })
    const html = d.sendOpsAlert.mock.calls[0][0].htmlBody
    expect(html).toMatch(/may have gone through/)
    expect(html).toMatch(/€0 New Start invoice/)
    expect(html).not.toMatch(/nothing was bought/i)
  })

  it('a help stamp never overwrites a granted row (the stamp is guarded on processing)', async () => {
    // A live-plan help on a row another run finished meanwhile.
    const f = fakeDb({ row: { status: 'granted' } })
    const d = deps({ findOrCreateGlofoxMember: vi.fn(async () => ({ status: 'linked', glofox_member_id: 'gm-1' })), mapMembershipStatus: vi.fn(() => 'trial') })
    expect(await run(d, { db: f.db })).toEqual({ kind: 'unavailable' })
    expect(f.row.status).toBe('granted')
    const help = f.updates.find((u) => u.patch.status === 'help_requested')
    expect(help.filters).toContainEqual(['eq', 'status', 'processing'])
    expect(help.touched).toBe(0)
    expect(d.sendOpsAlert).not.toHaveBeenCalled()
  })

  it('an existing help path (live_plan) on a processing row still stamps help and alerts', async () => {
    const f = fakeDb()
    const d = deps({ findOrCreateGlofoxMember: vi.fn(async () => ({ status: 'linked', glofox_member_id: 'gm-1' })), mapMembershipStatus: vi.fn(() => 'member') })
    expect(await run(d, { db: f.db })).toEqual({ kind: 'help_filed' })
    expect(f.row).toMatchObject({ status: 'help_requested', reason: 'live_plan: member', glofox_member_id: 'gm-1' })
    expect(d.sendOpsAlert).toHaveBeenCalledTimes(1)
  })

  it('a help stamp that errors still alerts staff (the alert is the filing)', async () => {
    const f = fakeDb({ updateError: (patch) => (patch.status === 'help_requested' ? { code: '57014' } : null) })
    const d = deps({ findOrCreateGlofoxMember: vi.fn(async () => ({ status: 'needs_review', error: 'x' })) })
    expect(await run(d, { db: f.db })).toEqual({ kind: 'help_filed' })
    expect(d.sendOpsAlert).toHaveBeenCalledTimes(1)
  })

  it('a marker write that errors, re-read showing no grant → help grant_unrecorded, nothing bought', async () => {
    const f = fakeDb({ markerError: { code: '57014', message: 'timeout' } })
    const d = deps()
    expect(await run(d, { db: f.db })).toEqual({ kind: 'help_filed' })
    expect(f.reads).toHaveLength(1)
    expect(lastStatus(f.updates).reason).toBe('grant_unrecorded')
    expect(f.row.grant).toBeNull()
    expect(d.sendOpsAlert.mock.calls[0][0].htmlBody).toMatch(/nothing was bought/)
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
