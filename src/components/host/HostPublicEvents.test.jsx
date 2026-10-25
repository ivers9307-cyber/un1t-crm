import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import HostPublicEvents from './HostPublicEvents.jsx'

// HOST-EVENTS-PAGE.2 — a card for an event whose registration has closed is
// listed with a red "Registration closed" badge and is NOT a link to the buy
// page; open and sold-out cards still link as before.
const card = (over) => ({
  slug: 'x', title: 'Event X', kindLabel: 'Masterclass', dateLabel: 'Sun 18 Oct',
  timeLabel: '11:00', venue: 'UN1T Hatch Street', priceLabel: '€15', badge: null, closed: false, ...over,
})
const render = (cards) => renderToStaticMarkup(
  <HostPublicEvents hostName="Host" headline="Upcoming events" blurb={null} heroUrl={null} accentHex={null} cards={cards} />,
)

describe('HostPublicEvents', () => {
  it('lists a closed event with the badge and no link to its buy page', () => {
    const html = render([card({ slug: 'ptc-closed', badge: 'Registration closed', closed: true })])
    expect(html).toContain('Registration closed')
    expect(html).toContain('Event X')
    expect(html).not.toContain('/event/ptc-closed')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('View')
  })

  it('an open event is unchanged: links to /event/<slug> with "View & book"', () => {
    const html = render([card({ slug: 'ptc-open' })])
    expect(html).toContain('href="/event/ptc-open"')
    expect(html).toContain('View &amp; book')
    expect(html).not.toContain('Registration closed')
  })

  it('a sold-out event still links (red badge, "View")', () => {
    const html = render([card({ slug: 'ptc-full', badge: 'Sold out' })])
    expect(html).toContain('href="/event/ptc-full"')
    expect(html).toContain('bg-red-600')
  })

  it('closed and open cards can sit side by side', () => {
    const html = render([card({ slug: 'a', badge: 'Registration closed', closed: true }), card({ slug: 'b', title: 'Event B' })])
    expect(html).not.toContain('/event/a"')
    expect(html).toContain('href="/event/b"')
  })
})
