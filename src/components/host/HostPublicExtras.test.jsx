// HOSTPAGE.2 — the public host page's extra sections: about (above the
// events), photos, "What people say" (testimonials + the ratings summary) and
// the collapsed past-events archive; every section omitted when empty.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import HostPublicExtras, { HostAbout } from './HostPublicExtras.jsx'

const FULL = {
  photos: [{ url: 'https://cdn.test/a.jpg', caption: 'Warm up' }, { url: 'https://cdn.test/b.jpg', caption: null }],
  testimonials: [{ quote: 'Brilliant class', author: 'Aoife' }, { quote: 'Came back twice', author: null }],
  ratingSummary: { average: 4.3, count: 3, comments: [{ rating: 5, comment: 'Loved it', author: 'Dan', created_at: '2026-07-19T09:00:00Z' }, { rating: 4, comment: 'Good', author: '', created_at: '2026-07-18T09:00:00Z' }] },
  pastEvents: [{ id: 'e1', name: 'Mobility Workshop', dateLabel: 'Friday 17 July 2026' }],
  accentHex: '#ff0000',
}
const render = (props) => renderToStaticMarkup(<HostPublicExtras {...props} />)

describe('HostPublicExtras', () => {
  it('renders photos with captions, testimonials with authors, the ratings line and comments, and past events without links', () => {
    const html = render(FULL)
    expect(html).toContain('src="https://cdn.test/a.jpg"')
    expect(html).toContain('<figcaption')
    expect(html).toContain('Warm up')
    expect(html).toContain('What people say')
    expect(html).toContain('Brilliant class')
    expect(html).toContain('— Aoife')
    expect(html).toContain('4.3')
    expect(html).toContain('3 ratings')
    expect(html).toContain('Loved it')
    expect(html).toContain('— Dan')
    expect(html).toContain('Past events')
    expect(html).toContain('Mobility Workshop')
    expect(html).toContain('Friday 17 July 2026')
    expect(html).toContain('<details')
    expect(html.slice(html.indexOf('Past events'))).not.toContain('<a href')
  })
  it('omits each empty section and renders nothing when all are empty', () => {
    const html = render({ ...FULL, photos: [], ratingSummary: null, pastEvents: [] })
    expect(html).not.toContain('<figure')
    expect(html).not.toContain('ratings')
    expect(html).not.toContain('Past events')
    expect(html).toContain('Brilliant class')
    expect(render({ photos: [], testimonials: [], ratingSummary: null, pastEvents: [] })).toBe('')
  })
  it('a summary with no comments still shows the line; "1 rating" is singular', () => {
    const html = render({ photos: [], testimonials: [], ratingSummary: { average: 5, count: 1, comments: [] }, pastEvents: [] })
    expect(html).toContain('What people say')
    expect(html).toContain('1 rating')
    expect(html).not.toContain('1 ratings')
  })
})

describe('HostAbout', () => {
  it('splits paragraphs on blank lines and renders nothing for empty text', () => {
    const html = renderToStaticMarkup(<HostAbout text={'We are Acme.\n\nWe run workshops.'} />)
    expect(html.match(/<p/g).length).toBe(2)
    expect(html).toContain('We run workshops.')
    expect(renderToStaticMarkup(<HostAbout text="" />)).toBe('')
  })
})
