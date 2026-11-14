// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({ approve: vi.fn(), decline: vi.fn(), unassign: vi.fn() }))
vi.mock('@/lib/approvals/team-actions', async () => {
  const real = await vi.importActual('@/lib/approvals/team-actions')
  return {
    ...real,
    unassignLeaveClashes: mocks.unassign,
    TEAM_ACTIONS: { ...real.TEAM_ACTIONS, time_off: { ...real.TEAM_ACTIONS.time_off, approve: mocks.approve, decline: mocks.decline } },
  }
})

import TimeOffCard from './TimeOffCard'

const item = { id: 't1', title: 'Jo Coach', subtitle: 'Annual leave · 2026-11-20 → 2026-11-22 (3 days)', meta: 'UN1T Stillorgan', submittedAt: '2026-11-10T10:20:00Z', amount: null, reviewUrl: '/schedule/time-off?focus=t1', warning: 'Still rostered for 2 shifts' }
const clash = (id, d) => ({ id, block_date: d, start_time: '07:00:00', template_name: 'Early', location_name: 'Stillorgan' })
const renderCard = (props = {}) => render(<TimeOffCard item={item} providerKey="time_off" providerLabel="Time off" timezone="Europe/Dublin" {...props} />)

beforeEach(() => { for (const m of Object.values(mocks)) m.mockReset() })
afterEach(cleanup)

async function approve(result) {
  renderCard()
  mocks.approve.mockResolvedValue(result)
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await screen.findByText('Approved.')
}

describe('TimeOffCard', () => {
  it('shows the clash warning before the decision', () => {
    renderCard()
    expect(screen.getByText('Still rostered for 2 shifts')).toBeTruthy()
  })

  it('no clashes: no follow-up', async () => {
    await approve({ ok: true, status: 200, body: { success: true, data: {}, clashes: [] } })
    expect(screen.queryByRole('button', { name: 'Unassign them' })).toBeNull()
    expect(screen.queryByText(/still rostered for/)).toBeNull()
  })

  it('clashes: names the person and count and offers both buttons', async () => {
    await approve({ ok: true, status: 200, body: { success: true, data: { profiles: { full_name: 'Jo Coach' } }, clashes: [clash('a1', '2026-11-20'), clash('a2', '2026-11-21')] } })
    expect(screen.getByText('Jo Coach is still rostered for 2 shifts in this leave.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Keep them rostered' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Unassign them' })).toBeTruthy()
    expect(mocks.unassign).not.toHaveBeenCalled()
  })

  it('uses the card title when the route names no one, singular for one shift', async () => {
    await approve({ ok: true, status: 200, body: { success: true, data: {}, clashes: [clash('a1', '2026-11-20')] } })
    expect(screen.getByText('Jo Coach is still rostered for 1 shift in this leave.')).toBeTruthy()
  })

  it('Unassign sends the clash ids once and shows the result', async () => {
    mocks.unassign.mockResolvedValue({ ok: true, status: 200, data: { removed: [{}, {}], already_removed: [], skipped: [] } })
    await approve({ ok: true, status: 200, body: { success: true, data: {}, clashes: [clash('a1', '2026-11-20'), clash('a2', '2026-11-21')] } })
    const btn = screen.getByRole('button', { name: 'Unassign them' })
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(await screen.findByText('Unassigned from 2 shifts.')).toBeTruthy()
    expect(mocks.unassign).toHaveBeenCalledTimes(1)
    expect(mocks.unassign).toHaveBeenCalledWith(item, ['a1', 'a2'])
  })

  it('Keep sends nothing and dismisses the step', async () => {
    await approve({ ok: true, status: 200, body: { success: true, data: {}, clashes: [clash('a1', '2026-11-20')] } })
    fireEvent.click(screen.getByRole('button', { name: 'Keep them rostered' }))
    expect(mocks.unassign).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Unassign them' })).toBeNull()
  })

  it('an unassign failure shows its error and allows retry', async () => {
    mocks.unassign.mockResolvedValueOnce({ ok: false, status: 409, error: 'The roster changed. Refresh and try again.' })
    await approve({ ok: true, status: 200, body: { success: true, data: {}, clashes: [clash('a1', '2026-11-20')] } })
    fireEvent.click(screen.getByRole('button', { name: 'Unassign them' }))
    expect(await screen.findByText('The roster changed. Refresh and try again.')).toBeTruthy()
    mocks.unassign.mockResolvedValueOnce({ ok: true, status: 200, data: { removed: [{}], already_removed: [], skipped: [] } })
    fireEvent.click(screen.getByRole('button', { name: 'Unassign them' }))
    expect(await screen.findByText('Unassigned from 1 shift.')).toBeTruthy()
    expect(mocks.unassign).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.queryByText('The roster changed. Refresh and try again.')).toBeNull())
  })

  it('a clash check that failed says so after the approval', async () => {
    await approve({ ok: true, status: 200, body: { success: true, data: {}, clashes: [], clashes_error: 'Could not check the roster for clashes' } })
    expect(screen.getByText('Could not check the roster for clashes.')).toBeTruthy()
  })
})
