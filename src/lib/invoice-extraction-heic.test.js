// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import { heicToJpeg } from './invoice-extraction.js'

// The fixture is a REAL HEVC-encoded HEIC (the iPhone default). sharp's
// prebuilt libvips CANNOT decode it ("Support for this compression format has
// not been built in") — that was the live P1-9 bug: receipts dead-lettered at
// OCR. heicToJpeg() uses heic-convert (libheif-js WASM), which can. This test
// actually runs the decode, so it catches a regression where the decoder or
// the bundling breaks again.
describe('heicToJpeg (real HEVC-HEIC decode)', () => {
  it('decodes a HEVC-HEIC into a valid JPEG', async () => {
    const heic = fs.readFileSync(new URL('./__fixtures__/heic-sample.heic', import.meta.url))
    expect(heic.slice(8, 12).toString('latin1')).toBe('heic') // ftyp major brand
    const jpg = await heicToJpeg(heic)
    expect(Buffer.isBuffer(jpg)).toBe(true)
    expect(jpg[0]).toBe(0xff) // JPEG SOI marker
    expect(jpg[1]).toBe(0xd8)
    expect(jpg.length).toBeGreaterThan(1000)
  })
})
