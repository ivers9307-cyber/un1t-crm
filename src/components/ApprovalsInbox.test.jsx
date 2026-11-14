// @vitest-environment jsdom
//
// APPROVALSQ.1 — the /approvals page: one Customers list plus the old tabs
// for team and money items. The four cards are stubbed; this is about the page.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, within, waitFor } from '@testing-library/react'

vi.mock('next/link', () => ({ default: ({ href, children, ...r }) => <a href={href} {...r}>{children}</a> }))

function stub(name) {
  return function Stub({ item, onDecided, selectable, selected, onToggle }) {
    return (
      <div data-testid={`card-${name}`}>
        <span>{item.id}</span>
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
      const status = statusFor(id)
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
})
