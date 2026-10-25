// MIAHATCH.2 — Mia's operator-editable Hatch copy (mia-copy.js): an operator
// value wins, else the code default; a `without` branch for a missing var.
import { describe, it, expect } from 'vitest'
import { MIA_HATCH_COPY, renderMiaCopy } from './mia-copy'
import { DEFAULTS } from './settings-contract'
import { INHERITABLE_SCALAR_KEYS } from './settings-overrides'

const KEY = 'chat_booking_unavailable_text'
const vars = { studio: 'UN1T Hatch Street', link: 'https://hatch.example.test/book' }

describe('MIA_HATCH_COPY', () => {
  it('chat_booking_unavailable_text: the two defaults exactly', () => {
    expect(MIA_HATCH_COPY[KEY]).toEqual({
      text: "I can't book classes at {studio} from here just yet. You can book here: {link}",
      without: { var: 'link', text: "I can't book classes at {studio} from here just yet. The team will help you book." },
    })
  })

  it('no default contains U+2014 or U+2013', () => {
    for (const [key, entry] of Object.entries(MIA_HATCH_COPY)) {
      expect(entry.text, key).not.toMatch(/[—–]/)
      if (entry.without) expect(entry.without.text, key).not.toMatch(/[—–]/)
    }
  })

  it('every key is a settings key the org may supply', () => {
    for (const key of Object.keys(MIA_HATCH_COPY)) {
      expect(DEFAULTS, key).toHaveProperty(key, null)
      expect(INHERITABLE_SCALAR_KEYS, key).toContain(key)
    }
  })
})

// MIAHATCH.4 (spec 6.6) — the slice-2 keys, exact.
const SLICE2_DEFAULTS = {
  purchase_offer_intro_text: "You've used all your classes. Here's how to keep training with us:",
  purchase_link_text: "Here's your secure payment link for {product}. Once it goes through I'll book you into {class}.",
  trial_used_text: "It looks like you've had your free trial with us before, so here are the ways to keep training:",
  refund_request_text: "I've passed that to the team, they'll look at it and get back to you.",
  purchase_link_open_text: "You already have a payment link waiting for {product}. I've asked the team to help you switch, they'll be in touch shortly.",
  purchase_paid_booked_text: "Payment received, thank you! You're booked into {class}. See you there.",
  purchase_paid_class_gone_text: "Payment received, thank you! {class} is no longer available, so I haven't booked it. Reply here and I'll find you another class.",
  purchase_paid_booking_failed_text: "Payment received, thank you! I couldn't book {class} just now, so the team will sort it and confirm with you shortly.",
  purchase_paid_no_class_text: "Payment received, thank you! It's on your account now. Would you like me to book you a class?",
  pay_done_page_text: 'Thanks! You can go back to WhatsApp now.',
  pay_cancel_page_text: 'No problem, nothing was charged. You can go back to WhatsApp.',
}

describe('MIAHATCH.4 slice-2 copy', () => {
  it('defaults exactly as listed', () => {
    for (const [key, text] of Object.entries(SLICE2_DEFAULTS)) expect(MIA_HATCH_COPY[key]?.text, key).toBe(text)
    expect(MIA_HATCH_COPY.purchase_link_text.without).toEqual({
      var: 'class',
      text: "Here's your secure payment link for {product}. I'll let you know when it's done.",
    })
  })

  it('each key is a null setting the org may supply, with no dash in any default', () => {
    for (const key of Object.keys(SLICE2_DEFAULTS)) {
      expect(DEFAULTS, key).toHaveProperty(key, null)
      expect(INHERITABLE_SCALAR_KEYS, key).toContain(key)
      expect(MIA_HATCH_COPY[key].text, key).not.toMatch(/[—–]/)
    }
    expect(MIA_HATCH_COPY.purchase_link_text.without.text).not.toMatch(/[—–]/)
  })

  it('purchase_link_text with a class names product and class', () => {
    expect(renderMiaCopy('purchase_link_text', {}, { product: '10 class pack', class: 'Strength, Mon 7am' }))
      .toBe("Here's your secure payment link for 10 class pack. Once it goes through I'll book you into Strength, Mon 7am.")
  })

  it('renderMiaCopy without class picks the no-class default', () => {
    for (const cls of [undefined, null, '  ']) {
      expect(renderMiaCopy('purchase_link_text', {}, { product: '10 class pack', class: cls }))
        .toBe("Here's your secure payment link for 10 class pack. I'll let you know when it's done.")
    }
  })

  it('without class, an operator text that needs {class} is not used; one that does not is', () => {
    expect(renderMiaCopy('purchase_link_text', { purchase_link_text: 'Pay {product}, then {class}.' }, { product: 'Pack' }))
      .toBe("Here's your secure payment link for Pack. I'll let you know when it's done.")
    expect(renderMiaCopy('purchase_link_text', { purchase_link_text: 'Pay for {product} here.' }, { product: 'Pack' }))
      .toBe('Pay for Pack here.')
  })

  it('the paid and page texts fill {class} and take an operator value', () => {
    expect(renderMiaCopy('purchase_paid_booked_text', {}, { class: 'Strength, Mon 7am' }))
      .toBe("Payment received, thank you! You're booked into Strength, Mon 7am. See you there.")
    expect(renderMiaCopy('pay_done_page_text', { pay_done_page_text: 'All done \u2014 back to WhatsApp.' }, {}))
      .toBe('All done, back to WhatsApp.')
    expect(renderMiaCopy('pay_cancel_page_text', {}, {})).toBe('No problem, nothing was charged. You can go back to WhatsApp.')
  })
})

describe('renderMiaCopy', () => {
  it('no operator value: the default with vars filled in', () => {
    expect(renderMiaCopy(KEY, {}, vars))
      .toBe("I can't book classes at UN1T Hatch Street from here just yet. You can book here: https://hatch.example.test/book")
    expect(renderMiaCopy(KEY, null, vars))
      .toBe("I can't book classes at UN1T Hatch Street from here just yet. You can book here: https://hatch.example.test/book")
  })

  it('an operator value wins and is filled the same way', () => {
    const settings = { [KEY]: 'Booking at {studio} is online only for now: {link}' }
    expect(renderMiaCopy(KEY, settings, vars)).toBe('Booking at UN1T Hatch Street is online only for now: https://hatch.example.test/book')
  })

  it('a blank operator value is no value', () => {
    expect(renderMiaCopy(KEY, { [KEY]: '   ' }, vars)).toContain('You can book here: https://hatch.example.test/book')
  })

  it('without the link: the no-link default', () => {
    expect(renderMiaCopy(KEY, {}, { studio: 'UN1T Hatch Street', link: null }))
      .toBe("I can't book classes at UN1T Hatch Street from here just yet. The team will help you book.")
    expect(renderMiaCopy(KEY, {}, { studio: 'UN1T Hatch Street', link: '  ' }))
      .toBe("I can't book classes at UN1T Hatch Street from here just yet. The team will help you book.")
    expect(renderMiaCopy(KEY, {}, { studio: 'UN1T Hatch Street' }))
      .toBe("I can't book classes at UN1T Hatch Street from here just yet. The team will help you book.")
  })

  it('without the link: an operator value that needs {link} is not used', () => {
    const settings = { [KEY]: 'Book {studio} here: {link}' }
    expect(renderMiaCopy(KEY, settings, { studio: 'UN1T Hatch Street', link: '' }))
      .toBe("I can't book classes at UN1T Hatch Street from here just yet. The team will help you book.")
  })

  it('without the link: an operator value that does not need it is used', () => {
    const settings = { [KEY]: 'The {studio} team will book you in.' }
    expect(renderMiaCopy(KEY, settings, { studio: 'UN1T Hatch Street', link: null })).toBe('The UN1T Hatch Street team will book you in.')
  })

  it('scrubs em and en dashes out of an operator value', () => {
    const settings = { [KEY]: 'Not from chat — book at {studio} – here: {link}' }
    const out = renderMiaCopy(KEY, settings, vars)
    expect(out).not.toMatch(/[—–]/)
    expect(out).toBe('Not from chat, book at UN1T Hatch Street, here: https://hatch.example.test/book')
  })

  it('a placeholder with no var leaves nothing behind', () => {
    const settings = { [KEY]: 'Hi {name}, book {studio} here: {link}' }
    expect(renderMiaCopy(KEY, settings, vars)).toBe('Hi, book UN1T Hatch Street here: https://hatch.example.test/book')
  })

  it('an unknown key is an empty string', () => {
    expect(renderMiaCopy('not_a_key', {}, vars)).toBe('')
  })
})
