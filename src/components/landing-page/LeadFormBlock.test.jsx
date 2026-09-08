import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LeadFormBlock } from './BlockRenderers.jsx'

// Node environment, no jsdom — render to static markup. WaitlistWidget
// is safe to render this way: it uses useState only, with no effects
// on mount.

const base = {
  id: 'l',
  type: 'lead_form',
  heading: 'Keep me posted',
  subtext: 'Not ready to join yet?',
  button_label: 'Keep me posted',
  consent_label: 'I agree',
}

const offer = {
  enabled: true,
  section_eyebrow: 'Two ways in',
  section_heading: 'Fix your rate\nbefore we open',
  eyebrow: 'Foundation membership',
  price: '€189',
  was_price: '€219',
  was_price_note: 'a month from 19 September',
  unit: 'per month\nfixed for life',
  deadline: 'Offer ends 19 September',
  ticks: ['Unlimited classes'],
  cta_label: 'Claim your rate',
  cta_url: 'https://hatchstreet.un1t.online/#join',
}

describe('LeadFormBlock offer branch (HATCH-OFFER.1)', () => {
  it('renders the offer panel and keeps the capture form when the offer is on', () => {
    const html = renderToStaticMarkup(<LeadFormBlock block={{ ...base, offer }} publicPath="hatch-street" />)
    expect(html).toContain('€189')
    expect(html).toContain('lp-was-strike')
    expect(html).toContain('https://hatchstreet.un1t.online/#join')
    expect(html).toContain('Keep me posted')
  })
  it('keeps the section anchored at #waitlist so the secondary CTA still resolves', () => {
    const html = renderToStaticMarkup(<LeadFormBlock block={{ ...base, offer }} publicPath="hatch-street" />)
    expect(html).toContain('id="waitlist"')
  })
  it('renders no offer markup at all when the offer is off', () => {
    const html = renderToStaticMarkup(<LeadFormBlock block={{ ...base, offer: { ...offer, enabled: false } }} publicPath="hatch-street" />)
    expect(html).not.toContain('€189')
    expect(html).not.toContain('lp-was-strike')
    expect(html).toContain('Keep me posted')
  })
  it('renders the pre-offer section unchanged for a block with no offer group', () => {
    const withOut = renderToStaticMarkup(<LeadFormBlock block={base} publicPath="hatch-street" />)
    const disabled = renderToStaticMarkup(<LeadFormBlock block={{ ...base, offer: { ...offer, enabled: false } }} publicPath="hatch-street" />)
    expect(withOut).toBe(disabled)
  })
  it('does not throw on a corrupted offer group', () => {
    const html = renderToStaticMarkup(<LeadFormBlock block={{ ...base, offer: 'broken' }} publicPath="hatch-street" />)
    expect(html).toContain('Keep me posted')
  })
})
