import { describe, it, expect } from 'vitest'
import { tvUploadPrefix, buildTvUploadPath, isTvUploadPath, checkTvImage, TV_UPLOAD_KINDS } from './tv-upload'
import { TV_IMAGE_MAX_BYTES } from './tv-media'

// TVUPLOAD.1 (C93) — the signed-upload flow's path and file rules, shared by
// POST /api/admin/tv-displays/upload/sign and …/finalise.
const LOC = '0a000000-0000-4000-8000-000000000001'
const OTHER = '0b000000-0000-4000-8000-000000000002'
const UUID = '1c000000-0000-4000-8000-000000000003'

describe('tvUploadPrefix / buildTvUploadPath', () => {
  it('push images sit under <location>/, template bases under <location>/templates/ (the multipart route\'s paths)', () => {
    expect(tvUploadPrefix(LOC, 'content')).toBe(LOC)
    expect(tvUploadPrefix(LOC, 'template')).toBe(`${LOC}/templates`)
    expect(buildTvUploadPath({ locationId: LOC, kind: 'content', fileName: 'Photo.JPG', id: UUID })).toBe(`${LOC}/${UUID}.jpg`)
    expect(buildTvUploadPath({ locationId: LOC, kind: 'template', fileName: 'base.png', id: UUID })).toBe(`${LOC}/templates/${UUID}.png`)
  })

  it('an extension is letters and digits only; none, or a junk one, falls back to jpg', () => {
    expect(buildTvUploadPath({ locationId: LOC, kind: 'content', fileName: 'x.we/bp', id: UUID })).toBe(`${LOC}/${UUID}.webp`)
    expect(buildTvUploadPath({ locationId: LOC, kind: 'content', fileName: '', id: UUID })).toBe(`${LOC}/${UUID}.jpg`)
    expect(buildTvUploadPath({ locationId: LOC, kind: 'content', fileName: 'x.../', id: UUID })).toBe(`${LOC}/${UUID}.jpg`)
  })

  it('only the two kinds exist', () => {
    expect(TV_UPLOAD_KINDS).toEqual(['content', 'template'])
  })
})

describe('isTvUploadPath — a path the sign route minted for THIS studio and kind', () => {
  it('accepts exactly the minted shapes', () => {
    expect(isTvUploadPath(`${LOC}/${UUID}.jpg`, LOC, 'content')).toBe(true)
    expect(isTvUploadPath(`${LOC}/templates/${UUID}.png`, LOC, 'template')).toBe(true)
  })

  it('refuses another studio, the other kind, traversal, extra segments and non-strings', () => {
    expect(isTvUploadPath(`${OTHER}/${UUID}.jpg`, LOC, 'content')).toBe(false)
    expect(isTvUploadPath(`${LOC}/templates/${UUID}.png`, LOC, 'content')).toBe(false)
    expect(isTvUploadPath(`${LOC}/${UUID}.jpg`, LOC, 'template')).toBe(false)
    expect(isTvUploadPath(`${LOC}/../${OTHER}/${UUID}.jpg`, LOC, 'content')).toBe(false)
    expect(isTvUploadPath(`${LOC}/x/${UUID}.jpg`, LOC, 'content')).toBe(false)
    expect(isTvUploadPath(`${LOC}/not-a-uuid.jpg`, LOC, 'content')).toBe(false)
    expect(isTvUploadPath(null, LOC, 'content')).toBe(false)
    expect(isTvUploadPath(`${LOC}/${UUID}.jpg`, null, 'content')).toBe(false)
  })
})

describe('checkTvImage — the multipart route\'s rules, on a declared or stored file', () => {
  it('accepts the TV image types under the cap', () => {
    expect(checkTvImage({ mime: 'image/jpeg', size: 1000 })).toEqual({ ok: true })
    expect(checkTvImage({ mime: 'IMAGE/PNG', size: TV_IMAGE_MAX_BYTES })).toEqual({ ok: true })
  })

  it('refuses another type, an empty or unknown size and anything over the cap, with the route\'s words', () => {
    expect(checkTvImage({ mime: 'image/heic', size: 10 })).toEqual({ ok: false, error: 'File must be a PNG, JPEG, WebP, GIF or AVIF image.' })
    expect(checkTvImage({ mime: 'image/png', size: TV_IMAGE_MAX_BYTES + 1 })).toEqual({ ok: false, error: 'Image must be under 15MB.' })
    expect(checkTvImage({ mime: 'image/png', size: 0 }).ok).toBe(false)
    expect(checkTvImage({ mime: 'image/png', size: Number.NaN }).ok).toBe(false)
    expect(checkTvImage({}).ok).toBe(false)
  })
})
