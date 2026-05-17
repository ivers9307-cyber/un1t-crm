// BCA submit — merge + compress pipeline (Phase 2).
//
// Takes N source files (the operator's staged docs) and produces
// ONE PDF Buffer ready to attach to the Postmark email.
//
// Why one PDF rather than N attachments:
//   - Postmark caps total attachment size at 10 MB per email. Ten 1-3 MB
//     phone JPGs would clear that easily; one merged + compressed PDF
//     typically lands at 1.5-4 MB.
//   - BCA receives a single tidy file named like the claim it covers,
//     rather than a stack of `doc_03_v5c.jpg`.
//   - The audit trail is one canonical artefact (also saved to
//     storage at the submission_id prefix).
//
// Pipeline per source:
//   PDF       → copy all pages into the merged doc verbatim
//   JPG/PNG/  → compress with sharp (max 2000 px on longest side,
//   WebP        JPEG Q80, strip EXIF) THEN embed as a single A4
//               page with a small slot-label header at the top
//
// Tests cover empty / mixed / image-heavy / oversized cases.

import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib'

const A4_WIDTH = 595.28
const A4_HEIGHT = 841.89
const HEADER_HEIGHT = 24     // points at top of A4 page for slot label
const PAGE_MARGIN = 20       // points around image on A4 page

// Sharp compression defaults — chosen so a typical phone photo lands
// around 300-600 KB after pass. JPEG over WebP for max client-side
// (PDF reader / OS preview) compatibility.
const SHARP_MAX_SIDE = 2000
const SHARP_JPEG_QUALITY = 80

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp'])

/**
 * Merge an ordered list of source files into a single PDF Buffer.
 *
 * @param {Array<{slug: string, label: string, buffer: Buffer, contentType: string}>} sources
 *   In display order. Each entry MUST have a buffer + contentType.
 * @returns {Promise<Buffer>}  Merged PDF, ready to base64-encode for Postmark.
 * @throws  Error with a human-meaningful .message when a source can't
 *          be processed (encrypted PDF, corrupt image, unsupported type).
 *          The submit endpoint surfaces these directly to the operator.
 */
export async function mergeAndCompressBcaPack(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('No documents to merge.')
  }

  // Sharp is heavy + native — import lazily so Phase 1 routes don't
  // load it on every cold start. Same for pdf-lib (pure JS but
  // substantial). Both imports are cheap on subsequent calls.
  const sharp = (await import('sharp')).default

  const mergedDoc = await PDFDocument.create()
  // Embed a font once for all image-page headers.
  const headerFont = await mergedDoc.embedFont(StandardFonts.Helvetica)

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]
    if (!src?.buffer || !Buffer.isBuffer(src.buffer)) {
      throw new Error(`Slot ${i + 1} (${src?.slug || '?'}): missing buffer.`)
    }
    const ct = src.contentType || ''

    if (ct === 'application/pdf') {
      await copyPdfPages(mergedDoc, src, i)
    } else if (IMAGE_MIMES.has(ct)) {
      await embedImagePage(mergedDoc, headerFont, sharp, src, i)
    } else {
      throw new Error(`Slot ${i + 1} (${src.slug}): unsupported file type "${ct}".`)
    }
  }

  const bytes = await mergedDoc.save()
  return Buffer.from(bytes)
}

// Copy every page of a source PDF into the merged doc. Wraps the
// pdf-lib copy in a try/catch so encrypted / corrupt PDFs surface a
// useful error rather than a generic stack trace.
async function copyPdfPages(mergedDoc, src, index) {
  let donor
  try {
    donor = await PDFDocument.load(src.buffer, { ignoreEncryption: false })
  } catch (e) {
    const msg = String(e?.message || e)
    if (/encrypt/i.test(msg) || /password/i.test(msg)) {
      throw new Error(`Slot ${index + 1} (${src.slug}, ${src.label}): PDF is password-protected. Re-export without a password and re-upload.`)
    }
    throw new Error(`Slot ${index + 1} (${src.slug}, ${src.label}): unable to read PDF (${msg}).`)
  }
  const pageIndices = donor.getPageIndices()
  const copied = await mergedDoc.copyPages(donor, pageIndices)
  copied.forEach(p => mergedDoc.addPage(p))
}

// Compress an image with sharp, then embed it on a new A4 page with a
// header strip containing the slot label. EXIF is dropped so any
// phone-side orientation metadata is baked into the pixel output (we
// rely on sharp.rotate() with no args = honour EXIF orientation).
async function embedImagePage(mergedDoc, headerFont, sharp, src, index) {
  let compressed
  try {
    compressed = await sharp(src.buffer)
      .rotate()  // honour EXIF orientation, then strip
      .resize({ width: SHARP_MAX_SIDE, height: SHARP_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: SHARP_JPEG_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true })
  } catch (e) {
    throw new Error(`Slot ${index + 1} (${src.slug}, ${src.label}): unable to read image (${e?.message || e}).`)
  }

  const { data: imgData, info } = compressed
  const img = await mergedDoc.embedJpg(imgData)

  // Build an A4 page with a header strip + the image scaled to fit.
  const page = mergedDoc.addPage([A4_WIDTH, A4_HEIGHT])

  // Header strip — small text at the top with the slot label.
  page.drawText(`${src.slug.toUpperCase()} — ${src.label}`, {
    x: PAGE_MARGIN,
    y: A4_HEIGHT - HEADER_HEIGHT + 6,
    size: 9,
    font: headerFont,
    color: rgb(0.3, 0.3, 0.3),
  })

  // Available area for the image (page minus header + margins).
  const availW = A4_WIDTH - 2 * PAGE_MARGIN
  const availH = A4_HEIGHT - HEADER_HEIGHT - 2 * PAGE_MARGIN

  // Aspect-preserving scale.
  const imgRatio = info.width / info.height
  const availRatio = availW / availH
  let drawW, drawH
  if (imgRatio > availRatio) {
    drawW = availW
    drawH = availW / imgRatio
  } else {
    drawH = availH
    drawW = availH * imgRatio
  }
  const x = (A4_WIDTH - drawW) / 2
  const y = PAGE_MARGIN + (availH - drawH) / 2

  page.drawImage(img, { x, y, width: drawW, height: drawH, rotate: degrees(0) })
}
