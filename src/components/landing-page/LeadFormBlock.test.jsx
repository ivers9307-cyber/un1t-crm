import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LeadFormBlock, HeroBlock, SiteHeader, SiteFooter, PillarsBlock } from './BlockRenderers.jsx'

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
  // HATCH-OPEN.1
  it('swaps the capture form for a funnel button when asked and pageCtas resolved #start', () => {
    const html = renderToStaticMarkup(
      <LeadFormBlock block={{ ...base, offer, heading: 'Try us first', second_path: 'class_funnel' }} publicPath="hatch-street" ctaSecondaryHref="#start" ctaSecondaryLabel="Book free class" />
    )
    expect(html).toContain('€189')
    expect(html).toContain('Try us first')
    expect(html).toContain('href="#start"')
    expect(html).toContain('Book free class')
    expect(html).not.toContain('<form')
  })
  it('keeps the form when second_path asks for the funnel but pageCtas did not resolve it', () => {
    const html = renderToStaticMarkup(
      <LeadFormBlock block={{ ...base, offer, second_path: 'class_funnel' }} publicPath="hatch-street" ctaSecondaryHref="#waitlist" ctaSecondaryLabel="Keep me posted" />
    )
    expect(html).toContain('<form')
    expect(html).not.toContain('href="#start"')
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
    // W1.S1b — UN1T's wordmark arrives as a prop (org_settings.short_name)
    // now; with it the render is byte-identical to before the sweep.
    const html = renderToStaticMarkup(<LeadFormBlock block={base} publicPath="hatch-street" wordmark="UN1T" />)
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

describe('SiteHeader short label (HATCH-OFFER.3)', () => {
  it('prefers the short label so a long CTA is not clipped on phones', () => {
    const html = renderToStaticMarkup(
      <SiteHeader sticky ctaHref="https://x.test/#join" ctaLabel="Secure your Foundation Rate" ctaLabelShort="Foundation Offer" />
    )
    expect(html).toContain('Foundation Offer')
    expect(html).not.toContain('Secure your Foundation Rate')
  })
  it('falls back to the full label when no short one is given', () => {
    const html = renderToStaticMarkup(
      <SiteHeader sticky ctaHref="https://x.test/#join" ctaLabel="Secure your Foundation Rate" />
    )
    expect(html).toContain('Secure your Foundation Rate')
  })
  it('ignores a blank short label rather than rendering an empty button', () => {
    const html = renderToStaticMarkup(
      <SiteHeader sticky ctaHref="#waitlist" ctaLabel="Join the waitlist" ctaLabelShort="   " />
    )
    expect(html).toContain('Join the waitlist')
  })
})

describe('SiteHeader mobile fit (HEADER-FIT.1)', () => {
  // These assert CLASSES, not text. The failure this guards against is
  // a button running off a 375px screen, and vitest runs under node
  // with no jsdom — nothing here can measure a box. Classes are the
  // only part of that contract a unit test can hold; the widths
  // themselves were measured in a real browser.
  const header = (extra = {}) => renderToStaticMarkup(
    <SiteHeader sticky ctaHref="#waitlist" ctaLabel="Claim 3 free classes" eventsHref="/stillorgan/events" {...extra} />
  )

  it('steps Events aside below 420px so the CTA has room', () => {
    expect(header()).toContain('hidden min-[420px]:inline-block')
  })
  it('slims the button padding below 420px and restores it above', () => {
    expect(header()).toContain('!px-3.5 min-[420px]:!px-5')
  })
  it('lets the button shrink and ellipsize instead of running off-screen', () => {
    const html = header()
    expect(html).toContain('min-w-0')
    expect(html).toContain('truncate')
    // shrink-0 would pin the width and re-create the clip.
    expect(html).not.toContain('!text-sm shrink-0')
  })
  it('still renders the label and the events link', () => {
    const html = header()
    expect(html).toContain('Claim 3 free classes')
    expect(html).toContain('/stillorgan/events')
  })
})

// W1.S1b — the landing chrome names the page's own brand, never a literal.
describe('landing chrome carries the tenant brand (W1.S1b)', () => {
  it('SiteFooter names the org, lists ITS studios and its legal holder', () => {
    const html = renderToStaticMarkup(
      <SiteFooter
        brand="Gym A"
        legalName="Gym A Trading Ltd"
        studios={[{ name: 'Gym A North', href: '/welcome/north' }, { name: 'Gym A South', href: '/welcome/south' }]}
      />
    )
    expect(html).toContain('Gym A</div>')
    expect(html).toContain('href="/welcome/north"')
    expect(html).toContain('Gym A South')
    expect(html).toContain('Gym A Trading Ltd. All rights reserved.')
    expect(html).not.toMatch(/UN1T|Stillorgan|Hatch|\/welcome\/stillorgan|\/welcome\/hatch-street/)
  })

  it('SiteFooter with no chrome names nobody (no studios column, no holder)', () => {
    const html = renderToStaticMarkup(<SiteFooter />)
    expect(html).not.toMatch(/UN1T|Stillorgan|Hatch/)
    expect(html).not.toContain('Studios')
    expect(html).toMatch(/© \d{4}\. All rights reserved\./)
  })

  it('UN1T Group\'s chrome renders the footer UN1T always had', () => {
    const html = renderToStaticMarkup(
      <SiteFooter
        brand="UN1T Dublin"
        legalName="UN1T Dublin"
        studios={[{ name: 'UN1T Stillorgan', href: '/welcome/stillorgan' }, { name: 'UN1T Hatch Street', href: '/welcome/hatch-street' }]}
      />
    )
    expect(html).toContain('uppercase mb-4">UN1T Dublin</div>')
    expect(html).toContain('href="/welcome/stillorgan"')
    expect(html).toContain('href="/welcome/hatch-street"')
    expect(html).toContain('UN1T Dublin. All rights reserved.')
  })

  it('the watermark, the header fallback and "Why …" follow the wordmark prop', () => {
    expect(renderToStaticMarkup(<LeadFormBlock block={base} publicPath="x" wordmark="GA" />)).toContain('text-[13rem]">GA</span>')
    expect(renderToStaticMarkup(<LeadFormBlock block={base} publicPath="x" />)).not.toMatch(/UN1T/)
    expect(renderToStaticMarkup(<SiteHeader wordmark="GA" />)).toContain('tracking-widest text-white">GA</div>')
    expect(renderToStaticMarkup(<SiteHeader />)).not.toMatch(/UN1T/)
    const pillars = { id: 'p', type: 'pillars', items: [{ title: 'Coaching', body: 'b' }] }
    expect(renderToStaticMarkup(<PillarsBlock block={pillars} wordmark="GA" />)).toContain('Why GA')
    expect(renderToStaticMarkup(<PillarsBlock block={pillars} />)).toContain('Why us')
  })

  it('a lead form with no consent label names the page\'s studio', () => {
    const { consent_label: _c, ...noConsent } = base
    const html = renderToStaticMarkup(<LeadFormBlock block={noConsent} publicPath="x" locationName="Gym A North" />)
    expect(html).toContain('hear from Gym A North about the launch')
    expect(html).not.toMatch(/UN1T|Hatch Street/)
  })
})
