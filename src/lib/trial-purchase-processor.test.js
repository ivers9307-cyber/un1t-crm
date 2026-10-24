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

import { processTrialPurchase, alertTrialPurchaseStaff, REVIEW_REASONS } from './trial-purchase-processor'

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
  const inserts = []
  const db = {
    from: (table) => ({
      insert: async (fields) => { inserts.push({ table, fields }); return { data: null, error: null } },
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
  return { db, updates, inserts }
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
    // PAIDTRIAL.4 — always complimentary: the CRM already holds the money.
    expect(mocks.purchase).toHaveBeenCalledWith({ branchId: 'b1', token: 't' }, 'g-existing', 'm1', 'p1', { body: { payment_method: 'complimentary' } })
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
    expect(mocks.purchase).toHaveBeenCalledWith(expect.anything(), 'g-new', 'm1', 'p1', { body: { payment_method: 'complimentary' } })
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

  // PAIDTRIAL.3 — the buyer has paid: a Glofox account that already holds
  // their mobile under another email must not hold up the grant.
  it('asks the resolver to CREATE on a phone-only match, grants, and notes the match on the contact', async () => {
    mocks.member.mockResolvedValueOnce({ status: 'created', glofox_member_id: 'g-new', phone_match: { matches: 1, glofox_member_ids: ['g-old'] } })
    const { db, updates, inserts } = makeDb()
    const r = await processTrialPurchase(db, ROW)
    expect(r.outcome).toBe('granted')
    expect(mocks.member).toHaveBeenCalledWith(expect.objectContaining({ phoneMatchPolicy: 'create', attachTrial: false, createIfMissing: true }))
    expect(mocks.purchase).toHaveBeenCalledWith(expect.anything(), 'g-new', 'm1', 'p1', { body: { payment_method: 'complimentary' } })
    expect(updates.at(-1).fields).toMatchObject({ status: 'granted', glofox_member_id: 'g-new' })
    const note = inserts.find((i) => i.table === 'notes')
    expect(note.fields.contact_id).toBe('c1')
    expect(note.fields.content).toContain('g-old')
    expect(note.fields.content).toContain('already holds this mobile number')
  })

  // PURCHASEVALUE.1 — the server Purchase says how much was taken.
  it('the Purchase event to Meta carries the amount, currency and our purchase id as the order', async () => {
    const { db } = makeDb()
    expect((await processTrialPurchase(db, ROW)).outcome).toBe('granted')
    expect(mocks.capi).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventName: 'Purchase', value: 39, currency: 'EUR', orderId: 'tp1', contentType: 'product', contentName: '2 Week Trial',
    }))
  })

  it('a created account with no phone match leaves no note', async () => {
    mocks.member.mockResolvedValueOnce({ status: 'created', glofox_member_id: 'g-new' })
    const { db, inserts } = makeDb()
    expect((await processTrialPurchase(db, ROW)).outcome).toBe('granted')
    expect(inserts.filter((i) => i.table === 'notes')).toHaveLength(0)
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

describe('alertTrialPurchaseStaff', () => {
  it('the staff alert escapes the buyer name', async () => {
    const { db } = makeDb()
    mocks.purchase.mockResolvedValue({ ok: false, error: 'NO' })
    await processTrialPurchase(db, { ...ROW, customer_name: '<img src=x onerror=alert(1)>' })
    const html = mocks.ops.mock.calls[0][0].htmlBody
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('escapes every buyer-typed or Glofox-supplied field, and leaves the push body plain text', async () => {
    const { db } = makeDb()
    const evil = '<script>x</script>'
    await alertTrialPurchaseStaff(db, {
      ...ROW, customer_name: 'A & B', customer_email: `a${evil}@x.com`, customer_phone: evil,
      product_name: evil, membership_id: evil, plan_code: evil,
    }, 'unknown_reason<i>', `<b>glofox</b>`)
    const call = mocks.ops.mock.calls[0][0]
    expect(call.htmlBody).not.toContain('<script>')
    expect(call.htmlBody).not.toContain('<i>')
    expect(call.htmlBody).not.toContain('<b>glofox')
    expect(call.htmlBody).toContain('A &amp; B')
    expect(call.htmlBody).toContain('&lt;b&gt;glofox&lt;/b&gt;')
    expect(call.pushBody).toContain('A & B')
    expect(call.pushBody).not.toContain('&amp;')
  })

  it('a help_requested row gets the help-request subject; any other row keeps the paid-trial subject', async () => {
    const { db } = makeDb()
    await alertTrialPurchaseStaff(db, { ...ROW, status: 'help_requested' }, 'trial_used')
    expect(mocks.ops.mock.calls[0][0].subject).toBe('Trial help request: Ava Byrne (Stillorgan)')
    await alertTrialPurchaseStaff(db, ROW, 'grant_refused')
    expect(mocks.ops.mock.calls[1][0].subject).toBe('Paid trial needs a hand: Ava Byrne (Stillorgan)')
  })

  it('a help_requested body says nobody was charged and asks staff to contact the customer', async () => {
    const { db } = makeDb()
    await alertTrialPurchaseStaff(db, { ...ROW, status: 'help_requested' }, 'trial_used', 'glofox_trial_claim')
    const html = mocks.ops.mock.calls[0][0].htmlBody
    expect(html).toContain('A customer asked for help on the /trial page and was not charged.')
    expect(html).toContain('glofox_trial_claim')
    expect(html).toContain('Ava Byrne')
    expect(html).toContain('contact the customer, then mark the card handled.')
    expect(html).not.toContain('was taken')
    expect(html).not.toContain('retry the grant')
    expect(html).not.toContain('Paid:')
    expect(mocks.ops.mock.calls[0][0].pushBody).not.toContain('manual grant')
  })

  it('a grant-failure body is unchanged', async () => {
    const { db } = makeDb()
    await alertTrialPurchaseStaff(db, ROW, 'grant_refused')
    const html = mocks.ops.mock.calls[0][0].htmlBody
    expect(html).toContain('A paid trial purchase was taken but the plan was not put on the account automatically.')
    expect(html).toContain('<strong>Paid:</strong>')
    expect(html).toContain('retry the grant')
  })

  it('has the five new review reasons', () => {
    for (const k of ['trial_used', 'active_member', 'un1t_account_refused', 'un1t_checkout_refused', 'un1t_outcome_unknown']) {
      expect(REVIEW_REASONS[k]).toBeTruthy()
    }
    expect(REVIEW_REASONS.trial_used).toBe('The buyer already had a trial here and asked for help.')
  })
})
