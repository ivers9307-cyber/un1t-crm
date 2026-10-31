// @vitest-environment jsdom
//
// PAGES.1 — LandingPageSettingsForm in page mode (a `page` prop): it edits a
// landing_pages row, saves PUT /api/landing-pages/<id> with { title, blocks,
// chrome }, previews /<slug>?edit=1, and renders read-only for a viewer who
// may not edit. The legacy studio mode (locationId + initialSettings) is
// untouched until studio pages move here in PR3.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: () => ({}) }))

import LandingPageSettingsForm from './LandingPageSettingsForm'
import { newBlockOfType, BLOCK_TYPES } from '@/lib/landing-page-blocks'
import { splitOfferBlock, STUDIO_OFFER_KEYS, ATTRIBUTION_KEYS, DROPPED_BLOCK_KEYS } from '@/lib/landing-page-offers'

const HATCH = '11111111-1111-1111-1111-111111111111'
const STUDIOS = [{ location_id: HATCH, name: 'UN1T Hatch Street', membership_source: 'un1t_online', enabled: true, sort_order: 0 }]

const HERO = { ...newBlockOfType('hero', { brand: 'UN1T' }), id: 'b-hero' }
const PILLARS = { ...newBlockOfType('pillars', { brand: 'UN1T' }), id: 'b-pillars' }

const basePage = (over = {}) => ({
  id: 'p-1', organization_id: 'org-1', slug: 'summer', title: 'Summer', kind: 'campaign',
  scope: 'one', primary_location_id: HATCH, offer_type: 'none', blocks: [HERO, PILLARS],
  chrome: { logo_url: 'https://cdn.example/logo.png', tone: 'dark', noindex: true, was_live: true },
  publish_state: 'draft', redirect_to: null, updated_at: '2026-10-30T10:00:00Z', ...over,
})

let puts
beforeEach(() => {
  puts = []
  globalThis.fetch = vi.fn(async (url, init) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(init.body)
      puts.push({ url, body })
      return { ok: true, status: 200, json: async () => ({ success: true, data: basePage({ title: body.title }) }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: { paid_products: [] }, memberships: [] }) }
  })
})
afterEach(() => cleanup())

function renderForm(props = {}) {
  return render(
    <LandingPageSettingsForm
      page={basePage()} studios={STUDIOS} canEdit
      availableBookingTypes={[]} availableEvents={[]} brand={{ companyName: 'UN1T', shortName: 'UN1T' }}
      {...props}
    />,
  )
}

describe('LandingPageSettingsForm (page mode)', () => {
  it('saves to /api/landing-pages/<id> with title, blocks and chrome, and the preview iframe src is /<slug>?edit=1', async () => {
    const { container } = renderForm()
    expect(container.querySelector('iframe').getAttribute('src')).toBe('/summer?edit=1')
    expect(container.querySelector('a[href="/summer"]')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Summer 26' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })

    expect(puts).toHaveLength(1)
    expect(puts[0].url).toBe('/api/landing-pages/p-1')
    expect(puts[0].body.title).toBe('Summer 26')
    expect(puts[0].body.blocks.map((b) => b.id)).toEqual(['b-hero', 'b-pillars'])
    // The stored chrome comes back with the form's logo and Instagram
    // fields over it; was_live is the server's and is never sent.
    expect(puts[0].body.chrome).toEqual({
      logo_url: 'https://cdn.example/logo.png', logo_alt: null, logo_width_px: null,
      tone: 'dark', noindex: true, show_instagram_feed: true,
    })
    expect(Object.keys(puts[0].body).sort()).toEqual(['blocks', 'chrome', 'title'])
    expect(screen.getByText(/^Saved /)).toBeTruthy()
  })

  it('a refused save shows the reason and keeps the edits', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ success: false, error: 'offer_block_required' }) }))
    renderForm()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    expect(screen.getByText('The offer section must stay first on this page.')).toBeTruthy()
  })

  it('a 200-character logo alt (the legacy table limit) is sent as is', async () => {
    const alt = 'a'.repeat(200)
    renderForm({ page: basePage({ chrome: { logo_alt: alt } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    expect(puts[0].body.chrome.logo_alt).toBe(alt)
    expect(screen.getByText(/^Saved /)).toBeTruthy()
  })

  it('a save refused by validation names the field', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 400,
      json: async () => ({ success: false, error: 'Invalid request body', issues: [{ path: 'chrome.logo_alt', message: 'Too big' }] }),
    }))
    renderForm()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    expect(screen.getByText('Invalid value for chrome.logo_alt')).toBeTruthy()
  })

  it('unsaved edits hold the publish buttons until the save lands', async () => {
    renderForm()
    const publish = () => screen.getByRole('button', { name: 'Publish' })
    expect(publish().disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Summer 26' } })
    expect(publish().disabled).toBe(true)
    expect(screen.getByText('Save your changes first.')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    expect(publish().disabled).toBe(false)
    expect(screen.queryByText('Save your changes first.')).toBeNull()
  })

  it('the preview state message carries the page id beside the studio', async () => {
    const { container } = renderForm()
    const win = container.querySelector('iframe').contentWindow
    const post = vi.spyOn(win, 'postMessage').mockImplementation(() => {})
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, data: { namespace: 'lp-editor', type: 'ready' } }))
    })
    const state = post.mock.calls.map(([m]) => m).find((m) => m?.type === 'state')
    expect(state).toMatchObject({ pageId: 'p-1', locationId: HATCH })
    expect(state.blocks.map((b) => b.id)).toEqual(['b-hero', 'b-pillars'])
  })

  it('read-only when canEdit is false (no Save, inputs disabled)', () => {
    const { container } = renderForm({ canEdit: false })
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
    const controls = [...container.querySelectorAll('input, select, textarea')]
    expect(controls.length).toBeGreaterThan(3)
    expect(controls.filter((el) => !el.matches(':disabled')).map((el) => el.name || el.id || el.type)).toEqual([])
    expect(screen.getByText('You can view this page but not edit it. Ask an owner at this studio.')).toBeTruthy()
  })

  it('a studio page has no preview iframe and saves its un1t.online terms copy in the chrome', async () => {
    const { container } = renderForm({ page: basePage({ kind: 'studio', slug: 'hatch-street', chrome: { un1t_terms: { waiver_link_label: 'waiver' } } }) })
    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.getByText('The preview shows here once studio pages move to this editor.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Terms tick label'), { target: { value: '  I accept the {terms}  ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    expect(puts[0].body.chrome.un1t_terms).toEqual({
      terms_label: 'I accept the {terms}', terms_link_label: null, waiver_link_label: 'waiver',
      terms_required_message: null, legal_unavailable_message: null,
    })
  })

  it('an empty title is refused before any request', async () => {
    renderForm()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '  ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    expect(puts).toHaveLength(0)
    expect(screen.getByText('Give the page a title.')).toBeTruthy()
  })
})

describe('LandingPageSettingsForm (page mode): the pinned offer block', () => {
  const OFFER = { ...splitOfferBlock(newBlockOfType('campaign_funnel')).page, id: 'b-offer' }
  const offerPage = (over = {}) => basePage({ offer_type: 'one_class', blocks: [OFFER, HERO, PILLARS], ...over })
  const OFFER_STUDIOS = [{ ...STUDIOS[0], offer: {}, attribution: {} }]
  const send = async (data) => {
    await act(async () => { window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, data: { namespace: 'lp-editor', ...data } })) })
  }

  it('the offer block is pinned: no drag handle, no delete, the library hides offer types', async () => {
    renderForm({ page: offerPage(), studios: OFFER_STUDIOS })
    expect(screen.getByText('Pinned')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Drag Campaign funnel (own page)' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Drag Hero' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Delete section' })).toHaveLength(2)
    // Its studio rows render under the page half.
    expect(screen.getByRole('checkbox', { name: 'Switched on at UN1T Hatch Street' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Add section' }))
    const offerTypes = BLOCK_TYPES.filter((t) => t.offer)
    expect(offerTypes.map((t) => t.type).sort()).toEqual(['campaign_funnel', 'class_funnel', 'corp_promo', 'paid_trial'])
    for (const t of offerTypes) expect(screen.queryByText(t.description), t.type).toBeNull()
    expect(screen.getByText(BLOCK_TYPES.find((t) => t.type === 'pillars').description)).toBeTruthy()

    // The preview cannot move, copy or delete it, nor put a section above it.
    await send({ type: 'delete-block', blockId: 'b-offer' })
    await send({ type: 'duplicate-block', blockId: 'b-offer' })
    await send({ type: 'move-block', blockId: 'b-offer', direction: 'down' })
    await send({ type: 'move-block', blockId: 'b-hero', direction: 'up' })
    await send({ type: 'add-block', blockType: 'stats', atIndex: 0 })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    const types = puts[0].body.blocks.map((b) => b.type)
    expect(types).toEqual(['campaign_funnel', 'stats', 'hero', 'pillars'])
  })

  it('page-half edits on the pinned block count as unsaved and go out with the page save', async () => {
    renderForm({ page: offerPage(), studios: OFFER_STUDIOS })
    fireEvent.change(screen.getByDisplayValue('A free trial of The 50+ Club'), { target: { value: 'Try it' } })
    expect(screen.getByText('Save your changes first.')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    const saved = puts[0].body.blocks[0]
    expect(saved).toMatchObject({ id: 'b-offer', heading: 'Try it' })
    // The page save never carries the studio half of the offer.
    for (const key of [...STUDIO_OFFER_KEYS.campaign_funnel, ...ATTRIBUTION_KEYS, ...DROPPED_BLOCK_KEYS.campaign_funnel]) {
      expect(saved, key).not.toHaveProperty(key)
    }
  })

  it('a first block of another offer type is not pinned: the offer is missing', () => {
    renderForm({ page: offerPage({ offer_type: 'paid_trial' }), studios: OFFER_STUDIOS })
    expect(screen.getByText("This page's offer block is missing. Ask the team.")).toBeTruthy()
    expect(screen.queryByText('Pinned')).toBeNull()
  })

  it('a page with an offer whose first block is not one says so, with no pinned card', () => {
    renderForm({ page: offerPage({ blocks: [HERO, PILLARS] }), studios: OFFER_STUDIOS })
    expect(screen.getByText("This page's offer block is missing. Ask the team.")).toBeTruthy()
    expect(screen.queryByText('Pinned')).toBeNull()
  })

  it('a page with no offer has no pinned card', () => {
    renderForm()
    expect(screen.queryByText('Pinned')).toBeNull()
    expect(screen.queryByText("This page's offer block is missing. Ask the team.")).toBeNull()
  })
})
