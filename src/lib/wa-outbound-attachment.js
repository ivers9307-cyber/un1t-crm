// WAATTACH.1 — a photo or PDF sent from the WhatsApp inbox (the pure rules).
//
// The flow (all three steps judge the THREAD's studio, never the active one):
//   1. POST /api/whatsapp/conversations/[id]/attachments/sign — the browser
//      declares { file_name, mime, size }; the route judges it by the rules
//      below, mints a slot in the PRIVATE whatsapp-media bucket under the
//      conversation's studio, and answers with a signed upload token.
//   2. The browser puts the bytes straight into Storage (uploadToSignedUrl):
//      Vercel refuses a multipart body over ~4.5 MB before a route runs.
//   3. POST /api/whatsapp/conversations/[id]/send with { type, attachment_path,
//      caption?, file_name? }. The send route re-judges what Storage HOLDS
//      (size and stored type, read back from the bucket; the upload token
//      does not pin either) and mints Meta's short-lived signed URL itself.
//      A client never hands the route a URL to send.
//
// Why these limits: Meta accepts images as JPEG/PNG up to 5 MB and documents
// up to 100 MB. Ours caps a PDF at 16 MB, which every real class timetable,
// price list or form fits, and keeps a slow phone upload from timing out.
// The bucket itself has no type or size limit (mig 325): it also holds
// inbound media of any type Meta delivers, so the rules live here, enforced
// at sign AND at send.

const MB = 1024 * 1024

export const WA_ATTACHMENT_RULES = Object.freeze({
  'image/jpeg': Object.freeze({ kind: 'image', ext: 'jpg', maxBytes: 5 * MB }),
  'image/png': Object.freeze({ kind: 'image', ext: 'png', maxBytes: 5 * MB }),
  'application/pdf': Object.freeze({ kind: 'document', ext: 'pdf', maxBytes: 16 * MB }),
})

/** What the browser's file picker offers (the `accept` attribute). */
export const WA_ATTACHMENT_ACCEPT = Object.keys(WA_ATTACHMENT_RULES).join(',')

/**
 * How long Meta's link to the file lives. Meta fetches it when the message is
 * sent (and again if a delivery is retried), so an hour is ample; the inbox
 * itself re-signs through /api/whatsapp/media/[id], never with this URL.
 */
export const WA_ATTACHMENT_URL_TTL_SECS = 3600

// Staff-facing text. Plain words, no em-dashes.
export const WA_ATTACHMENT_TEXT = Object.freeze({
  type: 'Only a photo (JPEG or PNG) or a PDF can be sent.',
  empty: 'The file is empty. Pick it again.',
  imageTooBig: 'Photos can be at most 5 MB.',
  documentTooBig: 'PDFs can be at most 16 MB.',
  notUploaded: 'The file did not finish uploading. Try again.',
  notThisThread: 'That file was not uploaded to this conversation.',
  mismatch: 'The uploaded file is not the type that was picked. Pick it again.',
  unreadable: 'Could not check the uploaded file, so nothing was sent. Try again.',
  link: 'Could not prepare the file for WhatsApp, so nothing was sent. Try again.',
  windowClosed: 'The 24-hour messaging window has closed, so files cannot be sent. Send an approved template instead.',
  mediaUrlRefused: 'Attach the file from the inbox: a link to send is not accepted here.',
})

const normaliseMime = (mime) => String(mime || '').split(';')[0].trim().toLowerCase()

/**
 * Judge a declared or stored file. Returns { ok: true, contentType, kind, ext }
 * or { ok: false, error }.
 *
 * @param {{ mime: string, size: number }} file
 */
export function judgeWaAttachment({ mime, size } = {}) {
  const contentType = normaliseMime(mime)
  const rule = WA_ATTACHMENT_RULES[contentType]
  if (!rule) return { ok: false, error: WA_ATTACHMENT_TEXT.type }
  const bytes = Number(size)
  if (!Number.isFinite(bytes) || bytes <= 0) return { ok: false, error: WA_ATTACHMENT_TEXT.empty }
  if (bytes > rule.maxBytes) {
    return { ok: false, error: rule.kind === 'image' ? WA_ATTACHMENT_TEXT.imageTooBig : WA_ATTACHMENT_TEXT.documentTooBig }
  }
  return { ok: true, contentType, kind: rule.kind, ext: rule.ext }
}

/**
 * The slot the sign route mints (the server picks it, never the client):
 * `<studio>/outbound/<conversation>/<uuid>.<ext>`. The studio prefix matches
 * the inbound re-host layout (`<studio>/<message>.<ext>`), so one studio's
 * objects stay under one folder.
 */
export function buildWaAttachmentPath({ locationId, conversationId, id, ext }) {
  if (!locationId || !conversationId || !id || !ext) throw new Error('buildWaAttachmentPath: missing part')
  return `${locationId}/outbound/${conversationId}/${id}.${ext}`
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const EXTS = [...new Set(Object.values(WA_ATTACHMENT_RULES).map((r) => r.ext))].join('|')
const NAME_RE = new RegExp(`^${UUID}\\.(${EXTS})$`)

/**
 * Is `path` a slot minted for THIS conversation at THIS studio? Exactly
 * `<studio>/outbound/<conversation>/<uuid>.<ext>`: no other studio, no other
 * thread, no traversal, no caller-chosen name. Returns { ext, contentType,
 * kind } for the slot's extension, else null.
 */
export function parseWaAttachmentPath(path, { locationId, conversationId } = {}) {
  if (typeof path !== 'string' || !locationId || !conversationId) return null
  const prefix = `${locationId}/outbound/${conversationId}/`
  if (!path.startsWith(prefix)) return null
  const m = path.slice(prefix.length).match(NAME_RE)
  if (!m) return null
  const ext = m[1]
  const contentType = Object.keys(WA_ATTACHMENT_RULES).find((t) => WA_ATTACHMENT_RULES[t].ext === ext)
  return { ext, contentType, kind: WA_ATTACHMENT_RULES[contentType].kind }
}

/**
 * The file name Meta shows on a document: the picked file's own name, made
 * plain (no folders, no control characters), always ending in `.pdf`.
 */
export function waAttachmentFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || ''
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!clean) return 'document.pdf'
  return /\.pdf$/i.test(clean) ? clean : `${clean}.pdf`
}
