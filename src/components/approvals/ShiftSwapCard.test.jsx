// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

const mocks = vi.hoisted(() => ({ approve: vi.fn(), decline: vi.fn(), anyway: vi.fn() }))
vi.mock('@/lib/approvals/team-actions', async () => {
  const real = await vi.importActual('@/lib/approvals/team-actions')
  return {
    ...real,
    approveSwapAnyway: mocks.anyway,
    TEAM_ACTIONS: { ...real.TEAM_ACTIONS, shift_swaps: { ...real.TEAM_ACTIONS.shift_swaps, approve: mocks.approve, decline: mocks.decline } },
  }
})

import ShiftSwapCard from './ShiftSwapCard'

const item = { id: 's1', title: 'Alex swap', subtitle: 'Fri 20 Nov Early', meta: 'UN1T Stillorgan', submittedAt: '2026-11-10T10:20:00Z', amount: null, reviewUrl: '/schedule/swaps?focus=s1' }
const conflict409 = {
  ok: false, status: 409, error: 'Jo is on leave. Jo already works that day.',
  body: { success: false, code: 'swap_conflicts', error: 'x', conflicts: [{ message: 'Jo is on leave.' }, { message: 'Jo already works that day.' }] },
}
const renderCard = (props = {}) => render(<ShiftSwapCard item={item} providerKey="shift_swaps" providerLabel="Shift swaps" timezone="Europe/Dublin" {...props} />)
const pressApprove = () => fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

beforeEach(() => { for (const m of Object.values(mocks)) m.mockReset() })
afterEach(cleanup)

describe('ShiftSwapCard', () => {
  it('a swap_conflicts 409 shows the conflicts and the two buttons, not the generic error', async () => {
    mocks.approve.mockResolvedValue(conflict409)
    renderCard()
    pressApprove()
    expect(await screen.findByText('Jo is on leave.')).toBeTruthy()
    expect(screen.getByText('Jo already works that day.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve anyway' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
    expect(screen.queryByText('Jo is on leave. Jo already works that day.')).toBeNull()
  })

  it('Approve anyway sends it once, then shows the approved outcome and calls onDecided once', async () => {
    mocks.approve.mockResolvedValue(conflict409)
    mocks.anyway.mockResolvedValue({ ok: true, status: 200 })
    const onDecided = vi.fn()
    renderCard({ onDecided })
    pressApprove()
    const btn = await screen.findByRole('button', { name: 'Approve anyway' })
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(await screen.findByText('Approved. The roster is updated.')).toBeTruthy()
    expect(mocks.anyway).toHaveBeenCalledTimes(1)
    expect(mocks.anyway).toHaveBeenCalledWith(item)
    expect(onDecided).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Approve anyway' })).toBeNull()
  })

  it('Back returns to the buttons without another request', async () => {
    mocks.approve.mockResolvedValue(conflict409)
    renderCard()
    pressApprove()
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }))
    expect(screen.queryByRole('button', { name: 'Approve anyway' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(mocks.approve).toHaveBeenCalledTimes(1)
    expect(mocks.anyway).not.toHaveBeenCalled()
  })

  it('a failed Approve anyway shows that error', async () => {
    mocks.approve.mockResolvedValue(conflict409)
    mocks.anyway.mockResolvedValue({ ok: false, status: 500, error: 'The swap could not be saved.' })
    renderCard()
    pressApprove()
    fireEvent.click(await screen.findByRole('button', { name: 'Approve anyway' }))
    expect(await screen.findByText('The swap could not be saved.')).toBeTruthy()
  })

  it('any other failure still shows its error text', async () => {
    mocks.approve.mockResolvedValue({ ok: false, status: 403, error: 'You cannot approve swaps.', body: { success: false } })
    renderCard()
    pressApprove()
    expect(await screen.findByText('You cannot approve swaps.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve anyway' })).toBeNull()
  })

  it('a 409 with another code is an ordinary failure', async () => {
    mocks.approve.mockResolvedValue({ ok: false, status: 409, error: 'Already decided.', body: { success: false, code: 'other' } })
    renderCard()
    pressApprove()
    expect(await screen.findByText('Already decided.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve anyway' })).toBeNull()
  })

  it('a conflict with no listed messages falls back to the route error', async () => {
    mocks.approve.mockResolvedValue({ ok: false, status: 409, error: 'This swap has a conflict.', body: { code: 'swap_conflicts' } })
    renderCard()
    pressApprove()
    expect(await screen.findByText('This swap has a conflict.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve anyway' })).toBeTruthy()
  })
})
