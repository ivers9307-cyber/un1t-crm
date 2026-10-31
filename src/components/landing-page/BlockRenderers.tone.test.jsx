// FIFTYPLUS.1 — tone="light" on BlockRenderer for a light page (/50plus).
// The stats and reviews blocks already render on the pale surface since the
// Editorial look (#2255); the video testimonials block is the one that was
// still black, so it is the one the prop changes. The default is unchanged
// (dark), and tone is a prop the page passes, never block data.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import BlockRenderer from './BlockRenderers.jsx'

const stats = { id: 's', type: 'stats', items: [{ number: '4.9', label: 'Google rating' }] }
const videos = { id: 'v', type: 'video_testimonials', title: 'Hear from members', items: [{ video_url: 'https://x/a.mp4', poster_url: 'https://x/a.jpg' }] }
const reviews = { id: 'r', type: 'reviews', title: 'Reviews', min_rating: 4 }
const reviewsData = { reviews: [{ id: 1, rating: 5, comment: 'Great', author_name: 'A', review_time: '2026-01-01' }] }

const LIGHT_SURFACE = /bg-lp-pale|bg-white/
// The section wrapper's class list: the play-button overlay inside a video
// thumbnail is dark on purpose in every tone, so the surface is judged on the
// section, not on the whole markup.
const sectionClass = (html) => (html.match(/<section class="([^"]*)"/) || [])[1] || ''

describe('BlockRenderer tone', () => {
  it('video testimonials render light on tone="light"', () => {
    const cls = sectionClass(renderToStaticMarkup(<BlockRenderer block={videos} tone="light" />))
    expect(cls).toMatch(LIGHT_SURFACE)
    expect(cls).toContain('text-black')
    expect(cls).not.toContain('bg-black')
  })

  it('video testimonials stay dark by default', () => {
    expect(sectionClass(renderToStaticMarkup(<BlockRenderer block={videos} />))).toContain('bg-black')
  })

  it.each([['stats', stats], ['reviews', reviews]])('%s is already light, with or without the prop', (_, block) => {
    for (const tone of [undefined, 'light']) {
      const cls = sectionClass(renderToStaticMarkup(<BlockRenderer block={block} tone={tone} reviewsData={reviewsData} />))
      expect(cls).toMatch(LIGHT_SURFACE)
      expect(cls).not.toContain('bg-black')
    }
  })

  it('a block the prop does not cover ignores it', () => {
    const pillars = { id: 'p', type: 'pillars', items: [{ number: '01', title: 'T', body: 'B' }] }
    expect(renderToStaticMarkup(<BlockRenderer block={pillars} tone="light" />)).toBe(renderToStaticMarkup(<BlockRenderer block={pillars} />))
  })
})
