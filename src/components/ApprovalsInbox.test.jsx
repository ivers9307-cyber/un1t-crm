// @vitest-environment jsdom
//
// APPROVALSQ.1 — the /approvals page: one Customers list plus the old tabs
// for team and money items. The four cards are stubbed; this is about the page.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'

vi.mock('next/link', () => ({ default: ({ href, children, ...r }) => <a href={href} {...r}>{children}</a> }))

function stub(name) {
  return function Stub({ item, onDecided }) {
    return (
      <div data-testid={`card-${name}`}>
        <span>{item.id}</span>
        <button type="button" onClick={() => onDecided?.()}>decide-{item.id}</button>
      </div>
    )
  }
}
vi.mock('@/components/AgentRequestDecideCard', () => ({ default: stub('agent') }))
vi.mock('@/components/TrialPurchaseReviewCard', () => ({ default: stub('trial') }))
vi.mock('@/components/CorpPromoClaimCard', () => ({ default: stub('corp') }))
vi.mock('@/components/approvals/OfferPurchaseCard', () => ({ default: stub('offer') }))

import ApprovalsInbox from './ApprovalsInbox.jsx'

const it_ = (id, extra = {}) => ({ id, title: id, submittedAt: '2026-11-01T10:00:00Z', ...extra })
const prov = (key, items, failedItems = [], extra = {}) => ({
  key, label: key, reviewBase: `/x/${key}`, count: items.length + failedItems.length, items, failedItems, ...extra,
})

function mockApi(providers) {
  const total = providers.reduce((s, p) => s + p.count, 0)
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true, data: { providers, total } }) })))
}

const customers = () => [
  prov('agent_requests', [it_('mia-wait')], [it_('mia-fail')]),
  prov('trial_purchases', [it_('trial-1')]),
  prov('corp_promo_claims', [it_('corp-1')]),
  prov('offer_purchases', [it_('offer-1')]),
]
const team = () => [prov('time_off', [it_('leave-1', { reviewUrl: '/leave/1', subtitle: 's' })], [], { label: 'Time off' })]

beforeEach(() => {})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ApprovalsInbox customers view', () => {
  it('shows one list mixing Mia, trial, promo and offer cards, failed Mia first under "Needs fixing"', async () => {
    mockApi(customers())
    render(<ApprovalsInbox />)
    await screen.findByText('mia-fail')
    expect(screen.getByText('Needs fixing')).toBeTruthy()
    expect(screen.getByText('Waiting')).toBeTruthy()
    const ids = screen.getAllByTestId(/^card-/).map((n) => n.querySelector('span').textContent)
    expect(ids[0]).toBe('mia-fail')
    expect(ids.slice().sort()).toEqual(['corp-1', 'mia-fail', 'mia-wait', 'offer-1', 'trial-1'])
    expect(screen.getByTestId('card-corp')).toBeTruthy()
    expect(screen.getByTestId('card-offer')).toBeTruthy()
  })

  it('a chip narrows the list and All restores it', async () => {
    mockApi(customers())
    render(<ApprovalsInbox />)
    await screen.findByText('trial-1')
    fireEvent.click(screen.getByRole('button', { name: /^Paid trials/ }))
    expect(screen.getAllByTestId(/^card-/)).toHaveLength(1)
    expect(screen.getByText('trial-1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^All/ }))
    expect(screen.getAllByTestId(/^card-/)).toHaveLength(5)
  })

  it('renders no chip for a provider the API did not return', async () => {
    mockApi([prov('agent_requests', [it_('mia-wait')])])
    render(<ApprovalsInbox />)
    await screen.findByText('mia-wait')
    expect(screen.getByRole('button', { name: /^Mia requests/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Paid trials/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Offer sales/ })).toBeNull()
  })

  it('opens on Team and money when no customer item is waiting', async () => {
    mockApi([prov('agent_requests', []), ...team()])
    render(<ApprovalsInbox />)
    await screen.findByText('leave-1')
    expect(screen.queryByText('Nothing waiting on customers.')).toBeNull()
  })

  it('hides the Customers view when the API returns no customer provider', async () => {
    mockApi(team())
    render(<ApprovalsInbox />)
    await screen.findByText('leave-1')
    expect(screen.queryByRole('button', { name: /^Customers/ })).toBeNull()
  })

  it('Team and money shows the old tabs without the four customer keys', async () => {
    mockApi([...customers(), ...team()])
    render(<ApprovalsInbox />)
    await screen.findByText('mia-fail')
    fireEvent.click(screen.getByRole('button', { name: /^Team and money/ }))
    expect(screen.getByText('leave-1')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^trial_purchases/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^agent_requests/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^Time off/ })).toBeTruthy()
  })

  it('deciding a card drops the Customers badge by one', async () => {
    mockApi([...customers(), ...team()])
    render(<ApprovalsInbox />)
    await screen.findByText('trial-1')
    const view = screen.getByRole('button', { name: /^Customers/ })
    expect(within(view).getByText('5')).toBeTruthy()
    fireEvent.click(screen.getByText('decide-trial-1'))
    expect(within(view).getByText('4')).toBeTruthy()
  })

  it('one provider with count 0 and no items does not break the list', async () => {
    mockApi([prov('agent_requests', [it_('mia-wait')]), prov('offer_purchases', [])])
    render(<ApprovalsInbox />)
    await screen.findByText('mia-wait')
    expect(screen.getAllByTestId(/^card-/)).toHaveLength(1)
    expect(screen.queryByText('Waiting')).toBeNull()
  })
})
