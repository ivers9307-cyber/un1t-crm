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
// Plain data and pure functions, no imports: the guard test imports this.

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

// Legacy spellings of a listed type. Browsers today send the canonical ones,
// but other clients (scripts, old Windows registry mappings, RN FormData)
// still send these; the stored type, and the Content-Type Storage checks
// against the bucket's allowed_mime_types, is always the canonical one.
const ALIASES = Object.freeze({
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'application/x-pdf': 'application/pdf',
})

/**
 * The type to store a car document as, or null to refuse it.
 * A declared type on the list (or a legacy alias of one) is kept, as its
 * canonical spelling. An unlabelled file (no type, or
 * application/octet-stream) takes the type its first bytes show, if that is
 * on the list. Anything else is refused, whatever its bytes.
 *
 * @param {string|null|undefined} declared  File.type from the browser
 * @param {string|null} sniffed  sniffMimeFromBytes(bytes) from src/lib/invoice-extraction.js,
 *   or sniffCarDocumentHeif(bytes)
 * @returns {string|null} one of CAR_DOCUMENT_MIME_TYPES, or null
 */
export function resolveCarDocumentType(declared, sniffed) {
  const bare = String(declared ?? '').split(';')[0].trim().toLowerCase()
  const d = ALIASES[bare] || bare
  if (CAR_DOCUMENT_MIME_TYPES.includes(d)) return d
  if (UNLABELLED.has(d) && sniffed && CAR_DOCUMENT_MIME_TYPES.includes(sniffed)) return sniffed
  return null
}

/**
 * Did the client send no real type (none, or application/octet-stream)?
 * Such a file is judged by its bytes (resolveCarDocumentType's second
 * argument); the signed-upload finalise reads the stored bytes only then.
 *
 * @param {string|null|undefined} declared
 * @returns {boolean}
 */
export function isUnlabelledCarDocumentType(declared) {
  return UNLABELLED.has(String(declared ?? '').split(';')[0].trim().toLowerCase())
}

// ISO-BMFF 'ftyp' brands. HEIC is HEVC-coded HEIF (the iPhone default);
// mif1/msf1 are the generic HEIF brands, which AVIF files also carry, so a
// file naming an AVIF brand anywhere in its ftyp box is not HEIF.
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'])
const HEIF_BRANDS = new Set(['mif1', 'msf1'])
const AVIF_BRANDS = new Set(['avif', 'avis'])

/**
 * An unlabelled HEIC/HEIF from its first bytes: 'image/heic', 'image/heif' or
 * null. Chrome and Firefox on Windows send a .heic with no type, and
 * sniffMimeFromBytes (src/lib/invoice-extraction.js) deliberately knows only
 * the five types the OCR model reads, so the route asks this second.
 *
 * @param {Uint8Array|null|undefined} bytes
 * @returns {'image/heic'|'image/heif'|null}
 */
export function sniffCarDocumentHeif(bytes) {
  if (!bytes || bytes.length < 16) return null
  const ascii = (from, to) => String.fromCharCode(...bytes.subarray(from, to))
  if (ascii(4, 8) !== 'ftyp') return null
  const boxSize = ((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3]
  const end = Math.min(boxSize >= 16 ? boxSize : 16, bytes.length, 256)
  const major = ascii(8, 12)
  const compatible = []
  for (let i = 16; i + 4 <= end; i += 4) compatible.push(ascii(i, i + 4))
  if ([major, ...compatible].some((b) => AVIF_BRANDS.has(b))) return null
  if (HEIC_BRANDS.has(major)) return 'image/heic'
  if (HEIF_BRANDS.has(major)) return 'image/heif'
  return null
}
