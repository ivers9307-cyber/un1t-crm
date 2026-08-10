import { describe, it, expect } from 'vitest'
import {
  templateButtonsError, componentsButtonsError,
  dynamicUrlButtonIndex, urlButtonSendBlock, URL_BUTTON_MAPPING_KEY, normalizeButtonsForMeta,
} from './whatsapp-template-buttons.js'

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
    expect(err).toMatch(/sample value/i)
    expect(err).toMatch(/URL|link/i)
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

describe('dynamicUrlButtonIndex', () => {
  const btns = (buttons) => [{ type: 'BODY', text: 'Hi' }, { type: 'BUTTONS', buttons }]

  it('finds the position of a URL button whose link ends in a variable', () => {
    expect(dynamicUrlButtonIndex(btns([
      { type: 'QUICK_REPLY', text: 'No thanks' },
      { type: 'URL', text: 'Shop', url: 'https://un1t.com/shop?promo={{1}}', example: ['summer'] },
    ]))).toBe(1)
  })

  it('is -1 for a fixed URL, no buttons, or no components', () => {
    expect(dynamicUrlButtonIndex(btns([{ type: 'URL', text: 'Book', url: 'https://un1t.com/book' }]))).toBe(-1)
    expect(dynamicUrlButtonIndex([{ type: 'BODY', text: 'Hi' }])).toBe(-1)
    expect(dynamicUrlButtonIndex(null)).toBe(-1)
  })
})

describe('urlButtonSendBlock — refuse the send rather than let Meta reject each message', () => {
  const dynamic = { components: [{ type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Shop', url: 'https://un1t.com/s?p={{1}}', example: ['x'] }] }] }
  const fixed = { components: [{ type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Book', url: 'https://un1t.com/book' }] }] }

  it('blocks when the link variable has no mapped value', () => {
    const block = urlButtonSendBlock(dynamic, {})
    expect(block).toMatch(/link/i)
    expect(block).toContain('Shop')
  })

  it('blocks on a blank or whitespace-only value', () => {
    expect(urlButtonSendBlock(dynamic, { [URL_BUTTON_MAPPING_KEY]: '   ' })).toBeTruthy()
  })

  it('passes once a value is mapped', () => {
    expect(urlButtonSendBlock(dynamic, { [URL_BUTTON_MAPPING_KEY]: 'summer2026' })).toBeNull()
    expect(urlButtonSendBlock(dynamic, { [URL_BUTTON_MAPPING_KEY]: 'id' })).toBeNull()
  })

  it('never blocks a template without a dynamic URL button', () => {
    expect(urlButtonSendBlock(fixed, {})).toBeNull()
    expect(urlButtonSendBlock({ components: [] }, {})).toBeNull()
    expect(urlButtonSendBlock(null, null)).toBeNull()
  })
})

describe('normalizeButtonsForMeta', () => {
  it('keeps the example on a genuinely dynamic URL button', () => {
    const btns = [{ type: 'URL', text: 'Shop', url: 'https://un1t.com/s?p={{1}}', example: ['summer'] }]
    expect(normalizeButtonsForMeta(btns)).toEqual(btns)
  })

  it('drops a stale example once the variable leaves the link', () => {
    const out = normalizeButtonsForMeta([{ type: 'URL', text: 'Shop', url: 'https://un1t.com/shop', example: ['summer'] }])
    expect(out[0]).toEqual({ type: 'URL', text: 'Shop', url: 'https://un1t.com/shop' })
    expect('example' in out[0]).toBe(false)
  })

  it('drops a blank example and normalises a scalar one to an array', () => {
    expect('example' in normalizeButtonsForMeta([{ type: 'URL', text: 'S', url: 'https://u.com/{{1}}', example: ['  '] }])[0]).toBe(false)
    expect(normalizeButtonsForMeta([{ type: 'URL', text: 'S', url: 'https://u.com/{{1}}', example: 'x' }])[0].example).toEqual(['x'])
  })

  it('passes a well-formed button of each type through unchanged', () => {
    const btns = [{ type: 'QUICK_REPLY', text: 'Yes' }, { type: 'FLOW', text: 'Book', flow_id: '1', navigate_screen: 'PATH' }]
    expect(normalizeButtonsForMeta(btns)).toEqual(btns)
    expect(normalizeButtonsForMeta()).toEqual([])
  })

  it('drops fields left behind when the operator switches a button type', () => {
    // Typed a URL + sample, then switched the type to Quick Reply.
    expect(normalizeButtonsForMeta([
      { type: 'QUICK_REPLY', text: 'No thanks', url: 'https://un1t.com/x?c={{1}}', example: ['summer'] },
    ])).toEqual([{ type: 'QUICK_REPLY', text: 'No thanks' }])
    expect(normalizeButtonsForMeta([
      { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+35312345678', flow_id: 'F1' },
    ])).toEqual([{ type: 'PHONE_NUMBER', text: 'Call', phone_number: '+35312345678' }])
  })

  it('keeps COPY_CODE examples and Meta-synced flow_action', () => {
    expect(normalizeButtonsForMeta([{ type: 'COPY_CODE', text: 'Copy', example: ['UN1T20'] }])[0].example).toEqual(['UN1T20'])
    const flow = { type: 'FLOW', text: 'Book', flow_id: 1343015528022374, flow_action: 'NAVIGATE', navigate_screen: 'PATH' }
    expect(normalizeButtonsForMeta([flow])).toEqual([flow])
  })

  it('leaves an unknown type alone for the validator to name', () => {
    expect(normalizeButtonsForMeta([{ type: 'MAGIC', text: 'Hi' }])).toEqual([{ type: 'MAGIC', text: 'Hi' }])
  })
})
