// @vitest-environment jsdom
//
// APPROVALSQ.1 — the /approvals page: one Customers list plus the old tabs
// for team and money items. The four cards are stubbed; this is about the page.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useState } from 'react'
import { render, cleanup, screen, fireEvent, within, waitFor, act } from '@testing-library/react'
import { UNDO_CLEAR_WINDOW_MS } from '@/lib/approvals/undo-clear'

vi.mock('next/link', () => ({ default: ({ href, children, ...r }) => <a href={href} {...r}>{children}</a> }))

function stub(name) {
  return function Stub({ item, onDecided, onUndone, selectable, selected, onToggle, timezone }) {
    // APPROVALSQ.5 — a quiet clear is reported through the request the card got back.
    const [cleared, setCleared] = useState(false)
    return (
      <div data-testid={`card-${name}`} data-tz={timezone ?? ''}>
        <span>{item.id}</span>
        {cleared && <em>cleared-{item.id}</em>}
        <button type="button" onClick={() => { setCleared(true); onDecided?.(item.id, { details: { cleared: { silent: true } } }) }}>clear-{item.id}</button>
        <button type="button" onClick={() => { setCleared(false); onUndone?.(item.id, { status: 'pending' }) }}>undo-{item.id}</button>
        {selectable && (
          <input type="checkbox" aria-label={`select-${item.id}`} checked={!!selected} onChange={() => onToggle?.()} />
        )}
        <button type="button" onClick={() => onDecided?.()}>decide-{item.id}</button>
      </div>
    )
  }
}
vi.mock('@/components/AgentRequestDecideCard', () => ({ default: stub('agent') }))
vi.mock('@/components/TrialPurchaseReviewCard', () => ({ default: stub('trial') }))
vi.mock('@/components/CorpPromoClaimCard', () => ({ default: stub('corp') }))
vi.mock('@/components/approvals/OfferPurchaseCard', () => ({ default: stub('offer') }))

// APPROVALSQ.4 — team cards stubbed: id, provider key, zone, and a decide button.
function teamStub(name) {
  return function TeamStub({ item, providerKey, timezone, onDecided }) {
    const [outcome, setOutcome] = useState(null)
    return (
      <div data-testid={`team-${name}`} data-provider={providerKey} data-tz={timezone ?? ''}>
        <span>{item.id}</span>
        {outcome && <em>outcome-{item.id}</em>}
        <button type="button" onClick={() => { setOutcome('done'); onDecided?.() }}>decide-{item.id}</button>
      </div>
    )
  }
}
vi.mock('@/components/approvals/team-cards', () => ({
  TEAM_CARDS: { time_off: teamStub('decide'), fte_expenses: teamStub('decide'), shift_swaps: teamStub('decide') },
  TeamLinkCard: teamStub('link'),
}))

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

// APPROVALSQ.2 — clear several Mia requests at once.
const miaItems = () => [
  prov('agent_requests',
    [it_('mia-1', { kind: 'class_booking' }), it_('mia-2', { kind: 'pause' }), it_('mia-3', { kind: 'consultation' })],
    [it_('mia-fail', { kind: 'class_booking', failed: true })]),
  prov('trial_purchases', [it_('trial-1')]),
  prov('corp_promo_claims', [it_('corp-1')]),
  prov('offer_purchases', [it_('offer-1')]),
]

// A fetch that serves the list and records every PATCH. `statusFor(id)` lets a test make one id answer 409.
function mockBulkApi(providers, statusFor = () => 200) {
  const total = providers.reduce((s, p) => s + p.count, 0)
  const patches = []
  const fn = vi.fn(async (url, init) => {
    if (init?.method === 'PATCH') {
      const id = String(url).split('/').pop()
      patches.push({ id, body: JSON.parse(init.body) })
      const status = statusFor(id, JSON.parse(init.body))
      return { ok: status < 300, status, json: async () => ({ success: status < 300 }) }
    }
    return { json: async () => ({ success: true, data: { providers, total } }) }
  })
  vi.stubGlobal('fetch', fn)
  return { patches, fn }
}

const boxes = () => screen.queryAllByRole('checkbox').map((b) => b.getAttribute('aria-label'))

async function enterSelect() {
  await screen.findByText('mia-1')
  fireEvent.click(screen.getByRole('button', { name: 'Select' }))
}

describe('ApprovalsInbox bulk clear', () => {
  it('Select puts a checkbox on Mia cards only, not trial, promo or offer cards', async () => {
    mockBulkApi(miaItems())
    render(<ApprovalsInbox />)
    await screen.findByText('mia-1')
    expect(boxes()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    expect(boxes().sort()).toEqual(['select-mia-1', 'select-mia-2', 'select-mia-3', 'select-mia-fail'])
  })

  it('the bar shows the count, and Clear is disabled at 0', async () => {
    mockBulkApi(miaItems())
    render(<ApprovalsInbox />)
    await enterSelect()
    expect(screen.getByText('0 selected')).toBeTruthy()
    expect(screen.getByRole('button', { name: "Clear, don't notify" }).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('select-mia-1'))
    expect(screen.getByText('1 selected')).toBeTruthy()
    expect(screen.getByRole('button', { name: "Clear, don't notify" }).disabled).toBe(false)
  })

  it('Select all picks only the clearable cards shown under the active chip', async () => {
    mockBulkApi(miaItems())
    render(<ApprovalsInbox />)
    await enterSelect()
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByText('4 selected')).toBeTruthy()
    // switching chip clears the selection, and Select all on Paid trials picks nothing
    fireEvent.click(screen.getByRole('button', { name: /^Paid trials/ }))
    expect(screen.getByText('0 selected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByText('0 selected')).toBeTruthy()
  })

  it('the confirm shows the count and the booking warning with the right k', async () => {
    mockBulkApi(miaItems())
    render(<ApprovalsInbox />)
    await enterSelect()
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    expect(screen.getByText("Clear 4 requests without telling the customers?")).toBeTruthy()
    // mia-1 class_booking and mia-3 consultation wait; mia-fail is failed; mia-2 is a pause
    expect(screen.getByText('Mia told 2 of these customers the team would confirm. Clearing sends them nothing.')).toBeTruthy()
    expect(screen.getByRole('button', { name: "Clear 4 requests, don't notify" })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
  })

  it('no warning line when none of the selected were told the team would confirm', async () => {
    mockBulkApi(miaItems())
    render(<ApprovalsInbox />)
    await enterSelect()
    fireEvent.click(screen.getByLabelText('select-mia-2'))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    expect(screen.getByText('Clear 1 request without telling the customer?')).toBeTruthy()
    expect(screen.queryByText(/Clearing sends them nothing/)).toBeNull()
  })

  it('one waiting booking selected: singular question, button and warning', async () => {
    mockBulkApi(miaItems())
    render(<ApprovalsInbox />)
    await enterSelect()
    fireEvent.click(screen.getByLabelText('select-mia-1'))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    expect(screen.getByText('Clear 1 request without telling the customer?')).toBeTruthy()
    expect(screen.getByText('Mia told this customer the team would confirm. Clearing sends them nothing.')).toBeTruthy()
    expect(screen.getByRole('button', { name: "Clear 1 request, don't notify" })).toBeTruthy()
  })

  it('the progress total is the confirmed count even when the selection changes mid-run', async () => {
    let release
    const gate = new Promise((r) => { release = r })
    const providers = miaItems()
    const total = providers.reduce((s, p) => s + p.count, 0)
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init?.method === 'PATCH') { await gate; return { ok: true, status: 200, json: async () => ({ success: true }) } }
      return { json: async () => ({ success: true, data: { providers, total } }) }
    }))
    render(<ApprovalsInbox />)
    await enterSelect()
    fireEvent.click(screen.getByLabelText('select-mia-1'))
    fireEvent.click(screen.getByLabelText('select-mia-2'))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    fireEvent.click(screen.getByRole('button', { name: "Clear 2 requests, don't notify" }))
    await screen.findByText('Clearing 1 of 2')
    // the selection empties under the run (chip switch)
    fireEvent.click(screen.getByRole('button', { name: /^Paid trials/ }))
    expect(screen.getByText(/^Clearing \d of 2$/)).toBeTruthy()
    release()
    await screen.findByText(/Cleared 2\./)
  })

  it('a card decided in place drops out of the selection and the bulk run', async () => {
    const { patches } = mockBulkApi(miaItems())
    render(<ApprovalsInbox />)
    await enterSelect()
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByText('4 selected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'decide-mia-2' }))
    expect(screen.getByText('3 selected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    fireEvent.click(screen.getByRole('button', { name: "Clear 3 requests, don't notify" }))
    await screen.findByText(/Cleared 3\./)
    expect(patches.map((p) => p.id)).not.toContain('mia-2')
    expect(patches).toHaveLength(3)
  })

  it('when every request fails the notice says none could be cleared, in the red style', async () => {
    mockBulkApi(miaItems(), () => 409)
    render(<ApprovalsInbox />)
    await enterSelect()
    fireEvent.click(screen.getByLabelText('select-mia-1'))
    fireEvent.click(screen.getByLabelText('select-mia-2'))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    fireEvent.click(screen.getByRole('button', { name: "Clear 2 requests, don't notify" }))
    const notice = await screen.findByText('None could be cleared (already decided, or an error).')
    expect(notice.className).toContain('text-red-700')
    expect(screen.queryByText(/Cleared 0/)).toBeNull()
  })

  it('confirming sends one silent PATCH per selected id, in order, with the note, and never for other kinds', async () => {
    const { patches } = mockBulkApi(miaItems())
    render(<ApprovalsInbox />)
    await enterSelect()
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    fireEvent.change(screen.getByPlaceholderText('Note (optional)'), { target: { value: 'old backlog' } })
    fireEvent.click(screen.getByRole('button', { name: "Clear 4 requests, don't notify" }))
    await screen.findByText(/Cleared 4\./)
    expect(patches.map((p) => p.id)).toEqual(['mia-fail', 'mia-1', 'mia-2', 'mia-3'])
    for (const p of patches) expect(p.body).toEqual({ status: 'declined', silent: true, decision_note: 'old backlog' })
    const ids = patches.map((p) => p.id)
    for (const other of ['trial-1', 'corp-1', 'offer-1']) expect(ids).not.toContain(other)
  })

  it('an empty note is sent as null', async () => {
    const { patches } = mockBulkApi(miaItems())
    render(<ApprovalsInbox />)
    await enterSelect()
    fireEvent.click(screen.getByLabelText('select-mia-2'))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    fireEvent.click(screen.getByRole('button', { name: "Clear 1 request, don't notify" }))
    await screen.findByText(/Cleared 1\./)
    expect(patches[0].body.decision_note).toBeNull()
  })

  it('a double click on confirm does not double the requests', async () => {
    const { patches } = mockBulkApi(miaItems())
    render(<ApprovalsInbox />)
    await enterSelect()
    fireEvent.click(screen.getByLabelText('select-mia-1'))
    fireEvent.click(screen.getByLabelText('select-mia-2'))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    const confirm = screen.getByRole('button', { name: "Clear 2 requests, don't notify" })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await screen.findByText(/Cleared 2\./)
    expect(patches).toHaveLength(2)
  })

  it('a 409 on one id reports it as not cleared and the others as cleared, then reloads the list', async () => {
    const { patches, fn } = mockBulkApi(miaItems(), (id) => (id === 'mia-2' ? 409 : 200))
    render(<ApprovalsInbox />)
    await enterSelect()
    fireEvent.click(screen.getByLabelText('select-mia-1'))
    fireEvent.click(screen.getByLabelText('select-mia-2'))
    fireEvent.click(screen.getByLabelText('select-mia-3'))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    const listCallsBefore = fn.mock.calls.filter(([, i]) => !i?.method).length
    fireEvent.click(screen.getByRole('button', { name: "Clear 3 requests, don't notify" }))
    await screen.findByText(/Cleared 2\./)
    expect(screen.getByText(/1 could not be cleared \(already decided, or an error\)\./)).toBeTruthy()
    expect(patches.map((p) => p.id)).toEqual(['mia-1', 'mia-2', 'mia-3'])
    await waitFor(() => expect(fn.mock.calls.filter(([, i]) => !i?.method).length).toBeGreaterThan(listCallsBefore))
    // select mode is left
    expect(boxes()).toEqual([])
    expect(screen.getByRole('button', { name: 'Select' })).toBeTruthy()
  })

  it('shows progress while running and disables the bar controls', async () => {
    let release
    const gate = new Promise((r) => { release = r })
    const providers = miaItems()
    const total = providers.reduce((s, p) => s + p.count, 0)
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init?.method === 'PATCH') { await gate; return { ok: true, status: 200, json: async () => ({ success: true }) } }
      return { json: async () => ({ success: true, data: { providers, total } }) }
    }))
    render(<ApprovalsInbox />)
    await enterSelect()
    fireEvent.click(screen.getByLabelText('select-mia-1'))
    fireEvent.click(screen.getByLabelText('select-mia-2'))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    fireEvent.click(screen.getByRole('button', { name: "Clear 2 requests, don't notify" }))
    expect(await screen.findByText('Clearing 1 of 2')).toBeTruthy()
    for (const b of screen.getAllByRole('button')) {
      if (/^(Select all|Cancel|Back)$/.test(b.textContent.trim())) expect(b.disabled).toBe(true)
    }
    release()
    await screen.findByText(/Cleared 2\./)
  })

  it('Cancel leaves select mode and sends nothing', async () => {
    const { patches } = mockBulkApi(miaItems())
    render(<ApprovalsInbox />)
    await enterSelect()
    fireEvent.click(screen.getByLabelText('select-mia-1'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(boxes()).toEqual([])
    expect(patches).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    expect(screen.getByText('0 selected')).toBeTruthy()
  })

  it('Back from the confirm sends nothing and keeps the selection', async () => {
    const { patches } = mockBulkApi(miaItems())
    render(<ApprovalsInbox />)
    await enterSelect()
    fireEvent.click(screen.getByLabelText('select-mia-1'))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('1 selected')).toBeTruthy()
    expect(patches).toHaveLength(0)
  })

  it('switching to Team and money leaves select mode', async () => {
    mockBulkApi([...miaItems(), ...team()])
    render(<ApprovalsInbox />)
    await enterSelect()
    fireEvent.click(screen.getByLabelText('select-mia-1'))
    fireEvent.click(screen.getByRole('button', { name: /^Team and money/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Customers/ }))
    expect(boxes()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    expect(screen.getByText('0 selected')).toBeTruthy()
  })

  it('the Select button is not shown on Team and money', async () => {
    mockBulkApi([...miaItems(), ...team()])
    render(<ApprovalsInbox />)
    await screen.findByText('mia-1')
    fireEvent.click(screen.getByRole('button', { name: /^Team and money/ }))
    expect(screen.queryByRole('button', { name: 'Select' })).toBeNull()
  })

  // APPROVALSQ.3 — the studio's zone reaches every card and the link rows.
  it('passes its timezone to all four customer cards', async () => {
    mockApi(customers())
    render(<ApprovalsInbox timezone="America/New_York" />)
    await screen.findByText('mia-fail')
    const cards = screen.getAllByTestId(/^card-/)
    expect(cards.length).toBe(5)
    for (const c of cards) expect(c.getAttribute('data-tz')).toBe('America/New_York')
    expect(new Set(cards.map((c) => c.getAttribute('data-testid')))).toEqual(new Set(['card-agent', 'card-trial', 'card-corp', 'card-offer']))
  })

  it('passes no zone when it has none, so cards fall back to the platform zone', async () => {
    mockApi(customers())
    render(<ApprovalsInbox />)
    await screen.findByText('mia-fail')
    for (const c of screen.getAllByTestId(/^card-/)) expect(c.getAttribute('data-tz')).toBe('')
  })
})

// APPROVALSQ.4 — Team and money is one list of cards with filter chips.
const teamMix = () => [
  prov('time_off', [it_('leave-1', { submittedAt: '2026-11-03T10:00:00Z' })], [], { label: 'Time off' }),
  prov('fte_expenses', [it_('exp-1', { submittedAt: '2026-11-01T10:00:00Z' })], [], { label: 'Expenses' }),
  prov('rosters', [it_('roster-1', { submittedAt: '2026-11-02T10:00:00Z' })], [], { label: 'Rosters' }),
]
const teamIds = () => screen.getAllByTestId(/^team-/).map((n) => n.querySelector('span').textContent)

describe('ApprovalsInbox team view', () => {
  it('shows one list mixing providers, oldest first', async () => {
    mockApi(teamMix())
    render(<ApprovalsInbox />)
    await screen.findByText('exp-1')
    expect(teamIds()).toEqual(['exp-1', 'roster-1', 'leave-1'])
  })

  it('a chip narrows the list and All restores it', async () => {
    mockApi(teamMix())
    render(<ApprovalsInbox />)
    await screen.findByText('exp-1')
    fireEvent.click(screen.getByRole('button', { name: /^Rosters/ }))
    expect(teamIds()).toEqual(['roster-1'])
    fireEvent.click(screen.getByRole('button', { name: /^All/ }))
    expect(teamIds()).toHaveLength(3)
  })

  it('decidable providers render their mapped card and link-only providers the link card, with the zone', async () => {
    mockApi(teamMix())
    render(<ApprovalsInbox timezone="America/New_York" />)
    await screen.findByText('exp-1')
    expect(screen.getAllByTestId('team-decide')).toHaveLength(2)
    const links = screen.getAllByTestId('team-link')
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute('data-provider')).toBe('rosters')
    for (const c of screen.getAllByTestId(/^team-/)) expect(c.getAttribute('data-tz')).toBe('America/New_York')
  })

  it('deciding a card drops the Team badge and the page total by one', async () => {
    mockApi([...customers(), ...teamMix()])
    render(<ApprovalsInbox />)
    await screen.findByText('mia-fail')
    fireEvent.click(screen.getByRole('button', { name: /^Team and money/ }))
    const view = screen.getByRole('button', { name: /^Team and money/ })
    expect(within(view).getByText('3')).toBeTruthy()
    expect(screen.getByText('8 pending')).toBeTruthy()
    fireEvent.click(screen.getByText('decide-leave-1'))
    expect(within(view).getByText('2')).toBeTruthy()
    expect(screen.getByText('7 pending')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^All 2/ })).toBeTruthy()
  })

  it('a chip whose provider disappears on reload falls back to All', async () => {
    const first = teamMix()
    let current = first
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ success: true, data: { providers: current, total: current.reduce((s, p) => s + p.count, 0) } }),
    })))
    render(<ApprovalsInbox />)
    await screen.findByText('exp-1')
    fireEvent.click(screen.getByRole('button', { name: /^Rosters/ }))
    expect(teamIds()).toEqual(['roster-1'])
    current = first.filter((p) => p.key !== 'rosters')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(teamIds()).toEqual(['exp-1', 'leave-1']))
    expect(screen.queryByRole('button', { name: /^Rosters/ })).toBeNull()
  })

  it('a decided card stays after a reload that no longer returns it, once, uncounted, with its state', async () => {
    const first = teamMix()
    let current = first
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ success: true, data: { providers: current, total: current.reduce((s, p) => s + p.count, 0) } }),
    })))
    render(<ApprovalsInbox />)
    await screen.findByText('exp-1')
    fireEvent.click(screen.getByText('decide-leave-1'))
    expect(screen.getByText('outcome-leave-1')).toBeTruthy()
    current = [
      prov('fte_expenses', [it_('exp-1', { submittedAt: '2026-11-01T10:00:00Z' })], [], { label: 'Expenses' }),
      prov('rosters', [it_('roster-1', { submittedAt: '2026-11-02T10:00:00Z' })], [], { label: 'Rosters' }),
    ]
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Time off/ })).toBeNull())
    expect(teamIds().filter((i) => i === 'leave-1')).toHaveLength(1)
    expect(screen.getByText('outcome-leave-1')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^All 2/ })).toBeTruthy()
    // a reload that still returns it does not duplicate it
    current = first
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Time off/ })).toBeTruthy())
    expect(teamIds().filter((i) => i === 'leave-1')).toHaveLength(1)
    expect(screen.getByText('outcome-leave-1')).toBeTruthy()
  })

  it('works with no customer providers, and has no tab strip beyond the chips', async () => {
    mockApi(teamMix())
    render(<ApprovalsInbox />)
    await screen.findByText('exp-1')
    expect(screen.queryByRole('button', { name: /^Customers/ })).toBeNull()
    const names = screen.getAllByRole('button').map((b) => b.textContent.trim())
    expect(names.filter((n) => /^(Time off|Expenses|Rosters)/.test(n))).toHaveLength(3)
    // chips each carry a count; the old tab strip had a second row of the same labels
    expect(screen.getAllByRole('button', { name: /^Time off/ })).toHaveLength(1)
  })

  it('shows the empty state when nothing is waiting', async () => {
    mockApi([prov('time_off', [], [], { label: 'Time off' })])
    render(<ApprovalsInbox />)
    await screen.findByText('Nothing waiting on your review.')
  })
})


// APPROVALSQ.5 — Undo on a quiet clear.
// Click Refresh and wait for the reload to land (the button is disabled while loading).
async function refresh() {
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' }).disabled).toBe(false))
}
const waitingCount = () => screen.getByText(/\d+ pending|All clear/).textContent

describe('ApprovalsInbox undo of a single clear', () => {
  function mockReloadable() {
    let current = miaItems()
    const total = () => current.reduce((s, p) => s + p.count, 0)
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true, data: { providers: current, total: total() } }) })))
    return { set: (next) => { current = next } }
  }
  const without = (id) => miaItems().map((p) => p.key === 'agent_requests'
    ? { ...p, items: p.items.filter((i) => i.id !== id), failedItems: p.failedItems.filter((i) => i.id !== id), count: p.count - 1 }
    : p)

  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => { vi.useRealTimers() })

  it('a cleared card stays mounted, with its state, across a reload that no longer returns it, and is not counted', async () => {
    const api = mockReloadable()
    render(<ApprovalsInbox />)
    await screen.findByText('mia-1')
    expect(waitingCount()).toBe('7 pending')
    fireEvent.click(screen.getByRole('button', { name: 'clear-mia-1' }))
    expect(waitingCount()).toBe('6 pending')
    api.set(without('mia-1'))
    await refresh()
    expect(screen.getAllByText('mia-1')).toHaveLength(1)
    expect(screen.getByText('cleared-mia-1')).toBeTruthy()
    expect(waitingCount()).toBe('6 pending')
  })

  it('does not keep a card that was decided in any other way', async () => {
    const api = mockReloadable()
    render(<ApprovalsInbox />)
    await screen.findByText('mia-1')
    fireEvent.click(screen.getByRole('button', { name: 'decide-mia-1' }))
    api.set(without('mia-1'))
    await refresh()
    expect(screen.queryByText('mia-1')).toBeNull()
  })

  it('keeps a failed card under Needs fixing', async () => {
    const api = mockReloadable()
    render(<ApprovalsInbox />)
    await screen.findByText('mia-fail')
    fireEvent.click(screen.getByRole('button', { name: 'clear-mia-fail' }))
    api.set(without('mia-fail'))
    await refresh()
    expect(screen.getByText('cleared-mia-fail')).toBeTruthy()
  })

  it('drops the card on the first reload after its window has closed', async () => {
    const api = mockReloadable()
    render(<ApprovalsInbox />)
    await screen.findByText('mia-1')
    fireEvent.click(screen.getByRole('button', { name: 'clear-mia-1' }))
    api.set(without('mia-1'))
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_CLEAR_WINDOW_MS + 1000) })
    // still on the page until something reloads
    expect(screen.getByText('mia-1')).toBeTruthy()
    await refresh()
    expect(screen.queryByText('mia-1')).toBeNull()
  })

  it('an undo puts the count and the total back up by one, and the card is selectable again', async () => {
    mockReloadable()
    render(<ApprovalsInbox />)
    await screen.findByText('mia-1')
    fireEvent.click(screen.getByRole('button', { name: 'clear-mia-1' }))
    expect(waitingCount()).toBe('6 pending')
    expect(screen.getByRole('button', { name: /^All 6/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'undo-mia-1' }))
    expect(waitingCount()).toBe('7 pending')
    expect(screen.getByRole('button', { name: /^All 7/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    expect(boxes()).toContain('select-mia-1')
  })

  // The initial load answers at once; every later load waits on a gate the test opens.
  function mockGated() {
    const base = miaItems()
    const gates = []
    let first = true
    vi.stubGlobal('fetch', vi.fn(() => {
      if (first) { first = false; return Promise.resolve({ json: async () => ({ success: true, data: { providers: base, total: 7 } }) }) }
      return new Promise((resolve, reject) => gates.push({
        ok: (providers) => resolve({ json: async () => ({ success: true, data: { providers, total: providers.reduce((n, q) => n + q.count, 0) } }) }),
        fail: () => reject(new Error('offline')),
      }))
    }))
    return { gates }
  }
  async function clearThenUndo() {
    const g = mockGated()
    render(<ApprovalsInbox />)
    await screen.findByText('mia-1')
    fireEvent.click(screen.getByRole('button', { name: 'clear-mia-1' }))
    fireEvent.click(screen.getByRole('button', { name: 'undo-mia-1' }))
    return g
  }

  it('Undo starts a reload and the card stays rendered while it is pending', async () => {
    const { gates } = await clearThenUndo()
    expect(gates).toHaveLength(1)
    expect(screen.getAllByText('mia-1')).toHaveLength(1)
  })

  it('the reload answers with the request: shown once', async () => {
    const { gates } = await clearThenUndo()
    await act(async () => { gates[0].ok(miaItems()) })
    expect(screen.getAllByText('mia-1')).toHaveLength(1)
  })

  it('the reload answers without the request (someone else decided it): gone', async () => {
    const { gates } = await clearThenUndo()
    await act(async () => { gates[0].ok(without('mia-1')) })
    expect(screen.queryByText('mia-1')).toBeNull()
  })

  it('a failed reload keeps the card; the next successful one drops it if the server no longer returns it', async () => {
    const { gates } = await clearThenUndo()
    await act(async () => { gates[0].fail() })
    expect(screen.getAllByText('mia-1')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await act(async () => { gates[1].ok(without('mia-1')) })
    expect(screen.queryByText('mia-1')).toBeNull()
  })

  it('a failed reload keeps the card; the next successful one that returns it shows it once', async () => {
    const { gates } = await clearThenUndo()
    await act(async () => { gates[0].fail() })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await act(async () => { gates[1].ok(miaItems()) })
    expect(screen.getAllByText('mia-1')).toHaveLength(1)
  })

  it('a cleared card is not selectable in select mode', async () => {
    mockReloadable()
    render(<ApprovalsInbox />)
    await screen.findByText('mia-1')
    fireEvent.click(screen.getByRole('button', { name: 'clear-mia-1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    expect(boxes()).not.toContain('select-mia-1')
  })
})

describe('ApprovalsInbox undo of a bulk clear', () => {
  const clearBulk = async (ids) => {
    await enterSelect()
    for (const id of ids) fireEvent.click(screen.getByLabelText(`select-${id}`))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    fireEvent.click(screen.getByRole('button', { name: `Clear ${ids.length} ${ids.length === 1 ? 'request' : 'requests'}, don't notify` }))
    await screen.findByText(/Cleared \d+\./)
  }
  const undoBodies = (patches) => patches.filter((p) => p.body.undo_clear)

  it('the notice carries Undo, which sends the undo for each cleared id one after another, reloads and reports', async () => {
    const { patches, fn } = mockBulkApi(miaItems())
    render(<ApprovalsInbox />)
    await clearBulk(['mia-1', 'mia-2', 'mia-3'])
    const listCalls = () => fn.mock.calls.filter(([, i]) => !i?.method).length
    const before = listCalls()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await screen.findByText('Restored 3.')
    expect(undoBodies(patches).map((p) => p.id)).toEqual(['mia-1', 'mia-2', 'mia-3'])
    for (const p of undoBodies(patches)) expect(p.body).toEqual({ undo_clear: true })
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before))
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('reports the ones that could not be restored', async () => {
    mockBulkApi(miaItems(), (id, body) => (body.undo_clear && id === 'mia-2' ? 409 : 200))
    render(<ApprovalsInbox />)
    await clearBulk(['mia-1', 'mia-2', 'mia-3'])
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await screen.findByText(/Restored 2\./)
    expect(screen.getByText(/1 could not be restored\./)).toBeTruthy()
  })

  it('when none could be restored the notice is red', async () => {
    mockBulkApi(miaItems(), (id, body) => (body.undo_clear ? 409 : 200))
    render(<ApprovalsInbox />)
    await clearBulk(['mia-1', 'mia-2'])
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    const notice = await screen.findByText('None could be restored.')
    expect(notice.className).toContain('text-red-700')
    expect(screen.queryByText(/Restored 0/)).toBeNull()
  })

  it('a double press runs one undo, and the button is disabled while it runs', async () => {
    const { patches } = mockBulkApi(miaItems())
    render(<ApprovalsInbox />)
    await clearBulk(['mia-1', 'mia-2'])
    const undo = screen.getByRole('button', { name: 'Undo' })
    fireEvent.click(undo)
    fireEvent.click(undo)
    expect(undo.disabled).toBe(true)
    await screen.findByText('Restored 2.')
    expect(undoBodies(patches)).toHaveLength(2)
  })

  it('the Undo is gone after 120 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      mockBulkApi(miaItems())
      render(<ApprovalsInbox />)
      await clearBulk(['mia-1'])
      expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_CLEAR_WINDOW_MS + 1000) })
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
      expect(screen.getByText(/Cleared 1\./)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a run that cleared nothing has no Undo', async () => {
    mockBulkApi(miaItems(), () => 409)
    render(<ApprovalsInbox />)
    await enterSelect()
    fireEvent.click(screen.getByLabelText('select-mia-1'))
    fireEvent.click(screen.getByRole('button', { name: "Clear, don't notify" }))
    fireEvent.click(screen.getByRole('button', { name: "Clear 1 request, don't notify" }))
    await screen.findByText('None could be cleared (already decided, or an error).')
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })
})

// APPROVALSQ.6 — responses are sequenced: only the latest request may settle the page.
describe('ApprovalsInbox response order', () => {
  const S1 = { id: 'studio-1', name: 'Stillorgan' }
  const S2 = { id: 'studio-2', name: 'Hatch Street' }
  const plainData = { providers: [prov('agent_requests', [it_('here-1')])], total: 1, studios: [S1, S2] }
  const allData = {
    providers: [prov('agent_requests', [it_('here-1', { studioId: 'studio-1' }), it_('other-1', { studioId: 'studio-2' })])],
    total: 2, scope: 'all', studios: [S1, S2], failedStudios: [], truncated: false,
  }
  const reply = (data) => ({ json: async () => ({ success: true, data }) })

  // The first (plain) load answers at once; later ones wait to be resolved by hand.
  function deferredApi() {
    const pending = []
    let first = true
    vi.stubGlobal('fetch', vi.fn((url) => {
      if (first) { first = false; return Promise.resolve(reply(plainData)) }
      return new Promise((resolve) => pending.push({ url: String(url), resolve }))
    }))
    return pending
  }

  async function startBoth() {
    localStorage.clear()
    const pending = deferredApi()
    render(<ApprovalsInbox />)
    await screen.findByText('here-1')
    fireEvent.click(screen.getByRole('button', { name: 'All my studios' }))
    await waitFor(() => expect(pending).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'This studio' }))
    await waitFor(() => expect(pending).toHaveLength(2))
    expect(pending[0].url).toContain('scope=all')
    expect(pending[1].url).not.toContain('scope=all')
    return pending
  }

  it('a slow all-studios answer arriving after the this-studio one does not overwrite it', async () => {
    const pending = await startBoth()
    await act(async () => { pending[1].resolve(reply(plainData)) })
    await screen.findByText('here-1')
    await act(async () => { pending[0].resolve(reply(allData)) })
    expect(screen.queryByText('other-1')).toBeNull()
    expect(screen.getByText('here-1')).toBeTruthy()
    expect(screen.getByText('1 pending')).toBeTruthy()
    expect(screen.queryByText(/Each decision is made at the studio named on the card/)).toBeNull()
  })

  it('the reverse order lands on the same page', async () => {
    const pending = await startBoth()
    await act(async () => { pending[0].resolve(reply(allData)) })
    expect(screen.queryByText('other-1')).toBeNull()
    await act(async () => { pending[1].resolve(reply(plainData)) })
    await screen.findByText('here-1')
    expect(screen.queryByText('other-1')).toBeNull()
    expect(screen.getByText('1 pending')).toBeTruthy()
  })

  it('a stale failure neither shows an error nor stops the spinner of the latest request', async () => {
    const pending = await startBoth()
    await act(async () => { pending[0].resolve({ json: async () => ({ success: false, error: 'stale boom' }) }) })
    expect(screen.queryByText('stale boom')).toBeNull()
    expect(screen.getByRole('button', { name: 'Refresh' }).disabled).toBe(true)
    await act(async () => { pending[1].resolve(reply(plainData)) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' }).disabled).toBe(false))
  })
})
