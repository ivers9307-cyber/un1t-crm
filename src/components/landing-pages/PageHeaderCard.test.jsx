// @vitest-environment jsdom
//
// PAGES.1 — the page editor's header card: the title (saved by the form's
// Save), the path with Rename, the status with its buttons (POST …/publish),
// the read-only scope, and the un1t.online terms copy on a studio page.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

import PageHeaderCard from './PageHeaderCard'
import { DEFAULT_FUNNEL_TERMS_COPY } from '@/lib/un1t-online-funnel-copy'

const HATCH = '11111111-1111-1111-1111-111111111111'
const STUDIOS = [{ location_id: HATCH, name: 'UN1T Hatch Street', enabled: true }]

const basePage = (over = {}) => ({
  id: 'p-1', organization_id: 'org-1', slug: 'summer', title: 'Summer', kind: 'campaign',
  scope: 'one', primary_location_id: HATCH, offer_type: 'paid_trial', blocks: [], chrome: {},
  publish_state: 'draft', redirect_to: null, updated_at: '2026-10-30T10:00:00Z', ...over,
})

let answer
beforeEach(() => {
  answer = { ok: true, status: 200, body: { success: true, data: basePage({ publish_state: 'live' }) } }
  globalThis.fetch = vi.fn(async () => ({ ok: answer.ok, status: answer.status, json: async () => answer.body }))
})
afterEach(() => cleanup())

function renderCard(props = {}) {
  const onPageChange = vi.fn()
  const onTitleChange = vi.fn()
  const onTermsChange = vi.fn()
  const page = props.page || basePage()
  render(
    <PageHeaderCard
      page={page} studios={STUDIOS} canEdit title={page.title} terms={{}}
      onTitleChange={onTitleChange} onPageChange={onPageChange} onTermsChange={onTermsChange}
      {...props}
    />,
  )
  return { onPageChange, onTitleChange, onTermsChange }
}

const click = (name) => act(async () => { fireEvent.click(screen.getByRole('button', { name })) })
const sentBody = (i = 0) => JSON.parse(globalThis.fetch.mock.calls[i][1].body)

describe('PageHeaderCard', () => {
  it('Publish posts live and shows not_ready from the API as a message naming the studio', async () => {
    answer = {
      ok: false, status: 409,
      body: {
        success: false, error: 'not_ready',
        studios: [
          { location_id: HATCH, name: 'UN1T Hatch Street', reason: 'needs_plan' },
          { location_id: 'x', name: 'UN1T Stillorgan', reason: 'no_platform' },
        ],
      },
    }
    const { onPageChange } = renderCard()
    await click('Publish')
    expect(globalThis.fetch.mock.calls[0][0]).toBe('/api/landing-pages/p-1/publish')
    expect(globalThis.fetch.mock.calls[0][1].method).toBe('POST')
    expect(sentBody()).toEqual({ publish_state: 'live' })
    expect(screen.getByRole('alert').textContent).toBe(
      'Not ready to go live: UN1T Hatch Street (needs a plan), UN1T Stillorgan (has no platform).',
    )
    expect(onPageChange).not.toHaveBeenCalled()
  })

  it('a published page is lifted to the editor and its chip changes', async () => {
    const { onPageChange } = renderCard()
    expect(screen.getByText('Draft')).toBeTruthy()
    await click('Publish')
    expect(onPageChange).toHaveBeenCalledWith(expect.objectContaining({ publish_state: 'live' }))
  })

  it('a draft offers Publish and Mark coming soon; coming soon offers Publish and Back to draft', () => {
    renderCard()
    expect(screen.getByRole('button', { name: 'Mark coming soon' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retire' })).toBeNull()
    cleanup()
    renderCard({ page: basePage({ publish_state: 'coming_soon' }) })
    expect(screen.getByText('Coming soon').className).toContain('bg-amber-500/10 text-amber-700')
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Back to draft' })).toBeTruthy()
  })

  it('Retire asks for a redirect path', async () => {
    const { onPageChange } = renderCard({ page: basePage({ publish_state: 'live' }) })
    expect(screen.getByText('Live').className).toContain('bg-green-500/10 text-green-700')
    await click('Retire')
    const path = screen.getByLabelText('Send visitors to')
    expect(path.value).toBe('/trial')

    fireEvent.change(path, { target: { value: '//evil.example' } })
    await click('Retire page')
    expect(screen.getByRole('alert').textContent).toBe('Use a path on this site that starts with /, like /trial.')
    expect(globalThis.fetch).not.toHaveBeenCalled()

    answer.body = { success: true, data: basePage({ publish_state: 'retired', redirect_to: '/autumn' }) }
    fireEvent.change(path, { target: { value: '/autumn' } })
    await click('Retire page')
    expect(sentBody()).toEqual({ publish_state: 'retired', redirect_to: '/autumn' })
    expect(onPageChange).toHaveBeenCalledWith(expect.objectContaining({ publish_state: 'retired' }))
  })

  it('a retired page shows where it redirects and offers Back to draft', () => {
    renderCard({ page: basePage({ publish_state: 'retired', redirect_to: '/trial' }) })
    expect(screen.getByText('Retired')).toBeTruthy()
    expect(screen.getByText('/trial')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Back to draft' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
  })

  it('Rename checks the path, PUTs the slug, and names a refusal', async () => {
    const { onPageChange } = renderCard({ page: basePage({ publish_state: 'live' }) })
    expect(screen.getByText('/summer')).toBeTruthy()
    await click('Rename')
    expect(screen.getByText('The old address will redirect to the new one.')).toBeTruthy()
    const input = screen.getByLabelText('New path')

    fireEvent.change(input, { target: { value: 'settings' } })
    await click('Save path')
    expect(screen.getByRole('alert').textContent).toBe('That path is reserved.')
    expect(globalThis.fetch).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'x' } })
    await click('Save path')
    expect(screen.getByRole('alert').textContent).toBe('Use letters, numbers and dashes only, 2 to 40 characters.')

    answer = { ok: false, status: 409, body: { success: false, error: 'taken' } }
    fireEvent.change(input, { target: { value: 'autumn' } })
    await click('Save path')
    expect(globalThis.fetch.mock.calls[0][0]).toBe('/api/landing-pages/p-1')
    expect(globalThis.fetch.mock.calls[0][1].method).toBe('PUT')
    expect(sentBody()).toEqual({ slug: 'autumn' })
    expect(screen.getByRole('alert').textContent).toBe('That path is already taken.')
    expect(onPageChange).not.toHaveBeenCalled()

    answer = { ok: true, status: 200, body: { success: true, data: basePage({ slug: 'autumn' }) } }
    await click('Save path')
    expect(onPageChange).toHaveBeenCalledWith(expect.objectContaining({ slug: 'autumn' }))
  })

  it('the title is lifted to the form and the scope is read-only', () => {
    const { onTitleChange } = renderCard()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Autumn' } })
    expect(onTitleChange).toHaveBeenCalledWith('Autumn')
    expect(screen.getByText('One studio: UN1T Hatch Street')).toBeTruthy()
    cleanup()
    renderCard({ page: basePage({ scope: 'all', primary_location_id: null }) })
    expect(screen.getByText('All studios')).toBeTruthy()
  })

  it('a studio page has no Rename or Retire and edits its un1t.online terms copy', () => {
    const { onTermsChange } = renderCard({ page: basePage({ kind: 'studio', slug: 'hatch-street', publish_state: 'live' }) })
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retire' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Unpublish' })).toBeTruthy()
    const label = screen.getByLabelText('Terms tick label')
    expect(label.placeholder).toBe(DEFAULT_FUNNEL_TERMS_COPY.terms_label)
    expect(screen.getByLabelText('Message when a document cannot load').placeholder).toBe(DEFAULT_FUNNEL_TERMS_COPY.legal_unavailable_message)
    fireEvent.change(label, { target: { value: 'I accept' } })
    expect(onTermsChange).toHaveBeenCalledWith({ terms_label: 'I accept' })
  })

  it('a campaign page shows no terms copy fields', () => {
    renderCard()
    expect(screen.queryByLabelText('Terms tick label')).toBeNull()
  })

  it('read-only: no buttons, a disabled title, and who edits the page', () => {
    renderCard({ canEdit: false, page: basePage({ scope: 'all', primary_location_id: null }) })
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByLabelText('Title').disabled).toBe(true)
    expect(screen.getByText('You can view this page but not edit it. An organisation admin edits all-studios pages.')).toBeTruthy()
    cleanup()
    renderCard({ canEdit: false })
    expect(screen.getByText('You can view this page but not edit it. Ask an owner at this studio.')).toBeTruthy()
  })
})
