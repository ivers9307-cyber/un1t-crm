// Host campaign email rendering + recipient resolution (HOST-EMAIL.3).
//
// A host campaign email has exactly ONE piece of host-authored, unescaped
// input: body_html. Everything else (sender name, host name, subject, the
// unsubscribe link) is escaped, and the body itself goes through
// sanitizeCampaignHtml — a strip-list sanitizer that removes active content
// (script/iframe/object/embed/form/link/svg/math, non-viewport meta, every
// attribute whose name starts with `on`, and every URL scheme outside
// http/https/mailto/tel — both checked after entity-decoding), keeps
// `<style>` scrubbed (also after entity-decoding) and one canonical
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
// The tokenizer walks each pass ONCE: at every `<` that starts a tag it runs
// the HTML tokenizer's tag states to that tag's `>` (scanTag / walkMarkup),
// acts on that one tag, and RESUMES AFTER the `>`. Every "find the closer"
// search (`</script`, `</style`, `-->`, `--!>`) goes through a MEMOISED
// finder, because N openers sharing ONE closer is the same quadratic wearing a
// different hat (`'<!--[if mso]>'.repeat(23000)` plus a single `-->`). Output
// is accumulated as an array of chunks and joined once, never spliced string
// by string.
//
// ROUND 6 MADE THAT WALK THE ONLY ONE. The scanner it replaced ended a tag at
// any inner `<` — including one inside a quoted attribute value, which no
// tokenizer does — and a second, deliberately cruder scanner answered "is this
// position inside a tag?" for the placeholder drop. Two hand-rolled scanners
// that disagree on purpose is how a critical XSS survived 182 green tests
// (`<img src=x onerror="alert(document.domain);'<a'">` sanitized to itself),
// so tokenizePass, the placeholder-drop scan and the footer's `</body>` lookup
// are all derived from ONE walk now, and the attribute rules read that walk's
// ATTRIBUTE SPANS instead of pattern-matching a tag's text. A parse5 oracle
// pins the walk's tag boundaries against a real parser, in the test file and
// over 100,000 random inputs in the fuzz harness.
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
//
// ROUND 6: the test that RECOGNISES an authored viewport meta is no longer a
// regex over the tag's text (it matched `name=viewport` written inside another
// attribute's VALUE, so `<meta content="name=viewport">` claimed the one
// canonical slot). isViewportMeta reads the tokenizer's attribute spans.
const VIEWPORT_META_SAFE = '<meta name="viewport" content="width=device-width, initial-scale=1">'

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
// on* event-handler attributes, in the three quotings HTML allows.
//
// ROUND 6: THESE ARE NO LONGER THE SANITIZER'S ATTRIBUTE RULE. They survive
// for exactly one job — stripOnAttrsFromCss, which runs over a <style> BODY,
// i.e. over TEXT that has no attribute structure to read and can never become
// an attribute either. Every real attribute decision is now made from the
// tokenizer's own attribute spans (scrubTagAttributes), because a regex cannot
// describe the attribute names a browser actually accepts: `on<p`, `onerror`
// with no value at all, or a handler whose value contains the `<` that used to
// cut the tag in half (`onerror="alert(1);'<a'"`, the round-6 critical).
const ON_ATTR_DQ = /([\s/"'])on[a-z]+\s*=\s*"[^"]*"/gi
const ON_ATTR_SQ = /([\s/"'])on[a-z]+\s*=\s*'[^']*'/gi
const ON_ATTR_BARE = /([\s/"'])on[a-z]+\s*=\s*[^\s>'"][^\s>]*/gi

// URL-carrying attributes (href / src / poster / formaction / background /
// action, and the xlink: forms). Each of these carries a SINGLE URL, so each
// is scheme-checked exactly like href/src: `poster` fetches a video still,
// `formaction` re-points a submit, `action` is a form's own target, and
// `background` is a tracking pixel wearing a table cell
// (`<td background="http://tracker/x.png">`) that nothing else here would look
// at. Matched by NAME against the tokenizer's attribute spans, so quoting,
// spacing and case cannot hide one.
const URL_ATTR_NAMES = new Set([
  'href', 'src', 'poster', 'formaction', 'background', 'action',
  'xlink:href', 'xlink:src',
])
const SAFE_URL_SCHEMES = new Set(['http', 'https', 'mailto', 'tel'])

// Fixed-point bounds. The INNER bound belongs to one stripActiveContent call;
// the OUTER one bounds the strip+drop rounds in sanitizeCampaignHtml.
// Exhausting the outer bound is a FAIL-CLOSED condition (return ''), never a
// "ship what we have" one — an unconverged document is precisely one where a
// deletion's splice has not been re-scanned.
const MAX_INNER_PASSES = 10
// Reachable from `'<'.repeat(n) + 'link>'.repeat(n)` — every pass deletes one
// welded `<link>` and hands the next `<` a fresh one — and that is fine:
// exhausting it fails closed and warns, loudly.
const MAX_OUTER_PASSES = 20

// Minimal entity decode for scheme sniffing: numeric (dec/hex) plus the named
// entities usable to obfuscate a scheme or to smuggle a quote back into an
// attribute value. Decode-for-CHECK only where a URL is concerned — a value
// that passes is kept byte-for-byte as authored.
//
// The named pass runs AFTER the numeric one and neither is repeated, which is
// what a browser does: `&amp;#106;avascript:` decodes to the literal text
// `&#106;avascript:`, which is a RELATIVE url and not a scheme at all.
const NAMED_ENTITIES = {
  colon: ':', tab: '\t', newline: '\n', amp: '&', quot: '"', apos: "'",
  lt: '<', gt: '>', sol: '/', nbsp: '\u00a0',
}
function decodeEntitiesForCheck(s) {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => fromCodePointSafe(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => fromCodePointSafe(parseInt(dec, 10)))
    .replace(/&(colon|tab|newline|amp|quot|apos|lt|gt|sol|nbsp);/gi, (_, name) => NAMED_ENTITIES[name.toLowerCase()])
}

function fromCodePointSafe(code) {
  return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
}

/**
 * Escape a value being written back into a double-quoted attribute.
 *
 * scrubStyleAttrValue DECODES entities before scrubbing (round-6 finding 3:
 * `style="width:&#101;xpression(alert(1))"` walked straight past a scrub that
 * only understood literal text), and a decode can mint a `"` that would end
 * the attribute early. Re-escaping is what makes the decode safe, and using
 * `&amp;` / `&quot;` / `&#39;` — all of which decodeEntitiesForCheck knows how
 * to read back — is what makes it IDEMPOTENT: escape, decode, scrub, escape is
 * a fixed point.
 */
function escapeAttrValue(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// HOST-EMAILS.2 — a <style> body captured via the backslash-close trick can
// smuggle HTML-attribute-shaped text — `onerror=…` — past scrubCss, which only
// understands CSS syntax and leaves it as inert text. Stripping on* handlers
// from the raw capture BEFORE scrubCss runs keeps that text out of the shipped
// message even though it can never become a live attribute.
//
// The boundary character captured by ON_ATTR_* ($1) is ALWAYS put back
// verbatim, never dropped: it may be whitespace, but it may just as easily be
// a `/` or the quote CLOSING the previous attribute's value, and when the
// removed on* text directly abuts the next token it is the only thing standing
// between them.
function stripOnAttrsFromCss(css) {
  return css
    .replace(ON_ATTR_DQ, '$1')
    .replace(ON_ATTR_SQ, '$1')
    .replace(ON_ATTR_BARE, '$1')
}

// Browsers strip ASCII controls and whitespace anywhere in a URL before they
// detect its scheme; NBSP goes too, because an entity-decoded `&nbsp;` is not
// a character a scheme check should trip over.
const URL_IGNORED_CHARS = /[\u0000-\u0020\u00a0]/g

/**
 * Is this URL value safe to keep as authored? Judged on the ENTITY-DECODED,
 * control-stripped value, so `&#106;avascript:`, `jav&Tab;ascript:` and
 * `jAvAsCrIpT:` are all seen for what they are. A value with no scheme at all
 * is relative or a fragment, which is inert.
 */
function isSafeUrlValue(value) {
  const decoded = decodeEntitiesForCheck(value).replace(URL_IGNORED_CHARS, '')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(decoded)
  if (!scheme) return true
  return SAFE_URL_SCHEMES.has(scheme[1].toLowerCase())
}

/**
 * Scrub one inline style attribute value, and return it ESCAPED for a
 * double-quoted attribute.
 *
 * DECODE FIRST (round-6 finding 3). The URL check has always decoded entities
 * before sniffing a scheme; this did not, so
 * `style="width:&#101;xpression(alert(1))"` and
 * `style="x:&#106;avascript&colon;alert(1)"` passed through unchanged. The
 * scrub has to see what the CSS parser will see.
 *
 * scrubCss's output contains no `<` and no `>` by construction; the quotes are
 * stripped here as well and whatever is left is escaped, so the scrubbed value
 * can never break OUT of the attribute it is re-emitted into.
 */
function scrubStyleAttrValue(rawValue, counter) {
  const decoded = decodeEntitiesForCheck(rawValue)
  return escapeAttrValue(scrubCss(decoded, counter).replace(/["']/g, '').trim())
}

// ── The tokenizer ─────────────────────────────────────────
//
// ONE SPEC-FAITHFUL WALK, AND EVERY PASS IS DERIVED FROM IT (round 6).
//
// What it replaced: a scanner that returned a PARTIAL tag at any inner `<`,
// even one sitting inside a quoted attribute value. That is not what any
// tokenizer does — inside a tag, only `>` (or end of input) ends the tag, and
// a `<` is an ordinary character in every tag state — and the gap was a live,
// critical XSS:
//
//   <img src=x onerror="alert(document.domain);'<a'">
//
// cut at the `<a`, so the handler regexes saw a value with no closing quote
// (ON_ATTR_DQ needs one), the bare-value pattern refuses a leading quote, and
// the URL pattern's bare alternative produced a value starting with `"` whose
// scheme check therefore failed "relative". The payload sanitized to ITSELF
// and ran in the browser, on both render paths. The same cut left `=` in
// tag-name position, so `<s=<x='><!--</>` — ONE element named `s=<x='`
// followed by a comment, to parse5 and to every browser — sent the sanitizer
// into a phantom quoted value and cost the message its unsubscribe anchor.
//
// So the states below are the HTML tokenizer's states, and the walk is the
// single source of truth for where a tag begins and ends. The parse5 ORACLE in
// the test file pins that claim against a real parser over a corpus of tricky
// tags; the fuzz runs the same comparison over random input.
//
// The one deliberate deviation is the round-4 CONDITIONAL COMMENT convention:
// `<!--[if …]>` / `<![endif]` / `<!--<![endif]` are scanned as tags that end
// at their first `>`, with what lies between them scanned as markup, because
// every Unlayer and Canva export ships
// `<!--[if mso]><style>…</style><![endif]-->` and mso really does parse the
// contents. A `<!--[if` opener with no `-->` or `--!>` after it is still an
// unterminated comment in every client that is not Outlook, so it is
// tail-deleted like any other.

/**
 * The HTML tokenizer's whitespace set. `\r` is here because the input stream
 * preprocessor turns CR and CRLF into LF before the tokenizer ever runs.
 */
function isHtmlSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r'
}

/** Only an ASCII letter after `<` (or after `</`) opens a tag. */
function isAsciiAlpha(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
}

// The conditional-comment markers that begin `<!--`. The bare `<![endif]` is
// recognised with the other `<!` forms in the walk below.
const COND_COMMENT_OPENERS = ['<!--<![endif]', '<!--[if']

/**
 * Scan the tag opening at `start` (which must be a `<` followed by an ASCII
 * letter, or by `/` and an ASCII letter) and return its shape:
 *
 *   { start, end, isEnd, nameStart, nameEnd, attrs }   `end` is EXCLUSIVE —
 *   one past the `>` — and every attribute carries the offsets of its name,
 *   its value and the whole attribute source (`end`), so a caller can delete
 *   or replace exactly one attribute and leave the rest of the tag
 *   byte-for-byte as authored.
 *
 *   null   the input ran out inside the tag. A real tokenizer DROPS such a
 *          tag; the caller tail-deletes from the `<`, which is what stops the
 *          server-injected footer from supplying the missing `>` (round 5).
 *
 * THE STATES ARE THE SPEC'S, and the two that matter most are the ones the
 * round-6 review was written about:
 *   TAG_NAME ends on whitespace, `/` or `>` ONLY — `=` and `<` are part of the
 *     name, so `<s=<x='>` is one element named `s=<x='`;
 *   VALUE_DQ / VALUE_SQ end on their OWN closing quote ONLY — a `<` inside a
 *     quoted value is an ordinary character, so `onerror="alert(1);'<a'"` is a
 *     complete attribute and the handler is seen and removed.
 * AFTER_VALUE_QUOTED and SELF_CLOSING reconsume anything unexpected as the
 * start of the next attribute name, exactly as the spec does, which is how
 * `<img src="x"onerror=…>` and `<img/onerror=…>` are read as two attributes.
 */
function scanTag(html, start) {
  const isEnd = html[start + 1] === '/'
  const nameStart = start + (isEnd ? 2 : 1)
  const attrs = []
  let nameEnd = -1
  let state = 'TAG_NAME'
  let attr = null
  const openAttr = (i) => {
    attr = { nameStart: i, nameEnd: -1, valueStart: -1, valueEnd: -1, valueOuterStart: -1, end: -1 }
  }
  const closeAttr = (end) => {
    if (!attr) return
    if (attr.nameEnd < 0) attr.nameEnd = end
    attr.end = end
    attrs.push(attr)
    attr = null
  }
  const done = (gt) => {
    if (nameEnd < 0) nameEnd = gt
    closeAttr(gt)
    return { start, end: gt + 1, isEnd, nameStart, nameEnd, attrs }
  }

  for (let i = nameStart; i < html.length; i++) {
    const ch = html[i]
    switch (state) {
      case 'TAG_NAME':
        if (ch === '>') return done(i)
        if (isHtmlSpace(ch)) { nameEnd = i; state = 'BEFORE_ATTR_NAME' }
        else if (ch === '/') { nameEnd = i; state = 'SELF_CLOSING' }
        break
      case 'BEFORE_ATTR_NAME':
        if (ch === '>') return done(i)
        if (isHtmlSpace(ch)) break
        if (ch === '/') { state = 'SELF_CLOSING'; break }
        // An `=` here is a parse error whose recovery starts an attribute NAME
        // containing the `=`, never a value.
        openAttr(i)
        state = 'ATTR_NAME'
        break
      case 'ATTR_NAME':
        if (ch === '>') return done(i)
        if (isHtmlSpace(ch)) { attr.nameEnd = i; state = 'AFTER_ATTR_NAME'; break }
        if (ch === '/') { attr.nameEnd = i; closeAttr(i); state = 'SELF_CLOSING'; break }
        if (ch === '=') { attr.nameEnd = i; state = 'BEFORE_ATTR_VALUE'; break }
        break
      case 'AFTER_ATTR_NAME':
        if (ch === '>') return done(i)
        if (isHtmlSpace(ch)) break
        if (ch === '/') { closeAttr(attr.nameEnd); state = 'SELF_CLOSING'; break }
        if (ch === '=') { state = 'BEFORE_ATTR_VALUE'; break }
        closeAttr(attr.nameEnd)
        openAttr(i)
        state = 'ATTR_NAME'
        break
      case 'BEFORE_ATTR_VALUE':
        if (isHtmlSpace(ch)) break
        if (ch === '"') { attr.valueOuterStart = i; attr.valueStart = i + 1; state = 'VALUE_DQ'; break }
        if (ch === "'") { attr.valueOuterStart = i; attr.valueStart = i + 1; state = 'VALUE_SQ'; break }
        // `<a href=>` — missing-attribute-value. The tag ends here and the
        // attribute keeps its `=`, so a deletion has to take the `=` with it.
        if (ch === '>') return done(i)
        attr.valueOuterStart = i
        attr.valueStart = i
        state = 'VALUE_UNQ'
        break
      case 'VALUE_DQ':
        if (ch === '"') { attr.valueEnd = i; closeAttr(i + 1); state = 'AFTER_VALUE_QUOTED' }
        break
      case 'VALUE_SQ':
        if (ch === "'") { attr.valueEnd = i; closeAttr(i + 1); state = 'AFTER_VALUE_QUOTED' }
        break
      case 'VALUE_UNQ':
        if (ch === '>') { attr.valueEnd = i; return done(i) }
        if (isHtmlSpace(ch)) { attr.valueEnd = i; closeAttr(i); state = 'BEFORE_ATTR_NAME' }
        break
      case 'AFTER_VALUE_QUOTED':
        if (ch === '>') return done(i)
        if (isHtmlSpace(ch)) { state = 'BEFORE_ATTR_NAME'; break }
        if (ch === '/') { state = 'SELF_CLOSING'; break }
        openAttr(i)
        state = 'ATTR_NAME'
        break
      default: // SELF_CLOSING
        if (ch === '>') return done(i)
        i -= 1 // reconsume in before-attribute-name
        state = 'BEFORE_ATTR_NAME'
        break
    }
  }
  return null
}

/**
 * THE walk. Visit every markup construct in `html`, left to right, once.
 *
 * The visitor is called with one span per construct and may return an offset
 * to RESUME AT (tokenizePass uses that to skip a `<script>` element's raw text
 * in one step); returning nothing resumes just past the span. TEXT is
 * everything the spans do not cover, so a caller that keeps text verbatim
 * copies the gaps.
 *
 *   TAG          { start, end, name, isEnd, attrs }. `name` is LOWERCASED for
 *                comparison only — nothing here lowercases the document, which
 *                can change string length for some Unicode characters (`İ`
 *                lowercases to TWO code points) and desynchronise every offset.
 *   COMMENT      a real `<!--…-->` (or `--!>`), including the two abrupt forms
 *                `<!-->` and `<!--->` that close immediately. With
 *                `enterComments` the walk reports the OPENER instead and then
 *                walks the interior as markup, which is how a `<script>`
 *                written inside a comment is still stripped.
 *   COND         the conditional-comment convention (see above).
 *   BOGUS        a bogus comment or a doctype: `</` + non-letter, `<!` that is
 *                not a comment, `<?`. All of them end at the first `>` with no
 *                quote awareness at all, so their contents can never contain a
 *                `>` and nothing dangerous fits inside one.
 *   DROP         `</>`, for which a tokenizer emits nothing at all.
 *   EOF          the input ran out inside a tag, a quoted value, a comment or a
 *                bogus comment. `start` is the OPENER; the walk stops there and
 *                the caller tail-deletes, because a browser drops the construct
 *                and what the missing `>` would swallow is the server-injected
 *                footer.
 */
function walkMarkup(html, visit, { enterComments = false } = {}) {
  const findCommentClose = makeCloserFinder(/--!?>/g)
  const emit = (span) => {
    const next = visit(span)
    return typeof next === 'number' && next > span.start ? next : span.end
  }
  let i = 0
  for (;;) {
    const lt = html.indexOf('<', i)
    if (lt < 0) return
    const c1 = html[lt + 1]
    if (c1 === undefined) return // a trailing `<` is text

    if (html.startsWith('<!--', lt)) {
      if (COND_COMMENT_OPENERS.some((t) => html.startsWith(t, lt))) {
        // Outlook parses these; every other client sees an ordinary comment, so
        // an opener with no closer still swallows everything after it.
        const gt = findCommentClose(html, lt + 4) < 0 ? -1 : html.indexOf('>', lt)
        if (gt < 0) { visit({ kind: 'EOF', start: lt, reason: 'comment' }); return }
        i = emit({ kind: 'COND', start: lt, end: gt + 1 })
        continue
      }
      // The tokenizer's abrupt-closing rules: both of these are COMPLETE, empty
      // comments, not danglers.
      if (html.startsWith('<!-->', lt)) { i = emit({ kind: 'COMMENT', start: lt, end: lt + 5 }); continue }
      if (html.startsWith('<!--->', lt)) { i = emit({ kind: 'COMMENT', start: lt, end: lt + 6 }); continue }
      const close = findCommentClose(html, lt + 4)
      if (close < 0) { visit({ kind: 'EOF', start: lt, reason: 'comment' }); return }
      const end = close + (html[close + 2] === '!' ? 4 : 3)
      if (!enterComments) { i = emit({ kind: 'COMMENT', start: lt, end }); continue }
      i = emit({ kind: 'COMMENT_OPEN', start: lt, end: lt + 4, commentEnd: end })
      continue
    }

    if (c1 === '!' || c1 === '?') {
      const isCond = html.startsWith('<![endif]', lt)
      const gt = html.indexOf('>', c1 === '?' ? lt + 1 : lt + 2)
      if (gt < 0) { visit({ kind: 'EOF', start: lt, reason: 'bogus' }); return }
      i = emit({ kind: isCond ? 'COND' : 'BOGUS', start: lt, end: gt + 1 })
      continue
    }

    if (c1 === '/') {
      const c2 = html[lt + 2]
      if (c2 === undefined) return // `</` at end of input is text
      if (c2 === '>') { i = emit({ kind: 'DROP', start: lt, end: lt + 3 }); continue }
      if (!isAsciiAlpha(c2)) {
        const gt = html.indexOf('>', lt + 2)
        if (gt < 0) { visit({ kind: 'EOF', start: lt, reason: 'bogus' }); return }
        i = emit({ kind: 'BOGUS', start: lt, end: gt + 1 })
        continue
      }
    } else if (!isAsciiAlpha(c1)) {
      i = lt + 1 // a bare `<` in ordinary copy (`book if 5 < 6`) starts no tag
      continue
    }

    const tag = scanTag(html, lt)
    if (!tag) { visit({ kind: 'EOF', start: lt, reason: 'tag' }); return }
    tag.kind = 'TAG'
    tag.name = html.slice(tag.nameStart, tag.nameEnd).toLowerCase()
    i = emit(tag)
  }
}

/**
 * Every TAG span the walk finds, with its attribute spans. Exported for the
 * parse5 ORACLE test, which asserts that every start/end tag a real parser
 * reports has a span here at exactly the same offsets — the claim this whole
 * file rests on, checked against something that is not this file.
 */
export function markupTagSpans(html) {
  const spans = []
  walkMarkup(String(html), (span) => { if (span.kind === 'TAG') spans.push(span) })
  return spans
}

/**
 * A MEMOISED forward search. `re` must be a global regex; the returned function
 * takes a start offset and answers with the index of the first match at or
 * after it.
 *
 * The memo is what keeps "N openers, ONE closer" linear. Without it,
 * `'<!--[if mso]>'.repeat(23000) + '-->'` asks 23,000 times whether a comment
 * closer exists after each opener, and each answer costs a full scan of the
 * tail: the O(n²) the tokenizer exists to remove, wearing a different hat. Both
 * facts it caches are MONOTONE in the start offset — a match found at index m
 * answers every start <= m, and "no match from here" answers every later start
 * as well — which is what makes the cache sound. A finder belongs to ONE walk
 * over ONE string; a new walk builds new ones, because what it caches are
 * offsets into that string.
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
 * Does this tag carry `name=viewport`? Read from the ATTRIBUTE SPANS, not from
 * a regex over the tag's text: `<meta content="name=viewport">` is not a
 * viewport meta, and the regex that used to answer this said it was.
 */
function isViewportMeta(html, tag) {
  for (const a of tag.attrs) {
    if (a.valueStart < 0) continue
    if (html.slice(a.nameStart, a.nameEnd).toLowerCase() !== 'name') continue
    if (html.slice(a.valueStart, a.valueEnd).trim().toLowerCase() === 'viewport') return true
  }
  return false
}

/**
 * Scrub the attributes of ONE tag, from the tokenizer's own attribute spans.
 * Returns null when nothing needs changing, which is the overwhelmingly common
 * case and keeps the host's markup byte-for-byte as authored.
 *
 * Three rules, and the first one is the round-6 fix:
 *   ANY attribute whose name starts with `on` is DELETED, whatever it contains
 *     and whether or not it has a value. The old regexes needed a well-formed
 *     `on[a-z]+=` with a matching quote, so a handler whose value contained a
 *     `<` was invisible to them (the critical) and a junk name like `on<p`, or
 *     a valueless `onerror`, reached the DOM untouched (finding 4).
 *   a URL attribute whose DECODED scheme is outside the allowlist has its whole
 *     value replaced by `"#"`;
 *   `style=` is decoded, scrubbed by scrubCss and written back escaped.
 *
 * Deleting an attribute removes exactly its own source span, so the character
 * BEFORE it — whitespace, a `/`, or the quote closing the previous attribute's
 * value in `<a onclick="1"href="…">` — is left where it was and two attributes
 * can never be welded into one.
 */
function scrubTagAttributes(html, tag, counter) {
  let edits = null
  const edit = (start, end, text) => { (edits || (edits = [])).push({ start, end, text }) }
  for (const a of tag.attrs) {
    const name = html.slice(a.nameStart, a.nameEnd).toLowerCase()
    if (name.startsWith('on')) { edit(a.nameStart, a.end, ''); continue }
    if (a.valueStart < 0) continue
    const value = html.slice(a.valueStart, a.valueEnd)
    if (URL_ATTR_NAMES.has(name)) {
      if (!isSafeUrlValue(value)) edit(a.valueOuterStart, a.end, '"#"')
      continue
    }
    if (name === 'style') {
      const safe = scrubStyleAttrValue(value, counter)
      if (!safe) { edit(a.nameStart, a.end, ''); continue }
      const replacement = `"${safe}"`
      if (html.slice(a.valueOuterStart, a.end) !== replacement) edit(a.valueOuterStart, a.end, replacement)
    }
  }
  if (!edits) return null
  const parts = []
  let pos = tag.start
  for (const e of edits) {
    parts.push(html.slice(pos, e.start), e.text)
    pos = e.end
  }
  parts.push(html.slice(pos, tag.end))
  return parts.join('')
}

/**
 * ONE PASS of the tokenizer: walk `html` left to right, act on each construct
 * exactly once, and return the rewritten document. Linear in html.length.
 *
 * `ctx` carries what must survive across passes and rounds: the per-call nonce
 * and its placeholders, the lifted <style> bodies, whether the one viewport
 * meta has been claimed, the per-DOCUMENT <style>-block CSS budget and the
 * per-PASS inline `style=` budget.
 *
 * The rules, in the order the walk applies them:
 *
 *   unterminated anything  TAIL-DELETED from its opener (the walk's EOF span,
 *                          which is the one notion of "unterminated" here).
 *   `</>`                  deleted — a tokenizer emits nothing for it.
 *   comments / bogus       kept verbatim. A comment's INTERIOR is walked as
 *                          markup, so a `<script>` or `<style>` written inside
 *                          one is stripped or lifted exactly as it would be
 *                          outside one, and dropStrandedPlaceholders then
 *                          deletes any placeholder that ended up in there. A
 *                          bogus comment's contents cannot contain a `>` at
 *                          all, so there is nothing in one to act on.
 *   `<script …>`           deleted THROUGH its `</script …>`, content and all;
 *                          with no closer, tail-deleted from the opener, since
 *                          the rest of the document is script data to a real
 *                          parser, footer included.
 *   `<style …>`            body lifted, scrubbed by scrubCss and replaced by a
 *                          nonced placeholder; with no closer, tail-deleted for
 *                          the same reason (RAWTEXT to EOF).
 *   first viewport <meta>  replaced by a nonced placeholder. Every LATER one
 *                          falls through to the strip list, so it is removed
 *                          and the splice its removal makes is re-scanned.
 *   STRIP_TAGS             the tag is deleted, its content kept.
 *   anything else          attributes scrubbed (on*, URL schemes, style=), the
 *                          tag otherwise kept exactly as authored.
 */
function tokenizePass(html, ctx) {
  const findScriptClose = makeCloserFinder(/<\/script/gi)
  const findStyleClose = makeCloserFinder(/<\/style/gi)
  const out = []
  let textStart = 0 // start of the pending run of text and kept-as-authored tags
  let truncated = false
  // Everything from textStart up to `end` is kept verbatim, as one chunk.
  const flush = (end) => { if (end > textStart) out.push(html.slice(textStart, end)) }
  const cutTail = (at) => { flush(at); truncated = true; return html.length }
  const dropSpan = (span) => { flush(span.start); textStart = span.end }

  walkMarkup(html, (span) => {
    // A construct that never closes takes the footer with it, so it is
    // TAIL-DELETED from its opener — the walk's EOF span, and the only notion
    // of "unterminated" in this file. Round 5 needed a separate,
    // browser-faithful pre-pass here (trimUnterminatedTail) because the
    // scanner this walk replaced answered a NARROWER question and could not
    // see an unterminated quoted value; asking the same question twice, with
    // two scanners that disagreed on purpose, is what the round-6 review was
    // about. One walk answers it once, at the same offset, and a `<script>` or
    // `<style>` whose RAW TEXT contains an unterminated tag now loses that
    // element rather than the whole tail of the message.
    if (span.kind === 'EOF') return cutTail(span.start)
    if (span.kind === 'DROP') { dropSpan(span); return undefined }
    if (span.kind !== 'TAG') return undefined // COMMENT_OPEN / COMMENT / COND / BOGUS: verbatim
    const { name, isEnd, start, end } = span

    if (!isEnd && name === 'script') {
      const closer = findScriptClose(html, end)
      const closerTag = closer < 0 ? null : scanTag(html, closer)
      // No `</script …>` that actually closes: the rest of the document is
      // script data to a real parser, footer included, so it goes.
      if (!closerTag) return cutTail(start)
      flush(start)
      textStart = closerTag.end
      return closerTag.end
    }
    if (!isEnd && name === 'style') {
      const closer = findStyleClose(html, end)
      const closerTag = closer < 0 ? null : scanTag(html, closer)
      // No `</style …>` that actually closes: RAWTEXT to EOF, same reasoning.
      if (!closerTag) return cutTail(start)
      const safe = scrubCss(stripOnAttrsFromCss(html.slice(end, closer)), ctx.blockCounter).trim()
      flush(start)
      // An empty result after the scrub drops the block entirely.
      if (safe) {
        ctx.styles.push(safe)
        out.push(`@@UN1T_${ctx.nonce}_STYLE_${ctx.styles.length - 1}@@`)
      }
      textStart = closerTag.end
      return closerTag.end
    }
    if (!isEnd && !ctx.viewportSeen && name === 'meta' && isViewportMeta(html, span)) {
      ctx.viewportSeen = true
      flush(start)
      out.push(ctx.viewportPlaceholder)
      textStart = end
      return undefined
    }
    if (STRIP_TAGS.has(name) || name === 'script' || name === 'style') { dropSpan(span); return undefined }

    const scrubbed = scrubTagAttributes(html, span, ctx.inlineCounter)
    if (scrubbed !== null) {
      flush(start)
      out.push(scrubbed)
      textStart = end
    }
    return undefined
  }, { enterComments: true })

  if (!truncated) flush(html.length)
  return out.join('')
}

/**
 * Strip active content to a FIXED POINT: removing one construct can splice a
 * new one together (`'<'.repeat(n) + 'link>'.repeat(n)` welds one fresh
 * `<link>` per pass), so every pass re-scans the whole string and the loop only
 * stops when a pass changes nothing. Bounded at MAX_INNER_PASSES — and every
 * pass is LINEAR, so the loop costs O(10n) where round 4 paid O(10n²).
 *
 * `ctx.inlineCounter` is the CSS budget for the INLINE `style=` scrub (the
 * document-level <style>-BLOCK budget is `ctx.blockCounter`, spent once per
 * document). It is reset to zero at the top of EVERY pass, and the caller hands
 * in a fresh one for every outer round, because the budget is meant to bound
 * ONE linear scan of the document — not the number of times a fixed point
 * happens to re-scan it. Sharing it across passes made the passes multiply
 * against CSS_TOTAL_MAX_CHARS, so on a large but entirely legitimate message (a
 * long table of styled cells) a later pass would start returning '' for every
 * value and silently wipe every inline style in the email.
 *
 * This is not the only place deletions happen: dropStrandedPlaceholders deletes
 * too. The invariant that covers both is stated on sanitizeCampaignHtml — every
 * deletion happens INSIDE the outer fixed point, so the splice it makes is
 * re-scanned.
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

/**
 * The subset of `offsets` (which MUST be ascending) sitting anywhere other than
 * ordinary TEXT — inside a tag, inside one of its quoted attribute values,
 * inside a comment or inside a bogus comment.
 *
 * It is THE SAME WALK the strip pass uses, with one difference that is the
 * whole point of running it: comments are NOT entered, so a placeholder lifted
 * out of a `<style>` written inside a comment counts as stranded and is dropped
 * rather than restored. Before round 6 this was a second, cruder state machine
 * kept deliberately out of step with the tokenizer; two hand-rolled scanners
 * disagreeing about where a tag ends is exactly the shape of the bug the
 * round-6 review found, so there is now one.
 *
 * What makes restoration safe is not this scan but what restoration can DO —
 * insert `<style>` around a scrubCss body that provably contains no `<` and no
 * `>`, or the one fixed literal meta tag. Getting a position wrong therefore
 * misplaces a stylesheet; it cannot mint an attribute or a tag.
 */
function strandedOffsets(whole, offsets) {
  const ranges = []
  walkMarkup(whole, (span) => {
    ranges.push(span.kind === 'EOF' ? [span.start, whole.length] : [span.start, span.end])
  })
  const stranded = new Set()
  let r = 0
  for (const off of offsets) {
    while (r < ranges.length && ranges[r][1] <= off) r++
    if (r >= ranges.length) break
    if (off >= ranges[r][0]) stranded.add(off)
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

/**
 * The offset of the document's real `</body>` end tag, or -1.
 *
 * Read from the tokenizer walk, never from a regex: `<!--</body>-->` is a
 * COMMENT, and injecting the mandatory footer before ITS `</body>` put the
 * whole footer inside the comment — the host name, the unsubscribe anchor and
 * the consent line all present in the source and absent from the DOM, which is
 * precisely the failure the footer tests parse for. Comments are not entered
 * here, so only an end tag in markup position can match.
 */
function bodyEndTagOffset(html) {
  let at = -1
  // A `</body>` between `<!--[if mso]>` and `<![endif]-->` is comment data to
  // every client that is not Outlook. The walk scans that interior as markup
  // ON PURPOSE (it is where an Unlayer export keeps its stylesheet), so the
  // footer injection has to opt out of the convention: a body end tag in there
  // would put the whole footer inside a comment for everyone else — the same
  // failure as `<!--</body>-->`, one indirection further out. The fuzz found
  // this one too.
  let insideConditional = false
  walkMarkup(html, (span) => {
    if (span.kind === 'COND') { insideConditional = html.startsWith('<!--[if', span.start); return }
    if (at < 0 && !insideConditional && span.kind === 'TAG' && span.isEnd && span.name === 'body') at = span.start
  })
  return at
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
    // THE `</body>` HAS TO BE A REAL ONE. A regex found the first `</body>`
    // ANYWHERE in the text, so a host body containing `<!--</body>-->` had the
    // whole mandatory footer injected INSIDE that comment: present in the
    // source, absent from the DOM, no unsubscribe anchor at all on either
    // parser. The round-6 fuzz found it; the walk answers it, because the walk
    // is the one thing here that knows a comment from an end tag.
    const bodyEnd = bodyEndTagOffset(safeDoc)
    if (bodyEnd >= 0) return `${safeDoc.slice(0, bodyEnd)}${footer}${safeDoc.slice(bodyEnd)}`
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
