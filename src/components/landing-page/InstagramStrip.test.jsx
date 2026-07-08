import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import InstagramStrip from './InstagramStrip.jsx'

// This repo runs vitest under the `node` environment with no jsdom /
// @testing-library/react installed (2950 pure-lib tests). We render the
// component to static markup via react-dom/server and assert on the HTML —
// same three behaviours the plan specifies (tiles link to the permalink with
// rel=noopener, reels are marked data-reel, empty posts renders nothing).

const posts = [
  { id: '1', permalink: 'https://instagram.com/p/1', thumb_url: 'https://x/1.jpg', is_reel: false, caption: 'a' },
  { id: '2', permalink: 'https://instagram.com/reel/2', thumb_url: 'https://x/2.jpg', is_reel: true, caption: 'b' },
]

// Anchor open-tags whose href points at a post permalink (p/ or reel/),
// excluding the profile "Follow" header link.
function permalinkAnchors(html) {
  return (html.match(/<a\b[^>]*>/g) || []).filter((tag) => /href="https:\/\/instagram\.com\/(?:p|reel)\//.test(tag))
}

describe('InstagramStrip', () => {
  it('renders a tile per post linking to the permalink with rel=noopener', () => {
    const html = renderToStaticMarkup(
      <InstagramStrip posts={posts} username="un1t" profileUrl="https://instagram.com/un1t" />,
    )
    const links = permalinkAnchors(html)
    expect(links.length).toBe(2)
    links.forEach((tag) => expect(tag).toContain('noopener'))
  })

  it('marks reels (data-reel) so the badge shows', () => {
    const html = renderToStaticMarkup(<InstagramStrip posts={posts} />)
    expect((html.match(/data-reel="true"/g) || []).length).toBe(1)
  })

  it('renders nothing when there are no posts', () => {
    const html = renderToStaticMarkup(<InstagramStrip posts={[]} />)
    expect(html).toBe('')
  })
})
