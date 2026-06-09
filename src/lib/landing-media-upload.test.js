import { describe, it, expect } from 'vitest'
import { parseUploadResponse, captureVideoPoster } from './landing-media-upload'

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

describe('captureVideoPoster', () => {
  it('resolves null for a non-video file without touching the DOM', async () => {
    const notAVideo = { name: 'photo.jpg', type: 'image/jpeg' }
    await expect(captureVideoPoster(notAVideo)).resolves.toBeNull()
  })
  it('resolves null for a missing file', async () => {
    await expect(captureVideoPoster(null)).resolves.toBeNull()
  })
})
