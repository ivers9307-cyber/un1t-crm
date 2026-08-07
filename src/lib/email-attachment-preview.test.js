// EMAIL-ATTACH-PREVIEW.1 — the allow-list, and the things it must never grow.
//
// The tests that matter most here are the NEGATIVE ones. A preview feature is
// easy to test in the happy direction (a JPEG shows) and the happy direction is
// not what can hurt anyone. What can hurt is a type quietly acquiring a preview
// — so SVG, HTML and the rest are asserted by name, and the allow-lists are
// asserted by their exact contents so that adding an entry is a deliberate,
// visible act rather than a diff nobody reads.

import { describe, it, expect } from 'vitest'
import {
  PREVIEWABLE_IMAGE_MIME_TYPES,
  PREVIEWABLE_DOCUMENT_MIME_TYPES,
  attachmentPreviewKind,
  isPreviewableAttachment,
  attachmentIconKind,
  attachmentPreviewNotice,
  isCrossOriginUrl,
} from './email-attachment-preview'

describe('the allow-list itself', () => {
  it('is exactly the four universally-renderable raster types', () => {
    // Stated as an equality, not a membership check: this is the whole
    // security surface of the feature, and it should not be possible to widen
    // it without this line turning red.
    expect([...PREVIEWABLE_IMAGE_MIME_TYPES]).toEqual([
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    ])
  })

  it('is exactly PDF on the document side', () => {
    expect([...PREVIEWABLE_DOCUMENT_MIME_TYPES]).toEqual(['application/pdf'])
  })

  it('is frozen, so nothing can push onto it at runtime', () => {
    expect(Object.isFrozen(PREVIEWABLE_IMAGE_MIME_TYPES)).toBe(true)
    expect(Object.isFrozen(PREVIEWABLE_DOCUMENT_MIME_TYPES)).toBe(true)
  })

  it('contains no wildcard, prefix or pattern — only literal types', () => {
    for (const t of [...PREVIEWABLE_IMAGE_MIME_TYPES, ...PREVIEWABLE_DOCUMENT_MIME_TYPES]) {
      expect(t).toMatch(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/)
      expect(t).not.toContain('*')
    }
  })
})

describe('SVG', () => {
  // The single most important assertion in this file. An SVG is scriptable
  // markup from an unauthenticated stranger; the moment it is "previewable"
  // it is one UI refactor away from executing.
  it('is NEVER previewable', () => {
    expect(attachmentPreviewKind('image/svg+xml')).toBeNull()
    expect(isPreviewableAttachment('image/svg+xml')).toBe(false)
  })

  it('is not previewable under any casing or parameter dressing', () => {
    for (const dressed of [
      'IMAGE/SVG+XML',
      'image/svg+xml; charset=utf-8',
      '  image/svg+xml  ',
      'image/svg+xml;name="x.svg"',
    ]) {
      expect(isPreviewableAttachment(dressed)).toBe(false)
    }
  })

  it('is not in either allow-list', () => {
    expect(PREVIEWABLE_IMAGE_MIME_TYPES).not.toContain('image/svg+xml')
    expect(PREVIEWABLE_DOCUMENT_MIME_TYPES).not.toContain('image/svg+xml')
  })

  it('cannot be promoted by a .png filename — the type decides, the name never does', () => {
    // attachmentPreviewKind takes no filename at all, which is the guarantee.
    // Asserted through the exported surface so a future signature change that
    // added one would fail here.
    expect(attachmentPreviewKind.length).toBe(1)
    expect(isPreviewableAttachment('image/svg+xml')).toBe(false)
  })

  it('says why, plainly, instead of showing a blank box', () => {
    expect(attachmentPreviewNotice('image/svg+xml', 'logo.svg')).toMatch(/never previewed/i)
    expect(attachmentPreviewNotice('image/svg+xml', 'logo.svg')).toMatch(/download/i)
  })
})

describe('other scriptable or hostile types are absent too', () => {
  // A deny-list would have had to name each of these. The allow-list means
  // this test is a demonstration, not the mechanism.
  it.each([
    'text/html',
    'application/xhtml+xml',
    'image/svg+xml-compressed',
    'application/xml',
    'text/xml',
    'application/javascript',
    'text/javascript',
    'application/x-shockwave-flash',
    'application/octet-stream',
    'application/zip',
  ])('%s is download-only', (mime) => {
    expect(isPreviewableAttachment(mime)).toBe(false)
  })

  it('a junk or absent type falls through to download-only', () => {
    for (const junk of [null, undefined, '', 'not a mime', 42, {}, 'image', 'image/']) {
      expect(isPreviewableAttachment(junk)).toBe(false)
    }
  })
})

describe('HEIC / HEIF', () => {
  // Not a security call — a rendering one. iPhones send these constantly and
  // Chrome and Firefox cannot decode them, so a preview would be a permanently
  // broken image rather than a picture.
  it('is not previewable', () => {
    expect(isPreviewableAttachment('image/heic')).toBe(false)
    expect(isPreviewableAttachment('image/heif')).toBe(false)
  })

  it('is still recognised as an image for the icon', () => {
    expect(attachmentIconKind('image/heic')).toBe('image')
    expect(attachmentIconKind('image/heif')).toBe('image')
  })

  it('explains the actual reason, and names where the photo came from', () => {
    const notice = attachmentPreviewNotice('image/heic', 'IMG_4821.heic')
    expect(notice).toMatch(/HEIC/)
    expect(notice).toMatch(/iPhone/i)
    expect(notice).toMatch(/download/i)
  })

  it('explains it from the filename too, for a photo whose type arrived mangled', () => {
    expect(attachmentPreviewNotice('application/octet-stream', 'IMG_4821.HEIC')).toMatch(/HEIC/)
  })
})

describe('the previewable types', () => {
  it.each(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])('%s previews as an image', (mime) => {
    expect(attachmentPreviewKind(mime)).toBe('image')
  })

  it('PDF previews as a pdf, which is a different renderer', () => {
    expect(attachmentPreviewKind('application/pdf')).toBe('pdf')
  })

  it('survives the casing and parameters a real Content-Type arrives with', () => {
    expect(attachmentPreviewKind('IMAGE/JPEG')).toBe('image')
    expect(attachmentPreviewKind('image/jpeg; name="photo.jpg"')).toBe('image')
    expect(attachmentPreviewKind('application/pdf; charset=binary')).toBe('pdf')
  })
})

describe('icons', () => {
  it.each([
    ['application/pdf', 'pdf'],
    ['application/msword', 'doc'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc'],
    ['application/vnd.ms-excel', 'sheet'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sheet'],
    ['text/csv', 'sheet'],
    ['application/vnd.ms-powerpoint', 'slides'],
    ['application/zip', 'archive'],
    ['text/plain', 'text'],
    ['image/png', 'image'],
    ['image/tiff', 'image'],
    ['application/octet-stream', 'file'],
  ])('%s → %s', (mime, kind) => {
    expect(attachmentIconKind(mime)).toBe(kind)
  })

  // THE PPTX HOLE, stated as a test so it cannot be "fixed" by accident and
  // leave the fallback looking pointless. safeMimeType() caps a subtype at 60
  // characters; the real .pptx subtype is 61, so every PowerPoint deck is
  // recorded as application/octet-stream. The type is therefore useless for
  // this one format and the filename is all there is.
  it('falls back to the filename when the type says nothing (the .pptx case)', () => {
    const pptx = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    expect(attachmentIconKind(pptx, 'Q3 deck.pptx')).toBe('slides')
    expect(attachmentIconKind('application/octet-stream', 'Q3 deck.pptx')).toBe('slides')
    expect(attachmentPreviewNotice('application/octet-stream', 'Q3 deck.pptx')).toMatch(/PowerPoint/)
  })

  it('prefers the TYPE over the filename when the type is informative', () => {
    // A .png name on a PDF must not turn it into an image — this is the
    // display half of "the filename never decides anything".
    expect(attachmentIconKind('application/pdf', 'invoice.png')).toBe('pdf')
  })

  it('a filename with no extension, or a hostile one, still resolves', () => {
    expect(attachmentIconKind('application/octet-stream', 'noextension')).toBe('file')
    expect(attachmentIconKind('application/octet-stream', '.hidden')).toBe('file')
    expect(attachmentIconKind('application/octet-stream', 'x.')).toBe('file')
    expect(attachmentIconKind('application/octet-stream', null)).toBe('file')
  })
})

describe('the no-preview sentence', () => {
  it('always says what to do next rather than just refusing', () => {
    for (const [mime, name] of [
      ['application/vnd.ms-excel', 'members.xls'],
      ['application/msword', 'letter.doc'],
      ['application/vnd.ms-powerpoint', 'deck.ppt'],
      ['application/zip', 'photos.zip'],
      ['application/octet-stream', 'mystery.bin'],
      ['image/tiff', 'scan.tiff'],
    ]) {
      const notice = attachmentPreviewNotice(mime, name)
      expect(notice.length).toBeGreaterThan(20)
      expect(notice.toLowerCase()).toContain('download')
    }
  })

  it('names the application an operator would actually open it in', () => {
    expect(attachmentPreviewNotice('application/msword', 'x.doc')).toMatch(/Word/)
    expect(attachmentPreviewNotice('application/vnd.ms-excel', 'x.xls')).toMatch(/Excel/)
    expect(attachmentPreviewNotice('application/vnd.ms-powerpoint', 'x.ppt')).toMatch(/PowerPoint/)
  })
})

describe('isCrossOriginUrl — the gate on framing a PDF', () => {
  const CRM = 'https://crm.un1tdublin.com'

  it('is true for a Supabase Storage signed URL', () => {
    expect(isCrossOriginUrl(
      'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/sign/email-attachments/x?token=y',
      CRM,
    )).toBe(true)
  })

  it('is FALSE for anything on the app’s own origin', () => {
    expect(isCrossOriginUrl('https://crm.un1tdublin.com/storage/x.pdf', CRM)).toBe(false)
    // Same host, same scheme, default port spelled out — still same origin.
    expect(isCrossOriginUrl('https://crm.un1tdublin.com:443/x.pdf', CRM)).toBe(false)
  })

  it('treats a different port or scheme as a different origin', () => {
    expect(isCrossOriginUrl('http://crm.un1tdublin.com/x.pdf', CRM)).toBe(true)
    expect(isCrossOriginUrl('https://crm.un1tdublin.com:8443/x.pdf', CRM)).toBe(true)
  })

  it('fails CLOSED on anything it cannot parse or does not trust', () => {
    for (const bad of [
      null, undefined, '', 'not a url', '/relative/path',
      'javascript:alert(1)', 'data:image/svg+xml;base64,AAAA', 'blob:https://x/y',
      'file:///etc/passwd',
    ]) {
      expect(isCrossOriginUrl(bad, CRM)).toBe(false)
    }
  })

  it('fails closed when the page origin is unknown (SSR, or a jsdom-less test)', () => {
    expect(isCrossOriginUrl('https://x.supabase.co/y', '')).toBe(false)
    expect(isCrossOriginUrl('https://x.supabase.co/y', undefined)).toBe(false)
  })
})
