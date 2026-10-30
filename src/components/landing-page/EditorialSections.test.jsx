// src/components/landing-page/EditorialSections.test.jsx
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatsBlock, PillarsBlock, TestimonialBlock, ReviewsBlock } from './BlockRenderers.jsx'

const stats = { id: 's', type: 'stats', items: [{ number: '200+', label: 'members' }] }
const pillars = { id: 'p', type: 'pillars', items: [{ number: '01', title: 'Coach-led', body: 'x' }] }
const quote = { id: 'q', type: 'testimonial', quote: 'Best gym', author: 'Nikki M' }
const reviews = { id: 'r', type: 'reviews', min_rating: 4 }
const reviewsData = { reviews: [{ id: '1', rating: 5, comment: 'Great', author_name: 'A', review_time: '2026-01-01', hidden: false }] }

describe('Editorial sections (TRIALFIRST.1)', () => {
  it('stats, pillars and reviews sit on the pale token with black type', () => {
    for (const html of [renderToStaticMarkup(<StatsBlock block={stats} />), renderToStaticMarkup(<PillarsBlock block={pillars} wordmark="UN1T" />), renderToStaticMarkup(<ReviewsBlock block={reviews} reviewsData={reviewsData} />)]) {
      expect(html).toContain('bg-lp-pale')
      expect(html).not.toContain('bg-black ')
      expect(html).not.toMatch(/text-white(\/\d+)?["\s]/)
    }
  })
  it('the quote band stays black with white stars and no giant quote mark', () => {
    const html = renderToStaticMarkup(<TestimonialBlock block={quote} />)
    expect(html).toContain('bg-black')
    expect(html).not.toContain('text-amber-400')
    expect(html).not.toContain('text-[12rem]')
  })
  it('a review card is white with a hairline', () => {
    const html = renderToStaticMarkup(<ReviewsBlock block={reviews} reviewsData={reviewsData} />)
    expect(html).toContain('bg-white border border-black/10')
    expect(html).toContain('from-lp-pale')
  })
  it('the edit-mode placeholder for reviews takes the pale surface too', () => {
    const html = renderToStaticMarkup(<ReviewsBlock block={reviews} reviewsData={{ reviews: [] }} onEdit={() => {}} />)
    expect(html).toContain('bg-lp-pale')
    expect(html).not.toMatch(/text-white/)
  })
})
