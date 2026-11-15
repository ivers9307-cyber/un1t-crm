// @vitest-environment jsdom
//
// FUNNELPREVIEW.1 — every word the editor has for an offer block reaches the
// card in the preview, as it is typed.
//
// The defect this pins: the preview used to clone the card element the server
// built (`layout.offer`) with the live block's words. Across the server
// boundary that element is a LAZY REFERENCE, never an element (its copy
// shares `expect_cards` with the expect strip, and a shared object makes the
// enclosing element lazy), so `isValidElement` was false, the clone was
// skipped and the card kept the words the server seeded: the reassurance line
// stayed on its default while the hero (read live) followed every keystroke.
// The old test passed because it handed the overlay a plain element, which a
// server never does. So here `offer` is what a browser really gets (a lazy
// reference) and the card is the REAL one.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'

vi.mock('@/lib/funnel-track', () => ({ trackFunnelStep: vi.fn() }))
vi.mock('@/lib/meta-pixel-lead', () => ({
  newLeadEventId: () => 'lead-id', pixelUserData: () => ({}), fireBrowserLead: vi.fn(),
  fireBrowserInitiateCheckout: vi.fn(), checkoutEventIdFor: (id) => `c-${id}`,
}))
vi.mock('@/lib/meta-pixel-paths', () => ({ metaPixelIdsForPath: () => [], pageLocationIdFromDocument: () => null, STUDIO_META_PIXELS_BY_LOCATION: {} }))
vi.mock('@/lib/visit-origin', () => ({ readVisitOrigin: () => null, firstTouchAttribution: () => null }))
vi.mock('./ClassFunnelCheckout', () => ({ default: () => null }))
vi.mock('./BlockRenderers', () => ({
  default: (p) => <div data-testid={`block-${p.block.id}`}>{p.block.type}</div>,
  SiteHeader: () => null,
  SiteFooter: () => null,
}))

import EditModeOverlay from './EditModeOverlay.jsx'
import { CampaignFunnelEdit } from '@/components/LandingPageSettingsForm'
import { CAMPAIGN_FUNNEL_COPY_DEFAULTS, campaignFunnelCopy, campaignFunnelClientCopy } from '@/lib/campaign-funnel'
import { corpPromoCopyFromBlocks } from '@/lib/corp-promos'

// What the Flight client hands a client component for an element whose props
// share an object with an earlier prop: a lazy reference to the element.
const asServerSends = (element) => ({ $$typeof: Symbol.for('react.lazy'), _payload: element, _init: (p) => p })

const CLASSES = [
  { event_id: 'e1', name: '50+ Club', day: '2026-11-16', day_label: 'Mon, 16 Nov', time: '07:00', starts_at: '2026-11-16T07:00:00Z' },
  { event_id: 'e2', name: '50+ Club', day: '2026-11-18', day_label: 'Wed, 18 Nov', time: '07:00', starts_at: '2026-11-18T07:00:00Z' },
]
const listAnswer = (data) => vi.fn(async (url, init) => {
  if (init?.method === 'POST') return { ok: true, json: async () => ({ success: true }) }
  return { ok: true, json: async () => ({ success: true, data }) }
})

const pushState = (blocks) => act(() => {
  window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, data: { namespace: 'lp-editor', type: 'state', blocks } }))
})

// The saved block before the operator types: nothing set, every word a default.
const SAVED = { id: 'cf', type: 'campaign_funnel', video_url: 'https://x/v.mp4', sound_default: 'muted' }
const TEXT_KEYS = [...Object.keys(CAMPAIGN_FUNNEL_COPY_DEFAULTS), 'consent_label']
// What the operator types: a different, recognisable value in every field.
const live = (key) => (key === 'cta_label' ? 'LIVE cta {day} {time}' : `LIVE ${key}`)
const TYPED = { ...SAVED, ...Object.fromEntries(TEXT_KEYS.map((k) => [k, live(k)])) }
const shown = (key) => (key === 'cta_label' ? 'LIVE cta Mon 07:00' : live(key))

// The layout as the [slug] route builds it for the preview, seeded from SAVED.
function campaignLayout() {
  const copy = campaignFunnelCopy(SAVED, { brand: 'UN1T' })
  const offerProps = { publicPath: 'stillorgan', campaign: '50plus', page: '50plus', copy: campaignFunnelClientCopy(copy), locationName: 'UN1T' }
  return {
    kind: 'one_class', offerBlockId: 'cf', cta: { href: '#book', label: 'Book a free class' },
    hero: { videoUrl: copy.video_url, soundLabel: copy.sound_label, soundDefault: copy.sound_default, eyebrow: copy.eyebrow, heading: copy.heading, subhead: copy.subhead },
    expect: { eyebrow: copy.expect_eyebrow, heading: copy.expect_heading, cards: copy.expect_cards },
    // Never rendered once offerProps is there; a lazy reference, as in a browser.
    offer: asServerSends(<div data-testid="server-card">{copy.reassurance}</div>),
    offerProps,
  }
}

const text = () => document.body.textContent

beforeEach(() => {
  Object.defineProperty(window, 'parent', { value: { postMessage: vi.fn() }, configurable: true })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(window, 'parent', { value: window, configurable: true })
})

describe('the campaign card in the preview follows the editor (FUNNELPREVIEW.1)', () => {
  it('the reassurance line under the button shows what was typed, not the default', async () => {
    globalThis.fetch = listAnswer({ classes: CLASSES, campaign: { configured: true } })
    render(<EditModeOverlay initialBlocks={[SAVED]} offerLayout={campaignLayout()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Book Mon 07:00' })).toBeTruthy())
    expect(text()).toContain(CAMPAIGN_FUNNEL_COPY_DEFAULTS.reassurance)

    pushState([{ ...SAVED, reassurance: 'Free · no card · 45 minutes' }])
    expect(text()).toContain('Free · no card · 45 minutes')
    expect(text()).not.toContain(CAMPAIGN_FUNNEL_COPY_DEFAULTS.reassurance)
    // Blanked again: back on the default, as the public page resolves it.
    pushState([{ ...SAVED, reassurance: '' }])
    expect(text()).toContain(CAMPAIGN_FUNNEL_COPY_DEFAULTS.reassurance)
  })

  it('every text field of the block is reflected in the preview, on the step that shows it', async () => {
    const seen = new Set()
    const expectShown = (...keys) => { for (const k of keys) { expect(text(), k).toContain(shown(k)); seen.add(k) } }

    // The class step, the details step and the booked step.
    globalThis.fetch = listAnswer({ classes: CLASSES, campaign: { configured: true } })
    render(<EditModeOverlay initialBlocks={[SAVED]} offerLayout={campaignLayout()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Book Mon 07:00' })).toBeTruthy())
    pushState([TYPED])
    expectShown('eyebrow', 'heading', 'subhead', 'sound_label', 'pick_title', 'pick_body', 'cta_label', 'reassurance', 'expect_eyebrow', 'expect_heading')

    fireEvent.click(screen.getByRole('button', { name: shown('cta_label') }))
    expectShown('details_title', 'details_body', 'consent_label', 'reassurance', 'cta_label')

    fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'Ann' } })
    fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: 'Byrne' } })
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'ann@example.com' } })
    fireEvent.change(screen.getByPlaceholderText('Phone'), { target: { value: '0871234567' } })
    fireEvent.click(screen.getByRole('button', { name: shown('cta_label') }))
    await waitFor(() => expect(text()).toContain(shown('done_title')))
    expectShown('done_title', 'done_body')
    cleanup()

    // The three states with no class to pick, each in the operator's words.
    for (const [key, data] of [
      ['no_classes_text', { classes: [], campaign: { configured: true } }],
      ['not_configured_text', { classes: [], campaign: { configured: false } }],
      ['timetable_unavailable_text', { classes: [], campaign: { configured: true, timetable_unavailable: true } }],
    ]) {
      globalThis.fetch = listAnswer(data)
      render(<EditModeOverlay initialBlocks={[SAVED]} offerLayout={campaignLayout()} />)
      await waitFor(() => expect(text()).toContain(CAMPAIGN_FUNNEL_COPY_DEFAULTS[key]))
      pushState([TYPED])
      expectShown(key)
      cleanup()
    }

    // Nothing the block owns was left unchecked.
    expect([...seen].sort()).toEqual([...TEXT_KEYS].sort())
  })

  it('the editor has no text field this test does not cover', () => {
    const onUpdate = vi.fn()
    const { container } = render(<CampaignFunnelEdit block={SAVED} onUpdate={onUpdate} uploadMedia={vi.fn()} uploading={{}} uploadErr={{}} progress={{}} />)
    for (const el of container.querySelectorAll('input[type="text"], textarea')) fireEvent.change(el, { target: { value: 'typed' } })
    const written = new Set(onUpdate.mock.calls.flatMap(([patch]) => Object.keys(patch || {})))
    // Media and the expect cards are not card words: the hero and the strip read them live (EditModeOverlay.offer.test.jsx).
    const notWords = ['video_url', 'poster_url', 'video_focus', 'sound_default', 'expect_cards']
    const words = [...written].filter((k) => !notWords.includes(k))
    expect(words.length).toBeGreaterThan(10)
    expect(words.filter((k) => !TEXT_KEYS.includes(k))).toEqual([])
  })

  it('the card\'s own words are still edited in place, and the card renders with no offerProps as the server built it', async () => {
    globalThis.fetch = listAnswer({ classes: CLASSES, campaign: { configured: true } })
    const posted = []
    Object.defineProperty(window, 'parent', { value: { postMessage: (m) => posted.push(m) }, configurable: true })
    render(<EditModeOverlay initialBlocks={[SAVED]} offerLayout={campaignLayout()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Book Mon 07:00' })).toBeTruthy())
    const title = screen.getAllByRole('textbox').find((el) => el.textContent === CAMPAIGN_FUNNEL_COPY_DEFAULTS.pick_title)
    title.textContent = 'Choose a morning'
    fireEvent.input(title)
    expect(posted).toContainEqual({ namespace: 'lp-editor', type: 'edit-field', blockId: 'cf', path: ['pick_title'], value: 'Choose a morning' })
    cleanup()

    // The route's no-path notice: no props to rebuild from, the server's element stands.
    const layout = { ...campaignLayout(), offerProps: null }
    render(<EditModeOverlay initialBlocks={[SAVED]} offerLayout={layout} />)
    await waitFor(() => expect(screen.getByTestId('server-card')).toBeTruthy())
  })
})

describe('the sibling cards follow the editor too (FUNNELPREVIEW.1)', () => {
  it('a promo card (corp_promo): its class step, and its filled tokens', async () => {
    globalThis.fetch = listAnswer({ classes: CLASSES, campaign: { configured: true } })
    const PROMO = { id: 'cp', type: 'corp_promo', promo_key: 'k1' }
    const layout = {
      kind: 'one_class', offerBlockId: 'cp', anchor: 'corp', cta: { href: '#corp', label: 'Claim' },
      hero: { heading: '' }, expect: { eyebrow: '', heading: '', cards: [] },
      offer: asServerSends(<div data-testid="server-card" />),
      offerProps: { promoKey: 'k1', copy: corpPromoCopyFromBlocks([PROMO], 'k1'), terms: null, page: 'corp', studio: 'hatch', stepCopy: {} },
      offerLive: { promoKey: 'k1', platform: null, tokens: { studio_name: 'Hatch Street', credits: 3 }, unavailableText: null },
    }
    render(<EditModeOverlay initialBlocks={[PROMO]} offerLayout={layout} />)
    await waitFor(() => expect(screen.getAllByRole('button').some((b) => b.hasAttribute('data-tile'))).toBe(true))
    pushState([{ ...PROMO, pick_title: 'LIVE promo pick', cta_label: 'LIVE claim {credits} at {studio_name}' }])
    expect(text()).toContain('LIVE promo pick')
    // On to the form, where the promo's own button shows, tokens filled.
    fireEvent.click(document.querySelector('[data-tile="e1"]'))
    fireEvent.click(screen.getAllByRole('button').find((el) => el.textContent === 'Choose Mon 07:00'))
    await waitFor(() => expect(text()).toContain('LIVE claim 3 at Hatch Street'))
  })

  it('a paid trial card (paid_trial): the page\'s words change, the studio\'s product does not', async () => {
    globalThis.fetch = listAnswer({ classes: [], campaign: { configured: true } })
    const view = {
      key: 'stillorgan', label: 'Stillorgan', publicPath: 'stillorgan', sellable: true,
      block: { heading: 'The 14 Day Reset', cta_label: 'Start my trial', consent_label: 'Keep me posted.', product_name: 'The 14 Day Reset' },
      priceCents: 3900, currency: 'EUR', durationDays: 14, productName: 'The 14 Day Reset',
    }
    const PT = { id: 'pt', type: 'paid_trial', heading: 'The 14 Day Reset' }
    const layout = {
      kind: 'frosted', anchor: 'trial', heroImageUrl: 'https://x/b.jpg', offerBlockId: 'pt', cta: { href: '#trial', label: 'Start my trial' },
      offer: asServerSends(<div data-testid="server-card" />),
      offerProps: { studios: [view], initialStudio: 'stillorgan', resumePurchaseId: null, cancelled: false, hatchTerms: null, returnPath: '/trial', page: 'trial', preview: true },
    }
    render(<EditModeOverlay initialBlocks={[PT]} offerLayout={layout} />)
    expect(screen.getByRole('heading', { name: 'Pick your first class' })).toBeTruthy()
    pushState([{ ...PT, pick_title: 'LIVE trial pick', product_name: 'A product the page must not rename', studio_label: 'Elsewhere' }])
    expect(screen.getByRole('heading', { name: 'LIVE trial pick' })).toBeTruthy()
    expect(text()).not.toContain('A product the page must not rename')
    expect(text()).not.toContain('Elsewhere')
    // Still the disabled preview: nothing posted.
    expect(globalThis.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([])
  })

  it('a class funnel card (class_funnel): its heading and sub-copy', async () => {
    globalThis.fetch = listAnswer({ classes: [] })
    const FUNNEL = { id: 'fn', type: 'class_funnel', heading: 'Book a class' }
    const layout = {
      kind: 'frosted', anchor: 'start', heroImageUrl: 'https://x/b.jpg', offerBlockId: 'fn', cta: { href: '#start', label: 'Book' },
      offer: asServerSends(<div data-testid="server-card" />),
      offerProps: { publicPath: 'stillorgan', page: 'start', locationName: 'UN1T Stillorgan', consultSlug: '', heading: 'Book a class' },
    }
    render(<EditModeOverlay initialBlocks={[FUNNEL]} offerLayout={layout} />)
    await waitFor(() => expect(text()).toContain('Book a class'))
    pushState([{ ...FUNNEL, heading: 'LIVE funnel heading', subhead: 'LIVE funnel subhead' }])
    expect(text()).toContain('LIVE funnel heading')
    expect(text()).toContain('LIVE funnel subhead')
  })
})
