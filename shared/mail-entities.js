// MAIL-READER.M1 — one decoder for HTML character references, used on both
// sides of the seam and at both ends of a message's life.
//
// WHY IT IS SHARED. htmlToPlainText (src/lib/email-content.js) decoded
// `&nbsp; &zwnj; &lt; &gt; &quot; &#39; &amp;` and nothing else, and it runs at
// INGEST — the Postmark inbound webhook and sent-lane.js both store
// `TextBody || htmlToPlainText(HtmlBody)`. So every numeric reference in a
// message with no text part is already in the stored `text_body`, and fixing
// the ingest path alone leaves every existing row printing `&#38;` forever.
// The phone therefore decodes at render too, which needs the rule on the
// `shared/` side of the seam.
//
// ONE PASS, DELIBERATELY. `&amp;#38;` means the sender wrote the characters
// "&#38;", so the result of one pass is "&#38;" and a second pass would be
// wrong. The single regex below is what guarantees that: it consumes each
// reference once, left to right, and never re-examines its own output.
//
// SAFE AT RENDER. The phone's destination is a React Native <Text>, which
// renders a string as a string — decoding cannot produce markup there. On the
// web this only ever feeds the plain-text fallback, never innerHTML.

// The named set is deliberately small: the ones that actually appear in this
// estate's mail and templates. An unknown name is left as written rather than
// guessed at — `&notareference;` is far more likely to be prose than markup.
const NAMED = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  zwnj: '',
  shy: '',
})

// One alternation, one pass. `&#(\d+);` decimal, `&#[xX]([0-9a-f]+);` hex,
// `&([a-z]+);` named.
const REF = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));/g

// Above this, String.fromCodePoint throws. A reference nobody can render is
// left as the characters the sender typed — visible, and never an exception on
// a screen someone is trying to read their mail on.
const MAX_CODE_POINT = 0x10ffff

function fromCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > MAX_CODE_POINT) return null
  // Lone surrogates are legal code points but render as replacement squares
  // and can break string handling downstream; treat them as unrenderable.
  if (code >= 0xd800 && code <= 0xdfff) return null
  try {
    return String.fromCodePoint(code)
  } catch {
    return null
  }
}

/**
 * Decode HTML character references in plain text.
 *
 * @param {string} text
 * @returns {string} '' for falsy input; non-strings are stringified
 */
export function decodeCharRefs(text) {
  if (text === null || text === undefined || text === '') return ''
  const source = String(text)
  if (!source.includes('&')) return source
  return source.replace(REF, (whole, dec, hex, name) => {
    if (dec !== undefined) return fromCodePoint(Number.parseInt(dec, 10)) ?? whole
    if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16)) ?? whole
    const named = NAMED[String(name).toLowerCase()]
    return named === undefined ? whole : named
  })
}
