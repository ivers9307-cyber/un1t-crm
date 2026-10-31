// FIFTYPLUS.1 — /50plus: the campaign page renders the block's words and
// video, hands the funnel only client-safe copy, shows the chosen sections in
// the light tone, and never 404s paid traffic on an unreadable row.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

let blocks = []
let dbFails = false
function makeDb() {
  const q = (table) => {
    const b = {
      select: () => b, eq: () => b, gte: () => b, not: () => b, order: () => b, limit: () => b, in: () => b,
      maybeSingle: async () => {
        if (dbFails) return { data: null, error: { message: 'boom' } }
        return { data: { location_id: 'loc-s', public_path: 'stillorgan', blocks }, error: null }
      },
      then: (resolve, reject) => Promise.resolve(table === 'google_reviews' ? { data: [], error: null } : { data: null, error: null }).then(resolve, reject),
    }
    return b
  }
  return { from: (table) => q(table) }
}
vi.mock('@/lib/supabase', () => ({ createServerClient: () => makeDb() }))
vi.mock('@/lib/host-brand', () => ({
  resolveOrgChrome: vi.fn(async () => ({ companyName: 'UN1T', shortName: 'UN1T', studios: [], legalName: 'Champ Fitness Ltd' })),
  resolveLocationBrand: vi.fn(async () => ({ companyName: 'UN1T Stillorgan', locationName: 'Stillorgan' })),
}))
vi.mock('@/lib/landing-logo', () => ({ getLandingLogo: vi.fn(async () => 'https://x/logo.png'), STILLORGAN_LANDING_LOGO: 'https://x/logo.png' }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn() }))
vi.mock('@/components/landing-page/CampaignFunnel', () => ({ default: (props) => <div data-testid="funnel">{JSON.stringify(props)}</div> }))
vi.mock('@/components/landing-page/RevealManager', () => ({ default: () => null }))
vi.mock('@/components/VisitOriginCapture', () => ({ default: () => null }))

import FiftyPlusPage, { generateMetadata } from './page.js'

beforeEach(() => { blocks = []; dbFails = false })

const CFG = {
  type: 'campaign_funnel', campaign: '50plus', heading: 'A free trial of The 50+ Club',
  trial_membership_id: 'elite-m', trial_plan_code: 'elite-p', class_keywords: '50+',
  video_url: 'https://x/v.mp4', poster_url: 'https://x/p.jpg', show_sections: ['stats'],
}

describe('/50plus page', () => {
  it('renders hero copy, the funnel with client-safe copy only, the expect strip and the chosen sections in light tone', async () => {
    blocks = [
      CFG,
      { id: 's1', type: 'stats', items: [{ number: '4.9', label: 'Rating' }] },
      { id: 'v1', type: 'video_testimonials', items: [{ video_url: 'https://x/a.mp4', poster_url: 'https://x/a.jpg' }] },
    ]
    const html = renderToStaticMarkup(await FiftyPlusPage({ searchParams: Promise.resolve({}) }))
    expect(html).toContain('A free trial of The 50+ Club')
    expect(html).toContain('https://x/v.mp4')
    expect(html).not.toContain('trial_membership_id')
    expect(html).not.toContain('elite-m')
    expect(html).not.toContain('class_keywords')
    expect(html).toContain('Built for where you are now')
    expect(html).toContain('4.9')
    expect(html).not.toContain('https://x/a.jpg') // video_testimonials not in show_sections
    const funnelProps = JSON.parse(html.match(/data-testid="funnel">(.*?)<\/div>/)[1].replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&'))
    expect(funnelProps).toMatchObject({ publicPath: 'stillorgan', campaign: '50plus' })
    expect(funnelProps.copy.heading).toBe('A free trial of The 50+ Club')
    expect(funnelProps.copy.trial_membership_id).toBeUndefined()
  })

  it('renders the hero and card on an unreadable row (never a 404)', async () => {
    dbFails = true
    const html = renderToStaticMarkup(await FiftyPlusPage({ searchParams: Promise.resolve({}) }))
    expect(html).toContain('A free trial of The 50+ Club')
    expect(html).toContain('data-testid="funnel"')
  })

  it('renders the video testimonials section light when chosen', async () => {
    blocks = [
      { ...CFG, show_sections: ['video_testimonials'] },
      { id: 'v1', type: 'video_testimonials', items: [{ video_url: 'https://x/a.mp4', poster_url: 'https://x/a.jpg' }] },
    ]
    const html = renderToStaticMarkup(await FiftyPlusPage({ searchParams: Promise.resolve({}) }))
    // The island renders the poster statically; the clip plays on tap.
    expect(html).toContain('https://x/a.jpg')
    expect(html).toMatch(/<section class="bg-lp-pale text-black[^"]*"><div class="max-w-6xl mx-auto px-6">/)
  })

  it('metadata is noindex and the title carries no em-dash (customer-visible copy)', async () => {
    const meta = await generateMetadata()
    expect(meta.robots).toEqual({ index: false, follow: false })
    expect(meta.title).toBe('The 50+ Club Trial at UN1T')
    expect(meta.title).not.toContain('—')
  })
})
