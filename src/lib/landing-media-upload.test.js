import { describe, it, expect } from 'vitest'
import { parseUploadResponse, captureVideoPoster, videoOutputCap, compressImageForUpload } from './landing-media-upload'

// Fake Response factory — just the bits parseUploadResponse touches.
function res({ status = 200, contentType = 'application/json', body = null, text = '' }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
    text: async () => text,
  }
}

describe('parseUploadResponse', () => {
  it('turns a plain-text 413 (Vercel body cap) into a friendly "too large" message, not a JSON crash', async () => {
    const out = await parseUploadResponse(
      res({ status: 413, contentType: 'text/plain', text: 'Request Entity Too Large' })
    )
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/too large/i)
    expect(out.error).not.toMatch(/JSON/i)
  })

  it('handles any other non-JSON body without throwing', async () => {
    const out = await parseUploadResponse(
      res({ status: 502, contentType: 'text/html', text: '<html>Bad Gateway</html>' })
    )
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/502/)
  })

  it('passes a JSON success through as { success, url }', async () => {
    const out = await parseUploadResponse(
      res({ status: 200, body: { success: true, url: 'https://cdn/x.jpg' } })
    )
    expect(out).toEqual({ success: true, url: 'https://cdn/x.jpg' })
  })

  it('surfaces a JSON error envelope from the route', async () => {
    const out = await parseUploadResponse(
      res({ status: 400, body: { success: false, error: 'Unsupported file type.' } })
    )
    expect(out.success).toBe(false)
    expect(out.error).toBe('Unsupported file type.')
  })

  it('does not crash when a 200 body is somehow unparseable', async () => {
    const bad = res({ status: 200 })
    bad.json = async () => { throw new Error('boom') }
    const out = await parseUploadResponse(bad)
    expect(out.success).toBe(false)
  })
})

describe('videoOutputCap', () => {
  it('holds autoplay backgrounds to 50MB (every visitor downloads them on load)', () => {
    expect(videoOutputCap(true)).toBe(50 * 1024 * 1024)
  })
  it('allows tap-to-play clips up to the 200MB bucket ceiling', () => {
    expect(videoOutputCap(false)).toBe(200 * 1024 * 1024)
  })
  it('fails safe to the small cap for any non-false argument (undefined/null)', () => {
    expect(videoOutputCap(undefined)).toBe(50 * 1024 * 1024)
    expect(videoOutputCap(null)).toBe(50 * 1024 * 1024)
  })
})

describe('captureVideoPoster', () => {
  it('resolves null for a non-video file without touching the DOM', async () => {
    const notAVideo = { name: 'photo.jpg', type: 'image/jpeg' }
    await expect(captureVideoPoster(notAVideo)).resolves.toBeNull()
  })
  it('resolves null for a missing file', async () => {
    await expect(captureVideoPoster(null)).resolves.toBeNull()
  })
})

describe('compressImageForUpload', () => {
  it('fails open to the original file when the canvas pipeline is unavailable (node env)', async () => {
    const file = { type: 'image/jpeg', name: 'hero.jpg', size: 6 * 1024 * 1024 }
    await expect(compressImageForUpload(file)).resolves.toBe(file)
  })
  it('passes a non-image file through untouched', async () => {
    const file = { type: 'application/pdf', name: 'doc.pdf' }
    await expect(compressImageForUpload(file)).resolves.toBe(file)
  })
  it('passes a missing file through untouched', async () => {
    await expect(compressImageForUpload(null)).resolves.toBeNull()
  })
})
