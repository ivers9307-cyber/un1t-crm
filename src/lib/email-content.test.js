// COMMS-AUDIT 2026-07-10 — email content helpers.
//
// htmlToPlainText: every marketing/transactional email we send was
// HTML-only (a known spam signal — mixed-part MIME with a coherent
// text alternative scores better with Gmail/Outlook filters). The
// converter is deliberately conservative: strip tags, keep link
// targets, preserve block structure as newlines. It does NOT try to
// be a layout engine.
//
// injectPreheader: campaigns.preview_text was collected by the editor
// and stored but never used at send time. It's injected as the
// standard hidden-preheader pattern (display:none div, first thing
// inside <body>) so inbox list views show the operator's chosen
// snippet instead of whatever text happens to render first.

import { describe, it, expect } from 'vitest'
import { htmlToPlainText, injectPreheader } from './email-content.js'

describe('htmlToPlainText', () => {
  it('returns empty string for empty / null input', () => {
    expect(htmlToPlainText('')).toBe('')
    expect(htmlToPlainText(null)).toBe('')
    expect(htmlToPlainText(undefined)).toBe('')
  })

  it('strips simple tags', () => {
    expect(htmlToPlainText('<p>Hello <strong>world</strong></p>')).toBe('Hello world')
  })

  it('converts <br> and block closers to newlines', () => {
    const out = htmlToPlainText('<p>Line one</p><p>Line two<br>Line three</p>')
    expect(out).toBe('Line one\nLine two\nLine three')
  })

  it('keeps link targets so the text version stays actionable', () => {
    // An unsubscribe or booking link that vanishes in the text part
    // makes the text alternative useless (and spammy — mismatched
    // parts are their own signal). Label (url) is the convention.
    const out = htmlToPlainText('<a href="https://un1t.ie/book">Book now</a>')
    expect(out).toBe('Book now (https://un1t.ie/book)')
  })

  it('does not duplicate the URL when the label IS the url', () => {
    const out = htmlToPlainText('<a href="https://un1t.ie/x">https://un1t.ie/x</a>')
    expect(out).toBe('https://un1t.ie/x')
  })

  it('drops style/script/head blocks entirely', () => {
    const html = '<head><style>.a{color:red}</style></head><body><p>Visible</p><script>alert(1)</script></body>'
    expect(htmlToPlainText(html)).toBe('Visible')
  })

  it('decodes common entities', () => {
    expect(htmlToPlainText('<p>Fish &amp; chips &lt;3 &quot;deal&quot;&nbsp;&#39;now&#39;</p>'))
      .toBe(`Fish & chips <3 "deal" 'now'`)
  })

  it('renders list items with a dash', () => {
    const out = htmlToPlainText('<ul><li>One</li><li>Two</li></ul>')
    expect(out).toBe('- One\n- Two')
  })

  it('collapses runs of whitespace / blank lines', () => {
    const out = htmlToPlainText('<div>  a   </div>\n\n\n<div></div><div>b</div>')
    expect(out).toBe('a\nb')
  })

  it('survives a realistic table-layout email', () => {
    const html = `<html><body>
      <table role="presentation"><tr><td><h1>July offer</h1></td></tr>
      <tr><td><p>Hi Alice,</p><p>Your first class is free.</p></td></tr>
      <tr><td><a href="https://un1t.ie/free-class">Claim it</a></td></tr></table>
    </body></html>`
    const out = htmlToPlainText(html)
    expect(out).toContain('July offer')
    expect(out).toContain('Hi Alice,')
    expect(out).toContain('Claim it (https://un1t.ie/free-class)')
    expect(out).not.toContain('<')
  })
})

describe('injectPreheader', () => {
  it('returns html unchanged when preview text is empty', () => {
    expect(injectPreheader('<body><p>Hi</p></body>', '')).toBe('<body><p>Hi</p></body>')
    expect(injectPreheader('<body><p>Hi</p></body>', null)).toBe('<body><p>Hi</p></body>')
  })

  it('returns falsy html unchanged', () => {
    expect(injectPreheader('', 'Preview')).toBe('')
    expect(injectPreheader(null, 'Preview')).toBeNull()
  })

  it('inserts a hidden div immediately after <body>', () => {
    const out = injectPreheader('<html><body><p>Content</p></body></html>', 'Your July offer inside')
    // First thing inside the body, before any visible content.
    expect(out.indexOf('Your July offer inside')).toBeGreaterThan(out.indexOf('<body>'))
    expect(out.indexOf('Your July offer inside')).toBeLessThan(out.indexOf('<p>Content</p>'))
    expect(out).toMatch(/display:\s*none/)
  })

  it('handles a <body> tag with attributes', () => {
    const out = injectPreheader('<body style="margin:0" class="x"><p>C</p></body>', 'Peek')
    expect(out.indexOf('Peek')).toBeLessThan(out.indexOf('<p>C</p>'))
    expect(out.indexOf('Peek')).toBeGreaterThan(out.indexOf('class="x">'))
  })

  it('prepends when the html has no body tag (snippet bodies)', () => {
    const out = injectPreheader('<p>fragment</p>', 'Peek')
    expect(out.startsWith('<div')).toBe(true)
    expect(out.endsWith('<p>fragment</p>')).toBe(true)
  })

  it('escapes HTML in the preview text (operator input is plain text)', () => {
    const out = injectPreheader('<body><p>C</p></body>', '<script>alert(1)</script> & more')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
    expect(out).toContain('&amp; more')
  })

  it('is hidden with the belt-and-braces client CSS set', () => {
    // The standard pattern needs more than display:none — Outlook
    // ignores it, hence mso-hide + max-height/overflow.
    const out = injectPreheader('<body><p>C</p></body>', 'Peek')
    expect(out).toMatch(/mso-hide:\s*all/)
    expect(out).toMatch(/max-height:\s*0/)
    expect(out).toMatch(/overflow:\s*hidden/)
  })
})
