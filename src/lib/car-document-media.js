// CARDOCBUCKET.1 — what the private 'car-documents' storage bucket accepts.
//
// ONE list for the upload route (src/app/api/cars/[id]/documents/route.js
// validates every file against it before it uploads with the service role),
// the web picker (src/components/cars/DocumentsCard.jsx) and the bucket
// itself: migration 687 sets the bucket's allowed_mime_types to
// CAR_DOCUMENT_MIME_TYPES and its file_size_limit to CAR_DOCUMENT_MAX_BYTES,
// and tests/car-documents-bucket-guard.test.js fails CI if they drift. Change
// them together, in one PR with a migration, or Storage refuses a file the
// route accepted. The Xero sales-invoice PDF (src/lib/xero/invoices.js) is
// stored in the same bucket as application/pdf.
//
// The seven types are what the picker offers AND something downstream can
// read: the invoice queue's OCR takes PDF/JPEG/PNG/GIF/WebP and converts
// HEIC/HEIF (src/lib/invoice-extraction.js).
//
// Plain data and one pure function, no imports: the guard test imports this.

/** Types a car document may be. */
export const CAR_DOCUMENT_MIME_TYPES = Object.freeze([
  'application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
])

/**
 * 25 MiB. (A multipart POST to a Vercel route is capped at ~4.5 MB before
 * the route runs; the bucket limit is the route's contract, not that
 * platform cap.)
 */
export const CAR_DOCUMENT_MAX_BYTES = 25 * 1024 * 1024

/** The file picker's accept attribute. */
export const CAR_DOCUMENT_ACCEPT = CAR_DOCUMENT_MIME_TYPES.join(',')

/** For error messages. */
export const CAR_DOCUMENT_TYPES_LABEL = 'PDF, JPEG, PNG, GIF, WebP or HEIC'

const UNLABELLED = new Set(['', 'application/octet-stream'])

/**
 * The type to store a car document as, or null to refuse it.
 * A declared type on the list is kept. An unlabelled file (no type, or
 * application/octet-stream) takes the type its first bytes show, if that is
 * on the list. Anything else is refused, whatever its bytes.
 *
 * @param {string|null|undefined} declared  File.type from the browser
 * @param {string|null} sniffed  sniffMimeFromBytes(bytes) from src/lib/invoice-extraction.js
 * @returns {string|null}
 */
export function resolveCarDocumentType(declared, sniffed) {
  const d = String(declared ?? '').trim().toLowerCase()
  if (CAR_DOCUMENT_MIME_TYPES.includes(d)) return d
  if (UNLABELLED.has(d) && sniffed && CAR_DOCUMENT_MIME_TYPES.includes(sniffed)) return sniffed
  return null
}
