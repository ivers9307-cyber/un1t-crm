// CARDOCUPLOAD.1 (C124) — the car-document signed-upload flow's rules.
//
// Why: DocumentsCard posted car documents multipart to
// POST /api/cars/[id]/documents, and Vercel refuses a request body over
// ~4.5 MB with a plain-text 413 before the route runs, so the 25 MiB the
// bucket allows (mig 687) was unreachable and a 5–25 MB scan never uploaded.
// The browser now puts the bytes straight into Storage against a slot the
// server mints:
//   1. POST /api/cars/[id]/documents/sign     — gate, size and type of the
//      declared file (an unlabelled file by its first bytes, which the
//      browser sends as `head`), buildCarDocumentUploadPath,
//      createSignedUploadUrl → { path, token, content_type }
//   2. the browser: storage.from('car-documents').uploadToSignedUrl(path,
//      token, the file as a Blob of content_type)
//   3. POST /api/cars/[id]/documents/finalise — gate, isCarDocumentUploadPath
//      for this car and doc type, size and type of what Storage holds, then
//      the car_documents row + the bookkeeper queue, as the multipart route.
// The client half is src/lib/car-document-upload-client.js.
//
// The type is decided at SIGN, not only at finalise, because the bucket's
// allowed_mime_types applies to a signed upload too: an unlabelled file sent
// as itself arrives as application/octet-stream (and an alias as image/jpg)
// and Storage refuses it before finalise could judge it. Finalise re-decides
// from the stored bytes and refuses a mismatch.
//
// The limits are src/lib/car-document-media.js, the bucket's own.

import { CAR_DOCUMENT_MAX_BYTES, CAR_DOCUMENT_TYPES_LABEL } from './car-document-media'

// Staff-facing words.
export const CAR_DOCUMENT_SIZE_ERROR = `File too large (max ${CAR_DOCUMENT_MAX_BYTES / 1024 / 1024} MB)`
export const CAR_DOCUMENT_EMPTY_ERROR = 'The file is empty. Pick it again.'
export const CAR_DOCUMENT_TYPE_ERROR = `Unsupported file type (${CAR_DOCUMENT_TYPES_LABEL})`

/** Bytes of an unlabelled file the browser sends to sign (sniffCarDocumentHeif reads up to 256). */
export const CAR_DOCUMENT_HEAD_BYTES = 256

const EXTENSIONS = Object.freeze({
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
})

/** The stored file's extension for a listed type, or null. */
export function carDocumentExtension(contentType) {
  return EXTENSIONS[contentType] || null
}

/**
 * A fresh storage path for a car document (the server mints it, never the
 * client): the multipart route's `<car>/<doc_type>/` folder, a uuid, and
 * the extension of the type the file is stored as.
 */
export function buildCarDocumentUploadPath({ carId, docType, contentType, id }) {
  return `${carId}/${docType}/${id}.${carDocumentExtension(contentType)}`
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const NAME_RE = new RegExp(`^${UUID}\\.(?:${[...new Set(Object.values(EXTENSIONS))].join('|')})$`)

/**
 * Is `path` a slot the sign route minted for this car and doc type? Exactly
 * `<car>/<doc_type>/<uuid>.<ext>`: no other car, no other doc type, no
 * traversal, no caller-chosen name.
 */
export function isCarDocumentUploadPath(path, carId, docType) {
  if (typeof path !== 'string' || !carId || !docType) return false
  const prefix = `${carId}/${docType}/`
  if (!path.startsWith(prefix)) return false
  return NAME_RE.test(path.slice(prefix.length))
}

/** null when `size` is within the bucket's limit, else the staff-facing error. */
export function checkCarDocumentSize(size) {
  const bytes = Number(size)
  if (!Number.isFinite(bytes) || bytes <= 0) return CAR_DOCUMENT_EMPTY_ERROR
  if (bytes > CAR_DOCUMENT_MAX_BYTES) return CAR_DOCUMENT_SIZE_ERROR
  return null
}
