// CHARITY.3 — donation payments: provider order, the status machine, and the
// stamp-keyed paid side effects.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/payments', () => ({ paymentsFor: vi.fn() }))
vi.mock('@/lib/event-hosts', () => ({
  resolvePaymentProvider: vi.fn(() => 'revolut'),
  hostCanTakePayments: vi.fn(() => true),
}))
vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T Stillorgan' })),
}))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://app.test') }))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: vi.fn(async () => 'c-new') }))
vi.mock('@/lib/contact-tags', () => ({ writeContactTag: vi.fn(async () => ({ written: true, tag: 'donor', alreadyPresent: false })) }))
vi.mock('@/lib/marketing-consent', () => ({ applyFormMarketingConsent: vi.fn(async () => ({ ok: true, skipped: null, changed: ['email'] })) }))
vi.mock('@/lib/contact-events', () => ({
  EVENT_TYPES: { DONATION_PAID: 'donation.paid' },
  emitEvent: vi.fn(async () => ({ id: 'ev1' })),
}))
vi.mock('@/lib/event-email', () => ({
  resolveEventEmail: vi.fn(async ({ defaults }) => ({ subject: defaults.subject, htmlBody: '<p>b</p>' })),
}))
vi.mock('@/lib/event-comms-location', () => ({ resolveEventCommsLocation: vi.fn(async () => ({ id: 'L-comms', name: 'UN1T Stillorgan' })) }))
vi.mock('@/lib/transactional-consent', () => ({ checkTransactionalConsent: vi.fn(async () => ({ allowed: true, reason: null })) }))
vi.mock('@/lib/postmark', () => ({ sendTransactionalEmail: vi.fn(async () => ({ messageId: 'm1' })) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const { paymentsFor } = await import('@/lib/payments')
const { resolvePaymentProvider, hostCanTakePayments } = await import('@/lib/event-hosts')
const { findOrCreateRaceContact } = await import('@/lib/race-contact-linking')
const { writeContactTag } = await import('@/lib/contact-tags')
const { applyFormMarketingConsent } = await import('@/lib/marketing-consent')
const { emitEvent } = await import('@/lib/contact-events')
const { sendTransactionalEmail } = await import('@/lib/postmark')
const {
  DONATION_COLS, createDonationPayment, resolveDonationByRef, markDonationPaymentStatus,
  markDonationRefunded, runPaidDonationSideEffects,
} = await import('./donation-payments')

// A hand-rolled supabase double. Each from(table) call is one chain; the
// chain resolves { data, error } when awaited or when .select() / .maybeSingle()
// ends it. `opts.updateError` fails every update; `opts.updateRows` is what a
// conditional update reports as matched; `opts.row` is what a read returns.
function fakeDb(opts = {}) {
  const writes = []
  const reads = []
  return {
    writes,
    reads,
    from(table) {
      const w = { table, filters: [] }
      let isUpdate = false
      const result = () => (isUpdate
        ? { data: opts.updateError ? null : (opts.updateRows ?? [{ id: 'd1' }]), error: opts.updateError || null }
        : { data: opts.row ?? null, error: opts.readError || null })
      const b = {
        update: (fields) => { isUpdate = true; w.fields = fields; writes.push(w); return b },
        select: (cols) => { if (!isUpdate) { w.cols = cols; reads.push(w) } return isUpdate ? Promise.resolve(result()) : b },
        eq: (col, val) => { w.filters.push(['eq', col, val]); return b },
        is: (col, val) => { w.filters.push(['is', col, val]); return b },
        maybeSingle: () => Promise.resolve(result()),
        then: (res, rej) => Promise.resolve(result()).then(res, rej),
      }
      return b
    },
  }
}

const RACE = {
  id: 'e1', name: 'Hatch 5K', location_id: 'L1', host_id: null, sending_location_id: null,
  charity_enabled: true, charity: { name: 'MS Ireland', match_multiplier: 2 },
}
const DONATION = {
  id: 'd1', race_event_id: 'e1', location_id: 'L1', contact_id: null, donor_name: 'Sarah Byrne',
  donor_email: '  Sarah@Example.COM ', amount_cents: 2500, currency: 'EUR', match_multiplier: 1,
  status: 'awaiting_payment', marketing_opt_in: false, receipt_email_sent_at: null, receipt_email_status: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  resolvePaymentProvider.mockReturnValue('revolut')
  hostCanTakePayments.mockReturnValue(true)
})

describe('createDonationPayment', () => {
  const created = { providerRef: 'ref1', checkoutToken: 'tok', checkoutUrl: 'https://pay/x', state: 'pending', amountCents: 2500 }

  it('opens an order described "{brand}: Donation to {charity}" keyed on the donation id', async () => {
    const createPayment = vi.fn(async () => created)
    paymentsFor.mockReturnValue({ createPayment })
    const db = fakeDb()
    const r = await createDonationPayment({ db, donation: DONATION, race: RACE, host: null, returnUrl: 'https://app.test/event/x?donation=d1' })
    expect(paymentsFor).toHaveBeenCalledWith('revolut')
    expect(createPayment).toHaveBeenCalledWith({
      amountCents: 2500,
      currency: 'EUR',
      description: 'UN1T Stillorgan: Donation to MS Ireland',
      returnUrl: 'https://app.test/event/x?donation=d1',
      metadata: { donation_id: 'd1', domain: 'un1t_donation', race_event_id: 'e1', location_id: 'L1' },
      idempotencyKey: 'd1',
      connectedAccountId: null,
      applicationFeeCents: 0,
    })
    expect(db.writes[0].fields).toEqual({
      payment_provider: 'revolut',
      payment_provider_ref: 'ref1',
      payment_checkout_token: 'tok',
      payment_checkout_url: 'https://pay/x',
      connected_account_id: null,
    })
    expect(db.writes[0].filters).toContainEqual(['eq', 'id', 'd1'])
    expect(r).toEqual({ donationId: 'd1', checkout: { provider: 'revolut', token: 'tok', url: 'https://pay/x', connectedAccountId: null } })
  })
  it('a stripe_connect host: direct charge on the host account, no application fee', async () => {
    resolvePaymentProvider.mockReturnValue('stripe_connect')
    const createPayment = vi.fn(async () => created)
    paymentsFor.mockReturnValue({ createPayment })
    const host = { id: 'h1', payment_provider: 'stripe_connect', charges_enabled: true, stripe_connected_account_id: 'acct_1' }
    const r = await createDonationPayment({ db: fakeDb(), donation: DONATION, race: { ...RACE, host_id: 'h1' }, host, returnUrl: 'u' })
    expect(paymentsFor).toHaveBeenCalledWith('stripe_connect')
    expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({ connectedAccountId: 'acct_1', applicationFeeCents: 0 }))
    expect(r.checkout.connectedAccountId).toBe('acct_1')
  })
  it('stripe_connect host that cannot take payments: payments_unavailable, no order opened', async () => {
    resolvePaymentProvider.mockReturnValue('stripe_connect')
    hostCanTakePayments.mockReturnValue(false)
    const createPayment = vi.fn()
    paymentsFor.mockReturnValue({ createPayment })
    await expect(createDonationPayment({ db: fakeDb(), donation: DONATION, race: RACE, host: { id: 'h1' }, returnUrl: 'u' }))
      .rejects.toMatchObject({ message: 'payments_unavailable', code: 'payments_unavailable' })
    expect(createPayment).not.toHaveBeenCalled()
  })
  it('a failed ref update rejects: a checkout nothing could settle is not handed out', async () => {
    paymentsFor.mockReturnValue({ createPayment: vi.fn(async () => created) })
    await expect(createDonationPayment({ db: fakeDb({ updateError: new Error('db down') }), donation: DONATION, race: RACE, host: null, returnUrl: 'u' }))
      .rejects.toThrow(/persist/)
  })
})

describe('resolveDonationByRef', () => {
  it('reads by provider ref with the donation columns', async () => {
    const db = fakeDb({ row: { id: 'd1' } })
    expect(await resolveDonationByRef(db, 'ref1')).toEqual({ id: 'd1' })
    expect(db.reads[0].cols).toBe(DONATION_COLS)
    expect(db.reads[0].filters).toContainEqual(['eq', 'payment_provider_ref', 'ref1'])
  })
  it('no ref or no row is null; a read error throws so the webhook retries', async () => {
    expect(await resolveDonationByRef(fakeDb(), '')).toBeNull()
    expect(await resolveDonationByRef(fakeDb({ row: null }), 'ref1')).toBeNull()
    await expect(resolveDonationByRef(fakeDb({ readError: new Error('boom') }), 'ref1')).rejects.toThrow('boom')
  })
})

describe('markDonationPaymentStatus', () => {
  const mark = (db, donation, providerState, extra = {}) =>
    markDonationPaymentStatus({ db, donation, providerState, providerAmount: 2500, multiplier: 2, now: () => 'T', ...extra })

  it('completed on awaiting_payment → paid, snapshotting the multiplier, guarded on the old status', async () => {
    const db = fakeDb()
    const r = await mark(db, DONATION, 'COMPLETED')
    expect(r).toEqual({ status: 'paid', changed: true })
    expect(db.writes[0].fields).toEqual({ status: 'paid', paid_at: 'T', match_multiplier: 2 })
    expect(db.writes[0].filters).toEqual(expect.arrayContaining([['eq', 'id', 'd1'], ['eq', 'status', 'awaiting_payment']]))
  })
  it('records the provider amount when it differs', async () => {
    const db = fakeDb()
    await mark(db, DONATION, 'completed', { providerAmount: 2000 })
    expect(db.writes[0].fields.amount_cents).toBe(2000)
  })
  it('a paid row is never touched again (webhook redelivery)', async () => {
    const db = fakeDb()
    const r = await mark(db, { ...DONATION, status: 'paid' }, 'completed')
    expect(r).toEqual({ status: 'paid', changed: false })
    expect(db.writes).toHaveLength(0)
  })
  it('completed on a refunded row stays refunded', async () => {
    const db = fakeDb()
    const r = await mark(db, { ...DONATION, status: 'refunded' }, 'completed')
    expect(r).toEqual({ status: 'refunded', changed: false })
    expect(db.writes).toHaveLength(0)
  })
  it('failed and expired rows never change, whatever the provider says', async () => {
    for (const status of ['failed', 'expired']) {
      const db = fakeDb()
      const r = await mark(db, { ...DONATION, status }, 'completed')
      expect(r).toEqual({ status, changed: false })
      expect(db.writes).toHaveLength(0)
    }
  })
  it('failed → failed; cancelled and expired → expired', async () => {
    for (const [state, expected] of [['failed', 'failed'], ['cancelled', 'expired'], ['expired', 'expired']]) {
      const db = fakeDb()
      const r = await mark(db, DONATION, state)
      expect(r).toEqual({ status: expected, changed: true })
      expect(db.writes[0].fields).toEqual({ status: expected })
    }
  })
  it('a transient state changes nothing', async () => {
    const db = fakeDb()
    const r = await mark(db, DONATION, 'authorised')
    expect(r).toEqual({ status: 'awaiting_payment', changed: false })
    expect(db.writes).toHaveLength(0)
  })
  it('losing the race to a concurrent writer re-reads the settled status, changed false', async () => {
    const db = fakeDb({ updateRows: [], row: { status: 'paid' } })
    const r = await mark(db, DONATION, 'completed')
    expect(r).toEqual({ status: 'paid', changed: false })
  })
  it('a failed write throws rather than reporting a payment', async () => {
    await expect(mark(fakeDb({ updateError: new Error('db down') }), DONATION, 'completed')).rejects.toThrow('db down')
  })
})

describe('markDonationRefunded', () => {
  it('moves paid → refunded with who and when, guarded on paid', async () => {
    const db = fakeDb()
    const r = await markDonationRefunded({ db, donationId: 'd1', byProfileId: 'p1', now: () => 'T' })
    expect(r).toEqual({ changed: true })
    expect(db.writes[0].fields).toEqual({ status: 'refunded', refunded_at: 'T', refunded_by: 'p1' })
    expect(db.writes[0].filters).toEqual(expect.arrayContaining([['eq', 'id', 'd1'], ['eq', 'status', 'paid']]))
  })
  it('a Stripe-reported refund has no profile; a non-paid row reports changed false', async () => {
    const db = fakeDb({ updateRows: [] })
    expect(await markDonationRefunded({ db, donationId: 'd1', byProfileId: null, now: () => 'T' })).toEqual({ changed: false })
    expect(db.writes[0].fields.refunded_by).toBeNull()
  })
  it('a failed write throws', async () => {
    await expect(markDonationRefunded({ db: fakeDb({ updateError: new Error('x') }), donationId: 'd1' })).rejects.toThrow('x')
  })
})

describe('runPaidDonationSideEffects', () => {
  const PAID = { ...DONATION, status: 'paid', match_multiplier: 2, paid_at: 'T' }

  it('no contact yet: links, tags donor, stamps contact_id, emits the timeline event', async () => {
    const db = fakeDb()
    const r = await runPaidDonationSideEffects({ db, donation: PAID, race: RACE, ipAddress: '1.2.3.4' })
    expect(findOrCreateRaceContact).toHaveBeenCalledWith(expect.objectContaining({ db, email: '  Sarah@Example.COM ', locationId: 'L1', name: 'Sarah Byrne' }))
    expect(writeContactTag).toHaveBeenCalledWith(db, expect.objectContaining({ contactId: 'c-new', locationId: 'L1', tag: 'donor' }))
    expect(db.writes.find((w) => w.fields.contact_id)).toMatchObject({
      fields: { contact_id: 'c-new' },
      filters: expect.arrayContaining([['eq', 'id', 'd1'], ['is', 'contact_id', null]]),
    })
    expect(emitEvent).toHaveBeenCalledWith({
      db, eventType: 'donation.paid', contactEmail: '  Sarah@Example.COM ', contactId: 'c-new', locationId: 'L1',
      sourceType: 'donation', sourceId: 'd1',
      metadata: { amount_cents: 2500, currency: 'EUR', charity: 'MS Ireland', event_name: 'Hatch 5K' },
    })
    expect(r.contact).toBe('linked')
  })
  it('consent is applied only when marketing_opt_in', async () => {
    await runPaidDonationSideEffects({ db: fakeDb(), donation: PAID, race: RACE, ipAddress: '1.2.3.4' })
    expect(applyFormMarketingConsent).not.toHaveBeenCalled()

    const r = await runPaidDonationSideEffects({ db: fakeDb(), donation: { ...PAID, marketing_opt_in: true }, race: RACE, ipAddress: '1.2.3.4' })
    expect(applyFormMarketingConsent).toHaveBeenCalledWith(expect.anything(), {
      contactId: 'c-new', consent: true, source: 'donation', ipAddress: '1.2.3.4', locationId: 'L1',
    })
    expect(r.consent).toBe('applied')
  })
  it('contact_id already set: the contact step is skipped entirely (no duplicate event)', async () => {
    const r = await runPaidDonationSideEffects({ db: fakeDb(), donation: { ...PAID, contact_id: 'c1', marketing_opt_in: true }, race: RACE })
    expect(findOrCreateRaceContact).not.toHaveBeenCalled()
    expect(writeContactTag).not.toHaveBeenCalled()
    expect(applyFormMarketingConsent).not.toHaveBeenCalled()
    expect(emitEvent).not.toHaveBeenCalled()
    expect(r.contact).toBe('skipped')
  })
  it('a failed contact_id stamp skips the event and reports failed (a retry redoes the idempotent steps)', async () => {
    const db = fakeDb({ updateError: new Error('write failed') })
    const r = await runPaidDonationSideEffects({ db, donation: PAID, race: RACE })
    expect(r.contact).toBe('failed')
    expect(emitEvent).not.toHaveBeenCalled()
  })
  it('a contact helper that returns null reports failed and does not stamp', async () => {
    findOrCreateRaceContact.mockResolvedValueOnce(null)
    const db = fakeDb()
    const r = await runPaidDonationSideEffects({ db, donation: PAID, race: RACE })
    expect(r.contact).toBe('failed')
    expect(db.writes.find((w) => w.fields.contact_id)).toBeUndefined()
    expect(emitEvent).not.toHaveBeenCalled()
  })
  it('a contact helper that throws never escapes; the receipt still goes (to the donor, no contact id)', async () => {
    findOrCreateRaceContact.mockRejectedValueOnce(new Error('boom'))
    const r = await runPaidDonationSideEffects({ db: fakeDb(), donation: PAID, race: RACE })
    expect(r.contact).toBe('failed')
    expect(r.receipt).toBe('sent')
  })
  it('receipt_email_sent_at null → the receipt goes once, with the contact id', async () => {
    const r = await runPaidDonationSideEffects({ db: fakeDb(), donation: PAID, race: RACE })
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    expect(sendTransactionalEmail).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'c-new', tag: 'donation-receipt' }))
    expect(r.receipt).toBe('sent')
  })
  it('receipt_email_sent_at set → no second receipt', async () => {
    const r = await runPaidDonationSideEffects({ db: fakeDb(), donation: { ...PAID, contact_id: 'c1', receipt_email_sent_at: 'earlier' }, race: RACE })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(r.receipt).toBe('skipped')
  })
  it('a receipt that throws → receipt failed, status stamped failed, sent_at never stamped', async () => {
    sendTransactionalEmail.mockRejectedValueOnce(new Error('postmark down'))
    const db = fakeDb()
    const r = await runPaidDonationSideEffects({ db, donation: { ...PAID, contact_id: 'c1' }, race: RACE })
    expect(r.receipt).toBe('failed')
    const stamps = db.writes.filter((w) => 'receipt_email_status' in w.fields)
    expect(stamps).toHaveLength(1)
    expect(stamps[0].fields).toEqual({ receipt_email_status: 'failed' })
    expect(db.writes.some((w) => 'receipt_email_sent_at' in w.fields)).toBe(false)
  })
  it('no donor email: contact and receipt both skipped, nothing throws', async () => {
    const r = await runPaidDonationSideEffects({ db: fakeDb(), donation: { ...PAID, donor_email: '' }, race: RACE })
    expect(r).toMatchObject({ contact: 'skipped', receipt: 'skipped' })
    expect(findOrCreateRaceContact).not.toHaveBeenCalled()
  })
})
