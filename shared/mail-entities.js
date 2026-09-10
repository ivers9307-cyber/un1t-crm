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
//
// DECODE AND STRIP ARE SEPARATE FUNCTIONS, ON PURPOSE. decodeCharRefs turns a
// reference into the character it names, always — see the NAMED comment
// below for why that includes zwnj/shy. Deleting a decoded character is a
// distinct, later step: stripInvisibleChars, below. Callers that need the
// stored text safe for Postgres full-text search (see that function's own
// comment) call both, in that order.

// The named set is deliberately small: the ones that actually appear in this
// estate's mail and templates. An unknown name is left as written rather than
// guessed at — `&notareference;` is far more likely to be prose than markup.
//
// zwnj/shy decode to their TRUE characters (U+200C, U+00AD), not to ''. A
// decoder that quietly deletes characters is a name that lies, and doing so
// here specifically made the named and numeric forms of the same character
// (`&zwnj;` vs `&#8204;`) behave differently — read as a live bug, not a
// design choice. A caller that wants those characters gone calls
// stripInvisibleChars afterwards, as an explicit second step.
const NAMED = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  zwnj: '\u200C', // ZERO WIDTH NON-JOINER
  shy: '\u00AD', // SOFT HYPHEN
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

// ZERO WIDTH SPACE (U+200B), ZERO WIDTH NON-JOINER (U+200C), ZERO WIDTH
// JOINER (U+200D), COMBINING GRAPHEME JOINER (U+034F), SOFT HYPHEN (U+00AD),
// BYTE ORDER MARK (U+FEFF).
//
// WHY THIS EXISTS. htmlToPlainText (src/lib/email-content.js) stores its
// result into email_inbox_messages.text_body at INGEST, and mig
// 576_email_message_search.sql derives a GENERATED tsvector column from that
// row via to_tsvector('english', …), read by the mail search endpoint
// (src/app/api/email/mail/_search.js). Postgres's English parser treats
// U+200C/U+034F (and the rest of this set) as ordinary letters, not word
// separators:
//
//   to_tsvector('english', 'cli' || chr(8204) || 'ck here')  →  'cli‌ck':1
//   … @@ websearch_to_tsquery('english', 'click')            →  false
//
// Marketing email routinely hides these characters INSIDE words —
// `cli&#8204;ck here` — to break preheader scraping and simple spam filters.
// decodeCharRefs alone would turn that into the literal character
// "cli‌ck here": readable (the glyph is invisible), but glued into one
// token for search, and permanently so — the tsvector is GENERATED from the
// stored row, so a later fix here does not repair rows already ingested.
// Stripping these characters out after decoding is what keeps
// "cli&#8204;ck here" searchable as "click here", the same as it always was
// under the old ordered-.replace() chain (which deleted the two hard-coded
// numeric forms it happened to know about instead of decoding them).
const INVISIBLE = /[\u200B-\u200D\u034F\u00AD\uFEFF]/g

/**
 * Remove characters that are invisible to a reader but not to a word-boundary
 * parser (see comment above). Call AFTER decodeCharRefs, so named and numeric
 * forms of the same character are stripped identically.
 *
 * @param {string} text
 * @returns {string} '' for falsy input; non-strings are stringified
 */
export function stripInvisibleChars(text) {
  if (text === null || text === undefined || text === '') return ''
  return String(text).replace(INVISIBLE, '')
}
