import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LeadFormBlock, HeroBlock } from './BlockRenderers.jsx'

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
  it('renders the disabled-offer section identically to a block with no offer group', () => {
    const withOut = renderToStaticMarkup(<LeadFormBlock block={base} publicPath="hatch-street" />)
    const disabled = renderToStaticMarkup(<LeadFormBlock block={{ ...base, offer: { ...offer, enabled: false } }} publicPath="hatch-street" />)
    expect(withOut).toBe(disabled)
  })

  // The test above compares two renders of the SAME code path, so it
  // holds however that path changes — it proves absent === disabled and
  // nothing more. The property that actually matters is that the
  // no-offer markup never moves at all, because Stillorgan and every
  // future studio page render through it. That needs an artefact from
  // outside this file, so the expected HTML is committed as a fixture.
  //
  // Regenerate deliberately, never reflexively:  UPDATE_GOLDEN=1 npx vitest run src/components/landing-page/LeadFormBlock.test.jsx
  // A diff here means the public marketing page changed for every studio.
  it('matches the committed golden HTML for the no-offer render', () => {
    const html = renderToStaticMarkup(<LeadFormBlock block={base} publicPath="hatch-street" />)
    const goldenPath = new URL('./__fixtures__/lead-form-no-offer.html', import.meta.url)
    if (process.env.UPDATE_GOLDEN) {
      mkdirSync(dirname(fileURLToPath(goldenPath)), { recursive: true })
      writeFileSync(goldenPath, html)
    }
    expect(html).toBe(readFileSync(goldenPath, 'utf8'))
  })
  it('does not throw on a corrupted offer group', () => {
    const html = renderToStaticMarkup(<LeadFormBlock block={{ ...base, offer: 'broken' }} publicPath="hatch-street" />)
    expect(html).toContain('Keep me posted')
  })
})

describe('HeroBlock second CTA (HATCH-OFFER.1)', () => {
  const hero = { id: 'h', type: 'hero', headline: 'UN1T OPENS 2ND STUDIO' }

  it('renders both buttons when a secondary is supplied', () => {
    const html = renderToStaticMarkup(
      <HeroBlock block={hero} ctaHref="https://hatchstreet.un1t.online/#join" ctaLabel="Claim your rate" ctaSecondaryHref="#waitlist" ctaSecondaryLabel="Keep me posted" />
    )
    expect(html).toContain('Claim your rate')
    expect(html).toContain('Keep me posted')
    expect(html).toContain('lp-btn-ghost')
  })
  it('marks an off-site primary rel=noopener', () => {
    const html = renderToStaticMarkup(<HeroBlock block={hero} ctaHref="https://hatchstreet.un1t.online/#join" ctaLabel="Claim your rate" />)
    expect(html).toContain('rel="noopener"')
  })
  it('leaves an on-page anchor without rel', () => {
    const html = renderToStaticMarkup(<HeroBlock block={hero} ctaHref="#waitlist" ctaLabel="Join the waitlist" />)
    expect(html).not.toContain('rel="noopener"')
  })
  it('renders one button when there is no secondary', () => {
    const html = renderToStaticMarkup(<HeroBlock block={hero} ctaHref="#waitlist" ctaLabel="Join the waitlist" />)
    expect(html).not.toContain('lp-btn-ghost')
  })
})
