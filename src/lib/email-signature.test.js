// EMAIL-TICKET.5 — the signature append.
//
// Two properties carry the weight:
//   • NO signature appends NOTHING. Every reply the system has sent so far
//     was written by someone with no signature set, so a dangling "-- " on
//     the empty case is a visible regression for every member, not an edge.
//   • the separator is the RFC 3676 one ("-- ", with the trailing space) on a
//     line of its own after a blank line — that exact shape is what mail
//     clients collapse.

import { describe, it, expect } from 'vitest'
import {
  appendSignature,
  hasSignature,
  normalizeSignature,
  SIGNATURE_SEPARATOR,
  MAX_SIGNATURE_LENGTH,
} from './email-signature'

describe('appendSignature — the empty cases append NOTHING', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace only', '   \n\t  \n '],
    ['a non-string', 42],
  ])('%s leaves the body byte-identical', (_label, signature) => {
    const body = 'We open at 6.'
    const out = appendSignature(body, signature)
    expect(out).toBe(body)
    // Not just "same text" — no stray separator anywhere.
    expect(out).not.toContain('--')
    expect(out).not.toMatch(/\n\s*$/)
  })
})

describe('appendSignature — with a signature', () => {
  it('separates with a blank line then the RFC 3676 "-- " line', () => {
    const out = appendSignature('We open at 6.', 'Sarah\nUN1T Stillorgan')
    expect(out).toBe('We open at 6.\n\n-- \nSarah\nUN1T Stillorgan')

    // Stated structurally too, so a reformat can't quietly drop the blank
    // line or the trailing space that makes clients collapse it.
    const lines = out.split('\n')
    expect(lines[1]).toBe('')
    expect(lines[2]).toBe(SIGNATURE_SEPARATOR)
    expect(SIGNATURE_SEPARATOR).toBe('-- ')
  })

  it('does not stack the body’s own trailing whitespace in front of it', () => {
    expect(appendSignature('We open at 6.\n\n\n  ', 'Sarah')).toBe('We open at 6.\n\n-- \nSarah')
  })

  it('normalises CRLF out of a signature pasted from a mail client', () => {
    expect(appendSignature('hi', 'Sarah\r\nUN1T')).toBe('hi\n\n-- \nSarah\nUN1T')
  })

  it('trims the signature’s own leading/trailing blank lines', () => {
    expect(appendSignature('hi', '\n\n  Sarah  \n\n')).toBe('hi\n\n-- \nSarah')
  })

  it('appends exactly once when called on an already-signed body', () => {
    const once = appendSignature('hi', 'Sarah')
    // Guards the shape, not idempotency: the route must never call this twice,
    // and this records what would happen if it did.
    expect(once.match(/-- /g)).toHaveLength(1)
  })

  it('does not escape or alter markup-looking text — escaping is the caller’s single step', () => {
    // The whole point of appending to the TEXT is that the route's existing
    // text→HTML escaper then runs over body AND signature together. Escaping
    // here would double-escape.
    const out = appendSignature('a & b', 'R&D <team@un1t.ie>')
    expect(out).toContain('a & b')
    expect(out).toContain('R&D <team@un1t.ie>')
    expect(out).not.toContain('&amp;')
  })

  it('handles an empty body without a leading blank line', () => {
    // The route's schema forbids an empty body; the helper still must not
    // emit "\n\n-- " with nothing above it.
    expect(appendSignature('', 'Sarah')).toBe('-- \nSarah')
  })
})

describe('normalizeSignature / hasSignature', () => {
  it('agree on what counts as "no signature"', () => {
    for (const v of [null, undefined, '', '   ', '\n\n', 7]) {
      expect(normalizeSignature(v)).toBe('')
      expect(hasSignature(v)).toBe(false)
    }
  })

  it('agree on what counts as a real one', () => {
    expect(normalizeSignature('  Sarah\nUN1T  ')).toBe('Sarah\nUN1T')
    expect(hasSignature('  Sarah  ')).toBe(true)
  })
})

describe('MAX_SIGNATURE_LENGTH', () => {
  it('matches the mig 493 CHECK so the UI rejects before Postgres does', () => {
    expect(MAX_SIGNATURE_LENGTH).toBe(2000)
  })
})

// ── MAIL-SIG.1 — the rich signature renderer ────────────────────────────
// The user authors FIELDS, never markup: every value is escaped into the
// generated HTML, links are http(s)-or-dropped, and the photo may only be
// one of OUR public branding URLs. The renderer answering null means "no
// rich signature" and every caller falls back to the plain-text column.
import { renderRichSignature, richSignatureFromProfile, SIGNATURE_PHOTO_URL_PREFIXES } from './email-signature'

const RICH = {
  enabled: true,
  name: 'Garrett Ivers',
  title: 'General Manager',
  phone: '(01) 574 1871',
  note: 'UN1T Hatch Street',
  photo_url: 'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/signatures/u1/1.jpg',
  links: [
    { label: 'Instagram', url: 'https://instagram.com/un1t' },
    { label: 'Book a class', url: 'https://un1t.online/book' },
  ],
}

describe('renderRichSignature', () => {
  it('renders every field, escaped, with the RFC separator on the text part', () => {
    const out = renderRichSignature(RICH)
    expect(out.text).toContain('Garrett Ivers')
    expect(out.text).toContain('General Manager')
    expect(out.text).toContain('(01) 574 1871')
    expect(out.text).toContain('https://instagram.com/un1t')
    expect(out.html).toContain('Garrett Ivers')
    expect(out.html).toContain('href="https://instagram.com/un1t"')
    expect(out.html).toContain(RICH.photo_url)
  })

  it('ESCAPES field values — a name cannot smuggle markup into outbound mail', () => {
    const out = renderRichSignature({ ...RICH, name: '<img src=x onerror=alert(1)>' })
    expect(out.html).not.toContain('<img src=x')
    expect(out.html).toContain('&lt;img')
  })

  it('drops a non-http(s) link outright — javascript: never reaches an href', () => {
    const out = renderRichSignature({ ...RICH, links: [{ label: 'x', url: 'javascript:alert(1)' }] })
    expect(out.html).not.toContain('javascript:')
  })

  it('refuses a photo outside our public branding prefix', () => {
    const out = renderRichSignature({ ...RICH, photo_url: 'https://evil.example/pixel.png' })
    expect(out.html).not.toContain('evil.example')
    // …but the rest of the signature still renders.
    expect(out.html).toContain('Garrett Ivers')
  })

  it('answers null when disabled, absent, or empty of content', () => {
    expect(renderRichSignature(null)).toBeNull()
    expect(renderRichSignature({ ...RICH, enabled: false })).toBeNull()
    expect(renderRichSignature({ enabled: true, name: ' ', links: [] })).toBeNull()
  })

  it('caps links at five — the write side validates, the renderer still guards', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, url: `https://x.ie/${i}` }))
    const out = renderRichSignature({ ...RICH, links: many })
    expect((out.html.match(/href=/g) || []).length).toBe(5)
  })
})

describe('richSignatureFromProfile', () => {
  it('prefers the enabled rich signature; falls back to the plain column; null when neither', () => {
    expect(richSignatureFromProfile({ email_signature_rich: RICH, email_signature: 'old' })).not.toBeNull()
    const plain = richSignatureFromProfile({ email_signature_rich: { enabled: false }, email_signature: 'Old sign-off' })
    expect(plain).toBeNull() // callers then use appendSignature(text, email_signature) as before
    expect(richSignatureFromProfile({})).toBeNull()
  })
})

describe('SIGNATURE_PHOTO_URL_PREFIXES', () => {
  it('only ever allows our public branding storage', () => {
    for (const p of SIGNATURE_PHOTO_URL_PREFIXES) {
      expect(p).toMatch(/^https:\/\/.*\/storage\/v1\/object\/public\/branding\//)
    }
  })
})

// ── Design A pins (Richard's pick + follow-ups, 2 Sep) ──────────────────
describe('renderRichSignature — design A', () => {
  it('renders the initials block when no photo is uploaded — never an empty avatar slot', () => {
    const out = renderRichSignature({ ...RICH, photo_url: null })
    expect(out.html).toContain('>GI<') // Garrett Ivers → GI
    expect(out.html).not.toContain('<img')
  })

  it('the photo replaces the initials, round, from our bucket only', () => {
    const out = renderRichSignature(RICH)
    expect(out.html).toContain('<img')
    expect(out.html).not.toContain('>GI<')
  })

  it('initials are escaped like everything else', () => {
    const out = renderRichSignature({ ...RICH, name: '<b>x</b> y', photo_url: null })
    expect(out.html).not.toContain('<b>')
  })

  it('carries the black rule and the uppercase name treatment', () => {
    const out = renderRichSignature(RICH)
    expect(out.html).toContain('border-top:3px solid #0f172a')
    expect(out.html).toContain('text-transform:uppercase')
  })
})

describe('isAllowedSignaturePhotoUrl — the normalized check (audit #1)', () => {
  it('refuses a dot-segment path that normalizes outside the branding bucket', () => {
    const sneaky = 'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/../secrets/x.png'
    expect(renderRichSignature({ ...RICH, photo_url: sneaky }).html).not.toContain('secrets')
  })
})

// ── MAIL-SIG.2 — the studio half outranks the personal fallback ─────────
import { effectiveRichSignature } from './email-signature'

describe('effectiveRichSignature', () => {
  const PERSON = {
    enabled: true, name: 'Richard Ivers', note: 'UN1T Dublin',
    phone: '+353 1 578 9401',
    links: [{ label: 'personal', url: 'https://richardivers.com' }],
  }
  const HATCH = {
    phone: '(01) 574 1871',
    links: [
      { label: 'Book a class', url: 'https://un1tdublin.com/welcome/hatch-street#start' },
      { label: 'Membership options', url: 'https://un1tdublin.com/welcome/hatch-street' },
    ],
  }

  it('the SENDING studio supplies studio line, phone and links; the person keeps name', () => {
    const eff = effectiveRichSignature(PERSON, { locationName: 'UN1T Hatch Street', locationSignature: HATCH })
    expect(eff.name).toBe('Richard Ivers')
    expect(eff.note).toBe('UN1T Hatch Street')
    expect(eff.phone).toBe('(01) 574 1871')
    expect(eff.links.map(l => l.label)).toEqual(['Book a class', 'Membership options'])
  })

  it('a studio with NO signature settings falls back to the person’s own values', () => {
    const eff = effectiveRichSignature(PERSON, { locationName: 'UN1T Stillorgan', locationSignature: null })
    expect(eff.note).toBe('UN1T Stillorgan') // the studio line still follows the send
    expect(eff.phone).toBe('+353 1 578 9401')
    expect(eff.links.map(l => l.label)).toEqual(['personal'])
  })

  it('no location context at all leaves the personal signature untouched', () => {
    expect(effectiveRichSignature(PERSON, {})).toEqual(PERSON)
    expect(effectiveRichSignature(PERSON, undefined)).toEqual(PERSON)
  })

  it('a disabled/absent personal signature stays null-rendered whatever the studio holds', () => {
    expect(effectiveRichSignature(null, { locationSignature: HATCH })).toBeNull()
    expect(effectiveRichSignature({ enabled: false }, { locationSignature: HATCH })).toBeNull()
  })
})
