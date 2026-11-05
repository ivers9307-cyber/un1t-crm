// MOBILEFUNNEL.1 — the two long sections on a phone: member videos are a
// sideways swipe of ~70%-wide cards below md (the grid from md), and each
// "Why" pillar is a compact row with a 72px square photo below md (the 3:4
// photo card from md).
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PillarsBlock } from './BlockRenderers'
import VideoTestimonials from './VideoTestimonials'

const CLIPS = [1, 2, 3].map((i) => ({ video_url: `https://cdn/v${i}.mp4`, poster_url: `https://cdn/p${i}.jpg`, name: `Member ${i}` }))
const classOf = (html, marker) => {
  const at = html.indexOf(marker)
  const tagStart = html.lastIndexOf('<', at)
  const tag = html.slice(tagStart, html.indexOf('>', at))
  return (tag.match(/class="([^"]*)"/) || [])[1] || ''
}

describe('VideoTestimonials on a phone', () => {
  it('is a snapping sideways row below md and the three-column grid from md', () => {
    const html = renderToStaticMarkup(<VideoTestimonials items={CLIPS} />)
    const row = classOf(html, 'data-video-swipe')
    for (const c of ['flex', 'overflow-x-auto', 'snap-x', 'snap-mandatory', 'md:grid', 'md:grid-cols-3', 'md:overflow-visible']) expect(row.split(' ')).toContain(c)
    const tiles = html.match(/<figure class="[^"]*"/g)
    expect(tiles).toHaveLength(3)
    for (const t of tiles) {
      for (const c of ['shrink-0', 'w-[70%]', 'snap-start', 'md:w-auto', 'aspect-[9/16]']) expect(t).toContain(c)
    }
    expect(html).not.toContain('<video') // still posters only until tapped
  })
})

describe('PillarsBlock on a phone', () => {
  it('each pillar is a row with a 72px square photo below md, the 3:4 card from md', () => {
    const block = { items: [1, 2, 3].map((i) => ({ number: `0${i}`, title: `T${i}`, body: `B${i}`, photo_url: `https://cdn/${i}.jpg` })) }
    const html = renderToStaticMarkup(<PillarsBlock block={block} wordmark="UN1T" />)
    const cards = html.match(/<div data-pillar="" class="[^"]*"/g)
    expect(cards).toHaveLength(3)
    for (const c of cards) for (const k of ['flex', 'gap-4', 'p-4', 'md:block', 'md:p-7']) expect(c).toContain(k)
    expect(html).toContain('w-[72px] h-[72px] md:w-auto md:h-auto md:aspect-[3/4]')
    expect(html).toContain('T2')
    expect(html).toContain('B3')
  })
})
