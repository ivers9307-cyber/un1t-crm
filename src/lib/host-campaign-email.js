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

// ── Sanitizer ──────────────────────────────────────────────────────

// Tags whose CONTENT is dangerous too — removed as a block. <style> is NOT
// here any more (HOST-EMAILS.2): its body is lifted out, scrubbed by the
// CRM's scrubCss (no @import, no expression(), no remote url(), never a
// `<` or `>` in the output) and put back after the strip passes.
const CONTENT_STRIP_TAGS = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi
// Remaining dangerous tags — the tags go, their inner content (plain text
// fallback for iframe/object/form) stays. svg/math open foreign-content
// parsing contexts (mXSS classics), so both are stripped. `base` is here
// because a single `<base href="//evil/">` silently re-points EVERY relative
// URL in the message at another host — no attribute of its own needs to be
// dangerous, its mere presence is.
//
// plaintext/textarea/noscript/noembed/xmp/template are on the list for a
// different reason: each one opens a parsing mode in which everything after
// it STOPS BEING MARKUP, and `<plaintext>` can never be closed at all. The
// mandatory footer (host name + unsubscribe link + consent-basis line) is
// injected server-side AFTER this sanitizer runs, so one unclosed
// `<plaintext>` at the end of a host body would swallow the entire footer
// into inert text — the single thing the send path exists to guarantee.
// Removing the TAGS while keeping their inner text costs a host nothing
// legitimate in email HTML.
//
// This also sweeps any stray unclosed <script>/<style> open tag left after
// the block pass above.
const TAG_STRIP = /<\/?(script|style|iframe|object|embed|form|link|meta|base|svg|math|plaintext|textarea|noscript|noembed|xmp|template)\b[^>]*>/gi
// HOST-EMAILS.2 — lifted before the strip passes and restored after them.
// The placeholder prefix is stripped from the input first so a host cannot
// forge one (it is plain text, never a tag, so the strip passes ignore it).
// The viewport meta is always re-emitted in its canonical form, never as
// authored (no attribute smuggling).
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi
const VIEWPORT_META = /<meta\b[^>]*\bname\s*=\s*["']?viewport["']?[^>]*>/gi
const VIEWPORT_META_SAFE = '<meta name="viewport" content="width=device-width, initial-scale=1">'
// The placeholder tokens carry a per-call random NONCE (see makeNonce below),
// and THE NONCE IS THE WHOLE DEFENCE: a host cannot predict it, so cannot
// write a live token into the input ahead of time. The literal prefix is also
// stripped to a fixed point first, belt and braces, before the nonce even
// exists — `html.split(PREFIX).join('')` is only a single pass, and a nested
// forgery like `@@UN1T@@UN1T__STYLE_0@@` would otherwise reconstitute a live
// token after that one pass.
//
// Note what that fixed-point strip does NOT buy: the strip passes below can
// RE-SPLICE a literal `@@UN1T_` out of pieces the host wrote around a
// stripped tag (`@@UN1<script></script>T_`), so the OUTPUT can still contain
// that text. It is inert — plain text carrying no nonce, matching no
// placeholder regex — and that is exactly the point: forgery is impossible
// because of the nonce, not because the prefix can never appear.
const PLACEHOLDER_PREFIX = '@@UN1T_'

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
 * Strip active content to a FIXED POINT: removing one construct can splice a
 * new one together (`<scr<script>ipt>`), so every pass re-scans the whole
 * string and the loop only stops when a pass changes nothing. Bounded at
 * MAX_INNER_PASSES — each pass only removes or narrows, so it converges fast.
 *
 * `counter` is the CSS budget for the INLINE `style=` scrub only (the
 * document-level <style>-BLOCK budget lives in sanitizeCampaignHtml and is
 * spent once, before the loop). It is reset to zero at the top of EVERY pass,
 * and the caller hands in a fresh one for every outer round, because the
 * budget is meant to bound ONE linear scan of the document — not the number
 * of times a fixed point happens to re-scan it. Sharing it across passes made
 * the passes multiply against CSS_TOTAL_MAX_CHARS, so on a large but entirely
 * legitimate message (a long table of styled cells) a later pass would start
 * returning '' for every value and silently wipe every inline style in the
 * email.
 *
 * This is no longer the only place deletions happen, and this comment no
 * longer claims it is: dropStrandedPlaceholders deletes too. The invariant
 * that replaced the claim is stated on sanitizeCampaignHtml — every deletion
 * happens INSIDE the outer fixed point, so the splice it makes is re-scanned.
 */
function stripActiveContent(html, counter) {
  let out = html
  for (let i = 0; i < MAX_INNER_PASSES; i++) {
    const before = out
    counter.cssChars = 0
    out = out
      .replace(CONTENT_STRIP_TAGS, '')
      .replace(TAG_STRIP, '')
      .replace(ON_ATTR_DQ, '$1')
      .replace(ON_ATTR_SQ, '$1')
      .replace(ON_ATTR_BARE, '$1')
      .replace(URL_ATTR, neutralizeUrlAttr)
      .replace(STYLE_ATTR, (_m, boundary, rawValue) => {
        const safe = scrubStyleAttrValue(rawValue, counter)
        return safe ? `${boundary}style="${safe}"` : boundary
      })
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
 */
function strandedOffsets(whole, offsets) {
  const stranded = new Set()
  let state = 'TEXT'
  let next = 0
  for (let i = 0; i < whole.length; i++) {
    while (next < offsets.length && offsets[next] === i) {
      if (state !== 'TEXT') stranded.add(offsets[next])
      next++
    }
    if (next >= offsets.length) break
    const ch = whole[i]
    if (state === 'TEXT') {
      if (ch === '<') {
        if (whole.startsWith('<!--', i)) state = 'COMMENT'
        else if (isTagNameStart(whole[i + 1])) state = 'TAG'
      }
    } else if (state === 'TAG') {
      if (ch === '"') state = 'TAG_DQ'
      else if (ch === "'") state = 'TAG_SQ'
      else if (ch === '>') state = 'TEXT'
    } else if (state === 'TAG_DQ') {
      if (ch === '"') state = 'TAG'
    } else if (state === 'TAG_SQ') {
      if (ch === "'") state = 'TAG'
    } else if (state === 'COMMENT') {
      if (ch === '>' && whole.slice(i - 2, i) === '--') state = 'TEXT'
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
  // The <style>-BLOCK budget is per DOCUMENT and spent exactly once, in step
  // 1 below. The inline `style=` budget is per PASS and lives in
  // stripActiveContent — see its doc comment.
  const blockCounter = { cssChars: 0 }
  const styles = []
  // Belt and braces: strip the literal placeholder prefix to a FIXED POINT
  // first (a single `.split().join()` pass would let a nested forgery like
  // `@@UN1T@@UN1T__STYLE_0@@` reconstitute after one pass). The per-call
  // nonce below is the real defense; this loop only clears the literal text
  // out of the INPUT — the strip passes can splice it back in later, inert.
  // See PLACEHOLDER_PREFIX.
  let out = html
  while (out.includes(PLACEHOLDER_PREFIX)) out = out.split(PLACEHOLDER_PREFIX).join('')

  // A host cannot predict this, so cannot forge `@@UN1T_${nonce}_STYLE_0@@`
  // (or the viewport equivalent) into the input ahead of time.
  const nonce = makeNonce()
  const stylePlaceholder = new RegExp(`@@UN1T_${nonce}_STYLE_(\\d+)@@`, 'g')
  const viewportPlaceholder = `@@UN1T_${nonce}_VIEWPORT@@`
  // Every token this call can mint, with NO capture group — the drop step's
  // replace callback reads (match, offset).
  const anyPlaceholder = new RegExp(`@@UN1T_${nonce}_(?:STYLE_\\d+|VIEWPORT)@@`, 'g')

  // 1. Lift and scrub every <style> body. An empty result after the scrub
  //    drops the block entirely.
  out = out.replace(STYLE_BLOCK, (_m, css) => {
    const safe = scrubCss(stripOnAttrsFromCss(css), blockCounter).trim()
    if (!safe) return ''
    styles.push(safe)
    return `@@UN1T_${nonce}_STYLE_${styles.length - 1}@@`
  })
  // 2. Placeholder the FIRST viewport meta ONLY. Every later one is returned
  //    EXACTLY AS AUTHORED, so TAG_STRIP removes it inside the loop below
  //    (`meta` is on that list) and the splice its removal makes is
  //    re-scanned. See review 1 in the header note.
  let viewportSeen = false
  out = out.replace(VIEWPORT_META, (m) => {
    if (viewportSeen) return m
    viewportSeen = true
    return viewportPlaceholder
  })

  // 3. The OUTER fixed point: strip, then drop the placeholders now stranded
  //    inside an open tag — and go round again, because that drop spliced
  //    text together and the splice has not been scanned yet. The loop stops
  //    only when a whole round changes nothing, which is the proof that (a)
  //    no active construct is left and (b) no SURVIVING placeholder sits
  //    inside an open tag.
  //
  //    stripActiveContent gets a FRESH inline-CSS budget every round: the
  //    budget bounds one scan of the document, and a shared one would let the
  //    rounds multiply against it and wipe the inline styles of a large,
  //    entirely legitimate email.
  let converged = false
  for (let i = 0; i < MAX_OUTER_PASSES; i++) {
    const before = out
    out = stripActiveContent(out, { cssChars: 0 })
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
  //    Assert, don't trust: step 2 mints at most ONE viewport placeholder and
  //    a host cannot forge a nonced token, so a second occurrence here would
  //    mean an invariant broke. Fail closed rather than DELETE the extra — a
  //    deletion at this point is the very defect this structure exists to
  //    prevent.
  if (out.split(viewportPlaceholder).length > 2) {
    warnFailClosed('duplicate viewport placeholder')
    return ''
  }

  // 4. Restore. Both replacements are pure INSERTIONS, at positions the final
  //    loop round proved sit in ordinary text, and both insert balanced
  //    markup, so neither can move another placeholder into a tag:
  //      - `<style>` + a scrubCss result + `</style>` — scrubCss's output
  //        provably contains no `<` and no `>` (it ends with
  //        `.replace(/[<>]/g, '')`), so the body cannot close its own element.
  //      - the fixed canonical viewport meta, never the authored one, so no
  //        attribute can be smuggled through it.
  //    Nothing is deleted here.
  out = out.replace(stylePlaceholder, (_m, i) => `<style>${styles[Number(i)] ?? ''}</style>`)
  out = out.split(viewportPlaceholder).join(VIEWPORT_META_SAFE)

  // 5. Defensive: no live token may reach an operator's screen or a mailbox.
  //    Unreachable by construction (step 4 replaces every token this call
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
 * @param {{ host: {name?:string, sender_name?:string}|null, subject: string,
 *   bodyHtml: string, unsubscribeUrl: string }} args
 * @returns {string} full HTML document
 */
export function renderHostCampaignHtml({ host, subject, bodyHtml, unsubscribeUrl }) {
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
  if (/<\s*(!doctype|html)[\s>]/i.test(String(bodyHtml || '').slice(0, 500))) {
    const safeDoc = sanitizeCampaignHtml(bodyHtml)
    const footer = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr><td align="center" style="padding:16px 8px;font-family:${FONT};font-size:11px;line-height:1.5;color:#888888;">${hostName} &middot; <a href="${unsub}" style="color:#888888;text-decoration:underline;">Unsubscribe</a><br>You&#39;re receiving this because you attended an event or joined the mailing list.</td></tr></table>`
    if (/<\/body\s*>/i.test(safeDoc)) {
      return safeDoc.replace(/<\/body\s*>/i, `${footer}</body>`)
    }
    return safeDoc + footer
  }

  const safeBody = sanitizeCampaignHtml(bodyHtml)

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
