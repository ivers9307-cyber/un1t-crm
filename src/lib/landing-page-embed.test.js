import { describe, it, expect } from 'vitest'
import { parseEmbed } from './landing-page-embed.js'

describe('parseEmbed', () => {
  it('returns null for empty / non-string', () => {
    expect(parseEmbed('')).toBeNull()
    expect(parseEmbed(null)).toBeNull()
    expect(parseEmbed(undefined)).toBeNull()
    expect(parseEmbed(42)).toBeNull()
  })

  it('returns null for invalid URL', () => {
    expect(parseEmbed('not a url')).toBeNull()
    expect(parseEmbed('http://')).toBeNull()
  })

  it('returns null for unknown provider', () => {
    expect(parseEmbed('https://example.com/video/abc')).toBeNull()
    expect(parseEmbed('https://vimeo.com/12345')).toBeNull()
  })

  it('parses youtube.com/watch?v=', () => {
    expect(parseEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      provider: 'youtube',
      embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    })
  })

  it('parses youtu.be/<id>', () => {
    expect(parseEmbed('https://youtu.be/dQw4w9WgXcQ')).toEqual({
      provider: 'youtube',
      embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    })
  })

  it('parses youtube.com/shorts/<id>', () => {
    expect(parseEmbed('https://www.youtube.com/shorts/abc123')).toEqual({
      provider: 'youtube',
      embedUrl: 'https://www.youtube.com/embed/abc123',
    })
  })

  it('parses youtube.com/embed/<id> (already an embed URL)', () => {
    expect(parseEmbed('https://www.youtube.com/embed/abc123')).toEqual({
      provider: 'youtube',
      embedUrl: 'https://www.youtube.com/embed/abc123',
    })
  })

  it('parses instagram.com/p/<id>/', () => {
    expect(parseEmbed('https://www.instagram.com/p/CXkLZbsHj_a/')).toEqual({
      provider: 'instagram',
      embedUrl: 'https://www.instagram.com/p/CXkLZbsHj_a/embed',
    })
  })

  it('parses instagram.com/reel/<id>/', () => {
    expect(parseEmbed('https://www.instagram.com/reel/CXkLZbsHj_a/')).toEqual({
      provider: 'instagram',
      embedUrl: 'https://www.instagram.com/reel/CXkLZbsHj_a/embed',
    })
  })

  it('handles m.youtube.com (mobile share links)', () => {
    expect(parseEmbed('https://m.youtube.com/watch?v=abc123')).toEqual({
      provider: 'youtube',
      embedUrl: 'https://www.youtube.com/embed/abc123',
    })
  })

  it('strips whitespace before parsing', () => {
    expect(parseEmbed('  https://youtu.be/abc  ')).toEqual({
      provider: 'youtube',
      embedUrl: 'https://www.youtube.com/embed/abc',
    })
  })
})
