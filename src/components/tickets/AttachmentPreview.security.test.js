// EMAIL-ATTACH-PREVIEW.1 — assertions against the SOURCE of the two components
// that put a stranger's file on an operator's screen.
//
// Why source assertions rather than only behavioural ones: the properties that
// matter here are absences. Nothing renders differently, no test about pictures
// turns red, and no operator notices if someone swaps the attachment <img> for
// an <object>, reaches for React's raw-HTML escape hatch, or drops the
// cross-origin check on the PDF frame. Each of those quietly deletes a layer.
// This is the same technique src/lib/email-html.test.js uses on the email
// iframe's sandbox attribute, and for the same reason.
//
// Read as CODE, not prose: the scans below look at what the file DOES, so a
// comment explaining a rule can never be mistaken for a violation of it.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const read = (rel) => readFileSync(path.join(process.cwd(), rel), 'utf8')

// Comments stripped, so every assertion below is about what the file DOES. A
// header comment naming `<iframe>` or the raw-HTML prop must not read as a use
// of one — and a violation must not be hideable inside a comment either.
function codeOf(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const PREVIEW = codeOf(read('src/components/tickets/AttachmentPreview.jsx'))
const THREAD = codeOf(read('src/components/tickets/TicketThread.jsx'))

// The raw-HTML escape hatch, spelled in pieces so this file does not itself
// trip a scanner looking for the literal.
const RAW_HTML_PROP = `dangerously${'Set'}${'InnerHTML'}`

/** JSX element names actually rendered. */
function elementsIn(code) {
  return [...code.matchAll(/<([A-Za-z][A-Za-z0-9]*)[\s/>]/g)].map(m => m[1])
}

describe('the attachment overlay never gives hostile bytes an executing context', () => {
  const elements = elementsIn(PREVIEW)

  it('renders no <object>, <embed>, <svg> or <script>', () => {
    // <img> and <iframe> are the only two containers this feature may use, and
    // each is defended separately below. <object>/<embed> would run a plugin
    // and, for an SVG, would execute its script.
    for (const forbidden of ['object', 'embed', 'svg', 'script']) {
      expect(elements).not.toContain(forbidden)
    }
  })

  it('never uses React’s raw-HTML escape hatch', () => {
    expect(PREVIEW).not.toContain(RAW_HTML_PROP)
    expect(THREAD).not.toContain(RAW_HTML_PROP)
  })

  it('never pulls the HTML sanitiser into the client bundle', () => {
    // Same rule as the thread: a sanitiser in the browser proves nothing about
    // what the server sent, and drags postcss/htmlparser2 with it.
    const imports = [...PREVIEW.matchAll(/^import[^\n]*?from\s+'([^']+)'/gm)].map(m => m[1])
    expect(imports).not.toContain('@/lib/email-html')
    expect(imports).not.toContain('sanitize-html')
  })

  it('never opens an inline preview URL in a tab, or navigates to one', () => {
    // window.open is permitted for the DOWNLOAD url only — that response
    // carries Content-Disposition: attachment, so the browser saves rather
    // than renders. An inline URL opened in a tab is a rendering context, and
    // for an SVG it would be a scripting one. The overlay must therefore only
    // ever put an inline URL into an element's src.
    const opens = [...PREVIEW.matchAll(/window\.open\(([^)]*)\)/g)].map(m => m[1])
    expect(opens.length).toBeGreaterThan(0)
    for (const args of opens) {
      expect(args).toContain('j.data.url')
      expect(args).not.toContain('state.url')
    }
    expect(PREVIEW).not.toContain('location.href =')
    expect(PREVIEW).not.toContain('location.assign')
  })
})

describe('the image container', () => {
  it('is an <img>, and it handles its own failure', () => {
    expect(elementsIn(PREVIEW)).toContain('img')
    // A preview that fails must degrade to the honest "download instead"
    // panel, never to a browser's broken-image glyph.
    expect(PREVIEW).toMatch(/onError=\{\(\)\s*=>\s*setImageFailed\(true\)\}/)
  })
})

describe('the PDF frame', () => {
  it('is only rendered behind an isCrossOriginUrl check', () => {
    // THE PROPERTY: a framed PDF is walled off from this page's DOM, cookies
    // and Supabase session by the same-origin policy — which holds only
    // because the signed URL is on the Storage origin. That is checked, not
    // assumed, and the check must sit ABOVE the frame.
    expect(PREVIEW).toContain('isCrossOriginUrl(url, pageOrigin)')
    const guardAt = PREVIEW.indexOf('isCrossOriginUrl(url, pageOrigin)')
    const frameAt = PREVIEW.indexOf('<iframe')
    expect(guardAt).toBeGreaterThan(-1)
    expect(frameAt).toBeGreaterThan(guardAt)
  })

  it('is the only iframe in the file, and it is never fed inline content', () => {
    // srcDoc would make the frame content authored by us rather than a remote
    // cross-origin fetch, which is the whole basis of the separation above.
    expect(elementsIn(PREVIEW).filter(e => e === 'iframe')).toHaveLength(1)
    expect(PREVIEW).not.toContain('srcDoc')
  })

  it('sends no referrer to Storage', () => {
    expect(PREVIEW).toContain('referrerPolicy="no-referrer"')
  })
})

describe('the thread itself renders no attachment bytes', () => {
  it('draws no remote content of its own', () => {
    const elements = elementsIn(THREAD)
    // The thread's ONE iframe is the sanitised email document (EMAIL-TICKET.5),
    // asserted in src/lib/email-html.test.js. Nothing else in the file may draw
    // remote bytes — attachments are chips, and the overlay owns the rest.
    expect(elements.filter(e => e === 'iframe')).toHaveLength(1)
    expect(elements).not.toContain('img')
    expect(elements).not.toContain('object')
    expect(elements).not.toContain('embed')
  })

  it('never decides for itself what is previewable', () => {
    // The allow-list has one home: the server. The thread reads `preview_kind`
    // off the payload; if it ever started computing it, a client-side copy
    // could drift from the rule the route enforces.
    expect(THREAD).not.toContain('attachmentPreviewKind')
    expect(THREAD).not.toContain('isPreviewableAttachment')
    expect(THREAD).not.toContain('PREVIEWABLE_')
  })

  it('still renders a not-stored attachment’s reason, in words, on the chip', () => {
    // The regression that would hurt most: a redesign that turns every
    // attachment into a clickable chip and quietly drops the sentence
    // explaining that this one has no bytes. Staff act on that text.
    expect(THREAD).toContain('SKIPPED_REASON_LABEL[att.skipped_reason]')
  })
})
