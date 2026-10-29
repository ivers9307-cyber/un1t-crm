import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
// The stub prints the props it was handed as raw JSON (inner HTML, so React
// does not escape the quotes to &quot; the way it would in an attribute).
vi.mock('./PaidTrialFunnel', () => ({ default: (p) => <div data-funnel="" dangerouslySetInnerHTML={{ __html: JSON.stringify({ keys: p.studios.map((s) => s.key), initial: p.initialStudio, returnPath: p.returnPath, preview: p.preview }) }} /> }))
import BlockRenderer, { HeroBlock } from './BlockRenderers.jsx'

const hero = { id: 'h', type: 'hero', eyebrow: 'Stillorgan, Dublin', headline: 'Fourteen days.', subhead: 'Every class.', subtext: 'Pay once.', image_url: 'https://x/y.jpg' }
const studio = { key: 'stillorgan', label: 'UN1T Stillorgan', sellable: true, block: {}, priceCents: 3900, currency: 'EUR', durationDays: 14, productName: 'Reset' }
const trial = { studio, returnPath: '/stillorgan', resumePurchaseId: null, cancelled: false, hatchTerms: null, preview: false }

describe('HeroBlock trial-first (TRIALFIRST.1)', () => {
  it('renders the card beside mixed-case copy under id=trial, with no marquee, cue or hero button', () => {
    const html = renderToStaticMarkup(<HeroBlock block={hero} trial={trial} ctaHref="#trial" ctaLabel="Start" />)
    expect(html).toContain('id="trial"')
    expect(html).toContain('"keys":["stillorgan"],"initial":"stillorgan","returnPath":"/stillorgan","preview":false')
    expect(html).toContain('Fourteen days.')
    expect(html).not.toMatch(/<h1[^>]*uppercase/)
    expect(html).not.toContain('lp-marquee-track')
    expect(html).not.toContain('lp-cue')
    expect(html).not.toContain('class="lp-btn')
  })
  it('without trial the classic hero is unchanged (marquee, cue, button)', () => {
    const html = renderToStaticMarkup(<HeroBlock block={hero} ctaHref="#waitlist" ctaLabel="Join" />)
    expect(html).toContain('lp-marquee-track')
    expect(html).toContain('lp-cue')
    expect(html).toContain('Join')
    expect(html).not.toContain('id="trial"')
  })
  it('an empty hero block still renders the card on the wordmark backdrop', () => {
    const html = renderToStaticMarkup(<HeroBlock block={{ id: 'h', type: 'hero' }} trial={trial} wordmark="UN1T" />)
    expect(html).toContain('id="trial"')
    expect(html).toContain('lp-outline')
    expect(html).toContain('"keys":["stillorgan"]')
  })
  it('keeps every copy field, with the subhead as a grey block span', () => {
    const html = renderToStaticMarkup(<HeroBlock block={hero} trial={trial} />)
    expect(html).toContain('Stillorgan, Dublin')
    expect(html).toContain('<span class="block text-white/50 text-[clamp(1.35rem,3vw,2.4rem)] leading-[1.1] mt-2">Every class.</span>')
    expect(html).toContain('Pay once.')
    expect(html).toContain('md:grid-cols-[1.05fr_1fr]')
    expect(html).toContain('lp-kenburns')
  })
  it('the video still wins over the image in the trial-first backdrop', () => {
    const html = renderToStaticMarkup(<HeroBlock block={{ ...hero, video_url: 'https://x/v.mp4' }} trial={trial} />)
    expect(html).toContain('<video')
    expect(html).not.toContain('lp-kenburns')
  })
})

describe('BlockRenderer trial props (TRIALFIRST.1)', () => {
  it('forwards trial to the hero', () => {
    const html = renderToStaticMarkup(<BlockRenderer block={hero} trial={trial} />)
    expect(html).toContain('id="trial"')
    expect(html).toContain('"keys":["stillorgan"]')
  })
  it('forwards trialShown to the lead form as compact', () => {
    const lead = { id: 'l', type: 'lead_form', heading: 'Not ready yet?', subtext: 'Keep in touch.' }
    expect(renderToStaticMarkup(<BlockRenderer block={lead} publicPath="x" trialShown />)).toContain('bg-lp-pale')
    expect(renderToStaticMarkup(<BlockRenderer block={lead} publicPath="x" />)).not.toContain('bg-lp-pale')
  })
})
