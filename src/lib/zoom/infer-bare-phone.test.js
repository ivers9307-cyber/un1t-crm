import { describe, it, expect } from 'vitest'
import { inferBarePhone, inferAll, isBareNoCountryCode } from './infer-bare-phone.js'
import { normaliseForZoom } from './normalise-phone.js'

const row = (over = {}) => ({ id: 'c1', first_name: 'Ada', last_name: 'Byron', email: 'ada@example.com', phone: null, ...over })

describe('isBareNoCountryCode — mirrors the ZOOMSYNC.2 reject', () => {
  it('claims the 8- and 10-digit bare shapes', () => {
    expect(isBareNoCountryCode('3475717693')).toBe(true) // 10, US missing +1
    expect(isBareNoCountryCode('6978291516')).toBe(true) // 10, the Greek row
    expect(isBareNoCountryCode('12345678')).toBe(true)   // 8
    expect(isBareNoCountryCode('347 571 7693')).toBe(true) // separators tolerated
  })

  it('leaves alone everything the normaliser can already map', () => {
    expect(isBareNoCountryCode('+13475717693')).toBe(false) // already E.164
    expect(isBareNoCountryCode('0871234567')).toBe(false)   // IE national, trunk zero
    expect(isBareNoCountryCode('871234567')).toBe(false)    // 9-digit bare → +353…
    expect(isBareNoCountryCode('353871234567')).toBe(false) // already country-coded
    expect(isBareNoCountryCode('07911123456')).toBe(false)  // UK national
    expect(isBareNoCountryCode('not a phone')).toBe(false)
    expect(isBareNoCountryCode(null)).toBe(false)
  })

  // The whole population this module exists for is, by definition, the set the
  // live normaliser refuses. If these ever disagree the triage is aimed at the
  // wrong rows.
  it('agrees with normaliseForZoom: in-scope ⇒ rejected', () => {
    for (const p of ['3475717693', '6978291516', '3128291516', '12345678', '31712345678'.slice(0, 10)]) {
      expect(isBareNoCountryCode(p)).toBe(true)
      expect(normaliseForZoom(p)).toBeNull()
    }
  })

  it('agrees with normaliseForZoom: out-of-scope ⇒ accepted', () => {
    for (const p of ['0871234567', '871234567', '+13475717693', '353871234567']) {
      expect(isBareNoCountryCode(p)).toBe(false)
      expect(normaliseForZoom(p)).not.toBeNull()
    }
  })
})

describe('derived — country code read off a number we already hold', () => {
  it('uses contacts.wa_phone when it ends with the stored digits', () => {
    const r = inferBarePhone(row({ phone: '3475717693', wa_phone: '+13475717693' }))
    expect(r.tier).toBe('derived')
    expect(r.e164).toBe('+13475717693')
    expect(r.reason).toMatch(/not guessed/)
  })

  it('falls back to a WhatsApp thread number', () => {
    const r = inferBarePhone(row({ phone: '3475717693' }), ['+13475717693'])
    expect(r.tier).toBe('derived')
    expect(r.e164).toBe('+13475717693')
    expect(r.evidence[0]).toMatch(/whatsapp_conversations/)
  })

  // The repair is the known-good number itself, so an odd-length remainder
  // still yields the right answer rather than an assembled prefix.
  it('returns the stored E.164 verbatim even when the remainder is not 1–3 digits', () => {
    const r = inferBarePhone(row({ phone: '71234567', wa_phone: '+353871234567' }))
    expect(r.tier).toBe('derived')
    expect(r.e164).toBe('+353871234567')
  })

  it('ignores a wa_phone that is a different number', () => {
    const r = inferBarePhone(row({ phone: '3475717693', wa_phone: '+353871234567' }))
    expect(r.tier).not.toBe('derived')
  })

  it('derivation beats shape — it never needs corroboration', () => {
    const r = inferBarePhone(row({ phone: '3475717693', email: 'ada@example.ie', wa_phone: '+13475717693' }))
    expect(r.tier).toBe('derived') // .ie email does not veto a number we hold
  })
})

describe('the Greek row that started ZOOMSYNC.2', () => {
  it('never reads 697 as a NANP area code', () => {
    const r = inferBarePhone(row({ phone: '6978291516' }))
    expect(r.e164).not.toBe('+16978291516')
    expect(r.evidence.some(e => e.includes('+1'))).toBe(false)
  })

  it('is corroborated to +30 by a .gr email', () => {
    const r = inferBarePhone(row({ phone: '6978291516', email: 'nikos@example.gr' }))
    expect(r.tier).toBe('corroborated')
    expect(r.e164).toBe('+306978291516')
  })

  it('stays ambiguous with nothing to corroborate it', () => {
    const r = inferBarePhone(row({ phone: '6978291516', email: 'nikos@gmail.com' }))
    expect(r.tier).toBe('ambiguous')
    expect(r.e164).toBeNull()
  })
})

describe('corroborated — shape plus an independent signal', () => {
  it('accepts an assigned NANP area code seconded by USD', () => {
    const r = inferBarePhone(row({ phone: '3128291516', lifetime_currency: 'USD' }))
    expect(r.tier).toBe('corroborated')
    expect(r.e164).toBe('+13128291516')
  })

  it.each(['312', '347', '317', '310'])('recognises sampled area code %s', code => {
    const r = inferBarePhone(row({ phone: `${code}5717693`.padEnd(10, '0').slice(0, 10), lifetime_currency: 'USD' }))
    expect(r.e164).toBe(`+1${`${code}5717693`.padEnd(10, '0').slice(0, 10)}`)
  })
})

describe('ambiguous — the safe default', () => {
  it('refuses a NANP shape with nothing behind it', () => {
    const r = inferBarePhone(row({ phone: '3475717693', email: 'ada@gmail.com' }))
    expect(r.tier).toBe('ambiguous')
    expect(r.e164).toBeNull()
    expect(r.reason).toMatch(/nothing independent corroborates/)
  })

  it('refuses when context contradicts the shape — the wrong-number failure mode', () => {
    const r = inferBarePhone(row({ phone: '3475717693', email: 'sean@example.ie' }))
    expect(r.tier).toBe('ambiguous')
    expect(r.e164).toBeNull()
    expect(r.conflicts[0]).toMatch(/\+353/)
  })

  it('refuses an unassigned area code even with USD', () => {
    const r = inferBarePhone(row({ phone: '6978291516', lifetime_currency: 'USD' }))
    expect(r.tier).toBe('ambiguous') // 697 unassigned ⇒ no +1 hypothesis to corroborate
  })

  it('refuses a shape no country claims', () => {
    expect(inferBarePhone(row({ phone: '22345678', lifetime_currency: 'EUR' })).tier).toBe('ambiguous')
  })
})

describe('8-digit Dublin landline shape', () => {
  it('is corroborated by EUR', () => {
    const r = inferBarePhone(row({ phone: '12345678', lifetime_currency: 'EUR' }))
    expect(r.tier).toBe('corroborated')
    expect(r.e164).toBe('+35312345678')
  })

  it('stays ambiguous on its own', () => {
    expect(inferBarePhone(row({ phone: '12345678' })).tier).toBe('ambiguous')
  })
})

describe('out-of-scope rows are passed over', () => {
  it.each([['+13475717693'], ['0871234567'], ['871234567'], [null], ['ada@example.com']])('%s', phone => {
    expect(inferBarePhone(row({ phone })).tier).toBe('out-of-scope')
  })
})

describe('inferAll', () => {
  it('classifies a batch and threads WhatsApp numbers by contact id', () => {
    const rows = [
      row({ id: 'a', phone: '3475717693' }),
      row({ id: 'b', phone: '6978291516', email: 'n@example.gr' }),
      row({ id: 'c', phone: '+353871234567' }),
    ]
    const out = inferAll(rows, { a: ['+13475717693'] })
    expect(out.map(o => o.tier)).toEqual(['derived', 'corroborated', 'out-of-scope'])
  })

  it('tolerates an empty input', () => {
    expect(inferAll(null)).toEqual([])
  })
})

// Nothing this module proposes may itself be un-syncable — a repair that the
// normaliser would reject again is not a repair.
describe('every proposal round-trips through normaliseForZoom', () => {
  it('holds for derived and corroborated rows', () => {
    const proposals = [
      inferBarePhone(row({ phone: '3475717693', wa_phone: '+13475717693' })),
      inferBarePhone(row({ phone: '6978291516', email: 'n@example.gr' })),
      inferBarePhone(row({ phone: '3128291516', lifetime_currency: 'USD' })),
      inferBarePhone(row({ phone: '12345678', lifetime_currency: 'EUR' })),
    ]
    for (const p of proposals) {
      expect(p.e164).not.toBeNull()
      expect(normaliseForZoom(p.e164)).toBe(p.e164)
    }
  })
})
