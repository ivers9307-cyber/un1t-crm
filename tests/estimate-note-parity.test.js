// UN1TRADAR.2 — the phone cannot import src/lib, so its estimate note is a
// copy of the web's. They must say the same thing.
import { describe, it, expect } from 'vitest'
import { ESTIMATE_NOTE as WEB, AMOUNT_UNAVAILABLE as WEB_NONE, amountOrUnavailable as webAmount } from '../src/lib/radar-copy'
import { ESTIMATE_NOTE as PHONE, AMOUNT_UNAVAILABLE as PHONE_NONE, amountOrUnavailable as phoneAmount } from '../mobile/lib/arrears-estimate-label'

describe('estimate note parity', () => {
  it('web and phone say the same words', () => expect(PHONE).toBe(WEB))
  it('web and phone print the same "no amount" words', () => expect(PHONE_NONE).toBe(WEB_NONE))
  it('web and phone decide "no known amount" by the same rule', () => {
    const fmt = (c) => `F${c}`
    const cases = [
      [0, { estimated: true }], [0, { unknown: true }], [null, { estimated: true }], [-5, { estimated: true }],
      [1, { estimated: true }], [16500, { unknown: true }], [0, {}], [0, undefined], [16500, {}],
    ]
    for (const [c, flags] of cases) expect(phoneAmount(c, flags, fmt)).toBe(webAmount(c, flags, fmt))
  })
})
