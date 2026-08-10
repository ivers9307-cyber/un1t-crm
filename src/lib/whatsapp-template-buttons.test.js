import { describe, it, expect } from 'vitest'
import { templateButtonsError, componentsButtonsError } from './whatsapp-template-buttons.js'

const quickReply = (text) => ({ type: 'QUICK_REPLY', text })

describe('templateButtonsError — the rules behind Meta subcode 2388060', () => {
  it('passes the buttons on our live approved templates', () => {
    expect(templateButtonsError([{ type: 'URL', text: 'Book Now', url: 'https://www.un1tdublin.com/welcome/stillorgan#book' }])).toBeNull()
    expect(templateButtonsError([quickReply('Book my first class'), quickReply('Book Free Consultation')])).toBeNull()
    expect(templateButtonsError([{ type: 'FLOW', text: 'Click Here To Book', flow_id: '1343015528022374', navigate_screen: 'PATH' }])).toBeNull()
  })

  it('accepts no buttons at all', () => {
    expect(templateButtonsError([])).toBeNull()
    expect(templateButtonsError()).toBeNull()
  })

  it('rejects a variable in the button label', () => {
    const err = templateButtonsError([quickReply('Book {{1}}')])
    expect(err).toMatch(/variable/i)
    expect(err).toContain('Button 1')
  })

  it('rejects an emoji in the button label', () => {
    expect(templateButtonsError([quickReply('Book now 🔥')])).toMatch(/emoji/i)
  })

  it('rejects a line break in the button label', () => {
    expect(templateButtonsError([quickReply('Book\nnow')])).toMatch(/line break/i)
  })

  it('rejects WhatsApp formatting characters in the button label', () => {
    expect(templateButtonsError([quickReply('*Book now*')])).toMatch(/formatting/i)
    expect(templateButtonsError([quickReply('Book _now_')])).toMatch(/formatting/i)
  })

  it('rejects an over-long or empty label', () => {
    expect(templateButtonsError([quickReply('a'.repeat(26))])).toMatch(/25 characters/i)
    expect(templateButtonsError([quickReply('   ')])).toMatch(/label/i)
    expect(templateButtonsError([{ type: 'QUICK_REPLY' }])).toMatch(/label/i)
  })

  it('names the offending button by position', () => {
    const err = templateButtonsError([quickReply('Fine'), quickReply('Bad 🔥')])
    expect(err).toContain('Button 2')
  })

  it('rejects a URL variable with no example value, and says why', () => {
    const err = templateButtonsError([{ type: 'URL', text: 'Shop', url: 'https://un1t.com/shop?promo={{1}}' }])
    expect(err).toMatch(/example value/i)
    expect(err).toMatch(/URL/i)
  })

  it('accepts a Meta-synced dynamic URL button that carries its example', () => {
    expect(templateButtonsError([
      { type: 'URL', text: 'Shop', url: 'https://un1t.com/shop?promo={{1}}', example: ['https://un1t.com/shop?promo=summer'] },
    ])).toBeNull()
  })

  it('holds Meta to one variable, at the end of the link', () => {
    expect(templateButtonsError([{ type: 'URL', text: 'Shop', url: 'https://un1t.com/{{1}}/x', example: ['a'] }])).toMatch(/very end/i)
    expect(templateButtonsError([{ type: 'URL', text: 'Shop', url: 'https://un1t.com/{{1}}/{{2}}', example: ['a'] }])).toMatch(/only one variable/i)
  })

  it('rejects a URL button with a missing or non-http URL', () => {
    expect(templateButtonsError([{ type: 'URL', text: 'Shop' }])).toMatch(/URL/i)
    expect(templateButtonsError([{ type: 'URL', text: 'Shop', url: 'un1t.com' }])).toMatch(/https?:\/\//i)
  })

  it('requires the per-type fields', () => {
    expect(templateButtonsError([{ type: 'PHONE_NUMBER', text: 'Call us' }])).toMatch(/phone number/i)
    expect(templateButtonsError([{ type: 'FLOW', text: 'Book', navigate_screen: 'PATH' }])).toMatch(/flow id/i)
    expect(templateButtonsError([{ type: 'FLOW', text: 'Book', flow_id: '123' }])).toMatch(/screen/i)
  })

  it("enforces Meta's per-type counts", () => {
    const url = (n) => ({ type: 'URL', text: `Link ${n}`, url: `https://un1t.com/${n}` })
    expect(templateButtonsError([url(1), url(2)])).toBeNull()
    expect(templateButtonsError([url(1), url(2), url(3)])).toMatch(/two URL buttons/i)
    const phone = (n) => ({ type: 'PHONE_NUMBER', text: `Call ${n}`, phone_number: '+35312345678' })
    expect(templateButtonsError([phone(1), phone(2)])).toMatch(/one phone/i)
    expect(templateButtonsError(Array.from({ length: 11 }, (_, i) => quickReply(`Reply ${i}`)))).toMatch(/10 buttons/i)
  })

  it('ignoreEmptyLabels skips a half-built button but still catches its neighbour', () => {
    const opts = { ignoreEmptyLabels: true }
    expect(templateButtonsError([{ type: 'URL', text: '' }], opts)).toBeNull()
    expect(templateButtonsError([quickReply('Fine'), quickReply('')], opts)).toBeNull()
    const err = templateButtonsError([quickReply(''), quickReply('Bad 🔥')], opts)
    expect(err).toMatch(/emoji/i)
    expect(err).toContain('Button 2')   // positions survive the skip
  })

  it('rejects an unknown button type', () => {
    expect(templateButtonsError([{ type: 'MAGIC', text: 'Hi' }])).toMatch(/MAGIC/)
  })
})

describe('componentsButtonsError — the server-side view of the same payload', () => {
  const body = { type: 'BODY', text: 'Hi there' }

  it('is silent for a template with no BUTTONS component', () => {
    expect(componentsButtonsError([body])).toBeNull()
    expect(componentsButtonsError([])).toBeNull()
    expect(componentsButtonsError(null)).toBeNull()
  })

  it('finds the offending button inside the components array', () => {
    expect(componentsButtonsError([body, { type: 'BUTTONS', buttons: [quickReply('Go 🔥')] }])).toMatch(/emoji/i)
  })

  it('rejects a BUTTONS component with no buttons array', () => {
    expect(componentsButtonsError([body, { type: 'BUTTONS' }])).toMatch(/buttons/i)
  })
})
