// EMAIL-TICKET.5 — safe rendering of inbound email HTML.
// Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
//       ("Inbound HTML rendering")
//
// This module exists because rendering a stranger's HTML is the single most
// dangerous thing this CRM does. Email HTML is hostile input from
// unauthenticated senders, and the app has NO page-level CSP to fall back on
// (`next.config.js` grants `frame-ancestors *` to /embed and /book only —
// there is no `script-src` or `default-src` anywhere). So the protection is
// two INDEPENDENT layers, either of which must hold on its own:
//
//   LAYER 1 — the sandboxed iframe (IFRAME_SANDBOX below + emailFrameDocument).
//     No `allow-scripts` means nothing executes even if this sanitiser is
//     bypassed; no `allow-same-origin` means the frame is an opaque origin
//     that cannot touch the CRM's DOM, cookies or Supabase session. It also
//     contains the aggressive global CSS marketing email ships, which would
//     otherwise bleed into the CRM layout.
//   LAYER 2 — this sanitiser, run SERVER-SIDE in the ticket detail route.
//
// SANITISE AT RENDER, NOT AT INGEST. `email_inbox_messages.html_body` keeps
// the raw original (capped 300k on receipt) so this sanitiser can be improved
// later without having destroyed the evidence of what actually arrived.
//
// WHY THE WHOLE DOCUMENT IS BUILT HERE, ON THE SERVER
// The route hands the browser a finished `srcdoc` string, not a fragment. That
// keeps `sanitize-html` (and its postcss/htmlparser2 tree) out of the client
// bundle entirely: NO CLIENT COMPONENT MAY IMPORT THIS MODULE. The two
// browser-side pieces — the sandbox attribute and the show-images swap — are
// pinned by the constants below and asserted against the component's source in
// email-html.test.js.
//
// `import 'server-only'` is the idiomatic way to make that a BUILD error
// rather than a test, and it belongs here — but it cannot land yet. The
// package resolves through its `react-server` export condition, which Next
// applies and vitest does not, so vitest loads the throwing entry point and
// every test in this file dies on import. It needs one line in
// vitest.config.js (`resolve.alias: { 'server-only': …/empty.js }`, or the
// `react-server` condition) which is outside this change's file ownership.
// Until then the guarantee is enforced by a test that scans EVERY 'use client'
// file in src/ — see "no client component imports this module" in the tests.

import sanitizeHtml from 'sanitize-html'

// ── The two constants the browser side must match ────────────────────
//
// NEITHER `allow-scripts` NOR `allow-same-origin`. Both together would be
// worse than no sandbox at all (the frame could reach into the parent and
// remove its own sandbox attribute), and either one alone re-opens Layer 1.
// `allow-popups` (+ escape) is here so a link an operator clicks actually
// opens — without it the click silently does nothing. Neither permits script
// in THIS document: with no `allow-scripts` nothing in the frame can call
// window.open, so a popup still requires a real click.
export const IFRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox'

/**
 * Where a blocked remote image's real URL is parked.
 *
 * Every value under this attribute in our output has been proven to be an
 * absolute http(s) URL by this module and HTML-attribute-escaped by
 * sanitize-html. An incoming `data-original-src` is ALWAYS discarded (see the
 * img transform) so a sender cannot smuggle a URL straight into the unblocked
 * state.
 */
export const ORIGINAL_SRC_ATTR = 'data-original-src'

/**
 * The scheme a remote CSS `url()` is parked behind.
 *
 * A CSS background image is a tracking pixel wearing a stylesheet, so it is
 * blocked on exactly the same footing as <img> — but CSS has nowhere to park
 * a spare attribute, so the URL is left in place under a scheme no browser can
 * resolve. Nothing is fetched until the same "Show images" action removes it.
 * The token is deliberately odd so it cannot collide with words in an email.
 */
export const BLOCKED_CSS_URL_PREFIX = 'x-un1t-blocked:'

// "Show images" is a rename, not a re-sanitisation. Two replacements, both on
// the FINISHED document string:
//   ` data-original-src="`  →  ` src="`     (the <img> case)
//   `x-un1t-blocked:`       →  ``           (the CSS url() case)
// TicketThread.jsx performs exactly these. They are safe because of the
// guarantee above — every parked value was proven http(s) here and escaped by
// sanitize-html — and because Layer 1 means even a botched swap cannot execute
// anything. In a text node the literal string would simply stay a text node
// (`<` and `>` are escaped there), so no tag or attribute can be forged by it.
export const UNBLOCK_IMAGES_FROM = ` ${ORIGINAL_SRC_ATTR}="`
export const UNBLOCK_IMAGES_TO = ' src="'

/** The show-images swap. Pure string work — no parsing, no re-sanitising. */
export function unblockImages(html) {
  return String(html || '')
    .split(UNBLOCK_IMAGES_FROM).join(UNBLOCK_IMAGES_TO)
    .split(BLOCKED_CSS_URL_PREFIX).join('')
}

// ── Sanitiser configuration ──────────────────────────────────────────
//
// PERMISSIVE ON PRESENTATION, STRICT ON EXECUTION (Richard, 2026-08-07).
// The mail that actually lands in this queue is forwarded marketing, other
// systems' receipts and newsletters: table-based layout, inline styles, a
// <style> block, remote images. Sanitise presentation away and every one of
// them renders as a column of naked text — which is the exact failure the
// feature exists to fix. The asymmetry is what Layer 1 buys: inside a frame
// with no allow-scripts and no allow-same-origin, CSS cannot execute, cannot
// reach the parent document and cannot read a cookie, so Layer 2 does not have
// to be brutal about styling. It only has to be absolute about execution and
// about the network.

// Email is table-shaped and old-fashioned: <center>, <font> and bgcolor are
// still how mail-merge templates lay themselves out, so they stay. `style` is
// here deliberately — stripping <style> blocks breaks most real email — and
// its CSS is scrubbed by scrubCss() below.
const ALLOWED_TAGS = [
  ...sanitizeHtml.defaults.allowedTags,
  'img', 'style', 'center', 'font', 'big', 'strike', 'del', 'ins', 'tt',
]

// Presentational attributes only. NOTE WHAT IS ABSENT ON <img>: `src` and
// `srcset` are NOT allowed at all, so even if the transform below were
// bypassed no image can carry a live URL out of here — a remote fetch only
// becomes possible after the operator's explicit show-images swap.
const ALLOWED_ATTRIBUTES = {
  '*': [
    // `bgcolor` is a colour and stays; `background` is a URL and does NOT —
    // <td background="http://tracker/x.png"> is a tracking pixel wearing a
    // table cell, and would walk straight past the <img> blocking below.
    // `id` and `class` are here because <style> is allowed: a stylesheet that
    // cannot see the selectors it was written against styles nothing. Neither
    // is a risk without scripts — DOM clobbering needs script to clobber.
    // `role` is how email marks a layout table as presentational; dropping it
    // makes a screen reader read the layout out loud as data.
    'style', 'class', 'id', 'role', 'title', 'dir', 'lang', 'align', 'valign',
    'bgcolor', 'width', 'height', 'colspan', 'rowspan', 'span',
    'border', 'cellpadding', 'cellspacing', 'nowrap', 'scope', 'type', 'start',
  ],
  a: ['href', 'name', 'title', 'target', 'rel'],
  img: ['alt', 'title', 'width', 'height', 'align', 'border', 'style', ORIGINAL_SRC_ATTR],
  font: ['color', 'face', 'size'],
}

// Tags whose TEXT is dropped along with the tag. Without this, a disallowed
// tag keeps its inner text — `<title>` would leak the document title into the
// body and `<script>`'s source would render as visible nonsense. `svg`/`math`
// are here because they are foreign-content parsers with their own escaping
// rules; nothing inside them is content worth reading in an email.
//
// TWO THINGS THAT MUST NOT JOIN THIS LIST:
//   • `style` — it is ALLOWED now, and listing it would drop the CSS.
//   • `head` — real email puts its <style> in the head, and skipping the
//     head's contents would throw that stylesheet away with it. Head is
//     discarded as a tag; its children are judged on their own.
// Void elements (`link`, `meta`, `base`, `input`) are also deliberately
// absent: skipText is only cleared by a close tag, so a void element here
// risks swallowing the rest of the document. They carry no text anyway.
const NON_TEXT_TAGS = [
  'script', 'textarea', 'option', 'xmp', 'noscript',
  'title', 'iframe', 'object', 'embed', 'applet',
  'svg', 'math', 'template', 'frameset',
]

// No `ftp` (sanitize-html allows it by default), and emphatically no `data:`,
// `javascript:`, `vbscript:` or `cid:`. Protocol-relative URLs (`//host/x`)
// are refused too — they inherit whatever scheme the frame ends up with.
const ALLOWED_SCHEMES = ['http', 'https', 'mailto', 'tel']

// A CSS token that tries to EXECUTE. All of these are dead in every browser
// shipping today (`expression()` and `behavior:` were IE, `-moz-binding` went
// in Firefox 63) and none could run inside a frame with no allow-scripts
// anyway — they are stripped as cheap defence in depth, not because they are
// the live risk. The live risk is the network, handled by parkCssUrls().
const EXECUTABLE_KEYWORD =
  /expression\s*\(|behaviou?r\s*:|-moz-binding|javascript\s*:|vbscript\s*:/i

/**
 * Drop every declaration containing an executable keyword — in LINEAR time.
 *
 * THE REGEX THAT USED TO DO THIS WAS A DENIAL-OF-SERVICE HOLE. `[^;{}]*<kw>[^;{}]*`
 * is quadratic on a long run with no `;{}` in it: measured 9.1s at 100k, 36.8s
 * at 200k, 82.6s at 300k of blocking CPU. `HTML_BODY_MAX_CHARS` is exactly
 * 300,000, so `<style>` + 299k of one letter was a reachable, unauthenticated
 * way to make a ticket permanently unopenable — send it and every timeout on
 * the path blows, forever. Splitting on the delimiters instead is linear and
 * finishes the same 300k in about a millisecond.
 */
function dropExecutableDeclarations(css) {
  return css
    .split(/([;{}])/)
    .map(part => (part.length === 1 && ';{}'.includes(part)
      ? part
      : (EXECUTABLE_KEYWORD.test(part) ? '' : part)))
    .join('')
}

// url(...) up to the first `)`. The character class excludes `(` and `)`, so
// the greedy match stops dead at the closing paren and the `\)` that follows
// matches immediately — no backtracking. The bound is belt-and-braces against
// a run with no `)` at all; a real CSS URL is never near it, and one that
// exceeds it falls through to the UNPARKED_CSS_URL backstop and is dropped,
// which errs towards "do not fetch".
const CSS_URL = /url\(([^()]{0,1024})\)/gi

// The backstop for a url() the pattern above could NOT match — an unclosed
// one, most of all. CSS error recovery closes open constructs at end of input,
// so a stylesheet ending `background:url(https://tracker/x` really does fetch
// in a browser while matching nothing here. After parking, any surviving
// `url(` that is not one of ours (or an inert cid:) is renamed to an unknown
// function, which makes its declaration invalid and drops it.
const UNPARKED_CSS_URL = new RegExp(
  `url\\(\\s*(?!['"]?(?:${BLOCKED_CSS_URL_PREFIX}|cid:))`, 'gi',
)

// EVERY REMAINING REMOTE REFERENCE, whatever function it sits in.
//
// Enumerating URL-bearing CSS functions is a losing game: `url()` was the
// whole list until `image-set("https://…" 1x)` — which takes a BARE STRING,
// no url() anywhere — walked a tracking pixel straight past the parking with
// blockedImages at 0, so the operator saw no "Show images" button and no
// warning at all. `-webkit-image-set`, `cross-fade` and `src()` do the same,
// and CSS Images 4 will add more.
//
// So the rule is not "park these functions" but "park every remote reference
// left in the CSS". Anything that survives to here is either in a function we
// did not think of, or in a string where it is inert — and parking an inert
// one costs nothing but a slightly generous blocked count.
const REMAINING_REMOTE = new RegExp(`(?<!${BLOCKED_CSS_URL_PREFIX})https?:\\/\\/`, 'gi')

// A quoted protocol-relative URL — `image-set("//tracker/x.gif" 1x)` — resolves
// to https: and fetches just the same.
const QUOTED_PROTOCOL_RELATIVE = /(['"])\s*\/\//g

/**
 * Park or drop every network reference in a chunk of CSS.
 *
 * http(s) is parked behind BLOCKED_CSS_URL_PREFIX — an unresolvable scheme, so
 * the browser fetches nothing — and counted, so the message shows the same
 * "Show images" affordance an <img> would. `cid:` (an inline attachment we do
 * not re-host yet) is inert in a browser and left alone. Everything else,
 * `data:` included, becomes `none`: there is nothing there worth rendering and
 * `data:` is on the strip list.
 */
function parkCssUrls(css, counter) {
  const parked = css.replace(CSS_URL, (match, inner) => {
    const trimmed = String(inner).trim()
    const quote = (trimmed.startsWith('"') || trimmed.startsWith("'")) ? trimmed[0] : ''
    const url = (quote
      ? trimmed.slice(1, trimmed.endsWith(quote) ? -1 : undefined)
      : trimmed).trim()
    // IDEMPOTENT. Scrubbing twice must be harmless: sanitize-html runs the
    // tag-specific transform and then the '*' one, so a style attribute on an
    // <a> or an <img> passed through here twice — and the second pass, seeing
    // its own unresolvable `x-un1t-blocked:` scheme, threw the parked URL away
    // as junk and turned every CTA background into `none`.
    if (url.toLowerCase().startsWith(BLOCKED_CSS_URL_PREFIX)) return match
    if (isRemoteImageUrl(url)) {
      counter.blocked += 1
      return `url(${quote}${BLOCKED_CSS_URL_PREFIX}${url}${quote})`
    }
    if (/^cid:/i.test(url)) return match
    return 'none'
  })

  return parked
    .replace(UNPARKED_CSS_URL, 'none(')
    .replace(REMAINING_REMOTE, m => { counter.blocked += 1; return `${BLOCKED_CSS_URL_PREFIX}${m}` })
    .replace(QUOTED_PROTOCOL_RELATIVE, (m, q) => {
      counter.blocked += 1
      return `${q}${BLOCKED_CSS_URL_PREFIX}//`
    })
}

// No single stylesheet or style attribute in a real email is this big, and no
// message needs this much CSS scrubbed in total. Past either bound the CSS is
// dropped rather than processed: the linear scrub makes this belt-and-braces
// rather than load-bearing, but a bound that exists cannot be a DoS.
const CSS_CHUNK_MAX_CHARS = 100_000
const CSS_TOTAL_MAX_CHARS = 250_000

/**
 * Scrub a stylesheet or an inline declaration list.
 *
 * Backslashes go first and unconditionally. A CSS escape is the one way to
 * hide a keyword from a regex — `u\72 l(https://tracker/x)` is a real url()
 * to a browser and not one to this filter — and legitimate email CSS
 * essentially never contains one. Removing them cannot create a token that
 * was not already there, so it is safe to do before matching.
 *
 * `@import` is stripped for the same reason remote images are blocked: it is
 * an unconsented network fetch that reports the studio's read and leaks the
 * IP. Unlike an image it cannot be un-blocked later, because a stylesheet can
 * change far more than a picture.
 *
 * ANGLE BRACKETS GO LAST, AND THAT ORDERING IS THE WHOLE POINT.
 * sanitize-html emits <style> bodies VERBATIM — its own source says escaping
 * them would ruin the CSS — so this function's output is re-wrapped in a
 * literal <style> element without ever being escaped. Every deletion above is
 * therefore a weapon: any of them sitting between a `<` and a `/style` + `>`
 * RECONSTITUTES A REAL CLOSING TAG, and everything after it becomes live,
 * unsanitised HTML in the frame. Three worked (see the corpus in
 * email-html.test.js for the literal payloads): a backslash between the two
 * halves, killed by the backslash strip; a CSS comment between them, killed by
 * the comment strip; an @import between them, killed by the @import strip.
 * htmlparser2 does not end the element on any of them, so the sanitiser reads
 * straight through and the lazy STYLE_BLOCK capture does not see the disguised
 * close either.
 *
 * Stripping `<` and `>` after every deletion makes the output provably free of
 * both characters, so no ordering of deletions — present or future — can build
 * a tag out of it. CSS needs neither character.
 */
function scrubCss(css, counter) {
  const input = String(css)
  if (input.length > CSS_CHUNK_MAX_CHARS) return ''
  if (counter.cssChars + input.length > CSS_TOTAL_MAX_CHARS) return ''
  counter.cssChars += input.length

  const stripped = input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\/g, '')
    .replace(/@import[^;{}]*;?/gi, '')
  return parkCssUrls(dropExecutableDeclarations(stripped), counter)
    // Any executable or inline scheme still standing — inside a url() whose
    // own parentheses defeated the pattern above, say — has its colon broken,
    // which is all a scheme is. In CSS these only ever appear in URLs.
    .replace(/\b(data|javascript|vbscript)\s*:/gi, '$1-')
    .replace(/[<>]/g, '')
}

/** The inline `style=` attribute — the same scrub, trimmed for tidiness. */
function safeStyle(value, counter) {
  return scrubCss(value, counter)
    .split(';')
    .map(d => d.trim())
    .filter(Boolean)
    .join('; ')
}

// <style> bodies are the one thing sanitize-html hands back VERBATIM (it
// cannot escape them without destroying the CSS), so they are scrubbed
// afterwards, on the output. What goes back between the tags is guaranteed by
// scrubCss() to contain no `<` and no `>`, so the only closing tag in the
// result is the one written here.
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/gi

function scrubStyleBlocks(html, counter) {
  return html.replace(STYLE_BLOCK, (match, css) => {
    const safe = scrubCss(css, counter).trim()
    return safe ? `<style>${safe}</style>` : ''
  })
}

/**
 * Is this an absolute http(s) URL?
 *
 * Leading control characters are stripped first for the same reason
 * sanitize-html strips them: browsers ignore them when resolving a scheme, so
 * `\x01https://…` and `java\tscript:…` must be judged on the cleaned string.
 * Anything that is not plainly http(s) — a relative path, `cid:` for an inline
 * attachment we have not re-hosted, a protocol-relative `//host` — is treated
 * as "no image", never as "load it".
 */
export function isRemoteImageUrl(value) {
  const cleaned = String(value || '').replace(/[\x00-\x20]+/g, '')
  return /^https?:\/\/./i.test(cleaned)
}

function buildOptions(counter) {
  return {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    nonTextTags: NON_TEXT_TAGS,
    allowedSchemes: ALLOWED_SCHEMES,
    // Scheme-check the parked URL as well, so the library is a second pair of
    // eyes on the attribute the show-images swap will promote to `src`.
    allowedSchemesAppliedToAttributes: [
      ...sanitizeHtml.defaults.allowedSchemesAppliedToAttributes,
      ORIGINAL_SRC_ATTR,
    ],
    allowProtocolRelative: false,
    allowedEmptyAttributes: ['alt'],
    // Silences sanitize-html's console.warn that `style` in allowedTags is
    // "inherently vulnerable to XSS" — a warning on EVERY call, against this
    // repo's no-console convention.
    //
    // IT IS ONLY HONEST TO SET THIS BECAUSE OF scrubCss()'s ANGLE-BRACKET
    // STRIP. The warning is the library flagging exactly the escape that was
    // live here: <style> bodies are emitted verbatim, so a deletion between a
    // `<` and a `/style>` reconstituted the closing tag and handed over
    // arbitrary unsanitised HTML. Silencing it before that fix would have been
    // precisely wrong. If the strip is ever removed, remove this too.
    allowVulnerableTags: true,
    // The style attribute is scrubbed by scrubCss() in the transforms below,
    // so sanitize-html's own postcss pass adds nothing but risk: it
    // re-stringifies (losing the sender's spacing) and console.warns on CSS it
    // cannot parse — and marketing email ships plenty it cannot parse. The
    // value is HTML-escaped on output either way.
    parseStyleAttributes: false,
    transformTags: {
      '*': (tagName, attribs) => {
        // on* handlers are already dropped by the attribute allowlist; the
        // work here is the style attribute, which the allowlist lets through
        // as an opaque string.
        if (attribs.style) {
          const style = safeStyle(attribs.style, counter)
          if (style) attribs.style = style
          else delete attribs.style
        }
        return { tagName, attribs }
      },
      a: (tagName, attribs) => {
        // The style is carried across: email CTAs are <a> elements painted to
        // look like buttons, and dropping their style renders the call to
        // action as plain blue text. It is NOT scrubbed here — the '*'
        // transform runs after this one and does that, once.
        return {
          tagName: 'a',
          attribs: {
            ...(attribs.href ? { href: attribs.href } : {}),
            ...(attribs.title ? { title: attribs.title } : {}),
            ...(attribs.style ? { style: attribs.style } : {}),
            // Overwritten, never merged: a sender-supplied target/rel is
            // exactly what we are here to replace.
            target: '_blank',
            rel: 'noopener noreferrer nofollow',
          },
        }
      },
      img: (tagName, attribs) => {
        // Rebuilt from scratch rather than edited: whatever the sender put on
        // this tag — src, srcset, data-original-src, onerror — is gone unless
        // it is copied across deliberately below.
        const out = {}
        for (const key of ['alt', 'title', 'width', 'height', 'align', 'border']) {
          if (attribs[key]) out[key] = attribs[key]
        }
        // Carried across raw; the '*' transform scrubs it after this returns.
        if (attribs.style) out.style = attribs.style
        if (isRemoteImageUrl(attribs.src)) {
          out[ORIGINAL_SRC_ATTR] = String(attribs.src).trim()
          counter.blocked += 1
          if (!out.alt) out.alt = 'Blocked image'
        } else if (!out.alt) {
          out.alt = ''
        }
        return { tagName: 'img', attribs: out }
      },
    },
  }
}

/**
 * Sanitise one email body.
 *
 * @returns {{ html: string, blockedImages: number }}
 * @throws whatever the parser throws — callers use emailHtmlDocument(), which
 *         turns a throw into "render the plain text with a notice". There is
 *         no code path that returns unsanitised HTML.
 */
export function sanitizeEmailHtml(raw) {
  // `cssChars` is the per-message CSS budget, shared by every style attribute
  // and every <style> block in this one email.
  const counter = { blocked: 0, cssChars: 0 }
  const html = sanitizeHtml(String(raw ?? ''), buildOptions(counter))
  // <style> bodies survive sanitize-html verbatim by design, so the CSS scrub
  // runs on the output. Everything else was handled inside the parser.
  return { html: scrubStyleBlocks(html, counter), blockedImages: counter.blocked }
}

// ── The document the iframe renders ──────────────────────────────────

// Deliberately minimal — a canvas, not a restyle.
//
// TWO THINGS IT MUST DO AND ONE IT MUST NOT.
//   • An explicit WHITE background and dark text. Email HTML assumes a white
//     canvas; dropped into a transparent frame, light-grey-on-white body copy
//     disappears and dark-mode-aware CSS renders white on white.
//   • A visible placeholder for every blocked image, so "the pictures are off"
//     reads as a decision rather than as a broken email.
//   • It must NOT clamp width. Marketing email is routinely a 600px fixed
//     table; `max-width:100%` would squash the layout it was designed as.
//     The frame scrolls horizontally inside its own box instead, so a wide
//     email never widens the CRM.
// These are the frame's own defaults and come FIRST, so an email's <style>
// (which lands in the body, after them) still wins — that is the point.
const FRAME_CSS = `
html{background:#fff}
html,body{margin:0;padding:0}
body{background:#fff;color:#111;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:12px}
img{height:auto}
a{color:#2563eb}
img[${ORIGINAL_SRC_ATTR}]{min-width:14px;min-height:14px;border:1px dashed #cbd5e1;background:#f8fafc;color:#64748b;font-size:11px;padding:2px}
blockquote{margin:0 0 0 8px;padding-left:10px;border-left:2px solid #e2e8f0;color:#475569}
`.trim()

/**
 * Wrap sanitised body HTML in the document the iframe's `srcdoc` gets.
 *
 * `referrer: no-referrer` matters once an operator clicks show-images: the
 * remote host learns nothing about which CRM page requested the pixel.
 */
export function emailFrameDocument(bodyHtml) {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="referrer" content="no-referrer">'
    + '<meta name="color-scheme" content="light">'
    + `<style>${FRAME_CSS}</style></head><body>${bodyHtml}</body></html>`
}

/**
 * The whole render decision for one message, as the route reports it.
 *
 * @returns {{ document: string|null, blockedImages: number, failed: boolean }}
 *   `document` — the complete srcdoc, or null to fall back to text_body.
 *   `failed`   — sanitisation threw. The caller shows the text with a visible
 *                "HTML could not be displayed safely" notice. It NEVER falls
 *                back to the raw input.
 */
export function emailHtmlDocument(raw) {
  const empty = { document: null, blockedImages: 0, failed: false }
  if (!raw || typeof raw !== 'string' || !raw.trim()) return empty
  try {
    const { html, blockedImages } = sanitizeEmailHtml(raw)
    // A body that sanitises down to nothing (an image-only tracker, a bare
    // <script>) is not worth an empty frame — fall through to the text.
    if (!html.trim()) return empty
    return { document: emailFrameDocument(html), blockedImages, failed: false }
  } catch {
    return { document: null, blockedImages: 0, failed: true }
  }
}
