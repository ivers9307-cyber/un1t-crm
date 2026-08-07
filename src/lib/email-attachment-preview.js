// EMAIL-ATTACH-PREVIEW.1 — what may be shown in the browser, and what may only
// be downloaded.
//
// Pure: no DB, no Buffer, no clock, no env. Imported by the operator UI AND by
// the route that mints preview URLs, so the same rule decides both. The IO
// lives in src/lib/email-attachments-server.js.
//
// ══ THE SECURITY DECISION ═══════════════════════════════════════════
//
// These files arrive from UNAUTHENTICATED STRANGERS. `mime_type` is their
// value, not ours — normalised by safeMimeType() and nothing more. So the rule
// is an ALLOW-LIST of types that are safe AND that every browser can actually
// render. Everything else — including everything invented after this was
// written — is a download, which is the outcome that can never surprise us.
//
// A deny-list would have been the natural shape ("everything except SVG") and
// it would be wrong: it fails open for image/svg+xml-compressed, for
// text/html, for application/xhtml+xml, and for whatever comes next.
//
// ── SVG IS NEVER PREVIEWED ──────────────────────────────────────────
// image/svg+xml is a scripting vector. An SVG document can carry <script>,
// event handlers and external references, and this system already goes to
// considerable lengths about exactly that threat on the HTML side
// (src/lib/email-html.js sanitises inbound HTML and renders it in an iframe
// with no allow-scripts; three real escapes were found there before merge).
//
// It is true that an <img src> pointing at an SVG does NOT execute its script —
// SVG-in-<img> is a script-disabled context in every browser. That is not the
// reason to allow it. The reason to refuse it is that "previewable" is a
// property this file hands to a UI, and a UI evolves: the moment someone
// renders a previewable attachment in an <object>, an <iframe>, or a
// same-origin tab — all reasonable-looking changes — the SVG executes. There
// is no version of that mistake that is caught by a test about images.
//
// So SVG is absent from the allow-list, and its absence is asserted directly
// in email-attachment-preview.test.js rather than left implicit.
//
// ── HEIC/HEIF IS ABSENT ON PURPOSE, FOR A DIFFERENT REASON ──────────
// Not a security question: iPhones send image/heic constantly and Postmark
// forwards it, but NO major browser can decode it (Safari can on Apple
// hardware; Chrome and Firefox cannot, which is what the operators use). A
// preview would be a permanently broken image on most desks, so it gets the
// same treatment as a Word document: a chip, a plain sentence saying why, and
// a download that opens correctly in Photos or Preview.
//
// ── PDF IS PREVIEWED, IN A CROSS-ORIGIN FRAME ───────────────────────
// The browser's own PDF viewer renders it, and the signed URL is on the
// Supabase Storage origin (<ref>.supabase.co) — a DIFFERENT origin from the
// CRM — so the framed document is walled off from this page's DOM, cookies and
// Supabase session by the same-origin policy. That separation is what makes
// the frame acceptable, so it is not assumed: isCrossOriginUrl() below is
// checked at render time, and a URL that ever came back same-origin degrades
// to "download instead" rather than being framed.
//
// ── THE FILENAME NEVER DECIDES ANYTHING THAT TOUCHES BYTES ──────────
// attachmentIconKind() and attachmentPreviewNotice() accept the filename so a
// file whose type arrived mangled still gets the right icon and the right
// sentence. That is DISPLAY ONLY. previewability is decided by the MIME type
// alone — see attachmentPreviewKind(), which does not take a filename — because
// the filename is the one field of an attachment that an attacker controls most
// directly, and letting `invoice.png` promote arbitrary bytes into an <img>
// would be exactly the confusion this file exists to prevent.

import { safeMimeType } from './email-attachment-quota'

/**
 * Raster image types that are safe in an <img> AND render in every browser
 * an operator might be using. Deliberately short.
 *
 * NOT here, and each absence is a decision:
 *   image/svg+xml   scriptable markup — see the header
 *   image/heic/heif no browser support (see the header)
 *   image/avif      broad but not universal support; a silent broken image on
 *                   an older browser is worse than an honest download
 *   image/tiff      no browser renders it
 *   image/bmp/ico   renderable, but nobody emails them as correspondence and
 *                   every entry here is an entry to defend
 */
export const PREVIEWABLE_IMAGE_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

/**
 * Non-image types the browser itself can display.
 *
 * PDF and nothing else. Word/Excel/PowerPoint are NOT here and cannot be:
 * browsers have no native renderer for them, and the two usual workarounds are
 * both refused — handing member correspondence to Microsoft's or Google's
 * hosted viewer is a GDPR non-starter for mail that may carry billing or health
 * information, and a client-side renderer (mammoth/SheetJS) is real bundle
 * weight for partial fidelity with no answer at all for PPTX. They get a chip,
 * an honest sentence, and a download.
 */
export const PREVIEWABLE_DOCUMENT_MIME_TYPES = Object.freeze([
  'application/pdf',
])

/**
 * How this attachment may be shown, if at all.
 *
 * @param {string} mimeType  the stored (already normalised) mime_type
 * @returns {'image'|'pdf'|null}  null means "download only"
 */
export function attachmentPreviewKind(mimeType) {
  const mime = safeMimeType(mimeType)
  if (PREVIEWABLE_IMAGE_MIME_TYPES.includes(mime)) return 'image'
  if (PREVIEWABLE_DOCUMENT_MIME_TYPES.includes(mime)) return 'pdf'
  return null
}

/**
 * May a preview (i.e. an INLINE, non-download) URL exist for this type at all?
 *
 * This is the server's question. It gates the minting of the URL, so a type
 * that is not previewable never gets an inline handle to its bytes — not even
 * one nobody happens to render today.
 */
export function isPreviewableAttachment(mimeType) {
  return attachmentPreviewKind(mimeType) !== null
}

// Families, for the icon and for the wording. Display only — nothing here
// widens what may be previewed.
const MIME_FAMILY = new Map([
  ['application/pdf', 'pdf'],
  ['application/msword', 'doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc'],
  ['application/rtf', 'doc'],
  ['application/vnd.oasis.opendocument.text', 'doc'],
  ['application/vnd.ms-excel', 'sheet'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sheet'],
  ['application/vnd.oasis.opendocument.spreadsheet', 'sheet'],
  ['text/csv', 'sheet'],
  ['application/vnd.ms-powerpoint', 'slides'],
  ['application/vnd.openxmlformats-officedocument.presentationml.slideshow', 'slides'],
  ['application/vnd.oasis.opendocument.presentation', 'slides'],
  ['application/zip', 'archive'],
  ['application/x-zip-compressed', 'archive'],
  ['application/gzip', 'archive'],
  ['application/x-7z-compressed', 'archive'],
  ['application/vnd.rar', 'archive'],
  ['application/x-rar-compressed', 'archive'],
  ['text/plain', 'text'],
])

// The extension fallback. It exists because safeMimeType() rejects a subtype
// longer than 60 characters, and
// `vnd.openxmlformats-officedocument.presentationml.presentation` — the real
// .pptx type — is 61, so every PowerPoint deck is stored as
// application/octet-stream. Rather than special-case that one length, the
// filename is used for the ICON AND THE SENTENCE ONLY when the type is
// uninformative. It never reaches attachmentPreviewKind().
const EXTENSION_FAMILY = new Map([
  ['pdf', 'pdf'],
  ['doc', 'doc'], ['docx', 'doc'], ['rtf', 'doc'], ['odt', 'doc'],
  ['xls', 'sheet'], ['xlsx', 'sheet'], ['xlsm', 'sheet'], ['csv', 'sheet'], ['ods', 'sheet'],
  ['ppt', 'slides'], ['pptx', 'slides'], ['ppsx', 'slides'], ['odp', 'slides'],
  ['zip', 'archive'], ['rar', 'archive'], ['7z', 'archive'], ['gz', 'archive'],
  ['txt', 'text'], ['log', 'text'],
  ['heic', 'image'], ['heif', 'image'],
  ['jpg', 'image'], ['jpeg', 'image'], ['png', 'image'], ['gif', 'image'],
  ['webp', 'image'], ['svg', 'image'], ['avif', 'image'], ['tif', 'image'], ['tiff', 'image'],
])

/** The lower-cased extension of a display filename, or ''. */
function extensionOf(filename) {
  if (typeof filename !== 'string') return ''
  const dot = filename.lastIndexOf('.')
  if (dot <= 0 || dot === filename.length - 1) return ''
  return filename.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)
}

/**
 * Which icon to draw on the chip.
 *
 * @param {string} mimeType
 * @param {string} [filename]  used ONLY when the type says nothing (see above)
 * @returns {'image'|'pdf'|'doc'|'sheet'|'slides'|'archive'|'text'|'file'}
 */
export function attachmentIconKind(mimeType, filename) {
  const mime = safeMimeType(mimeType)
  const family = MIME_FAMILY.get(mime)
  if (family) return family
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('text/')) return 'text'
  // Only now, and only for a type that told us nothing.
  return EXTENSION_FAMILY.get(extensionOf(filename)) || 'file'
}

/**
 * The sentence shown in the overlay INSTEAD of a preview.
 *
 * Never a blank box, and never "unsupported" on its own: an operator staring at
 * a member's file needs to know whether the problem is the file, the browser or
 * us, and whether downloading will actually help. Every branch says what to do
 * next.
 */
export function attachmentPreviewNotice(mimeType, filename) {
  const mime = safeMimeType(mimeType)

  if (mime === 'image/heic' || mime === 'image/heif' || ['heic', 'heif'].includes(extensionOf(filename))) {
    return 'Browsers cannot display HEIC photos, which is the format iPhones send by default. Download it to open in Photos or Preview.'
  }
  if (mime === 'image/svg+xml' || extensionOf(filename) === 'svg') {
    // Said plainly rather than as a security lecture, but said honestly: an
    // operator who is told "not supported" will try to work around it.
    return 'SVG files are never previewed here — they can carry scripts, and this one came from outside. Download it if you need to open it.'
  }

  switch (attachmentIconKind(mime, filename)) {
    case 'doc':
      return 'Preview is not available for Word documents. Download it to open in Word or Pages.'
    case 'sheet':
      return 'Preview is not available for spreadsheets. Download it to open in Excel or Numbers.'
    case 'slides':
      return 'Preview is not available for PowerPoint files. Download it to open in PowerPoint or Keynote.'
    case 'archive':
      return 'This is a compressed archive. Download it and unpack it to see what is inside.'
    case 'image':
      return 'This image is in a format browsers cannot display. Download it to open it locally.'
    default:
      return 'Preview is not available for this file type. Download it to open it locally.'
  }
}

/**
 * Is `url` on a different origin from the page?
 *
 * The gate on framing a PDF. Supabase Storage lives on its own origin, so this
 * is true in every real deployment — but "in every real deployment" is exactly
 * the kind of assumption that stops being true when someone puts Storage behind
 * a same-origin proxy path, and at that moment framing a stranger's document
 * would stop being walled off from this page.
 *
 * Fails CLOSED: an unparseable URL, a missing origin, or anything that is not
 * http(s) reads as "not safely cross-origin" and the caller falls back to a
 * download.
 */
export function isCrossOriginUrl(url, pageOrigin) {
  if (typeof url !== 'string' || typeof pageOrigin !== 'string' || !pageOrigin) return false
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  return parsed.origin !== pageOrigin
}
