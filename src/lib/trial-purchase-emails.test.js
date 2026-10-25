import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendTransactionalEmail = vi.fn(async () => ({ messageId: 'm1' }))
vi.mock('./postmark', () => ({ sendTransactionalEmail: (...a) => sendTransactionalEmail(...a) }))
const branding = { companyName: 'UN1T Stillorgan', shortName: 'UN1T', locationName: 'UN1T Stillorgan' }
vi.mock('./location-branding', () => ({ getLocationBranding: vi.fn(async () => branding) }))

import { defaultTrialCopy, sendTrialPurchaseEmail } from './trial-purchase-emails'

const tokens = { first_name: 'Ava', product_name: '2 Week Trial', amount: '€39', duration_days: 14, studio: 'Stillorgan', short_name: 'UN1T' }

// A db answering the contact, location and operator-template reads.
function makeDb({ template = null } = {}) {
  return {
    from: (table) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          if (table === 'locations') return { data: { name: 'Stillorgan' }, error: null }
          if (table === 'email_templates') return { data: template, error: null }
          return { data: null, error: null }
        },
      }
      return chain
    },
  }
}

const PURCHASE = {
  customer_email: 'ava@example.com', location_id: 'loc1', contact_id: null,
  first_name: 'Ava', customer_name: 'Ava Byrne', product_name: '2 Week Trial', duration_days: 14, amount_cents: 3900, currency: 'EUR',
}

beforeEach(() => vi.clearAllMocks())

describe('defaultTrialCopy', () => {
  it('escapes tokens', () => {
    expect(defaultTrialCopy('granted', { ...tokens, first_name: '<b>Ava</b>' }).htmlBody).toContain('&lt;b&gt;Ava')
  })
  it('escapes every token it prints', () => {
    const evil = '<i>x</i>'
    const { htmlBody } = defaultTrialCopy('granted', { first_name: evil, product_name: evil, amount: evil, duration_days: evil, studio: evil, short_name: evil })
    expect(htmlBody).not.toContain('<i>')
    expect(htmlBody).toContain('&lt;i&gt;x&lt;/i&gt;')
  })
})

describe('sendTrialPurchaseEmail', () => {
  it('escapes a buyer-typed name in the default copy it sends', async () => {
    await sendTrialPurchaseEmail(makeDb(), { purchase: { ...PURCHASE, first_name: null, customer_name: '<img src=x onerror=alert(1)>' } })
    const sent = sendTransactionalEmail.mock.calls[0][0]
    expect(sent.htmlBody).not.toContain('<img')
    expect(sent.htmlBody).toContain('&lt;img')
  })

  it('keeps the operator template as trusted HTML but escapes the token values placed in it', async () => {
    const template = { subject: 'Welcome {{first_name}}', html_content: '<h1>Hi {{first_name}}</h1><p>{{product_name}}</p>' }
    await sendTrialPurchaseEmail(makeDb({ template }), { purchase: { ...PURCHASE, customer_name: '<script>x</script>', first_name: null } })
    const sent = sendTransactionalEmail.mock.calls[0][0]
    expect(sent.htmlBody).toContain('<h1>Hi &lt;script&gt;x&lt;/script&gt;</h1>')
    expect(sent.htmlBody).not.toContain('<script>')
  })
})
