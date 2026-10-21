// PAIDTRIAL.1 — the fulfilment decision tree, with Glofox, the account
// helper, the email and Meta mocked. What it pins: a paid trial is granted
// to an existing member and to a new account alike, never buys the free
// trial, never buys twice (write-ahead marker), and never fails silently
// after the money is taken.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  creds: vi.fn(), missing: vi.fn(), purchase: vi.fn(), member: vi.fn(),
  capi: vi.fn(), ops: vi.fn(), email: vi.fn(),
}))
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: mocks.creds,
  missingGlofoxCredentialsForLocation: mocks.missing,
  purchaseGlofoxMembership: mocks.purchase,
}))
vi.mock('@/lib/glofox-push', () => ({ findOrCreateGlofoxMember: mocks.member }))
vi.mock('@/lib/meta-capi', () => ({ sendWebsiteConversion: mocks.capi }))
vi.mock('@/lib/ops-alerts', () => ({ sendOpsAlert: mocks.ops }))
vi.mock('@/lib/trial-purchase-emails', () => ({ sendTrialPurchaseEmail: mocks.email }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import { processTrialPurchase } from './trial-purchase-processor'

const ROW = {
  id: 'tp1', location_id: 'loc1', contact_id: 'c1', status: 'processing', payment_status: 'paid',
  customer_name: 'Ava Byrne', first_name: 'Ava', last_name: 'Byrne', customer_email: 'ava@example.com', customer_phone: '+353850000001',
  product_name: '2 Week Trial', membership_id: 'm1', plan_code: 'p1', duration_days: 14, amount_cents: 3900, currency: 'EUR',
  grant: null, attribution: { fbc: 'fb.1.x', event_source_url: 'https://www.un1tdublin.com/trial' },
}

// A db whose updates are recorded (with the status guard) and whose reads
// answer the contact and the location.
function makeDb({ contact = { id: 'c1', email: 'ava@example.com', first_name: 'Ava', last_name: 'Byrne', glofox_member_id: null }, updateFails = false } = {}) {
  const updates = []
  const db = {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (table === 'contacts') return { data: contact, error: null }
            if (table === 'locations') return { data: { organization_id: 'org1', name: 'Stillorgan' }, error: null }
            return { data: null, error: null }
          },
        }),
      }),
      update: (fields) => {
        const chain = {
          eq: () => chain,
          select: async () => {
            updates.push({ table, fields })
            return updateFails ? { data: null, error: new Error('db down') } : { data: [{ id: 'tp1' }], error: null }
          },
        }
        return chain
      },
    }),
  }
  return { db, updates }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.creds.mockResolvedValue({ branchId: 'b1', token: 't' })
  mocks.missing.mockReturnValue([]) // the real helper returns the list of missing fields
  mocks.purchase.mockResolvedValue({ ok: true, invoice_id: 'inv1', purchase_status: 'SUCCESS' })
  mocks.member.mockResolvedValue({ status: 'created', glofox_member_id: 'g-new' })
  mocks.capi.mockResolvedValue({ sent: true })
  mocks.email.mockResolvedValue({ status: 'sent' })
  mocks.ops.mockResolvedValue({ channel: 'email' })
})

describe('processTrialPurchase', () => {
  it('an existing Glofox member gets the plan on their account; the free trial is never bought', async () => {
    const { db, updates } = makeDb({ contact: { id: 'c1', email: 'ava@example.com', first_name: 'Ava', last_name: 'Byrne', glofox_member_id: 'g-existing' } })
    const r = await processTrialPurchase(db, ROW, { now: () => 'T' })
    expect(r).toEqual({ outcome: 'granted' })
    expect(mocks.member).not.toHaveBeenCalled()
    expect(mocks.purchase).toHaveBeenCalledWith({ branchId: 'b1', token: 't' }, 'g-existing', 'm1', 'p1')
    // write-ahead: the marker lands BEFORE the purchase, the outcome after
    expect(updates[0].fields.grant).toMatchObject({ stage: 'purchasing', glofox_member_id: 'g-existing' })
    expect(updates[1].fields).toMatchObject({ status: 'granted', granted_at: 'T', grant: { ok: true, invoice_id: 'inv1' } })
    expect(mocks.email).toHaveBeenCalledTimes(1)
    expect(mocks.capi).toHaveBeenCalledWith(db, expect.objectContaining({ eventName: 'Purchase', eventId: 'trialpurchase-tp1', locationId: 'loc1', fbc: 'fb.1.x' }))
  })

  it('a new person gets an account (attachTrial false) and then the plan', async () => {
    const { db } = makeDb()
    const r = await processTrialPurchase(db, ROW)
    expect(r.outcome).toBe('granted')
    expect(mocks.member).toHaveBeenCalledWith(expect.objectContaining({ createIfMissing: true, attachTrial: false, source: 'paid_trial' }))
    expect(mocks.purchase).toHaveBeenCalledWith(expect.anything(), 'g-new', 'm1', 'p1')
  })

  it('a clear Glofox refusal after the money is taken → needs_review + ops alert, nothing silent', async () => {
    mocks.purchase.mockResolvedValue({ ok: false, error: 'PLAN_NOT_FOUND', message_code: 'PLAN_NOT_FOUND', http_status: 400 })
    const { db, updates } = makeDb()
    const r = await processTrialPurchase(db, ROW)
    expect(r).toEqual({ outcome: 'needs_review', reason: 'grant_refused' })
    expect(updates.at(-1).fields).toMatchObject({ status: 'needs_review', grant: { ok: false, glofox_message_code: 'PLAN_NOT_FOUND' } })
    expect(mocks.ops).toHaveBeenCalledTimes(1)
    expect(mocks.email).not.toHaveBeenCalled()
  })

  it('no clear answer from Glofox (5xx / no reply) is never bought again: review, marker kept', async () => {
    mocks.purchase.mockResolvedValue({ ok: false, outcome_unknown: true, error: 'Glofox HTTP 502', http_status: 502 })
    const { db, updates } = makeDb()
    const r = await processTrialPurchase(db, ROW)
    expect(r).toEqual({ outcome: 'needs_review', reason: 'grant_unverified' })
    expect(updates.at(-1).fields.grant).toMatchObject({ stage: 'purchasing', outcome_unknown: true })
    // a re-run with that marker does NOT call Glofox again
    mocks.purchase.mockClear()
    const r2 = await processTrialPurchase(db, { ...ROW, grant: updates.at(-1).fields.grant })
    expect(r2.reason).toBe('grant_unverified')
    expect(mocks.purchase).not.toHaveBeenCalled()
  })

  it('a recorded ok grant on a re-run finishes the side effects without buying again', async () => {
    const { db, updates } = makeDb()
    const r = await processTrialPurchase(db, { ...ROW, grant: { ok: true, at: 'T0', glofox_member_id: 'g-existing' }, glofox_member_id: 'g-existing' })
    expect(r.outcome).toBe('granted')
    expect(mocks.purchase).not.toHaveBeenCalled()
    expect(updates[0].fields).toMatchObject({ status: 'granted', granted_at: 'T0' })
    expect(mocks.email).toHaveBeenCalledTimes(1)
  })

  it('an unwritable marker buys nothing', async () => {
    const { db } = makeDb({ updateFails: true })
    const r = await processTrialPurchase(db, ROW)
    expect(r.reason).toBe('grant_unrecorded')
    expect(mocks.purchase).not.toHaveBeenCalled()
  })

  it('an unpaid row is a review item, never a grant', async () => {
    const { db } = makeDb()
    const r = await processTrialPurchase(db, { ...ROW, payment_status: 'pending' })
    expect(r.reason).toBe('unpaid_row')
    expect(mocks.purchase).not.toHaveBeenCalled()
  })

  it('the account helper asking for review stops with the reason; a failed search throws for retry', async () => {
    mocks.member.mockResolvedValueOnce({ status: 'needs_review', error: 'phone_match_no_link' })
    const { db } = makeDb()
    expect((await processTrialPurchase(db, ROW)).reason).toBe('account_needs_review')
    mocks.member.mockResolvedValueOnce({ status: 'failed', error: 'Search failed: network' })
    await expect(processTrialPurchase(db, ROW)).rejects.toThrow(/search failed/i)
    expect(mocks.purchase).not.toHaveBeenCalled()
  })

  it('unreadable Glofox settings throw (the queue retries); none configured is a review item', async () => {
    const { db } = makeDb()
    mocks.creds.mockResolvedValueOnce({ readError: new Error('x') })
    await expect(processTrialPurchase(db, ROW)).rejects.toThrow(/unreadable/)
    mocks.missing.mockReturnValueOnce(['API Key'])
    expect((await processTrialPurchase(db, ROW)).reason).toBe('glofox_not_configured')
  })

  it('a failed email or Meta send never undoes a grant', async () => {
    mocks.email.mockRejectedValue(new Error('postmark down'))
    mocks.capi.mockRejectedValue(new Error('meta down'))
    const { db } = makeDb()
    expect((await processTrialPurchase(db, ROW)).outcome).toBe('granted')
  })
})
