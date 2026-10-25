import { describe, it, expect } from 'vitest'
import { TEMPLATE_MEDIA_LIMITS, validateTemplateMedia, mediaExt, isMintedMediaPath, resubmitMediaFields, templateHeaderMediaError } from './template-media.js'

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

// WATPLRESUBMEDIA.1 (C109) — what "Edit & resubmit" sends about the header
// media, and how the resubmit route judges it.
describe('resubmitMediaFields', () => {
  const saved = { header_media_handle: 'h-old', header_media_url: 'https://x/old.jpg', header_media_path: 'L/old.jpg' }
  it('sends nothing when the header is not media', () => {
    expect(resubmitMediaFields(saved, { handle: 'h-new', url: 'https://x/new.jpg', path: 'L/new.jpg' }, 'TEXT')).toEqual({})
  })
  it('sends nothing when the media did not change', () => {
    expect(resubmitMediaFields(saved, { handle: 'h-old', url: 'https://x/old.jpg', path: 'L/old.jpg' }, 'IMAGE')).toEqual({})
  })
  it('sends all three fields when a new file was uploaded', () => {
    expect(resubmitMediaFields(saved, { handle: 'h-new', url: 'https://x/new.png', path: 'L/new.png' }, 'IMAGE'))
      .toEqual({ header_media_handle: 'h-new', header_media_url: 'https://x/new.png', header_media_path: 'L/new.png' })
  })
})

describe('templateHeaderMediaError', () => {
  const LOC = '0c5a1f0e-2d3b-4c5d-8e9f-a0b1c2d3e4f5'
  const PATH = `${LOC}/1c5a1f0e-2d3b-4c5d-8e9f-a0b1c2d3e4f5.png`
  const ok = { path: PATH, url: `https://b/${PATH}`, publicUrl: `https://b/${PATH}`, format: 'IMAGE', locationId: LOC }
  it('accepts a minted path in the studio folder, of the header type, at the bucket URL', () => {
    expect(templateHeaderMediaError(ok)).toBeNull()
  })
  it('refuses a path not minted by the sign route, or in another folder', () => {
    expect(templateHeaderMediaError({ ...ok, path: `${LOC}/cat.png` })).toMatch(/path/i)
    expect(templateHeaderMediaError({ ...ok, path: 'global/1c5a1f0e-2d3b-4c5d-8e9f-a0b1c2d3e4f5.png' })).toMatch(/path/i)
  })
  it('refuses the wrong file type for the header, and a non-media header', () => {
    expect(templateHeaderMediaError({ ...ok, format: 'VIDEO' })).toBeTruthy()
    expect(templateHeaderMediaError({ ...ok, format: 'TEXT' })).toBeTruthy()
  })
  it('refuses a URL that is not the bucket URL for the path', () => {
    expect(templateHeaderMediaError({ ...ok, url: 'https://elsewhere/x.png' })).toBeTruthy()
  })
  it('has no em-dashes in what it says', () => {
    for (const e of [
      templateHeaderMediaError({ ...ok, path: 'x' }),
      templateHeaderMediaError({ ...ok, format: 'VIDEO' }),
      templateHeaderMediaError({ ...ok, format: 'TEXT' }),
      templateHeaderMediaError({ ...ok, url: 'https://elsewhere/x.png' }),
    ]) expect(e).not.toMatch(/—/)
  })
})
