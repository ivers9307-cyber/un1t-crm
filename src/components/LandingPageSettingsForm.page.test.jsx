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
import { newBlockOfType } from '@/lib/landing-page-blocks'

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
