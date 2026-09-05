// MOBILE-SIGHINT.1 — the tested unit. These two screens (the reply thread
// and the compose sheet) have no render-test harness in this repo, so every
// branch that decides WHAT THE PHONE CLAIMS IT IS ABOUT TO SIGN lives in the
// pure helper and is pinned here.
//
// THE PROPERTIES THIS FILE EXISTS FOR:
//   1. `effective_text: null` HIDES. A hint that renders the raw entry
//      instead would promise a sign-off on an email that appends none.
//   2. The requested STUDIO's entry, never the first one. "The first
//      context" would sign a Stillorgan reply with Hatch Street's phone.
//   3. '' + rich renders the rich line and NO "-- " separator — the send
//      appends no separator for a photo-only block, so neither may the hint.
// Each is a documented mutation in the contract; each fails a test below.
//
// The fixtures are the WIRE shape — `signature_contexts` exactly as
// GET /api/me/preferences serves it, already server-rendered. Nothing here
// resolves a signature, because nothing in mobile may (CLAUDE.md
// Web/mobile boundary; see the module header).

import { describe, it, expect } from 'vitest'
import { resolveSignatureHint, richSuffix, SIGNATURE_SEPARATOR } from './signature-hint'

const STILL = 'a0000000-0000-0000-0000-000000000001'
const HATCH = 'a0000000-0000-0000-0000-000000000002'

/** One wire entry, defaults being the common plain-text case. */
function ctx(over = {}) {
  return {
    location_id: STILL,
    location_name: 'UN1T Stillorgan',
    studio_signature: null,
    has_mailbox: true,
    effective_text: 'Sarah Byrne\nUN1T Stillorgan\n01 555 0100',
    rich: false,
    has_photo: false,
    has_links: false,
    ...over,
  }
}

describe('resolveSignatureHint — matching the SENDING studio', () => {
  it('returns the entry for the requested location', () => {
    const hint = resolveSignatureHint([ctx()], STILL)
    expect(hint).toMatchObject({
      text: 'Sarah Byrne\nUN1T Stillorgan\n01 555 0100',
      rich: false,
      hasPhoto: false,
      hasLinks: false,
      suffix: null,
    })
    expect(hint.body).toBe('-- \nSarah Byrne\nUN1T Stillorgan\n01 555 0100')
  })

  it('picks the requested studio, NOT the first entry — a reply must never carry the other studio’s details', () => {
    const contexts = [
      ctx({ effective_text: 'Sarah Byrne\nUN1T Stillorgan\n01 555 0100' }),
      ctx({
        location_id: HATCH,
        location_name: 'UN1T Hatch Street',
        effective_text: 'Sarah Byrne\nUN1T Hatch Street\n01 555 0200',
      }),
    ]
    expect(resolveSignatureHint(contexts, HATCH).text).toBe('Sarah Byrne\nUN1T Hatch Street\n01 555 0200')
    expect(resolveSignatureHint(contexts, STILL).text).toBe('Sarah Byrne\nUN1T Stillorgan\n01 555 0100')
  })

  it('hides when the caller holds no context for that studio', () => {
    expect(resolveSignatureHint([ctx()], HATCH)).toBeNull()
  })

  it('hides with no location — a compose with no From account has nothing truthful to preview', () => {
    expect(resolveSignatureHint([ctx()], null)).toBeNull()
    expect(resolveSignatureHint([ctx()], undefined)).toBeNull()
    expect(resolveSignatureHint([ctx()], '')).toBeNull()
  })
})

describe('resolveSignatureHint — the three-value effective_text contract', () => {
  it('effective_text null HIDES: nothing will be appended, so nothing is promised', () => {
    expect(resolveSignatureHint([ctx({ effective_text: null })], STILL)).toBeNull()
  })

  it('a missing or non-string effective_text hides too — degraded is not "signs nothing extra"', () => {
    const bare = { location_id: STILL, location_name: 'UN1T Stillorgan' }
    expect(resolveSignatureHint([bare], STILL)).toBeNull()
    expect(resolveSignatureHint([ctx({ effective_text: 42 })], STILL)).toBeNull()
    expect(resolveSignatureHint([ctx({ effective_text: { text: 'x' } })], STILL)).toBeNull()
  })

  it('a plain string shows the separator block and no rich line', () => {
    const hint = resolveSignatureHint([ctx({ effective_text: 'Alex' })], STILL)
    expect(hint.body).toBe('-- \nAlex')
    expect(hint.rich).toBe(false)
    expect(hint.suffix).toBeNull()
  })

  it('preserves the server text VERBATIM — no trimming, no re-wrapping, no resolution', () => {
    const odd = '  Sarah  \n\n\nUN1T Stillorgan  '
    expect(resolveSignatureHint([ctx({ effective_text: odd })], STILL).text).toBe(odd)
  })
})

describe('resolveSignatureHint — the photo-only rich block', () => {
  const photoOnly = ctx({ effective_text: '', rich: true, has_photo: true, has_links: false })

  it("'' + rich SHOWS — an HTML-only block still goes out", () => {
    expect(resolveSignatureHint([photoOnly], STILL)).not.toBeNull()
  })

  it("'' + rich renders NO separator block — the send appends none", () => {
    const hint = resolveSignatureHint([photoOnly], STILL)
    expect(hint.text).toBe('')
    expect(hint.body).toBeNull()
    expect(hint.suffix).toBe('The email carries the rich layout — photo included.')
  })

  it("'' with NO rich block hides — an empty labelled box would be its own lie", () => {
    expect(resolveSignatureHint([ctx({ effective_text: '', rich: false })], STILL)).toBeNull()
  })

  it('a rich signature WITH text carries both the separator block and the suffix', () => {
    const hint = resolveSignatureHint(
      [ctx({ effective_text: 'Sarah Byrne\nUN1T Stillorgan', rich: true, has_photo: true, has_links: true })],
      STILL,
    )
    expect(hint.body).toBe('-- \nSarah Byrne\nUN1T Stillorgan')
    expect(hint.suffix).toBe('The email carries the rich layout — photo and links included.')
  })
})

describe('resolveSignatureHint — the suffix names what THIS studio sends', () => {
  const rich = over => resolveSignatureHint([ctx({ effective_text: 'Sarah', rich: true, ...over })], STILL)

  it('photo + links', () => {
    expect(rich({ has_photo: true, has_links: true }).suffix)
      .toBe('The email carries the rich layout — photo and links included.')
  })
  it('photo only — never promises links', () => {
    expect(rich({ has_photo: true, has_links: false }).suffix)
      .toBe('The email carries the rich layout — photo included.')
  })
  it('links only — never promises a photo', () => {
    expect(rich({ has_photo: false, has_links: true }).suffix)
      .toBe('The email carries the rich layout — links included.')
  })
  it('neither', () => {
    expect(rich({ has_photo: false, has_links: false }).suffix)
      .toBe('The email carries the rich layout.')
  })

  it('richSuffix is total — it never throws on a missing pair', () => {
    expect(richSuffix()).toBe('The email carries the rich layout.')
    expect(richSuffix({})).toBe('The email carries the rich layout.')
  })

  it('the flags are read strictly — a truthy non-true value is not a promise', () => {
    const hint = resolveSignatureHint(
      [ctx({ effective_text: 'Sarah', rich: 'yes', has_photo: 1, has_links: 'x' })],
      STILL,
    )
    // `rich` was not literally true, so this is the plain path: no suffix.
    expect(hint.rich).toBe(false)
    expect(hint.hasPhoto).toBe(false)
    expect(hint.hasLinks).toBe(false)
    expect(hint.suffix).toBeNull()
  })
})

describe('resolveSignatureHint — never throws on a degraded payload', () => {
  it('null / undefined / non-array contexts all hide', () => {
    expect(resolveSignatureHint(null, STILL)).toBeNull()
    expect(resolveSignatureHint(undefined, STILL)).toBeNull()
    expect(resolveSignatureHint({ location_id: STILL }, STILL)).toBeNull()
    expect(resolveSignatureHint('nope', STILL)).toBeNull()
    expect(resolveSignatureHint(42, STILL)).toBeNull()
  })

  it('an empty list hides', () => {
    expect(resolveSignatureHint([], STILL)).toBeNull()
  })

  it('null holes in the list are skipped, not dereferenced', () => {
    expect(() => resolveSignatureHint([null, undefined, ctx()], STILL)).not.toThrow()
    expect(resolveSignatureHint([null, undefined, ctx()], STILL).text)
      .toBe('Sarah Byrne\nUN1T Stillorgan\n01 555 0100')
  })

  it('both arguments missing', () => {
    expect(resolveSignatureHint()).toBeNull()
  })
})

describe('SIGNATURE_SEPARATOR', () => {
  it('keeps the trailing space RFC 3676 requires — mirrors src/lib/email-signature.js', () => {
    expect(SIGNATURE_SEPARATOR).toBe('-- ')
  })
})
