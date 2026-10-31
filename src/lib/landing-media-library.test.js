// MEDIALIB.1 — the two pure helpers of the media library: the kind of a
// stored object and the video → poster pairing read from a page's blocks.
import { describe, it, expect } from 'vitest'
import { mediaKindOf, posterPairsFromBlocks } from './landing-media-library.js'

describe('mediaKindOf', () => {
  it('reads the extension first, the stored MIME type second, and nothing for the rest', () => {
    expect(mediaKindOf('a.mp4')).toBe('video')
    expect(mediaKindOf('a.WEBM')).toBe('video')
    expect(mediaKindOf('a.mov')).toBe('video')
    expect(mediaKindOf('a.jpg')).toBe('image')
    expect(mediaKindOf('a.jpeg')).toBe('image')
    expect(mediaKindOf('a.png')).toBe('image')
    expect(mediaKindOf('a.webp')).toBe('image')
    expect(mediaKindOf('noext', 'video/mp4')).toBe('video')
    expect(mediaKindOf('noext', 'image/png')).toBe('image')
    expect(mediaKindOf('a.svg')).toBeNull()
    expect(mediaKindOf('a.pdf', 'application/pdf')).toBeNull()
    expect(mediaKindOf('', null)).toBeNull()
  })
})

describe('posterPairsFromBlocks', () => {
  it('pairs video_url with poster_url anywhere in the blocks, and a hero video with its image; the first poster wins', () => {
    const blocks = [
      { id: 'h', type: 'hero', video_url: 'v-hero', image_url: 'i-hero' },
      { id: 'cf', type: 'campaign_funnel', video_url: 'v-coach', poster_url: 'p-coach' },
      { id: 'vt', type: 'video_testimonials', items: [{ video_url: 'v-1', poster_url: 'p-1' }, { video_url: 'v-2', poster_url: '' }] },
      { id: 'dup', type: 'campaign_funnel', video_url: 'v-coach', poster_url: 'p-other' },
      { id: 'x', type: 'stats', items: [{ number: '1' }] },
    ]
    const pairs = posterPairsFromBlocks(blocks)
    expect([...pairs.entries()]).toEqual([['v-hero', 'i-hero'], ['v-coach', 'p-coach'], ['v-1', 'p-1']])
    expect(posterPairsFromBlocks(null).size).toBe(0)
    expect(posterPairsFromBlocks('junk').size).toBe(0)
  })
})
