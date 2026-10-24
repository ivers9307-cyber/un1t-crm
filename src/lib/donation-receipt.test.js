// CHARITY.3 — the donation receipt: fixed statements, escaping, stamps.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/event-email', () => ({
  resolveEventEmail: vi.fn(async ({ defaults }) => ({ subject: defaults.subject, htmlBody: '<p>body</p>' })),
}))
vi.mock('@/lib/event-comms-location', () => ({
  resolveEventCommsLocation: vi.fn(async () => ({ id: 'L-comms', name: 'UN1T Stillorgan' })),
}))
vi.mock('@/lib/transactional-consent', () => ({
  checkTransactionalConsent: vi.fn(async () => ({ allowed: true, reason: null })),
}))
vi.mock('@/lib/postmark', () => ({ sendTransactionalEmail: vi.fn(async () => ({ messageId: 'm1' })) }))
vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T Stillorgan' })),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const { resolveEventEmail } = await import('@/lib/event-email')
const { checkTransactionalConsent } = await import('@/lib/transactional-consent')
const { sendTransactionalEmail } = await import('@/lib/postmark')
const { logError } = await import('@/lib/log')
const { buildDonationReceiptDefaults, sendDonationReceipt } = await import('./donation-receipt')

function fakeDb({ updateError = null } = {}) {
  const writes = []
  return {
    writes,
    from(table) {
      const w = { table }
      const b = {
        update: (fields) => { w.fields = fields; writes.push(w); return b },
        eq: (col, val) => { w.eq = [col, val]; return b },
        is: (col, val) => { w.is = [col, val]; return b },
        select: () => Promise.resolve({ data: updateError ? null : [{ id: 'd1' }], error: updateError }),
      }
      return b
    },
  }
}

const CTX = {
  firstName: 'Sarah', brand: 'UN1T Stillorgan', charity: 'MS Ireland', raceName: 'Hatch 5K',
  locationName: 'UN1T Stillorgan', amountLabel: '€25.00', matchedLabel: '€50.00', multiplier: 2,
  subject: 'Thank you for your donation to MS Ireland',
}
const flat = (d) => Object.values(d).filter((v) => typeof v === 'string').join('\n')

describe('buildDonationReceiptDefaults', () => {
  it('escapes every ctx string (charity name with markup)', () => {
    const d = buildDonationReceiptDefaults({ ...CTX, charity: 'MS <b>Ireland</b>', firstName: '<i>S</i>', raceName: 'A & B' })
    const html = flat(d)
    expect(html).toContain('MS &lt;b&gt;Ireland&lt;/b&gt;')
    expect(html).not.toContain('<b>Ireland</b>')
    expect(html).toContain('&lt;i&gt;S&lt;/i&gt;')
    expect(html).toContain('A &amp; B')
  })
  it('multiplier 2: the match line, both amounts and the pass-on sentence', () => {
    const html = flat(buildDonationReceiptDefaults(CTX))
    expect(html).toContain('€25.00')
    expect(html).toContain('€50.00')
    expect(html).toContain('becomes')
    expect(html).toContain('UN1T Stillorgan passes every donation, matched, to MS Ireland after the event.')
    expect(html).toContain('This is not a charity tax receipt.')
  })
  it('multiplier 1: no match line, ", matched," dropped', () => {
    const html = flat(buildDonationReceiptDefaults({ ...CTX, multiplier: 1, matchedLabel: '€25.00' }))
    expect(html).not.toContain('becomes')
    expect(html).not.toContain('matched')
    expect(html).toContain('UN1T Stillorgan passes every donation to MS Ireland after the event.')
    expect(html).toContain('This is not a charity tax receipt.')
  })
  it('keeps the required statements out of the footer an operator intro replaces', () => {
    const d = buildDonationReceiptDefaults(CTX)
    expect(d.footerHtml).not.toContain('tax receipt')
    expect(d.footerHtml).not.toContain('passes every donation')
    expect(d.introHtml).toContain('passes every donation')
    expect(d.afterInfoHtml).toContain('This is not a charity tax receipt.')
  })
})

const RACE = {
  id: 'e1', name: 'Hatch 5K', location_id: 'L1', host_id: null, sending_location_id: null,
  charity_enabled: true,
  charity: { name: 'MS Ireland', match_multiplier: 2, receipt_subject: 'Thanks {{first_name}}, from {{charity}}', receipt_intro: 'Hi {{first_name}}, {{amount}} is {{matched}}.' },
}
const DONATION = {
  id: 'd1', contact_id: 'c1', donor_name: 'Sarah Byrne', donor_email: 'sarah@example.com',
  amount_cents: 2500, currency: 'EUR', match_multiplier: 2, status: 'paid', receipt_email_sent_at: null,
}

beforeEach(() => vi.clearAllMocks())

describe('sendDonationReceipt', () => {
  it('sends, tags donation-receipt, and stamps sent_at + status after the send', async () => {
    const db = fakeDb()
    const r = await sendDonationReceipt({ db, donation: DONATION, race: RACE, now: () => 'T' })
    expect(r).toEqual({ status: 'sent' })
    expect(sendTransactionalEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'sarah@example.com', contactId: 'c1', locationId: 'L-comms', tag: 'donation-receipt',
    }))
    expect(db.writes).toHaveLength(1)
    expect(db.writes[0].fields).toEqual({ receipt_email_sent_at: 'T', receipt_email_status: 'sent' })
    expect(db.writes[0].is).toEqual(['receipt_email_sent_at', null])
  })
  it('feeds the operator subject/intro through the donation_receipt kind, copy tags rendered', async () => {
    await sendDonationReceipt({ db: fakeDb(), donation: DONATION, race: RACE })
    const args = resolveEventEmail.mock.calls[0][0]
    expect(args.kind).toBe('donation_receipt')
    expect(args.race.donation_receipt_email_subject).toBe('Thanks Sarah, from MS Ireland')
    expect(args.race.donation_receipt_email_intro).toBe('Hi Sarah, €25.00 is €50.00.')
    expect(args.brandLocationId).toBe('L-comms')
  })
  it('a suppressed gate sends nothing and stamps both columns suppressed', async () => {
    checkTransactionalConsent.mockResolvedValueOnce({ allowed: false, reason: 'bounced' })
    const db = fakeDb()
    const r = await sendDonationReceipt({ db, donation: DONATION, race: RACE, now: () => 'T' })
    expect(r).toEqual({ status: 'suppressed', reason: 'bounced' })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(db.writes[0].fields).toEqual({ receipt_email_sent_at: 'T', receipt_email_status: 'suppressed' })
    expect(logError).toHaveBeenCalled()
  })
  it('a Postmark failure stamps only the status, so the next observation retries', async () => {
    sendTransactionalEmail.mockRejectedValueOnce(new Error('postmark down'))
    const db = fakeDb()
    const r = await sendDonationReceipt({ db, donation: DONATION, race: RACE, now: () => 'T' })
    expect(r.status).toBe('failed')
    expect(db.writes).toHaveLength(1)
    expect(db.writes[0].fields).toEqual({ receipt_email_status: 'failed' })
  })
  it('no donor email: skipped, nothing sent or written', async () => {
    const db = fakeDb()
    const r = await sendDonationReceipt({ db, donation: { ...DONATION, donor_email: '  ' }, race: RACE })
    expect(r.status).toBe('skipped')
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
  })
  it('a lost stamp is logged, never thrown, and the receipt still reports sent', async () => {
    const db = fakeDb({ updateError: new Error('write failed') })
    const r = await sendDonationReceipt({ db, donation: DONATION, race: RACE })
    expect(r).toEqual({ status: 'sent' })
    expect(logError).toHaveBeenCalled()
  })
  it('a resolver that throws falls back to the event location', async () => {
    const { resolveEventCommsLocation } = await import('@/lib/event-comms-location')
    resolveEventCommsLocation.mockRejectedValueOnce(new Error('boom'))
    const r = await sendDonationReceipt({ db: fakeDb(), donation: DONATION, race: RACE })
    expect(r.status).toBe('sent')
    expect(sendTransactionalEmail).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'L1' }))
  })
})
