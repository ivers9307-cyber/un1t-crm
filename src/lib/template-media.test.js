import { describe, it, expect } from 'vitest'
import { TEMPLATE_MEDIA_LIMITS, validateTemplateMedia, mediaExt, isMintedMediaPath } from './template-media.js'

const MB = 1024 * 1024

describe('validateTemplateMedia', () => {
  it('accepts a valid file per format', () => {
    expect(validateTemplateMedia({ format: 'IMAGE', mime: 'image/png', size: 4 * MB, fileName: 'a.png' }).ok).toBe(true)
    expect(validateTemplateMedia({ format: 'VIDEO', mime: 'video/mp4', size: 15 * MB, fileName: 'promo.mp4' }).ok).toBe(true)
    expect(validateTemplateMedia({ format: 'DOCUMENT', mime: 'application/pdf', size: 99 * MB, fileName: 'terms.pdf' }).ok).toBe(true)
  })

  it('normalises lowercase format and uppercases in the result', () => {
    const r = validateTemplateMedia({ format: 'video', mime: 'video/mp4', size: MB, fileName: 'v.mp4' })
    expect(r).toMatchObject({ ok: true, format: 'VIDEO', ext: '.mp4' })
  })

  it('rejects unknown formats', () => {
    expect(validateTemplateMedia({ format: 'AUDIO', mime: 'audio/mp3', size: MB, fileName: 'a.mp3' }).ok).toBe(false)
    expect(validateTemplateMedia({}).ok).toBe(false)
  })

  it('rejects wrong mime per format', () => {
    const r = validateTemplateMedia({ format: 'VIDEO', mime: 'video/quicktime', size: MB, fileName: 'v.mov' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('video/mp4')
  })

  it('rejects oversize files with both caps in the message', () => {
    const r = validateTemplateMedia({ format: 'VIDEO', mime: 'video/mp4', size: 17 * MB, fileName: 'big.mp4' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('16 MB')
    expect(r.error).toContain('17.0 MB')
  })

  it('rejects missing/zero/NaN sizes', () => {
    for (const size of [0, -1, NaN, undefined]) {
      expect(validateTemplateMedia({ format: 'IMAGE', mime: 'image/png', size, fileName: 'a.png' }).ok).toBe(false)
    }
  })

  it('rejects an extension that does not match the format', () => {
    const r = validateTemplateMedia({ format: 'IMAGE', mime: 'image/png', size: MB, fileName: 'sneaky.mp4' })
    expect(r.ok).toBe(false)
  })

  it('boundary: exactly the cap passes, one byte over fails', () => {
    const cap = TEMPLATE_MEDIA_LIMITS.IMAGE.maxBytes
    expect(validateTemplateMedia({ format: 'IMAGE', mime: 'image/jpeg', size: cap, fileName: 'a.jpg' }).ok).toBe(true)
    expect(validateTemplateMedia({ format: 'IMAGE', mime: 'image/jpeg', size: cap + 1, fileName: 'a.jpg' }).ok).toBe(false)
  })
})

describe('mediaExt', () => {
  it('extracts and lowercases the extension', () => {
    expect(mediaExt('Promo.MP4')).toBe('.mp4')
    expect(mediaExt('a.b.c.png')).toBe('.png')
  })
  it('falls back to .bin', () => {
    expect(mediaExt('noext')).toBe('.bin')
    expect(mediaExt('')).toBe('.bin')
    expect(mediaExt(null)).toBe('.bin')
  })
})

describe('isMintedMediaPath', () => {
  it('accepts location-uuid/uuid.ext and global/uuid.ext', () => {
    expect(isMintedMediaPath('0c5a1f0e-2d3b-4c5d-8e9f-a0b1c2d3e4f5/0c5a1f0e-2d3b-4c5d-8e9f-a0b1c2d3e4f5.mp4')).toBe(true)
    expect(isMintedMediaPath('global/0c5a1f0e-2d3b-4c5d-8e9f-a0b1c2d3e4f5.pdf')).toBe(true)
  })
  it('rejects traversal, nesting, and arbitrary names', () => {
    expect(isMintedMediaPath('../other-bucket/x.mp4')).toBe(false)
    expect(isMintedMediaPath('global/../secret.pem')).toBe(false)
    expect(isMintedMediaPath('global/a/b.mp4')).toBe(false)
    expect(isMintedMediaPath('global/notauuid.mp4')).toBe(false)
    expect(isMintedMediaPath('')).toBe(false)
  })
})
