// MAIL-READER.M1 — character references, decoded once and the same way on both
// platforms. htmlToPlainText handled six named entities and no numeric ones, so
// `&#38;` reached the stored text_body and printed literally on the phone.
import { describe, it, expect } from 'vitest'
import { decodeCharRefs } from './mail-entities.js'

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
    expect(decodeCharRefs('a&zwnj;b')).toBe('ab')
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
})
