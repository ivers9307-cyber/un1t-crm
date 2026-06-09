import { describe, it, expect } from 'vitest'
import { shouldCompress, compressVideoIfNeeded, PASSTHROUGH_MAX_BYTES } from './video-compress.js'

const MB = 1024 * 1024

describe('shouldCompress', () => {
  it('passes through a small mp4 (<= threshold)', () => {
    expect(shouldCompress({ size: 10 * MB, type: 'video/mp4' })).toBe(false)
  })
  it('passes through a small webm', () => {
    expect(shouldCompress({ size: 10 * MB, type: 'video/webm' })).toBe(false)
  })
  it('compresses a large mp4 (> threshold)', () => {
    expect(shouldCompress({ size: 65 * MB, type: 'video/mp4' })).toBe(true)
  })
  it('compresses a small .mov (non-mp4/webm container) regardless of size', () => {
    expect(shouldCompress({ size: 5 * MB, type: 'video/quicktime' })).toBe(true)
  })
  it('compresses a large webm (> threshold)', () => {
    expect(shouldCompress({ size: 40 * MB, type: 'video/webm' })).toBe(true)
  })
  it('treats a missing/odd file defensively (compress)', () => {
    expect(shouldCompress({ size: 30 * MB, type: '' })).toBe(true)
    expect(shouldCompress(null)).toBe(true)
  })
  it('exposes a sane passthrough threshold (20MB)', () => {
    expect(PASSTHROUGH_MAX_BYTES).toBe(20 * MB)
  })
})

describe('compressVideoIfNeeded', () => {
  it('returns the SAME file object for a passthrough clip (never touches ffmpeg)', async () => {
    const small = { size: 8 * MB, type: 'video/mp4', name: 'clip.mp4' }
    const out = await compressVideoIfNeeded(small)
    expect(out).toBe(small) // identical reference — no re-encode
  })
})
