// @vitest-environment jsdom
//
// APPROVALSQ.6 — the "This studio" | "All my studios" switch on /approvals.
// The cards are stubbed (they expose the studio props they receive).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('next/link', () => ({ default: ({ href, children, ...r }) => <a href={href} {...r}>{children}</a> }))

function stub(name) {
  return function Stub({ item, activeStudioId, selectable, selected, onToggle }) {
    return (
      <div data-testid={`card-${name}`} data-studio-id={item.studioId ?? ''} data-studio-name={item.studioName ?? ''} data-active={activeStudioId ?? ''}>
        <span>{item.id}</span>
        {selectable && <input type="checkbox" aria-label={`select-${item.id}`} checked={!!selected} onChange={() => onToggle?.()} />}
      </div>
    )
  }
}
vi.mock('@/components/AgentRequestDecideCard', () => ({ default: stub('agent') }))
vi.mock('@/components/TrialPurchaseReviewCard', () => ({ default: stub('trial') }))
vi.mock('@/components/CorpPromoClaimCard', () => ({ default: stub('corp') }))
vi.mock('@/components/approvals/OfferPurchaseCard', () => ({ default: stub('offer') }))
vi.mock('@/components/approvals/team-cards', () => ({
  TEAM_CARDS: { time_off: ({ item, activeStudioId }) => <div data-testid="team" data-studio-id={item.studioId ?? ''} data-active={activeStudioId ?? ''}>{item.id}</div> },
  TeamLinkCard: () => null,
}))

import ApprovalsInbox from './ApprovalsInbox.jsx'

const it_ = (id, extra = {}) => ({ id, title: id, submittedAt: '2026-11-01T10:00:00Z', ...extra })
const prov = (key, items, failedItems = []) => ({ key, label: key, reviewBase: `/x/${key}`, count: items.length + failedItems.length, items, failedItems })
const S1 = { id: 'studio-1', name: 'Stillorgan' }
const S2 = { id: 'studio-2', name: 'Hatch Street' }
const at = (s) => ({ studioId: s.id, studioName: s.name })

const thisStudio = (studios) => ({ providers: [prov('agent_requests', [it_('mia-1')]), prov('time_off', [it_('leave-1')])], total: 2, studios })
const allStudios = (extra = {}) => ({
  providers: [prov('agent_requests', [it_('mia-1', at(S1)), it_('mia-2', at(S2))]), prov('time_off', [it_('leave-1', at(S2))])],
  total: 3, scope: 'all', studios: [S1, S2], failedStudios: [], truncated: false, ...extra,
})

function mockApi({ plain, all }) {
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    json: async () => ({ success: true, data: String(url).includes('scope=all') ? all : plain }),
  })))
}
const urls = () => fetch.mock.calls.map((c) => c[0])
const render_ = () => render(<ApprovalsInbox activeStudioId="studio-1" />)

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('the studio switch', () => {
  it('is hidden with one studio, and with none', async () => {
    mockApi({ plain: thisStudio([S1]), all: allStudios() })
    render_()
    await screen.findByText('mia-1')
    expect(screen.queryByRole('button', { name: 'All my studios' })).toBeNull()
    cleanup()
    mockApi({ plain: { providers: [prov('agent_requests', [it_('mia-1')])], total: 1 }, all: allStudios() })
    render_()
    await screen.findByText('mia-1')
    expect(screen.queryByRole('button', { name: 'All my studios' })).toBeNull()
  })

  it('is shown with two studios, defaults to This studio and asks for no scope', async () => {
    mockApi({ plain: thisStudio([S1, S2]), all: allStudios() })
    render_()
    await screen.findByText('mia-1')
    expect(screen.getByRole('button', { name: 'This studio' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'All my studios' })).toBeTruthy()
    expect(urls()).toEqual(['/api/approvals/pending'])
    expect(screen.queryByText(/Each decision is made at the studio named on the card/)).toBeNull()
  })

  it('choosing All my studios requests ?scope=all and remembers the choice', async () => {
    mockApi({ plain: thisStudio([S1, S2]), all: allStudios() })
    render_()
    await screen.findByText('mia-1')
    fireEvent.click(screen.getByRole('button', { name: 'All my studios' }))
    await screen.findByText('mia-2')
    expect(urls().at(-1)).toBe('/api/approvals/pending?scope=all')
    expect(Object.values(localStorage)).toContain('all')
    cleanup()
    // A new visit opens straight on All my studios.
    mockApi({ plain: thisStudio([S1, S2]), all: allStudios() })
    render_()
    await screen.findByText('mia-2')
    expect(urls()).toEqual(['/api/approvals/pending?scope=all'])
    // And back again.
    fireEvent.click(screen.getByRole('button', { name: 'This studio' }))
    await waitFor(() => expect(screen.queryByText('mia-2')).toBeNull())
    expect(urls().at(-1)).toBe('/api/approvals/pending')
    expect(Object.values(localStorage)).not.toContain('all')
  })

  it('says how many studios, and what could not load or was cut off', async () => {
    mockApi({ plain: thisStudio([S1, S2]), all: allStudios({ failedStudios: ['Hatch Street'], truncated: true }) })
    render_()
    await screen.findByText('mia-1')
    fireEvent.click(screen.getByRole('button', { name: 'All my studios' }))
    await screen.findByText('mia-2')
    expect(screen.getByText(/Showing 2 studios\. Each decision is made at the studio named on the card\./)).toBeTruthy()
    expect(screen.getByText(/Could not load: Hatch Street\./)).toBeTruthy()
    expect(screen.getByText(/Showing the first 2 studios\./)).toBeTruthy()
  })

  it('says nothing about failures or a cut when there are none', async () => {
    mockApi({ plain: thisStudio([S1, S2]), all: allStudios() })
    render_()
    await screen.findByText('mia-1')
    fireEvent.click(screen.getByRole('button', { name: 'All my studios' }))
    await screen.findByText('mia-2')
    expect(screen.queryByText(/Could not load/)).toBeNull()
    expect(screen.queryByText(/first \d+ studios/)).toBeNull()
  })

  it('every card gets its studio fields and the active studio id', async () => {
    mockApi({ plain: thisStudio([S1, S2]), all: allStudios() })
    render_()
    await screen.findByText('mia-1')
    fireEvent.click(screen.getByRole('button', { name: 'All my studios' }))
    await screen.findByText('mia-2')
    const cards = screen.getAllByTestId('card-agent')
    expect(cards.map((c) => [c.dataset.studioId, c.dataset.studioName, c.dataset.active])).toEqual([
      ['studio-1', 'Stillorgan', 'studio-1'],
      ['studio-2', 'Hatch Street', 'studio-1'],
    ])
    fireEvent.click(screen.getByRole('button', { name: /^Team and money/ }))
    const t = await screen.findByTestId('team')
    expect([t.dataset.studioId, t.dataset.active]).toEqual(['studio-2', 'studio-1'])
  })

  it('the view badges show the merged totals', async () => {
    mockApi({ plain: thisStudio([S1, S2]), all: allStudios() })
    render_()
    await screen.findByText('mia-1')
    fireEvent.click(screen.getByRole('button', { name: 'All my studios' }))
    await screen.findByText('mia-2')
    expect(screen.getByRole('button', { name: /^Customers/ }).textContent).toContain('2')
    expect(screen.getByRole('button', { name: /^Team and money/ }).textContent).toContain('1')
    expect(screen.getByText('3 pending')).toBeTruthy()
  })

  it('switching scope reloads and clears the selection and select mode', async () => {
    mockApi({ plain: { ...thisStudio([S1, S2]), providers: [prov('agent_requests', [it_('mia-1')])] }, all: allStudios() })
    render_()
    await screen.findByText('mia-1')
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByLabelText('select-mia-1'))
    expect(screen.getByText('1 selected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'All my studios' }))
    await screen.findByText('mia-2')
    expect(screen.queryByText(/selected$/)).toBeNull()
    expect(screen.queryByLabelText('select-mia-1')).toBeNull()
    expect(screen.getByRole('button', { name: 'Select' })).toBeTruthy()
  })

  it('a saved All with only one studio falls back to the plain list', async () => {
    localStorage.setItem('un1t-approvals-scope', 'all')
    mockApi({ plain: thisStudio([S1]), all: allStudios({ studios: [S1] }) })
    render_()
    await screen.findByText('mia-1')
    expect(urls()).toEqual(['/api/approvals/pending?scope=all', '/api/approvals/pending'])
    expect(screen.queryByRole('button', { name: 'All my studios' })).toBeNull()
  })
})
