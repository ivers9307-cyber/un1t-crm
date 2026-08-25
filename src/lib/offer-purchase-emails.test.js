import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendTransactionalEmail = vi.fn(async () => ({ messageId: 'm1' }))
vi.mock('./postmark', () => ({ sendTransactionalEmail: (...a) => sendTransactionalEmail(...a) }))

import {
  bonusPhrase, applyTokens, defaultCopy, sendOfferPurchaseEmail, PURCHASE_EMAIL_TEMPLATES,
} from './offer-purchase-emails'

describe('bonusPhrase', () => {
  it('turns sale headlines into prose', () => {
    expect(bonusPhrase('+2 WEEKS FREE')).toBe('2 extra weeks')
    expect(bonusPhrase('+10 CLASSES FREE')).toBe('10 extra classes')
    expect(bonusPhrase('+1 MONTH FREE')).toBe('1 extra month')
  })
  it('returns empty for anything it cannot parse, rather than shouting caps mid-sentence', () => {
    expect(bonusPhrase('BIGGEST BONUS')).toBe('')
    expect(bonusPhrase(null)).toBe('')
    expect(bonusPhrase(undefined)).toBe('')
  })
})

describe('applyTokens', () => {
  it('substitutes known tokens and tolerates whitespace', () => {
    expect(applyTokens('Hi {{first_name}} / {{ offer_name }}', { first_name: 'Sam', offer_name: '20 Class Pack' }))
      .toBe('Hi Sam / 20 Class Pack')
  })
  it('leaves unknown tokens untouched instead of blanking them', () => {
    expect(applyTokens('{{unknown}} {{first_name}}', { first_name: 'Sam' })).toBe('{{unknown}} Sam')
  })
})

describe('defaultCopy', () => {
  const tokens = { first_name: 'Sam', offer_name: '20 Class Pack', bonus: '5 extra classes', amount: '€380', studio: 'UN1T Stillorgan' }

  it("the paid email does NOT claim the purchase is usable yet", () => {
    const { subject, htmlBody } = defaultCopy('paid', tokens)
    expect(subject).toContain('Payment received')
    expect(htmlBody).toContain('within 24 hours')
    expect(htmlBody).not.toMatch(/on your account and ready/i)
  })

  it('the ready email says it is on the account and bookable', () => {
    const { subject, htmlBody } = defaultCopy('ready', tokens)
    expect(subject).toContain("You're all set")
    expect(htmlBody).toMatch(/on your account and ready/i)
    expect(htmlBody).toContain('5 extra classes')
  })

  it('omits the bonus clause entirely when there is no parseable bonus', () => {
    const { htmlBody } = defaultCopy('ready', { ...tokens, bonus: '' })
    expect(htmlBody).not.toContain('included')
    expect(htmlBody).toContain('20 Class Pack')
  })

  it('carries no em-dashes or emoji in either variant (house style)', () => {
    for (const kind of ['paid', 'ready']) {
      const { subject, htmlBody } = defaultCopy(kind, tokens)
      expect(subject + htmlBody).not.toMatch(/—/)
      expect(subject + htmlBody).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u)
    }
  })
})

describe('gift card copy (GIFTCARD.1)', () => {
  const gift = { first_name: 'Sam', offer_name: '€100 Gift Card', bonus: '', amount: '€100', studio: 'UN1T Stillorgan', category: 'gift_card' }

  it('never tells a gift buyer to book classes — they are usually not the one training', () => {
    for (const kind of ['paid', 'ready']) {
      const { htmlBody } = defaultCopy(kind, gift)
      expect(htmlBody).not.toMatch(/book classes/i)
      expect(htmlBody).not.toMatch(/on your account/i)
    }
  })

  it('the ready email states the 5-year validity and how to redeem', () => {
    const { subject, htmlBody } = defaultCopy('ready', gift)
    expect(subject).toContain('€100 Gift Card')
    expect(htmlBody).toMatch(/5 years/)
    expect(htmlBody).toMatch(/hand over|reception/i)
  })

  it('the paid email still does not claim it is usable yet', () => {
    const { htmlBody } = defaultCopy('paid', gift)
    expect(htmlBody).toContain('within 24 hours')
    expect(htmlBody).not.toMatch(/ready to hand over/i)
  })

  it('a membership keeps the original copy — the branch is category-scoped', () => {
    const { htmlBody } = defaultCopy('ready', { ...gift, category: 'membership', offer_name: '3 Month Membership', bonus: '2 extra weeks' })
    expect(htmlBody).toMatch(/on your account/i)
    expect(htmlBody).toMatch(/book classes/i)
  })
})

const purchase = {
  id: 'p1', location_id: 'loc1', contact_id: 'c1',
  buyer_name: 'Sam Harley', buyer_email: 'harleys@tcd.ie', amount_cents: 38000,
}
const offer = { name: '20 Class Pack', bonus_headline: '+5 CLASSES FREE' }

function makeDb({ contact = { id: 'c1', first_name: 'Sam', email_status: null, contact_preferences: { email_administrative: true } }, template = null } = {}) {
  const seen = { templateName: null }
  return {
    seen,
    from(t) { this._t = t; return this },
    select() { return this },
    eq(col, val) { if (this._t === 'email_templates' && col === 'name') seen.templateName = val; return this },
    maybeSingle: async function () {
      if (this._t === 'contacts') return { data: contact }
      if (this._t === 'locations') return { data: { name: 'UN1T Stillorgan' } }
      if (this._t === 'email_templates') return { data: template }
      return { data: null }
    },
  }
}

beforeEach(() => sendTransactionalEmail.mockClear())

describe('sendOfferPurchaseEmail', () => {
  it('sends the ready email with resolved tokens, tagged and attributed to the contact', async () => {
    const r = await sendOfferPurchaseEmail(makeDb(), { purchase, offer, kind: 'ready' })
    expect(r).toEqual({ status: 'sent' })
    const arg = sendTransactionalEmail.mock.calls[0][0]
    expect(arg.to).toBe('harleys@tcd.ie')
    expect(arg.subject).toContain('20 Class Pack')
    expect(arg.htmlBody).toContain('Sam')
    expect(arg.htmlBody).toContain('5 extra classes')
    expect(arg.contactId).toBe('c1')
    expect(arg.locationId).toBe('loc1')
    expect(arg.tag).toBe('offer-purchase-ready')
  })

  it('looks up the operator override under the right template name per kind', async () => {
    const db = makeDb()
    await sendOfferPurchaseEmail(db, { purchase, offer, kind: 'paid' })
    expect(db.seen.templateName).toBe(PURCHASE_EMAIL_TEMPLATES.paid)
  })

  it('an operator template overrides the built-in copy and still gets tokens applied', async () => {
    const db = makeDb({ template: { subject: 'Custom {{offer_name}}', html_content: '<p>Yo {{first_name}}</p>' } })
    await sendOfferPurchaseEmail(db, { purchase, offer, kind: 'ready' })
    const arg = sendTransactionalEmail.mock.calls[0][0]
    expect(arg.subject).toBe('Custom 20 Class Pack')
    expect(arg.htmlBody).toBe('<p>Yo Sam</p>')
  })

  it('honours the administrative opt-out', async () => {
    const db = makeDb({ contact: { id: 'c1', first_name: 'Sam', contact_preferences: { email_administrative: false } } })
    expect(await sendOfferPurchaseEmail(db, { purchase, offer })).toEqual({
      status: 'skipped', reason: 'opted_out_administrative_email',
    })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })

  it('refuses to mail a bounced or complained address', async () => {
    for (const s of ['bounced', 'complained']) {
      sendTransactionalEmail.mockClear()
      const db = makeDb({ contact: { id: 'c1', email_status: s, contact_preferences: { email_administrative: true } } })
      expect((await sendOfferPurchaseEmail(db, { purchase, offer })).reason).toBe(`email_status=${s}`)
      expect(sendTransactionalEmail).not.toHaveBeenCalled()
    }
  })

  it('is NOT blocked by a marketing unsubscribe — this is transactional (LOCCOMMS.5)', async () => {
    const db = makeDb({ contact: { id: 'c1', first_name: 'Sam', email_status: 'unsubscribed', contact_preferences: { email_administrative: true } } })
    expect((await sendOfferPurchaseEmail(db, { purchase, offer })).status).toBe('sent')
  })

  it('skips when there is no address at all', async () => {
    expect(await sendOfferPurchaseEmail(makeDb(), { purchase: { ...purchase, buyer_email: null }, offer }))
      .toEqual({ status: 'skipped', reason: 'no_email_address' })
  })

  it('still sends when the purchase was never linked to a contact', async () => {
    const db = makeDb()
    const r = await sendOfferPurchaseEmail(db, { purchase: { ...purchase, contact_id: null }, offer })
    expect(r.status).toBe('sent')
    expect(sendTransactionalEmail.mock.calls[0][0].contactId).toBeNull()
  })
})
