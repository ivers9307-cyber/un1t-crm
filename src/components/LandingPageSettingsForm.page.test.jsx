// @vitest-environment jsdom
//
// PAGES.1 — LandingPageSettingsForm: it edits a landing_pages row (a studio
// page included), saves PUT /api/landing-pages/<id> with { title, blocks,
// chrome }, previews /<slug>?edit=1, and renders read-only for a viewer who
// may not edit.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: () => ({}) }))
const media = vi.hoisted(() => ({ upload: vi.fn(async () => ({ success: true, url: 'https://cdn/new.png' })) }))
vi.mock('@/lib/landing-media-upload', () => ({
  uploadLandingMedia: media.upload,
  captureVideoPoster: async () => null,
}))

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
    expect(screen.getByText('This page\'s offer section is missing, so it cannot be saved. Ask the team.')).toBeTruthy()
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

  it('page-mode uploads send page_id, never location_id', async () => {
    media.upload.mockClear()
    // scope='all': no primary location at all, so pageId alone must be enough.
    const { container } = renderForm({ page: basePage({ scope: 'all', primary_location_id: null }) })
    const input = container.querySelector('input[type=file][accept="image/png,image/jpeg,image/webp"]')
    expect(input).toBeTruthy()
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } }) })
    expect(media.upload).toHaveBeenCalledTimes(1)
    const arg = media.upload.mock.calls[0][0]
    expect(arg.pageId).toBe('p-1')
    expect(arg.locationId).toBeUndefined()
    expect(arg.kind).toBe('image')
  })

  it('the preview select lists enabled studios and sets &studio= on the iframe', () => {
    const STILL = '22222222-2222-2222-2222-222222222222'
    const OFF = '33333333-3333-3333-3333-333333333333'
    const rows = [
      { ...STUDIOS[0], public_path: 'hatch-street' },
      { location_id: STILL, name: 'UN1T Stillorgan', membership_source: 'glofox', enabled: true, sort_order: 1, public_path: null },
      { location_id: OFF, name: 'UN1T Xtown', membership_source: 'glofox', enabled: false, sort_order: 2, public_path: 'xtown' },
    ]
    const { container } = renderForm({ page: basePage({ scope: 'all', primary_location_id: null }), studios: rows })
    const select = screen.getByRole('combobox', { name: 'Preview studio' })
    const options = [...select.querySelectorAll('option')].map((o) => ({ label: o.textContent, value: o.value, disabled: o.disabled }))
    expect(options).toEqual([
      { label: 'Choose on page', value: '', disabled: false },
      { label: 'UN1T Hatch Street', value: 'hatch-street', disabled: false },
      { label: 'UN1T Stillorgan (no public path)', value: '', disabled: true },
    ])
    const iframe = () => container.querySelector('iframe').getAttribute('src')
    expect(iframe()).toBe('/summer?edit=1')
    fireEvent.change(select, { target: { value: 'hatch-street' } })
    expect(iframe()).toBe('/summer?edit=1&studio=hatch-street')
    // Not page content: choosing a studio leaves nothing unsaved.
    expect(screen.queryByText('Save your changes first.')).toBeNull()
    fireEvent.change(select, { target: { value: '' } })
    expect(iframe()).toBe('/summer?edit=1')
  })

  it('a one-studio page previews its studio with no select', () => {
    const { container } = renderForm()
    expect(screen.queryByRole('combobox', { name: 'Preview studio' })).toBeNull()
    expect(screen.getByText('Previewing:').parentElement.textContent).toContain('UN1T Hatch Street')
    expect(container.querySelector('iframe').getAttribute('src')).toBe('/summer?edit=1')
  })

  it('read-only when canEdit is false (no Save, inputs disabled)', () => {
    const { container } = renderForm({ canEdit: false })
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
    const controls = [...container.querySelectorAll('input, select, textarea')]
    expect(controls.length).toBeGreaterThan(3)
    expect(controls.filter((el) => !el.matches(':disabled')).map((el) => el.name || el.id || el.type)).toEqual([])
    expect(screen.getByText('You can view this page but not edit it. Ask an owner at this studio.')).toBeTruthy()
  })

  it('a studio page previews at its slug like any page, with Save', () => {
    const { container } = renderForm({ page: basePage({ kind: 'studio', slug: 'hatch-street' }) })
    expect(container.querySelector('iframe').getAttribute('src')).toBe('/hatch-street?edit=1')
    expect(screen.queryByText(/preview shows here once/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()
  })

  it('a studio page\'s un1t terms fields save into chrome.un1t_terms', async () => {
    renderForm({ page: basePage({ kind: 'studio', slug: 'hatch-street', chrome: { tone: 'dark', un1t_terms: { waiver_link_label: 'waiver' } } }) })
    const waiver = screen.getByLabelText('Waiver link text')
    expect(waiver.value).toBe('waiver')
    expect(waiver.disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('Terms tick label'), { target: { value: '  I accept the {terms}  ' } })
    // A terms edit is an unsaved change.
    expect(screen.getByText('Save your changes first.')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    expect(puts).toHaveLength(1)
    expect(puts[0].body.chrome.un1t_terms).toEqual({
      terms_label: 'I accept the {terms}', terms_link_label: null, waiver_link_label: 'waiver',
      terms_required_message: null, legal_unavailable_message: null,
    })
    expect(screen.queryByText('Save your changes first.')).toBeNull()
  })

  it('a class_funnel offer block edits the funnel emails only: the terms wording is the header card\'s alone', () => {
    const CF = { ...splitOfferBlock(newBlockOfType('class_funnel', { brand: 'UN1T' })).page, id: 'b-cf', terms_label: 'old block words' }
    renderForm({
      page: basePage({ kind: 'studio', slug: 'hatch-street', offer_type: 'class_funnel', blocks: [HERO, CF] }),
      studios: [{ ...STUDIOS[0], offer: {}, attribution: {} }],
    })
    expect(screen.getByText('New account email: subject (un1t.online studios)')).toBeTruthy()
    expect(screen.getByText('Trial already used email: message (un1t.online studios)')).toBeTruthy()
    for (const label of ['Terms tick (un1t.online studios)', 'Terms link text (un1t.online studios)', 'Waiver link text (un1t.online studios)',
      'Terms not ticked: message (un1t.online studios)', 'Terms page could not load: message (un1t.online studios)']) {
      expect(screen.queryByText(label), label).toBeNull()
    }
    expect(screen.queryByDisplayValue('old block words')).toBeNull()
    // One set of terms fields on the page: the header card's.
    expect(screen.getAllByLabelText('Terms tick label')).toHaveLength(1)
  })

  it('a campaign page shows no terms fields and sends none it did not hold', async () => {
    renderForm()
    expect(screen.queryByLabelText('Terms tick label')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    expect(puts[0].body.chrome).not.toHaveProperty('un1t_terms')
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

  it('an inline edit from the preview never writes the pinned block\'s studio half', async () => {
    renderForm({ page: offerPage(), studios: OFFER_STUDIOS })
    for (const key of [...STUDIO_OFFER_KEYS.campaign_funnel, ...ATTRIBUTION_KEYS, ...DROPPED_BLOCK_KEYS.campaign_funnel]) {
      await send({ type: 'edit-field', blockId: 'b-offer', path: [key], value: 'x' })
    }
    await send({ type: 'edit-field', blockId: 'b-offer', path: ['heading'], value: 'Strong at 60' })
    await send({ type: 'edit-field', blockId: 'b-offer', path: ['expect_cards', 0, 'title'], value: 'Your coach' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    const saved = puts[0].body.blocks[0]
    expect(saved).toMatchObject({ id: 'b-offer', heading: 'Strong at 60' })
    expect(saved.expect_cards[0].title).toBe('Your coach')
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

  it('a studio page pins its offer block where it sits: no "missing" notice, and a save keeps the order', async () => {
    const TRIAL = { ...splitOfferBlock(newBlockOfType('paid_trial', { brand: 'UN1T' })).page, id: 'b-trial' }
    const studioPage = basePage({ kind: 'studio', slug: 'hatch-street', offer_type: 'paid_trial', blocks: [HERO, PILLARS, TRIAL] })
    renderForm({ page: studioPage, studios: OFFER_STUDIOS })
    expect(screen.queryByText("This page's offer block is missing. Ask the team.")).toBeNull()
    expect(screen.getByText('Pinned')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Drag / }).map((b) => b.getAttribute('aria-label'))).toEqual(['Drag Hero', 'Drag Pillars'])
    expect(screen.getAllByRole('button', { name: 'Delete section' })).toHaveLength(2)

    // The preview cannot delete, copy or move it; other blocks may pass it.
    await send({ type: 'delete-block', blockId: 'b-trial' })
    await send({ type: 'duplicate-block', blockId: 'b-trial' })
    await send({ type: 'move-block', blockId: 'b-trial', direction: 'up' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    expect(puts[0].body.blocks.map((b) => b.id)).toEqual(['b-hero', 'b-pillars', 'b-trial'])

    await send({ type: 'move-block', blockId: 'b-pillars', direction: 'down' })
    await send({ type: 'add-block', blockType: 'stats', atIndex: 0 })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    expect(puts[1].body.blocks.map((b) => b.type)).toEqual(['stats', 'hero', 'paid_trial', 'pillars'])
  })

  it('a page with no offer has no pinned card', () => {
    renderForm()
    expect(screen.queryByText('Pinned')).toBeNull()
    expect(screen.queryByText("This page's offer block is missing. Ask the team.")).toBeNull()
  })
})
