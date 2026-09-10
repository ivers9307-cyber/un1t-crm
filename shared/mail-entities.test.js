// MAIL-READER.M1 — character references, decoded once and the same way on both
// platforms. htmlToPlainText handled six named entities and no numeric ones, so
// `&#38;` reached the stored text_body and printed literally on the phone.
import { describe, it, expect } from 'vitest'
import { decodeCharRefs, stripInvisibleChars } from './mail-entities.js'

describe('decodeCharRefs', () => {
  it('decodes decimal references', () => {
    expect(decodeCharRefs('a&#38;b')).toBe('a&b')
    expect(decodeCharRefs('it&#39;s')).toBe("it's")
  })

  it('decodes hex references, either case', () => {
    expect(decodeCharRefs('it&#x27;s')).toBe("it's")
    expect(decodeCharRefs('it&#X27;s')).toBe("it's")
  })

  it('decodes the named set', () => {
    expect(decodeCharRefs('&lt;b&gt; &amp; &quot;x&quot; &apos;y&apos;')).toBe('<b> & "x" \'y\'')
    expect(decodeCharRefs('a&nbsp;b')).toBe('a b')
  })

  it('decodes zwnj/shy to their real characters, not to empty string', () => {
    // Regression guard: an earlier version of this function decoded &zwnj;
    // and &shy; straight to '', which made the named and numeric forms of
    // the same character behave differently (&zwnj; vs &#8204;). A decoder
    // decodes; deleting the character is stripInvisibleChars's job.
    expect(decodeCharRefs('a&zwnj;b')).toBe('a\u200Cb')
    expect(decodeCharRefs('a&shy;b')).toBe('a\u00ADb')
  })

  it('decodes the named and numeric forms of zwnj/shy identically', () => {
    expect(decodeCharRefs('a&zwnj;b')).toBe(decodeCharRefs('a&#8204;b'))
    expect(decodeCharRefs('a&shy;b')).toBe(decodeCharRefs('a&#173;b'))
  })

  it('runs once, not twice — an escaped reference survives as text', () => {
    // The whole point: `&amp;#38;` means the sender wrote "&#38;", so one pass
    // must yield "&#38;" and not "&". A second pass would eat it.
    expect(decodeCharRefs('&amp;#38;')).toBe('&#38;')
  })

  it('leaves malformed references alone', () => {
    expect(decodeCharRefs('&#;')).toBe('&#;')
    expect(decodeCharRefs('&#x;')).toBe('&#x;')
    expect(decodeCharRefs('&notareference;')).toBe('&notareference;')
    expect(decodeCharRefs('100% & rising')).toBe('100% & rising')
  })

  it('refuses references outside the Unicode range rather than throwing', () => {
    expect(decodeCharRefs('&#1114112;')).toBe('&#1114112;')
    expect(decodeCharRefs('&#x110000;')).toBe('&#x110000;')
  })

  it('handles falsy and non-string input', () => {
    expect(decodeCharRefs('')).toBe('')
    expect(decodeCharRefs(null)).toBe('')
    expect(decodeCharRefs(undefined)).toBe('')
    expect(decodeCharRefs(42)).toBe('42')
  })

  it('decodes astral references', () => {
    expect(decodeCharRefs('&#128512;')).toBe('\u{1F600}')
  })

  it('completes in linear time on adversarial input (no catastrophic backtracking)', () => {
    // decodeCharRefs is fed raw, un-truncated, unauthenticated-sender HTML —
    // the inbound webhook calls htmlToPlainText on body.HtmlBody before any
    // size cap. REF is a single non-backtracking alternation by construction,
    // so this is a coverage gap, not a known bug; this test locks in the
    // linear-time property rather than measuring exact performance (a loose
    // budget, so it does not flake on a slow CI box).
    const validRefs = '&amp;'.repeat(100000)
    const loneAmpersands = '&'.repeat(100000)
    const nearMissNumerics = '&#;&#x;&#notdigits;&#12abc;'.repeat(25000)
    const adversarial = validRefs + loneAmpersands + nearMissNumerics

    const start = Date.now()
    decodeCharRefs(adversarial)
    const elapsedMs = Date.now() - start

    expect(elapsedMs).toBeLessThan(5000)
  })
})

describe('stripInvisibleChars', () => {
  it('removes zero-width space, ZWNJ, ZWJ, combining grapheme joiner, soft hyphen, and BOM', () => {
    expect(stripInvisibleChars('a\u200Bb')).toBe('ab') // ZERO WIDTH SPACE
    expect(stripInvisibleChars('a\u200Cb')).toBe('ab') // ZERO WIDTH NON-JOINER
    expect(stripInvisibleChars('a\u200Db')).toBe('ab') // ZERO WIDTH JOINER
    expect(stripInvisibleChars('a\u034Fb')).toBe('ab') // COMBINING GRAPHEME JOINER
    expect(stripInvisibleChars('a\u00ADb')).toBe('ab') // SOFT HYPHEN
    expect(stripInvisibleChars('a\uFEFFb')).toBe('ab') // BYTE ORDER MARK
  })

  it('leaves ordinary text, including other whitespace, untouched', () => {
    expect(stripInvisibleChars('Fish & chips <3')).toBe('Fish & chips <3')
    expect(stripInvisibleChars('a b\tc\nd')).toBe('a b\tc\nd')
    expect(stripInvisibleChars('a\u00A0b')).toBe('a\u00A0b') // NBSP is a visible space, not stripped
  })

  it('handles falsy and non-string input', () => {
    expect(stripInvisibleChars('')).toBe('')
    expect(stripInvisibleChars(null)).toBe('')
    expect(stripInvisibleChars(undefined)).toBe('')
    expect(stripInvisibleChars(42)).toBe('42')
  })

  it('composed with decodeCharRefs, decoded and numeric zero-width references both vanish (the FTS regression)', () => {
    // This is the pairing src/lib/email-content.js uses at ingest. Postgres's
    // English FTS parser treats U+200C as an ordinary letter, so a sender's
    // "cli&#8204;ck" — a real preheader-hiding / spam-filter-evasion pattern —
    // must come out searchable as "click", not as the glued "cli\u200Cck".
    expect(stripInvisibleChars(decodeCharRefs('cli&#8204;ck'))).toBe('click')
    expect(stripInvisibleChars(decodeCharRefs('cli&zwnj;ck'))).toBe('click')
  })
})
