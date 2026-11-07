// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import BoardReport from './BoardReport.jsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const DATA = {
  funnel: { stages: [{ id: 's1', name: 'New Leads', role: 'new', now: 4, movedIn7: 3, movedIn30: 9 }], entered7: 3, entered30: 9, historyNote: 'History before a stage rename is not counted.' },
  conversion: { entered30: 9, converted30: 3, rate: 1 / 3 },
  revenue: { currency: 'EUR', offerCents: 11700, purchases: 3 },
  followups: [{ stageId: 's1', packKey: 'p', state: 'live', sent: 5, failed: 1, delivered: 4, read: 3, replied: 2, bookedAfter: 1 }],
  health: [{ code: 'nobody_entered_7d', message: 'Nobody entered this board in 7 days.' }],
}
function stub(data) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data }) })))
}

describe('BoardReport', () => {
  it('renders the funnel row, history note, revenue and a warning chip', async () => {
    stub(DATA)
    render(<BoardReport boardId="b1" />)
    expect((await screen.findAllByText('New Leads')).length).toBe(2)
    expect(screen.getByText('History before a stage rename is not counted.')).toBeTruthy()
    expect(screen.getByText(/Offer revenue .*117\.00 from 3 purchases/)).toBeTruthy()
    expect(screen.getByText('Nobody entered this board in 7 days.').className).toContain('text-amber-700')
    expect(screen.getByText('33%')).toBeTruthy()
  })
  it('hides revenue when null', async () => {
    stub({ ...DATA, revenue: null })
    render(<BoardReport boardId="b1" />)
    await screen.findAllByText('New Leads')
    expect(screen.queryByText(/Offer revenue/)).toBeNull()
  })
  it('shows a fallback for a null followups block', async () => {
    stub({ ...DATA, followups: null })
    render(<BoardReport boardId="b1" />)
    expect(await screen.findByText("Couldn't load this part.")).toBeTruthy()
  })
  it('shows the route error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ success: false, error: 'Nope.' }) })))
    render(<BoardReport boardId="b1" />)
    expect((await screen.findByRole('alert')).textContent).toBe('Nope.')
  })
})
