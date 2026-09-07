// Host campaign email rendering + recipient resolution (HOST-EMAIL.3).
//
// A host campaign email has exactly ONE piece of host-authored, unescaped
// input: body_html. Everything else (sender name, host name, subject, the
// unsubscribe link) is escaped, and the body itself goes through
// sanitizeCampaignHtml — a strip-list sanitizer that removes active content
// (script/iframe/object/embed/form/link/svg/math, non-viewport meta, on*
// handlers, and every URL scheme outside http/https/mailto/tel — checked
// after entity-decoding), keeps `<style>` scrubbed and one canonical
// viewport meta (HOST-EMAILS.2). The footer — host name + per-host
// unsubscribe link + the "why you're receiving this" line — is injected
// server-side AFTER sanitization, so a host can never omit or strip it
// (spec: "enforced in the send path, not the composer").
//
// Recipient resolution happens AT SEND TIME (never stored): host_contacts
// membership joined to host consent (host_contacts.marketing_consent — the
// same predicate the portal Contacts page shows), minus
// host_email_suppressions, deduped by lowercased email. Pure/DB-shaped
// only — no Postmark here.

import { isEmailable } from './host-contact-list'
import { scrubCss } from './email-html'

const PAGE = 1000 // the supabase-js 1k select cap — always .range()-paginate

// ── Sanitizer ─────────────────────────────────────────────
//
// ONE LEFT-TO-RIGHT TAG TOKENIZER, RUN ONCE PER PASS. That shape is the
// round-5 fix, and the reason most of what follows is a state machine rather
// than a battery of regexes.
//
// What it replaced: a `<script>…</script>` block matcher, a strip-list tag
// matcher, a `<style>` block matcher and a viewport-meta matcher, each
// `.replace()`d over the WHOLE document on every pass of the fixed point.
// Every one of them re-scanned to the end of the document from EVERY opener
// whose closer was missing or far away (`<script\b[^>]*>` from 37,500 openers,
// and the lazy `[\s\S]*?` close scan from each of them), so each pass was
// O(n²) and the inner fixed point paid it up to ten times over. Measured
// against the API's 300,000-char body cap: `'<script '.repeat(37500)` took
// 8.4s of server CPU, `'<svg '.repeat(60000)` 6.8s,
// `'<meta x'.repeat(42000) + '>'` 4.6s, and a chain-prefixed variant
// engineered to force ten inner passes took 94s — all from ONE authenticated
// `POST /api/host/emails/preview`.
//
// The tokenizer walks each pass ONCE: at every `<` that starts a tag it finds
// that tag's `>` under a real tokenizer's `=`-gated quote rule (scanTag),
// acts on that one tag, and RESUMES AFTER the `>`. The attribute regexes below
// survive unchanged but are applied to a SINGLE TAG's substring, so their cost
// is bounded by that tag's length and every character of the document is
// visited once. Every "find the closer" search (`</script`, `</style`, `-->`,
// `--!>`) goes through a MEMOISED finder, because N openers sharing ONE closer
// is the same quadratic wearing a different hat
// (`'<!--[if mso]>'.repeat(23000)` plus a single `-->`). Output is accumulated
// as an array of chunks and joined once, never spliced string by string.
//
// Nothing here lowercases the whole document to drive indices: that can change
// string length for some Unicode characters and desynchronise every offset.
// Tag names are compared case-insensitively one short name at a time, and the
// closer searches are case-insensitive regexes.

// Tags removed outright — the tag goes, its inner content (the plain-text
// fallback of an iframe/object/form, the visible text of a select) stays.
// svg/math open foreign-content parsing contexts (mXSS classics), so both are
// stripped. `base` is here because a single `<base href="//evil/">` silently
// re-points EVERY relative URL in the message at another host — no attribute
// of its own needs to be dangerous, its mere presence is.
//
// plaintext/textarea/title/noframes/noscript/noembed/xmp/template are on the
// list for a different reason: each one opens a parsing mode in which
// everything after it STOPS BEING MARKUP, and `<plaintext>` can never be
// closed at all. `title` and `noframes` joined them in round 4: both are
// raw-text/RCDATA elements IN THE BODY too (the parser does not care that a
// <title> "belongs" in the head), so one unclosed `<title>` at the end of a
// host body swallows the injected footer exactly like `<plaintext>` does. The
// mandatory footer (host name + unsubscribe link + consent-basis line) is
// injected server-side AFTER this sanitizer runs, so one of these left open
// would swallow the entire footer into inert text — the single thing the send
// path exists to guarantee.
//
// select/option/optgroup joined in round 5, for a third reason again: parse5
// and every browser put an unclosed `<select>` into "in select" insertion
// mode, which IGNORES a following `<a>` outright — so a host body ending in
// `<select>` deleted the unsubscribe ANCHOR from the parsed document while
// leaving its text visible. A select outside a form is inert junk in email, so
// the tags go and their option text stays.
//
// Removing the TAGS while keeping their inner text costs a host nothing
// legitimate in email HTML. `script` and `style` are NOT in this set: each has
// its own rule in tokenizePass (delete with content / lift and scrub the
// body), and this set is the fallback for their stray END tags.
const STRIP_TAGS = new Set([
  'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base', 'svg', 'math',
  'plaintext', 'textarea', 'title', 'noframes', 'noscript', 'noembed', 'xmp', 'template',
  'select', 'option', 'optgroup',
])

// HOST-EMAILS.2 — the viewport meta is always re-emitted in this fixed
// canonical form, never as authored (no attribute smuggling), and the test
// that recognises one runs against a SINGLE tag's substring, never over the
// document.
const VIEWPORT_META_SAFE = '<meta name="viewport" content="width=device-width, initial-scale=1">'
const VIEWPORT_NAME_ATTR = /\bname\s*=\s*["']?viewport\b/i

// HOST-EMAILS.2 — a <style> body is lifted to a placeholder while the strip
// passes run, and restored after them.
// The placeholder tokens carry a per-call random NONCE (see makeNonce below),
// and THE NONCE IS THE WHOLE DEFENCE: a host cannot predict it, so cannot
// write a live token into the input ahead of time. The literal prefix is also
// stripped from the INPUT first, belt and braces, before the nonce even
// exists — see stripPlaceholderPrefix, which reaches the fixed point in ONE
// linear pass (a nested forgery like `@@UN1T@@UN1T__STYLE_0@@` reconstitutes
// a fresh prefix after a naive `.split().join()`, so a single such pass is
// not enough and REPEATING it is quadratic — the round-4 DoS).
//
// Note what that fixed-point strip does NOT buy: the strip passes below can
// RE-SPLICE a literal `@@UN1T_` out of pieces the host wrote around a
// stripped tag (`@@UN1<script></script>T_`), so the OUTPUT can still contain
// that text. It is inert — plain text carrying no nonce, matching no
// placeholder regex — and that is exactly the point: forgery is impossible
// because of the nonce, not because the prefix can never appear.
const PLACEHOLDER_PREFIX = '@@UN1T_'

/**
 * Remove every occurrence of the literal placeholder prefix, to a TRUE FIXED
 * POINT, in ONE LINEAR PASS.
 *
 * The obvious `while (s.includes(P)) s = s.split(P).join('')` is a fixed point
 * but it is QUADRATIC, and a host can drive it deliberately: with
 * `'@@UN1T'.repeat(k) + '@@UN1T_' + '_'.repeat(k)` every pass deletes exactly
 * one prefix and welds the next one together, so k passes each re-copy the
 * whole document. At the API's 300,000-char body cap that measured ~13s of
 * server CPU for one render — a single-request denial of service (round-4
 * security review).
 *
 * This is the standard stack formulation instead: append one character at a
 * time and, whenever the ACCUMULATOR ends with the prefix, drop those
 * characters. Because removals only ever come off the tail, everything before
 * the tail is final, so an occurrence ending at any earlier position was
 * already checked against identical preceding text — the accumulator therefore
 * never contains the prefix at any point, which is the fixed point, reached in
 * O(input x prefix length).
 */
function stripPlaceholderPrefix(s) {
  const P = PLACEHOLDER_PREFIX
  const n = P.length
  const last = P[n - 1]
  const buf = new Array(s.length)
  let len = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    buf[len++] = ch
    // Only a character that could END the prefix can complete an occurrence.
    if (ch !== last || len < n) continue
    let hit = true
    for (let k = 0; k < n - 1; k++) {
      if (buf[len - n + k] !== P[k]) { hit = false; break }
    }
    if (hit) len -= n
  }
  buf.length = len
  return buf.join('')
}

// crypto.randomUUID() when available (Node 19+, edge runtimes); Math.random
// fallback keeps the file importable anywhere. Never used for anything
// security-sensitive beyond "a host can't predict/forge this token".
function makeNonce() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID().replace(/-/g, '')
  }
  return Math.random().toString(36).slice(2, 10)
}
// on* event-handler attributes: double-quoted, single-quoted, bare. The
// boundary before the attribute name may be whitespace, a `/` (SVG-style
// `<img/onerror=…>`), or a quote closing the previous attribute's value
// (`src="x"onerror=…`) — captured and put back so stripping the handler
// never eats the closing quote.
//
// ROUND 5: these three and the two below are no longer run over the DOCUMENT.
// scrubTagAttributes applies them to ONE TAG's substring at a time, so their
// `[^"]*"` / `[^\s>]*` scans are bounded by the length of the tag they sit in
// and each character of the document is offered to them once. Within a single
// tag the letter runs `on[a-z]+` can backtrack over are disjoint (every match
// attempt starts at a fresh `[\s/"']` boundary, and the runs between two
// boundaries do not overlap), so the per-tag cost is linear too.
const ON_ATTR_DQ = /([\s/"'])on[a-z]+\s*=\s*"[^"]*"/gi
const ON_ATTR_SQ = /([\s/"'])on[a-z]+\s*=\s*'[^']*'/gi
const ON_ATTR_BARE = /([\s/"'])on[a-z]+\s*=\s*[^\s>'"][^\s>]*/gi
// URL-carrying attributes (href / src / poster / formaction / background, and
// the xlink: form; any boundary/quoting). Each of these carries a SINGLE URL,
// so each is scheme-checked exactly like href/src: `poster` fetches a video
// still, `formaction` re-points a submit, and `background` is a tracking
// pixel wearing a table cell (`<td background="http://tracker/x.png">`) that
// nothing else here would look at.
// neutralizeUrlAttr scheme-checks the value against an ALLOWLIST after
// entity-decoding + control-char stripping, so entity-encoded or
// control-obfuscated schemes and any scheme outside the allowlist all
// neutralize to "#", while https/http/mailto/tel and scheme-less relative
// URLs pass through verbatim.
const URL_ATTR = /([\s/"'])((?:xlink:)?(?:href|src|poster|formaction|background))\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi
const SAFE_URL_SCHEMES = new Set(['http', 'https', 'mailto', 'tel'])
// The inline `style="…"` attribute — the same posture as the CRM's own
// safeStyle (email-html.js). Without it the <style>-BLOCK scrub covers only
// half the surface: `style="background:url(https://tracker/x.gif)"` on a
// single <td> is an unconsented remote fetch that no other rule here looks
// at. Applied INSIDE the fixed-point loop, so a value spliced together by an
// earlier strip is scrubbed too.
const STYLE_ATTR = /([\s/"'])style\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi

// Fixed-point bounds. The INNER bound belongs to one stripActiveContent call;
// the OUTER one bounds the strip+drop rounds in sanitizeCampaignHtml.
// Exhausting the outer bound is a FAIL-CLOSED condition (return ''), never a
// "ship what we have" one — an unconverged document is precisely one where a
// deletion's splice has not been re-scanned.
const MAX_INNER_PASSES = 10
// Reachable from ~1.5 KB of nested `<scr<script>…` (one round per nesting
// level), and that is fine: exhausting it fails closed and warns, loudly.
const MAX_OUTER_PASSES = 20

// Minimal entity decode for scheme sniffing: numeric (dec/hex) plus the named
// entities usable to obfuscate a scheme. Decode-for-CHECK only — a value that
// passes is kept byte-for-byte as authored.
function decodeEntitiesForCheck(s) {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => fromCodePointSafe(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => fromCodePointSafe(parseInt(dec, 10)))
    .replace(/&(colon|tab|newline);/gi, (_, name) => ({ colon: ':', tab: '\t', newline: '\n' })[name.toLowerCase()])
}

function fromCodePointSafe(code) {
  return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
}

/** Drop the surrounding quotes from a captured attribute value, if any. */
function unquoteAttrValue(raw) {
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    return raw.slice(1, -1)
  }
  return raw
}

// HOST-EMAILS.2 — a <style> body captured via the backslash-close trick (see
// STYLE_BLOCK below) can smuggle HTML-attribute-shaped text — `onerror=…` —
// past scrubCss, which only understands CSS syntax and leaves it as inert
// text. Stripping on* handlers from the raw capture BEFORE scrubCss runs
// keeps that text out of the shipped message even though it can never
// become a live attribute.
//
// The boundary character captured by ON_ATTR_* ($1) is ALWAYS put back
// verbatim, never dropped: it may be whitespace separating two attributes,
// but it may just as easily be a `/` (SVG-style `<img/onerror=…>`) or the
// quote CLOSING the previous attribute's value (`src="x"onerror=…`) — and
// when the removed on* attribute directly abuts the next token (no
// whitespace), that boundary character is the only thing standing between
// them. Dropping it merges the two, e.g. `<a onclick="1"href="...">` would
// lose the space between attributes and become `<ahref="...">` (and its
// href would then never reach URL_ATTR's scheme check because it's no
// longer a `href=` attribute boundary at all).
//
// The cosmetic leftover space before `>` (`<a href="x" >`) is simply KEPT.
// The `\s+>` collapse that used to tidy it ran over the WHOLE finished
// document, so it edited ordinary copy and attribute values (`5 > 3` became
// `5> 3`) — a silent rewrite of the host's text that inert whitespace is not
// worth. It is NOT, however, what costs a restored <style> body its child
// combinators: scrubCss (email-html.js) ends with `.replace(/[<>]/g, '')`, so
// a `>` never survives ANY CSS this sanitizer emits, and `.a > .b` degrades
// to the descendant selector `.a  .b` regardless of anything done here. That
// angle-bracket strip is load-bearing for security — it is the guarantee that
// a scrubbed body can never reconstitute a `</style>` and break out of the
// element it is re-wrapped in — so the fidelity limit is inherited from the
// CRM's scrubber and stays.
function stripOnAttrsFromCss(css) {
  return css
    .replace(ON_ATTR_DQ, '$1')
    .replace(ON_ATTR_SQ, '$1')
    .replace(ON_ATTR_BARE, '$1')
}

function neutralizeUrlAttr(match, boundary, attr, rawValue) {
  const value = unquoteAttrValue(rawValue)
  // Browsers strip ASCII controls/whitespace anywhere in a URL before scheme
  // detection — mirror that (after entity-decoding) before sniffing.
  const decoded = decodeEntitiesForCheck(value).replace(/[\u0000-\u0020\u00a0]/g, '')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(decoded)
  if (!scheme) return match // relative / fragment / '#' — inert, keep verbatim
  if (SAFE_URL_SCHEMES.has(scheme[1].toLowerCase())) return match
  return `${boundary}${attr}="#"`
}

/**
 * Scrub one inline style attribute value. scrubCss's output contains no `<`
 * and no `>` by construction; the quotes are stripped here as well, so the
 * scrubbed value can never break OUT of the attribute it is re-emitted into
 * whichever quoting the author used.
 */
function scrubStyleAttrValue(rawValue, counter) {
  return scrubCss(unquoteAttrValue(rawValue), counter).replace(/["']/g, '').trim()
}

/**
 * Scrub the attributes of ONE tag: the whole of the attribute battery above,
 * applied to `tagSrc` (a single `<…>` substring) rather than to the document.
 *
 * The `=` fast path is not a nicety. Every one of those patterns needs an `=`
 * to match, and the overwhelmingly common tag (`<p>`, `<tr>`, `</td>`) has
 * none, so skipping them is what keeps a document of 100,000 tiny tags cheap.
 */
function scrubTagAttributes(tagSrc, counter) {
  if (tagSrc.indexOf('=') === -1) return tagSrc
  return tagSrc
    .replace(ON_ATTR_DQ, '$1')
    .replace(ON_ATTR_SQ, '$1')
    .replace(ON_ATTR_BARE, '$1')
    .replace(URL_ATTR, neutralizeUrlAttr)
    .replace(STYLE_ATTR, (_m, boundary, rawValue) => {
      const safe = scrubStyleAttrValue(rawValue, counter)
      return safe ? `${boundary}style="${safe}"` : boundary
    })
}

/** Does `ch` after a `<` start an ELEMENT (as opposed to `<!…` / `<?…`)? */
function isElementNameStart(ch) {
  if (!ch) return false
  return ch === '/' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
}

/** ASCII tag-name characters. An HTML tag name is never non-ASCII. */
function isTagNameChar(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '-'
}

/**
 * The name of the tag opening at `start` (which must be a `<`), lowercased,
 * plus whether it is an END tag. A name is a handful of characters, so
 * lowercasing it is free and — unlike lowercasing the DOCUMENT, which can
 * change string length for some Unicode characters — cannot shift an offset.
 */
function tagNameAt(html, start) {
  let i = start + 1
  const isEnd = html[i] === '/'
  if (isEnd) i++
  let j = i
  while (j < html.length && isTagNameChar(html[j])) j++
  return { name: html.slice(i, j).toLowerCase(), isEnd }
}

/**
 * Scan the tag opening at `start` (which must be a `<`) and say where it ends.
 *
 *   { closed: true,  stop }  `stop` is the index of the `>` that ends the tag.
 *   { closed: false, stop }  the scan hit an INNER `<` that itself starts a
 *                            tag, at index `stop` — the tag is PARTIAL.
 *   { closed: false, stop: html.length }   the input ran out inside the tag.
 *
 * THE QUOTE RULE IS `=`-GATED, like a real tokenizer — strandedOffsets keeps
 * a cruder version of the same idea ON PURPOSE, see the note under this
 * function: an attribute value is only quoted when the quote is the FIRST
 * character after `=` (whitespace allowed between). A stray quote anywhere
 * else stays in attribute-name position and does not open a value. Tracking
 * parity on every quote instead flipped the machine out of the tag early —
 * round 4's `<a href=x" y="z>AAA" BBB=…>` reads its `>` as closing the `<a`,
 * so a `>` inside a genuinely quoted value must still be shielded.
 *
 * THE INNER-`<` STOP is what keeps this LINEAR and what keeps the sanitizer's
 * position-blind posture. Two things come out of it:
 *   - Every scan stops at the next tag-opening `<`, so the ranges two
 *     consecutive scans cover are DISJOINT and one pass touches each character
 *     a bounded number of times. Without it, `'<meta x'.repeat(42000) + '>'`
 *     asks 42,000 scans to run to the same far `>` — the O(n²) this tokenizer
 *     exists to remove, in its purest form (4.6s measured at the 300 KB cap).
 *   - A construct SAWN IN HALF (`<img src=x on<style>…</style>error=alert(1)>`)
 *     keeps being taken apart the way the old whole-document regexes took it
 *     apart: the partial `<img src=x on` is left alone, the `<style>` after it
 *     is lifted like any other, and dropStrandedPlaceholders then deletes that
 *     placeholder because strandedOffsets — which does NOT stop at an inner
 *     `<`, and so is strictly STRICTER about what counts as "inside a tag" —
 *     says it is sitting in one. The weld that leaves (`onerror=`) is
 *     re-scanned by the next pass and stripped there. The two scanners
 *     disagreeing in THAT direction is safe and load-bearing: restoration only
 *     happens where the STRICTER of the two says "ordinary text".
 *
 * A PARTIAL tag is not deleted merely for being partial (`<img alt="a<b>c">`
 * is somebody's ordinary copy, and the walk simply resumes at the `<b`), but a
 * partial whose NAME is on the strip list is — `<p>hi</p><script <a href=x>`
 * would otherwise ship a `<script` that takes its `>` from the next tag and
 * swallows the injected footer as script data.
 *
 * THE EOF CASE IS THE ROUND-5 BLOCKER. `<p>hi</p><script ` used to sanitize to
 * itself, and the render shell then supplied the missing `>` out of the
 * server-injected footer, putting the host name, the unsubscribe anchor and
 * the consent line inside a `<script>` text node: parse5 and jsdom both found
 * no `a[href]` while the source still contained the word "Unsubscribe", which
 * is exactly why the footer tests parse instead of grepping. The whole family
 * behaved that way (`<style `, `<title x="y`, `<textarea `, `<iframe `,
 * `<template `, …). A real tokenizer that reaches EOF inside a tag DROPS the
 * tag, so the caller tail-deletes from the `<`. In practice
 * trimUnterminatedTail reaches most of these first — it asks the same question
 * browser-faithfully, over the whole document — and this branch is the
 * backstop that keeps the answer right if that scan is ever weakened.
 */
function scanTag(html, start) {
  // The attribute states a real tokenizer keeps, because the naive
  // "any `=` arms the next quote" model gets the UNQUOTED value wrong and the
  // fuzz found it: in `<a href=alert(1)="<!--[if mso]>` the second `=` and the
  // `"` are ordinary characters INSIDE an unquoted value, so a browser ends
  // that tag at the `>` — while the naive model opened a quoted value there,
  // ran past the `>`, and left a tag with an unbalanced quote in the output.
  // The footer injected after it then landed inside that quote and the
  // unsubscribe anchor stopped existing, which is finding 2 by another route.
  //   NAME  tag-name / attribute-name position (a quote here opens nothing)
  //   EQ    just past an `=`, whitespace allowed: a quote HERE opens a value
  //   UNQ   an unquoted value: it ends at whitespace or `>`, and `=` and `"`
  //         inside it are ordinary characters
  //   DQ/SQ a quoted value: only its own closing quote ends it, which is what
  //         shields a `>` in `<img title="a>b">`
  let state = 'NAME'
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i]
    if (ch === '<' && (isElementNameStart(html[i + 1]) || (state !== 'DQ' && state !== 'SQ' && isTagNameStart(html[i + 1])))) {
      return { closed: false, stop: i }
    }
    if (state === 'NAME') {
      if (ch === '>') return { closed: true, stop: i }
      else if (ch === '=') state = 'EQ'
    } else if (state === 'EQ') {
      if (ch === '>') return { closed: true, stop: i }
      else if (ch === '"') state = 'DQ'
      else if (ch === "'") state = 'SQ'
      else if (!/\s/.test(ch)) state = 'UNQ' // whitespace after `=` is allowed
    } else if (state === 'UNQ') {
      if (ch === '>') return { closed: true, stop: i }
      else if (/\s/.test(ch)) state = 'NAME'
    } else if (state === 'DQ') {
      if (ch === '"') state = 'NAME'
    } else if (state === 'SQ') {
      if (ch === "'") state = 'NAME'
    }
  }
  return { closed: false, stop: html.length }
}

// strandedOffsets keeps the OLDER, cruder version of this machine, and that is
// deliberate: its states are only ever used to answer "is this placeholder
// sitting outside every tag?", and the crude machine treats MORE positions as
// inside a tag than this one does (it arms a quoted value on any `=`, so it
// can stay in a tag longer, never less long). The two therefore disagree in
// one direction only — the tokenizer may lift a <style> whose placeholder the
// drop step then deletes, costing that stylesheet — and never in the direction
// that matters, which would be restoring a `<style>` element into a position
// that is really inside a tag.

/**
 * A MEMOISED forward search. `re` must be a global regex; the returned
 * function takes a start offset and answers with the index of the first match
 * at or after it.
 *
 * The memo is what keeps "N openers, ONE closer" linear. Without it,
 * `'<!--[if mso]>'.repeat(23000) + '-->'` asks 23,000 times whether a comment
 * closer exists after each opener, and each answer costs a full scan of the
 * tail: the same O(n²) the tokenizer exists to remove, wearing a different
 * hat. Both facts it caches are MONOTONE in the start offset — a match found
 * at index m answers every start <= m, and "no match from here" answers every
 * later start as well — which is what makes the cache sound. A finder belongs
 * to ONE pass over ONE string; a new pass builds new ones, because what it
 * caches are offsets into that string.
 */
function makeCloserFinder(re) {
  let found = -1
  let exhausted = false
  return (html, from) => {
    if (exhausted) return -1
    if (found >= from) return found
    re.lastIndex = from
    const m = re.exec(html)
    if (!m) { exhausted = true; return -1 }
    found = m.index
    return found
  }
}

/**
 * Cut the document at the start of a tag that NEVER CLOSES, judged the way a
 * browser judges it. Returns the input unchanged when there is no such tag.
 *
 * scanTag answers a narrower question — it stops at the next tag-opening `<`,
 * which is what keeps a pass linear and what keeps a sawn-in-half construct
 * being taken apart — and that narrower question misses this one:
 *
 *   <img src=x ='"<!--[if mso]><!--</body>
 *
 * has an attribute value opened with `'` that never closes, so a browser runs
 * to EOF inside it and DROPS the tag; scanTag stopped at the `</body` and left
 * the partial in place, and the footer injected before that `</body>` landed
 * inside the open quote. No `<a href>` in the parsed document, "Unsubscribe"
 * still in the source — finding 2's failure mode reached through an
 * unterminated ATTRIBUTE VALUE instead of an unterminated tag. The fuzz found
 * it; a person would not have.
 *
 * The walk is linear: a tag scan runs to its `>` and the walk RESUMES AFTER
 * that `>`, so the ranges two scans cover are disjoint — `'<meta x'.repeat(N)`
 * plus one far `>` is ONE scan here, not N. Comments are skipped whole (their
 * closer is found once and the walk resumes past it) so a `>` inside a comment
 * cannot read as a tag end; an unterminated comment is left alone, because
 * tokenizePass's own comment rule deletes it and says so in its own terms.
 *
 * This is a TAIL deletion, so it splices nothing together, and it runs inside
 * the fixed point like every other deletion here.
 */
function trimUnterminatedTail(html) {
  let i = 0
  for (;;) {
    const lt = html.indexOf('<', i)
    if (lt < 0) return html
    // A comment's INTERIOR is walked, not skipped, because tokenizePass walks
    // it too (see its `<!--` rules): whatever the tokenizer can leave standing
    // in there, this has to be able to see. Skipping comments instead let
    // `<!--=<a href='--><!--[if mso]>` through — the tokenizer processed that
    // `<a` and kept it as a partial with an unbalanced quote, and the injected
    // footer went inside the quote. The cost of walking in is that an
    // unbalanced quote inside a BALANCED comment now tail-deletes, which a
    // browser would not do; that shape does not occur in composer output, and
    // erring towards deletion is the right direction for a rule whose job is
    // that the footer cannot be swallowed.
    if (html.startsWith('<!--', lt)) { i = lt + 4; continue }
    if (!isTagNameStart(html[lt + 1])) { i = lt + 1; continue }
    let state = 'NAME'
    let end = -1
    for (let j = lt + 1; j < html.length; j++) {
      const ch = html[j]
      if (state === 'NAME') {
        if (ch === '>') { end = j; break }
        else if (ch === '=') state = 'EQ'
      } else if (state === 'EQ') {
        if (ch === '>') { end = j; break }
        else if (ch === '"') state = 'DQ'
        else if (ch === "'") state = 'SQ'
        else if (!/\s/.test(ch)) state = 'UNQ'
      } else if (state === 'UNQ') {
        if (ch === '>') { end = j; break }
        else if (/\s/.test(ch)) state = 'NAME'
      } else if (state === 'DQ') {
        if (ch === '"') state = 'NAME'
      } else if (state === 'SQ') {
        if (ch === "'") state = 'NAME'
      }
    }
    if (end < 0) return html.slice(0, lt)
    i = end + 1
  }
}

/**
 * ONE PASS of the tokenizer: walk `html` left to right, act on each tag
 * exactly once, and return the rewritten document. Linear in html.length.
 *
 * `ctx` carries what must survive across passes and rounds: the per-call nonce
 * and its placeholders, the lifted <style> bodies, whether the one viewport
 * meta has been claimed, the per-DOCUMENT <style>-block CSS budget and the
 * per-PASS inline `style=` budget.
 *
 * The rules, in the order the walk applies them:
 *
 *   `<!-->` / `<!--->`     COMPLETE comments (the tokenizer's abrupt-closing
 *                          rules) — kept verbatim, and the walk continues
 *                          after them. The raw `lastIndexOf('<!--')` this
 *                          replaced read them as danglers and tail-deleted the
 *                          rest of the message: `<p>a</p><!--><p>KEEPME</p>`
 *                          lost KEEPME.
 *   `<!--` with no closer  TAIL-DELETED, comment and all. `<p>Sale!</p><!--`
 *                          otherwise puts every later byte inside a comment,
 *                          so the server-injected footer is appended INTO it
 *                          and renders as nothing. Because this is a TAIL
 *                          deletion nothing follows it, so it splices nothing
 *                          together and cannot weld a new construct out of the
 *                          text on either side.
 *                          THIS INCLUDES A CONDITIONAL OPENER: `<!--[if mso]`
 *                          with no `-->` or `--!>` after it is an unterminated
 *                          comment in every client that is not Outlook, and
 *                          would swallow the footer in all of them. So
 *                          `<!--[if mso]<style>evil{x:y}</style>` sanitizing
 *                          to `''` is CORRECT browser semantics, not a
 *                          fidelity bug, and a test pins it as such.
 *   `<!--` with a closer   the comment's INTERIOR is walked as ordinary text,
 *                          so a `<script>` or `<style>` written inside a
 *                          comment is stripped or lifted exactly as it would
 *                          be outside one (which is what the old
 *                          whole-document regexes did, and
 *                          dropStrandedPlaceholders then deletes any
 *                          placeholder that ended up inside the comment).
 *                          Only the OPENER's position matters here, and it now
 *                          comes from the walk — so a `<!--` sitting inside a
 *                          quoted attribute value (`title="a<!--b"`) is not an
 *                          opener at all. That is what a browser does, and
 *                          what the raw `lastIndexOf` got wrong: it truncated
 *                          `<a href="/x" title="a<!--b">Link</a><p>KEEP</p>`
 *                          to `<a href="/x" title="a`.
 *   unterminated tag       TAIL-DELETED from the `<` (trimUnterminatedTail
 *                          answers this browser-faithfully before the walk
 *                          starts; scanTag's own EOF case is the backstop).
 *   `<script …>`           deleted THROUGH its `</script …>`, content and all;
 *                          with no closer, tail-deleted from the opener, since
 *                          the rest of the document is script data to a real
 *                          parser, footer included.
 *   `<style …>`            body lifted, scrubbed by scrubCss and replaced by a
 *                          nonced placeholder; with no closer, tail-deleted
 *                          for the same reason (RAWTEXT to EOF).
 *   first viewport <meta>  replaced by a nonced placeholder. Every LATER one
 *                          falls through to the strip list, so it is removed
 *                          and the splice its removal makes is re-scanned.
 *   STRIP_TAGS             the tag is deleted, its content kept.
 *   anything else          attributes scrubbed (on*, URL schemes, style=), the
 *                          tag otherwise kept exactly as authored.
 */
function tokenizePass(rawHtml, ctx) {
  // A tag that never closes takes the footer with it, and only a
  // browser-faithful scan can see all of them — see trimUnterminatedTail.
  const html = trimUnterminatedTail(rawHtml)
  const findScriptClose = makeCloserFinder(/<\/script/gi)
  const findStyleClose = makeCloserFinder(/<\/style/gi)
  // `-->` and the abrupt-close `--!>` both end a comment.
  const findCommentClose = makeCloserFinder(/--!?>/g)
  const out = []
  let textStart = 0 // start of the pending run of text and kept-as-authored tags
  let i = 0
  // Everything from textStart up to `end` is kept verbatim, as one chunk.
  const flush = (end) => { if (end > textStart) out.push(html.slice(textStart, end)) }

  for (;;) {
    const lt = html.indexOf('<', i)
    if (lt < 0) break
    let isCond = false

    if (html.startsWith('<!--', lt)) {
      // `<!-->` and `<!--->` close immediately: complete comments, kept.
      if (html.startsWith('<!-->', lt)) { i = lt + 5; continue }
      if (html.startsWith('<!--->', lt)) { i = lt + 6; continue }
      if (findCommentClose(html, lt + 4) < 0) { flush(lt); return out.join('') }
      isCond = COND_TAGS.some((t) => html.startsWith(t, lt))
      if (!isCond) { i = lt + 4; continue } // walk the interior as text
    } else if (!isTagNameStart(html[lt + 1])) {
      i = lt + 1 // a bare `<` in ordinary copy (`book if 5 < 6`) starts no tag
      continue
    }

    const scan = scanTag(html, lt)
    if (!scan.closed) {
      // EOF inside the tag: a real tokenizer drops it, and leaving it would
      // hand the footer's own `>` to a `<script`. Tail-delete.
      if (scan.stop >= html.length) { flush(lt); return out.join('') }
      // A PARTIAL tag, cut short by an inner `<`. Delete it if its name is one
      // we strip (it would otherwise borrow the next tag's `>`); otherwise
      // leave it exactly as authored and resume the walk at that inner `<`.
      const partial = isCond ? '' : tagNameAt(html, lt).name
      if (STRIP_TAGS.has(partial) || partial === 'script' || partial === 'style') {
        flush(lt)
        i = textStart = scan.stop
        continue
      }
      // Kept — but SCRUBBED, never verbatim. A partial tag carries live
      // attributes: `<a href=javascript:<p>KEEPME</p>` is a partial `<a`
      // (cut short by the `<p`) whose href a browser reads as
      // `javascript:<p`, and leaving it as authored shipped exactly that.
      // The old whole-document attribute regexes caught it because they did
      // not care where a tag ended; applying them to the partial's own text
      // is how that stays true now.
      const partialSrc = html.slice(lt, scan.stop)
      const partialScrubbed = scrubTagAttributes(partialSrc, ctx.inlineCounter)
      if (partialScrubbed !== partialSrc) {
        flush(lt)
        out.push(partialScrubbed)
        textStart = scan.stop
      }
      i = scan.stop
      continue
    }
    const end = scan.stop
    const tagSrc = html.slice(lt, end + 1)
    // A conditional opener is a "tag" with no name — it can match no rule
    // below, so it is emitted as authored, like any tag we do not act on.
    const { name, isEnd } = isCond ? { name: '', isEnd: false } : tagNameAt(html, lt)

    if (!isEnd && name === 'script') {
      const closer = findScriptClose(html, end + 1)
      const closerScan = closer < 0 ? null : scanTag(html, closer)
      // No `</script …>` that actually closes: the rest of the document is
      // script data to a real parser, footer included, so it goes.
      if (!closerScan || !closerScan.closed) { flush(lt); return out.join('') }
      const closerEnd = closerScan.stop
      flush(lt)
      i = textStart = closerEnd + 1
      continue
    }
    if (!isEnd && name === 'style') {
      const closer = findStyleClose(html, end + 1)
      const closerScan = closer < 0 ? null : scanTag(html, closer)
      // No `</style …>` that actually closes: RAWTEXT to EOF, same reasoning.
      if (!closerScan || !closerScan.closed) { flush(lt); return out.join('') }
      const closerEnd = closerScan.stop
      const safe = scrubCss(stripOnAttrsFromCss(html.slice(end + 1, closer)), ctx.blockCounter).trim()
      flush(lt)
      // An empty result after the scrub drops the block entirely.
      if (safe) {
        ctx.styles.push(safe)
        out.push(`@@UN1T_${ctx.nonce}_STYLE_${ctx.styles.length - 1}@@`)
      }
      i = textStart = closerEnd + 1
      continue
    }
    if (!isEnd && !ctx.viewportSeen && name === 'meta' && VIEWPORT_NAME_ATTR.test(tagSrc)) {
      ctx.viewportSeen = true
      flush(lt)
      out.push(ctx.viewportPlaceholder)
      i = textStart = end + 1
      continue
    }
    if (STRIP_TAGS.has(name) || name === 'script' || name === 'style') {
      flush(lt)
      i = textStart = end + 1
      continue
    }

    const scrubbed = scrubTagAttributes(tagSrc, ctx.inlineCounter)
    if (scrubbed !== tagSrc) {
      flush(lt)
      out.push(scrubbed)
      textStart = end + 1
    }
    i = end + 1
  }
  flush(html.length)
  return out.join('')
}

/**
 * Strip active content to a FIXED POINT: removing one construct can splice a
 * new one together (`<scr<script>ipt>`), so every pass re-scans the whole
 * string and the loop only stops when a pass changes nothing. Bounded at
 * MAX_INNER_PASSES — and every pass is LINEAR now (tokenizePass), so the loop
 * costs O(10n) where round 4 paid O(10n²).
 *
 * `ctx.inlineCounter` is the CSS budget for the INLINE `style=` scrub (the
 * document-level <style>-BLOCK budget is `ctx.blockCounter`, spent once per
 * document). It is reset to zero at the top of EVERY pass, and the caller
 * hands in a fresh one for every outer round, because the budget is meant to
 * bound ONE linear scan of the document — not the number of times a fixed
 * point happens to re-scan it. Sharing it across passes made the passes
 * multiply against CSS_TOTAL_MAX_CHARS, so on a large but entirely legitimate
 * message (a long table of styled cells) a later pass would start returning ''
 * for every value and silently wipe every inline style in the email.
 *
 * This is not the only place deletions happen: dropStrandedPlaceholders
 * deletes too. The invariant that covers both is stated on
 * sanitizeCampaignHtml — every deletion happens INSIDE the outer fixed point,
 * so the splice it makes is re-scanned.
 */
function stripActiveContent(html, ctx) {
  let out = html
  for (let i = 0; i < MAX_INNER_PASSES; i++) {
    const before = out
    ctx.inlineCounter.cssChars = 0
    out = tokenizePass(out, ctx)
    if (out === before) break
  }
  return out
}

/** Does `ch` turn a `<` into the start of a tag? (`<` + space is just text.) */
function isTagNameStart(ch) {
  if (!ch) return false
  return ch === '/' || ch === '!' || ch === '?' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
}

/**
 * QUOTE-AWARE tag-position scan. Walks `whole` ONCE tracking
 * TEXT / TAG / TAG_DQ / TAG_SQ / COMMENT, and returns the subset of
 * `offsets` (which MUST be ascending) sitting anywhere other than TEXT — i.e.
 * inside an open tag, inside one of its quoted attribute values, or inside a
 * comment.
 *
 * The `before.lastIndexOf('<') > before.lastIndexOf('>')` test this replaced
 * was wrong in BOTH directions:
 *   FALSE POSITIVE — a bare `<` in ordinary copy (`book if 5 < 6`) starts no
 *     tag at all, yet it made every later placeholder read as stranded, so a
 *     legitimate <style> block was silently deleted from the email. HTML only
 *     opens a tag when the `<` is followed by a letter, `/`, `!` or `?`.
 *   FALSE NEGATIVE — a `>` inside a quoted attribute value
 *     (`<img title="a>b" style="…">`) does not close the tag, but it pushed
 *     lastIndexOf('>') past the `<`, so a placeholder genuinely INSIDE that
 *     tag read as outside it and a `<style>` element was restored into
 *     another tag's attribute list.
 * One scan answers both, and it is O(document) rather than O(document) per
 * placeholder — which matters, because the number of placeholders is the
 * number of <style> blocks the host chose to write.
 *
 * THE QUOTE RULE IS `=`-GATED, like a real tokenizer: an attribute value is
 * only quoted when the quote is the FIRST character after `=` (whitespace
 * allowed between). A stray quote anywhere else in a tag stays in
 * attribute-name position and does not open a value. Tracking parity on every
 * quote instead flipped the machine out of the tag early — round 4's
 * `<a href=x" y="z>AAA" BBB=…>` reads its `>` as closing the `<a`, so a
 * placeholder still inside the tag scanned as ordinary text and a `<style>`
 * element was restored into the attribute list.
 *
 * CONDITIONAL COMMENTS are not comments for this purpose. Every Unlayer and
 * Outlook export ships `<!--[if mso]><style>…</style><![endif]-->`, and mso
 * really does parse the contents — so treating the whole thing as COMMENT
 * stranded the placeholder and silently deleted the Outlook stylesheet from
 * every export that had one. `<!--[if …]>` and `<![endif]-->` (with or
 * without a leading `<!--`) are therefore scanned as TAGS that end at their
 * first `>`, leaving what is between them as TEXT. An ORDINARY `<!--` still
 * enters COMMENT, and a placeholder inside one is still dropped.
 *
 * Its quote rule is the CRUDER ancestor of scanTag's, and deliberately so:
 * every `=` arms the next quote here, and this scan does not stop at an inner
 * `<` at all, so it treats MORE positions as "inside a tag" than the tokenizer
 * does. The two therefore disagree in one direction only — a lifted <style>
 * whose placeholder this calls stranded is dropped, costing that stylesheet —
 * and never in the direction that would restore a `<style>` element into a
 * position that is really inside a tag. The note under scanTag says the same
 * thing from the other end.
 *
 * This is a tokenizer-faithful APPROXIMATION, not a proof: it is a hand-rolled
 * scanner over a deny-list sanitizer's output, not a spec parser, and a
 * construct neither it nor the strip passes model could still mis-place a
 * position. What makes restoration safe is not this scan but what restoration
 * can DO — insert `<style>` around a scrubCss body that provably contains no
 * `<` and no `>`, or the one fixed literal meta tag. Getting a position wrong
 * therefore misplaces a stylesheet; it cannot mint an attribute or a tag.
 */
const COND_TAGS = ['<!--<![endif]', '<![endif]', '<!--[if']

function strandedOffsets(whole, offsets) {
  const stranded = new Set()
  let state = 'TEXT'
  let next = 0
  // TAG only: has the scan just passed an `=` (possibly then whitespace)?
  // Only then does a quote open an attribute value.
  let afterEq = false
  for (let i = 0; i < whole.length; i++) {
    while (next < offsets.length && offsets[next] === i) {
      if (state !== 'TEXT') stranded.add(offsets[next])
      next++
    }
    if (next >= offsets.length) break
    const ch = whole[i]
    if (state === 'TEXT') {
      if (ch === '<') {
        if (COND_TAGS.some((t) => whole.startsWith(t, i))) { state = 'TAG'; afterEq = false }
        else if (whole.startsWith('<!--', i)) state = 'COMMENT'
        else if (isTagNameStart(whole[i + 1])) { state = 'TAG'; afterEq = false }
      }
    } else if (state === 'TAG') {
      if (ch === '>') { state = 'TEXT'; afterEq = false }
      else if (ch === '=') afterEq = true
      else if (ch === '"' && afterEq) { state = 'TAG_DQ'; afterEq = false }
      else if (ch === "'" && afterEq) { state = 'TAG_SQ'; afterEq = false }
      else if (!/\s/.test(ch)) afterEq = false // whitespace after `=` is allowed
    } else if (state === 'TAG_DQ') {
      if (ch === '"') { state = 'TAG'; afterEq = false }
    } else if (state === 'TAG_SQ') {
      if (ch === "'") { state = 'TAG'; afterEq = false }
    } else if (state === 'COMMENT') {
      // `-->` and the abrupt-close `--!>` both end a comment.
      if (ch === '>' && (whole.slice(i - 2, i) === '--' || whole.slice(i - 3, i) === '--!')) state = 'TEXT'
    }
  }
  return stranded
}

/**
 * Delete every placeholder token that is NOT sitting in ordinary text. One
 * that landed inside an open tag (`<a href="x" @@…@@>`) must never be
 * restored into a real element — that would put a `<style>` tag inside
 * another tag's attribute list — so it is dropped instead.
 *
 * THIS IS A DELETION, and a deletion splices the text on either side of it
 * together: `<img src=x on@@…@@error=alert(1)>` becomes a live `onerror=`
 * the instant the token goes. That is exactly why the call site is INSIDE the
 * outer fixed point and never after it — see sanitizeCampaignHtml.
 */
function dropStrandedPlaceholders(html, tokenRe) {
  const offsets = []
  for (const m of html.matchAll(tokenRe)) offsets.push(m.index)
  if (offsets.length === 0) return html
  const stranded = strandedOffsets(html, offsets)
  if (stranded.size === 0) return html
  return html.replace(tokenRe, (m, offset) => (stranded.has(offset) ? '' : m))
}

function warnFailClosed(reason) {
  // Once per failed call, and loud: a campaign that reaches here renders with
  // an EMPTY body, which an operator sees immediately and reports.
  console.warn(`host campaign sanitizer failed closed (${reason}) — body dropped`)
}

/**
 * Strip active content from host-authored campaign HTML. Deny-list, not a
 * parser — good enough for email HTML (email clients don't run JS either;
 * this protects the operator preview surfaces and keeps abuse out of the
 * outbound mail). Applied EVERY render, on the server.
 *
 * THE INVARIANT, and the whole shape of this function:
 *
 *   EVERY DELETION HAPPENS INSIDE THE OUTER FIXED POINT, so the splice it
 *   makes is re-scanned by the next round's strip pass. RESTORATION ONLY
 *   INSERTS, and only at positions the final round proved lie outside any
 *   open tag.
 *
 * Two security reviews were spent learning that, once each:
 *   1. the extra-viewport-meta deletion ran AFTER the strip loop, so
 *      `<meta name=viewport><scr<meta name=viewport>ipt>…` shipped a live
 *      <script>: the sanitizer welded back together what the host had sawn in
 *      half. Fixed by placeholdering only the FIRST viewport meta.
 *   2. the SAME defect survived as `insideOpenTag(...) ? '' : …` in the
 *      restore step — dropping a stranded placeholder is a deletion too, and
 *      it also ran after the last strip pass. With no decoy meta to absorb
 *      the token, `<img src=x on<style>a{color:red}</style>error=alert(1)>`
 *      shipped a live onerror, and the same trick rebuilt <script>, <iframe>,
 *      <base>, a javascript: href, and an unclosed <style> that swallowed the
 *      mandatory footer. Every existing splice test carried a decoy
 *      `<meta name=viewport>` that absorbed the single placeholder, which is
 *      the only reason they stayed green.
 *
 * So the drop moved INTO the loop (step 3), and the restore (step 4) is now
 * pure insertion: a `<style>` wrapper around a scrubCss result (which
 * provably contains no `<` and no `>`), or one fixed literal meta tag.
 *
 * @param {string} html
 * @returns {string}
 */
export function sanitizeCampaignHtml(html) {
  if (!html || typeof html !== 'string') return ''
  // Belt and braces: strip the literal placeholder prefix to a FIXED POINT
  // first (a single `.split().join()` pass would let a nested forgery like
  // `@@UN1T@@UN1T__STYLE_0@@` reconstitute after one pass; LOOPING that pass
  // is quadratic and was a live DoS). stripPlaceholderPrefix does both in one
  // linear pass. The per-call nonce below is the real defense; this only
  // clears the literal text out of the INPUT — the strip passes can splice it
  // back in later, inert. See PLACEHOLDER_PREFIX.
  let out = stripPlaceholderPrefix(html)

  // A host cannot predict this, so cannot forge `@@UN1T_${nonce}_STYLE_0@@`
  // (or the viewport equivalent) into the input ahead of time.
  const nonce = makeNonce()
  const stylePlaceholder = new RegExp(`@@UN1T_${nonce}_STYLE_(\\d+)@@`, 'g')
  const viewportPlaceholder = `@@UN1T_${nonce}_VIEWPORT@@`
  // Every token this call can mint, with NO capture group — the drop step's
  // replace callback reads (match, offset).
  const anyPlaceholder = new RegExp(`@@UN1T_${nonce}_(?:STYLE_\\d+|VIEWPORT)@@`, 'g')
  // Everything the tokenizer needs to carry ACROSS passes and rounds. The
  // <style>-BLOCK CSS budget is per DOCUMENT and never reset; the inline
  // `style=` budget is per PASS (see stripActiveContent); `viewportSeen` is
  // per CALL, which is what makes "only the FIRST viewport meta becomes a
  // placeholder, every later one is stripped" true of the whole sanitize and
  // not merely of one pass.
  const ctx = {
    nonce,
    viewportPlaceholder,
    styles: [],
    viewportSeen: false,
    blockCounter: { cssChars: 0 },
    inlineCounter: { cssChars: 0 },
  }

  // 1. The OUTER fixed point: strip (which is also where <style> bodies are
  //    lifted and the viewport meta is placeholdered, both inside the linear
  //    tokenizer), then drop the placeholders now stranded inside an open tag
  //    — and go round again, because that drop spliced text together and the
  //    splice has not been scanned yet. The loop stops only when a whole round
  //    changes nothing, which is the proof that (a) no active construct is
  //    left and (b) no SURVIVING placeholder sits inside an open tag.
  //
  //    stripActiveContent gets a FRESH inline-CSS budget every round: the
  //    budget bounds one scan of the document, and a shared one would let the
  //    rounds multiply against it and wipe the inline styles of a large,
  //    entirely legitimate email.
  let converged = false
  for (let i = 0; i < MAX_OUTER_PASSES; i++) {
    const before = out
    ctx.inlineCounter = { cssChars: 0 }
    out = stripActiveContent(out, ctx)
    out = dropStrandedPlaceholders(out, anyPlaceholder)
    if (out === before) { converged = true; break }
  }
  //    Fail CLOSED. An unconverged document is by definition one whose last
  //    deletion was never re-scanned — exactly the state both bypasses above
  //    shipped from. Dropping the body is visible and recoverable; shipping
  //    an unscanned splice is neither.
  if (!converged) {
    warnFailClosed('strip/drop fixed point did not converge')
    return ''
  }
  //    Assert, don't trust: the tokenizer mints at most ONE viewport
  //    placeholder per call and a host cannot forge a nonced token, so a
  //    second occurrence here would mean an invariant broke. Fail closed
  //    rather than DELETE the extra — a deletion at this point is the very
  //    defect this structure exists to prevent.
  if (out.split(viewportPlaceholder).length > 2) {
    warnFailClosed('duplicate viewport placeholder')
    return ''
  }

  // 2. Restore. Both replacements are pure INSERTIONS, at positions the final
  //    loop round proved sit in ordinary text, and both insert balanced
  //    markup, so neither can move another placeholder into a tag:
  //      - `<style>` + a scrubCss result + `</style>` — scrubCss's output
  //        provably contains no `<` and no `>` (it ends with
  //        `.replace(/[<>]/g, '')`), so the body cannot close its own element.
  //      - the fixed canonical viewport meta, never the authored one, so no
  //        attribute can be smuggled through it.
  //    Nothing is deleted here.
  out = out.replace(stylePlaceholder, (_m, i) => `<style>${ctx.styles[Number(i)] ?? ''}</style>`)
  out = out.split(viewportPlaceholder).join(VIEWPORT_META_SAFE)

  // 3. Defensive: no live token may reach an operator's screen or a mailbox.
  //    Unreachable by construction (step 2 replaces every token this call
  //    could have minted), which is exactly why it is worth asserting.
  if (out.includes(`@@UN1T_${nonce}`)) {
    warnFailClosed('placeholder token survived restoration')
    return ''
  }
  return out
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"

/**
 * Render a host campaign into the server-owned email shell: escaped sender
 * header, sanitized host body, MANDATORY footer (host name + per-host
 * unsubscribe link + consent-basis line). Email-client safe: tables + inline
 * styles only, no external CSS, no JS.
 *
 * `sanitized: true` says bodyHtml has ALREADY been through
 * sanitizeCampaignHtml and must be used as-is. It exists for the send queue,
 * which renders the SAME body once per recipient (only the unsubscribe URL
 * differs) and would otherwise re-run the whole fixed-point sanitizer for
 * every address in the campaign. The flag is a promise the CALLER makes:
 * anywhere host-authored HTML arrives fresh — the composer preview, the test
 * send — it stays false and the body is sanitized here. Sanitizing is
 * idempotent, so the flag is a cost saving, never a security decision.
 *
 * @param {{ host: {name?:string, sender_name?:string}|null, subject: string,
 *   bodyHtml: string, unsubscribeUrl: string, sanitized?: boolean }} args
 * @returns {string} full HTML document
 */
export function renderHostCampaignHtml({ host, subject, bodyHtml, unsubscribeUrl, sanitized = false }) {
  // SANITIZE FIRST, ONCE, AND SNIFF THE SANITIZED TEXT (round-5 finding 4).
  // The doctype/`<html>` sniff below chooses between two SHAPES of email, and
  // it used to read the RAW body while the queue hands in an already-sanitized
  // one — so the two callers could disagree about which shape a campaign is.
  // `'<script>' + 'A'.repeat(600) + '</script><!DOCTYPE html>…'` sniffed as
  // "not a document" in the composer preview and the test send (the doctype
  // sits past the 500-char window, behind a <script> block) and as a full
  // document from the queue, where the script had already been stripped: the
  // host approved a branded shell and every recipient got the bare document.
  // Sanitizing before the sniff makes the input to the sniff identical on both
  // paths, which is the only thing that can make them agree.
  const safeBody = sanitized ? String(bodyHtml || '') : sanitizeCampaignHtml(bodyHtml)
  const senderName = escapeHtml(host?.sender_name || host?.name || '')
  const hostName = escapeHtml(host?.name || host?.sender_name || '')
  const safeSubject = escapeHtml(subject || '')
  const unsub = escapeHtml(unsubscribeUrl || '')

  // HOST-EMAIL.4 — a visual-composer campaign stores a FULL html document
  // (Unlayer export). Wrapping it in the shell would nest documents, so:
  // sanitize the whole thing (same strip-list — the security posture on
  // host-authored input is unchanged) and inject the mandatory footer
  // before </body> instead. The footer stays server-injected AFTER
  // sanitization so a host can never omit or strip it.
  if (/<\s*(!doctype|html)[\s>]/i.test(safeBody.slice(0, 500))) {
    const safeDoc = safeBody
    const footer = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr><td align="center" style="padding:16px 8px;font-family:${FONT};font-size:11px;line-height:1.5;color:#888888;">${hostName} &middot; <a href="${unsub}" style="color:#888888;text-decoration:underline;">Unsubscribe</a><br>You&#39;re receiving this because you attended an event or joined the mailing list.</td></tr></table>`
    if (/<\/body\s*>/i.test(safeDoc)) {
      return safeDoc.replace(/<\/body\s*>/i, `${footer}</body>`)
    }
    return safeDoc + footer
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeSubject}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background-color:#f4f4f5;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="border-collapse:collapse;max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="padding:20px 32px;border-bottom:1px solid #e4e4e7;font-family:${FONT};font-size:17px;font-weight:700;color:#18181b;">${senderName}</td></tr>
<tr><td style="padding:24px 32px;font-family:${FONT};font-size:15px;line-height:1.6;color:#27272a;">${safeBody}</td></tr>
</table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="border-collapse:collapse;max-width:600px;width:100%;">
<tr><td align="center" style="padding:16px 8px;font-family:${FONT};font-size:11px;line-height:1.5;color:#888888;">
${hostName} &middot; <a href="${unsub}" style="color:#888888;text-decoration:underline;">Unsubscribe</a><br>
You&#39;re receiving this because you attended an event or joined the mailing list.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}

/**
 * Resolve the recipients a host campaign would reach RIGHT NOW: the host's
 * membership rows joined to the contact's mailbox facts, gated by isEmailable
 * against HOST consent (host_contacts.marketing_consent, HOST-CONSENT.1) +
 * per-host suppression + bounce/complaint/suppressed_at — NOT the UN1T
 * broadcast predicate, deduped by lowercased email (newest membership wins —
 * memberships are ordered created_at DESC). Both queries scope
 * .eq('host_id', hostId): the caller is responsible only for resolving
 * hostId from getCurrentHost()/the campaign row.
 *
 * @param {SupabaseClient} db  service-role client
 * @param {string} hostId
 * @param {{audienceEventId?: string|null, emailType?: string, mailingListOnly?: boolean, nonOpenersOf?: string|null}} [options]
 * @param {boolean} [options.mailingListOnly] restrict the host_contacts query
 *   to source='mailing_list' (excludes 'event'-sourced membership rows).
 *   Every consent/suppression gate below is unaffected.
 * @param {string|null} [options.nonOpenersOf] HOST-EMAILS.2 — a reminder draft's
 *   audience: contacts with a 'sent', delivered, unopened, unclicked,
 *   unbounced/uncomplained/unsubscribed row on this PARENT campaign (which
 *   must belong to this host). Re-gated below by the normal emailability
 *   rules, so a contact who withdrew consent since the parent send is still
 *   excluded.
 * @returns {Promise<Array<{contact_id: string, email: string}>>}
 */
export async function resolveHostRecipients(db, hostId, { audienceEventId = null, emailType = 'marketing', mailingListOnly = false, nonOpenersOf = null } = {}) {
  // HOST-EMAIL.4 — per-event audience. Resolved from CONFIRMED registrations
  // at send time (host_contacts.source_event_id only records the FIRST event
  // that added a contact, so it cannot answer "who attended event X").
  // Null = no restriction (every host contact).
  let allowedContactIds = null
  if (audienceEventId) {
    allowedContactIds = new Set()
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('race_registrations')
        .select('id, teams:team_id ( team_members ( contact_id ) )')
        .eq('race_event_id', audienceEventId)
        .eq('status', 'confirmed')
        .order('registered_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`host campaign: attendee query failed: ${error.message}`)
      for (const reg of data || []) {
        const members = Array.isArray(reg?.teams?.team_members) ? reg.teams.team_members : []
        for (const m of members) {
          if (m?.contact_id) allowedContactIds.add(m.contact_id)
        }
      }
      if (!data || data.length < PAGE) break
    }
    if (allowedContactIds.size === 0) return []
  }

  // HOST-EMAILS.2 — reminder audience: the parent's rows that were delivered
  // but never opened nor clicked (and not bounced/complained/unsubscribed),
  // re-gated below by the normal emailability rules at SEND time. The parent
  // must be this host's: a foreign id resolves nobody, loudly.
  if (nonOpenersOf) {
    const { data: parent, error: parentErr } = await db
      .from('host_campaigns').select('id').eq('id', nonOpenersOf).eq('host_id', hostId).maybeSingle()
    if (parentErr) throw new Error(`host campaign: parent campaign read failed: ${parentErr.message}`)
    if (!parent) throw new Error('host campaign: parent campaign not found for this host')
    allowedContactIds = new Set()
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('host_campaign_sends')
        .select('contact_id')
        .eq('campaign_id', nonOpenersOf)
        .eq('status', 'sent')
        .not('delivered_at', 'is', null)
        .is('opened_at', null)
        .is('clicked_at', null)
        .is('bounced_at', null)
        .is('complained_at', null)
        .is('unsubscribed_at', null)
        .order('id')
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`host campaign: non-openers query failed: ${error.message}`)
      for (const row of data || []) if (row.contact_id) allowedContactIds.add(row.contact_id)
      if (!data || data.length < PAGE) break
    }
    // The well-performing campaign — where everyone opened — is the common case and should be free.
    if (allowedContactIds.size === 0) return []
  }

  const suppressed = new Set()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('host_email_suppressions')
      .select('contact_id')
      .eq('host_id', hostId)
      .order('contact_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`host campaign: suppressions query failed: ${error.message}`)
    for (const row of data || []) suppressed.add(row.contact_id)
    if (!data || data.length < PAGE) break
  }

  const recipients = []
  const seenEmails = new Set()
  for (let from = 0; ; from += PAGE) {
    let query = db
      .from('host_contacts')
      .select(`
        contact_id, marketing_consent,
        contact:contacts!contact_id ( id, email, email_administrative, email_status, email_suppressed_at )
      `)
      .eq('host_id', hostId)
    if (mailingListOnly) query = query.eq('source', 'mailing_list')
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`host campaign: contacts query failed: ${error.message}`)
    for (const row of data || []) {
      if (allowedContactIds && !allowedContactIds.has(row.contact_id)) continue
      const contact = row.contact || null
      if (!isEmailable(contact, suppressed.has(row.contact_id), { emailType, hostConsent: row.marketing_consent === true })) continue
      const key = String(contact.email).trim().toLowerCase()
      if (seenEmails.has(key)) continue
      seenEmails.add(key)
      recipients.push({ contact_id: row.contact_id, email: contact.email })
    }
    if (!data || data.length < PAGE) break
  }
  return recipients
}
