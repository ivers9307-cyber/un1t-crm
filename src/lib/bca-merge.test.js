// Tests for src/lib/bca-merge.js — produces a real merged PDF via
// pdf-lib + sharp and asserts pages/size/error shapes.

import { describe, it, expect } from 'vitest'
import { PDFDocument, rgb } from 'pdf-lib'
import { mergeAndCompressBcaPack } from './bca-merge'

// Tiny helpers — build a fixture PDF / image without external assets.

// 2-page PDF in memory, deterministic.
async function makePdfBuffer(pageCount = 1) {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pageCount; i++) {
    const p = doc.addPage([200, 200])
    p.drawText(`Test page ${i + 1}`, { x: 20, y: 100, size: 12, color: rgb(0, 0, 0) })
  }
  return Buffer.from(await doc.save())
}

// 100×100 solid-red JPEG via sharp (the same lib bca-merge uses).
async function makeJpegBuffer() {
  const sharp = (await import('sharp')).default
  return await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).jpeg({ quality: 90 }).toBuffer()
}

// 50×80 PNG via sharp.
async function makePngBuffer() {
  const sharp = (await import('sharp')).default
  return await sharp({
    create: { width: 50, height: 80, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } },
  }).png().toBuffer()
}

describe('mergeAndCompressBcaPack', () => {
  it('throws on empty input', async () => {
    await expect(mergeAndCompressBcaPack([])).rejects.toThrow(/No documents/)
    await expect(mergeAndCompressBcaPack(null)).rejects.toThrow(/No documents/)
  })

  it('throws when a source has no buffer', async () => {
    await expect(mergeAndCompressBcaPack([
      { slug: 'doc_01', label: 'X', contentType: 'application/pdf' },  // no buffer
    ])).rejects.toThrow(/missing buffer/)
  })

  it('throws on unsupported content type', async () => {
    await expect(mergeAndCompressBcaPack([
      { slug: 'doc_01', label: 'X', buffer: Buffer.from('hi'), contentType: 'text/plain' },
    ])).rejects.toThrow(/unsupported file type/)
  })

  it('merges 2 PDFs page-for-page', async () => {
    const a = await makePdfBuffer(2)
    const b = await makePdfBuffer(3)
    const merged = await mergeAndCompressBcaPack([
      { slug: 'doc_01', label: 'A', buffer: a, contentType: 'application/pdf' },
      { slug: 'doc_02', label: 'B', buffer: b, contentType: 'application/pdf' },
    ])
    expect(Buffer.isBuffer(merged)).toBe(true)
    const reloaded = await PDFDocument.load(merged)
    expect(reloaded.getPageCount()).toBe(5)  // 2 + 3
  })

  it('embeds a JPG as a single A4 page with header text', async () => {
    const jpg = await makeJpegBuffer()
    const merged = await mergeAndCompressBcaPack([
      { slug: 'doc_01', label: 'Photo', buffer: jpg, contentType: 'image/jpeg' },
    ])
    const reloaded = await PDFDocument.load(merged)
    expect(reloaded.getPageCount()).toBe(1)
    const page = reloaded.getPage(0)
    // A4 ~= 595.28 × 841.89 — assert close (pdf-lib uses doubles).
    expect(Math.round(page.getWidth())).toBe(595)
    expect(Math.round(page.getHeight())).toBe(842)
  })

  it('embeds a PNG (converted via sharp to JPG internally)', async () => {
    const png = await makePngBuffer()
    const merged = await mergeAndCompressBcaPack([
      { slug: 'doc_01', label: 'Blue', buffer: png, contentType: 'image/png' },
    ])
    const reloaded = await PDFDocument.load(merged)
    expect(reloaded.getPageCount()).toBe(1)
  })

  it('handles a mixed pack (PDF + image + PDF) in order', async () => {
    const pdfA = await makePdfBuffer(1)
    const jpg = await makeJpegBuffer()
    const pdfB = await makePdfBuffer(2)
    const merged = await mergeAndCompressBcaPack([
      { slug: 'doc_01', label: 'PDF A', buffer: pdfA, contentType: 'application/pdf' },
      { slug: 'doc_02', label: 'JPG',   buffer: jpg,  contentType: 'image/jpeg' },
      { slug: 'doc_03', label: 'PDF B', buffer: pdfB, contentType: 'application/pdf' },
    ])
    const reloaded = await PDFDocument.load(merged)
    // 1 (PDF A) + 1 (JPG) + 2 (PDF B) = 4 pages
    expect(reloaded.getPageCount()).toBe(4)
  })

  it('compresses big images so the merged PDF stays small', async () => {
    // 4000x3000 phone-sized JPEG → after sharp Q80 + 2000px cap
    // should land well under 1 MB embedded.
    const sharp = (await import('sharp')).default
    const big = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: { r: 100, g: 150, b: 200 } },
    }).jpeg({ quality: 95 }).toBuffer()
    expect(big.length).toBeGreaterThan(50_000)  // sanity: starting size

    const merged = await mergeAndCompressBcaPack([
      { slug: 'doc_01', label: 'Big', buffer: big, contentType: 'image/jpeg' },
    ])
    // Solid-colour image compresses massively; assert under 500 KB
    // as a smoke check against an obviously-broken compression path.
    expect(merged.length).toBeLessThan(500_000)
  })

  it('surfaces a useful error on an obviously corrupt PDF', async () => {
    await expect(mergeAndCompressBcaPack([
      { slug: 'doc_01', label: 'Bad', buffer: Buffer.from('not a pdf'), contentType: 'application/pdf' },
    ])).rejects.toThrow(/unable to read PDF/)
  })

  it('surfaces a useful error on a corrupt image', async () => {
    await expect(mergeAndCompressBcaPack([
      { slug: 'doc_01', label: 'Bad', buffer: Buffer.from('definitely not an image'), contentType: 'image/jpeg' },
    ])).rejects.toThrow(/unable to read image/)
  })
})
