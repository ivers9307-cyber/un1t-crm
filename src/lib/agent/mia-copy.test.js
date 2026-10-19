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
