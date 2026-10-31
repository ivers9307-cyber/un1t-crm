// PAGES.1 (Task 18b): uploadLandingMedia attributes an upload to a landing
// PAGE when given a pageId: it sends page_id and never location_id. A scope='all'
// page has no location, so pageId alone must be enough.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({ uploadToSignedUrl: vi.fn(async () => ({ error: null })) }))
vi.mock('./video-compress', () => ({ compressVideoIfNeeded: async (f) => f }))
vi.mock('./supabase', () => ({
  createBrowserClient: () => ({ storage: { from: () => ({ uploadToSignedUrl: mocks.uploadToSignedUrl }) } }),
}))

import { uploadLandingMedia } from './landing-media-upload'

const jsonRes = (body, status = 200) => ({
  ok: status < 300, status,
  headers: { get: () => 'application/json' },
  json: async () => body,
  text: async () => JSON.stringify(body),
})

let fetchMock
beforeEach(() => {
  mocks.uploadToSignedUrl.mockClear()
  fetchMock = vi.fn(async (url) => (String(url).includes('signed-upload')
    ? jsonRes({ success: true, path: 'pages/p-1/x.mp4', token: 't', url: 'https://cdn/x.mp4' })
    : jsonRes({ success: true, url: 'https://cdn/x.png' })))
  globalThis.fetch = fetchMock
})
afterEach(() => { vi.restoreAllMocks() })

describe('uploadLandingMedia with a pageId', () => {
  it('sends page_id and no location_id when pageId is given', async () => {
    const file = new File(['x'], 'a.txt', { type: 'text/plain' }) // not an image: skips the canvas pipeline
    const out = await uploadLandingMedia({ file, pageId: 'p-1', kind: 'image' })
    expect(out).toEqual({ success: true, url: 'https://cdn/x.png' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/landing-page-settings/media')
    expect(init.body.get('page_id')).toBe('p-1')
    expect(init.body.has('location_id')).toBe(false)
    expect(init.body.get('kind')).toBe('image')
  })

  it('prefers pageId when both ids are given', async () => {
    const file = new File(['x'], 'a.txt', { type: 'text/plain' })
    await uploadLandingMedia({ file, pageId: 'p-1', locationId: 'loc-1', kind: 'image' })
    const body = fetchMock.mock.calls[0][1].body
    expect(body.get('page_id')).toBe('p-1')
    expect(body.has('location_id')).toBe(false)
  })

  it('still sends location_id alone for a legacy caller', async () => {
    const file = new File(['x'], 'a.txt', { type: 'text/plain' })
    await uploadLandingMedia({ file, locationId: 'loc-1', kind: 'image' })
    const body = fetchMock.mock.calls[0][1].body
    expect(body.get('location_id')).toBe('loc-1')
    expect(body.has('page_id')).toBe(false)
  })

  it('signs with page_id for a video', async () => {
    const file = new File(['x'], 'v.mp4', { type: 'video/mp4' })
    const out = await uploadLandingMedia({ file, pageId: 'p-1', kind: 'video' })
    expect(out).toEqual({ success: true, url: 'https://cdn/x.mp4' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/landing-page-settings/media/signed-upload')
    expect(JSON.parse(init.body)).toEqual({ page_id: 'p-1', kind: 'video', content_type: 'video/mp4' })
    expect(mocks.uploadToSignedUrl).toHaveBeenCalledTimes(1)
  })

  it('signs with location_id for a legacy video', async () => {
    const file = new File(['x'], 'v.mp4', { type: 'video/mp4' })
    await uploadLandingMedia({ file, locationId: 'loc-1', kind: 'video' })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ location_id: 'loc-1', kind: 'video', content_type: 'video/mp4' })
  })

  it('refuses with no ids', async () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    const out = await uploadLandingMedia({ file, kind: 'image' })
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/Missing file/)
    expect(fetchMock).not.toHaveBeenCalled()
    const v = await uploadLandingMedia({ file: new File(['x'], 'v.mp4', { type: 'video/mp4' }), kind: 'video' })
    expect(v.success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
