import { describe, it, expect } from 'vitest'
import { normalizeIgMedia } from './instagram-feed.js'

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
