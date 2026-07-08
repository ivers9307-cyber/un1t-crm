import { describe, it, expect } from 'vitest'
import { normalizeIgMedia, fetchIgMedia, fetchIgUsername } from './instagram-feed.js'

describe('normalizeIgMedia', () => {
  const img = { id: '1', media_type: 'IMAGE', media_url: 'https://cdn/i1.jpg', permalink: 'https://instagram.com/p/1', caption: 'hello', timestamp: '2026-07-01T10:00:00Z' }
  const reel = { id: '2', media_type: 'VIDEO', media_product_type: 'REELS', thumbnail_url: 'https://cdn/t2.jpg', media_url: 'https://cdn/v2.mp4', permalink: 'https://instagram.com/reel/2', timestamp: '2026-07-02T10:00:00Z' }

  it('maps an image post to a row (image_url from media_url)', () => {
    const [row] = normalizeIgMedia([img])
    expect(row).toMatchObject({ ig_media_id: '1', media_type: 'IMAGE', is_reel: false, permalink: 'https://instagram.com/p/1', image_url: 'https://cdn/i1.jpg', posted_at: '2026-07-01T10:00:00Z' })
  })

  it('detects a reel and uses thumbnail_url for video image_url', () => {
    const [row] = normalizeIgMedia([reel])
    expect(row.is_reel).toBe(true)
    expect(row.image_url).toBe('https://cdn/t2.jpg')
  })

  it('truncates long captions to <=140 chars with an ellipsis', () => {
    const [row] = normalizeIgMedia([{ ...img, caption: 'x'.repeat(200) }])
    expect(row.caption.length).toBeLessThanOrEqual(140)
    expect(row.caption.endsWith('…')).toBe(true)
  })

  it('drops items with no id/permalink or no usable image', () => {
    expect(normalizeIgMedia([{ id: '3', permalink: 'https://instagram.com/p/3', media_type: 'IMAGE' }])).toHaveLength(0) // no media_url
    expect(normalizeIgMedia([{ media_type: 'IMAGE', media_url: 'x' }])).toHaveLength(0) // no id/permalink
    expect(normalizeIgMedia(null)).toEqual([])
  })
})

describe('fetchIgMedia', () => {
  const conn = { external_account_id: 'ig123', access_token: 'tok' }
  it('calls the media edge with fields+token and normalizes the result', async () => {
    const calls = []
    const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => ({ data: [{ id: '1', media_type: 'IMAGE', media_url: 'https://cdn/i.jpg', permalink: 'https://instagram.com/p/1' }] }) } }
    const rows = await fetchIgMedia(conn, { fetchImpl, limit: 5 })
    expect(calls[0]).toContain('/ig123/media')
    expect(calls[0]).toContain('access_token=tok')
    expect(rows).toHaveLength(1)
  })
  it('throws on a Graph error (so the caller keeps last-good)', async () => {
    const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'bad scope' } }) })
    await expect(fetchIgMedia(conn, { fetchImpl })).rejects.toThrow(/bad scope/)
  })
  it('throws when the connection lacks id/token', async () => {
    await expect(fetchIgMedia({}, {})).rejects.toThrow(/external_account_id/)
  })
})

describe('fetchIgUsername', () => {
  it('returns the account username, or null on error', async () => {
    const ok = async () => ({ ok: true, json: async () => ({ username: 'un1tstillorgan' }) })
    expect(await fetchIgUsername({ external_account_id: 'ig123', access_token: 'tok' }, { fetchImpl: ok })).toBe('un1tstillorgan')
    const bad = async () => ({ ok: false, status: 400, json: async () => ({}) })
    expect(await fetchIgUsername({ external_account_id: 'ig123', access_token: 'tok' }, { fetchImpl: bad })).toBeNull()
  })
})
