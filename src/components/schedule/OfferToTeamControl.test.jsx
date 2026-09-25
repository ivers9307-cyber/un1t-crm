// @vitest-environment jsdom
//
// REPLACE.1b — the block dialog's offer control: a button when the shared
// rule allows an offer, the offer's state + Withdraw when one is open,
// nothing otherwise. Where it is DRAWN is a browser check (jsdom cannot see
// layout).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import OfferToTeamControl from '@/components/schedule/OfferToTeamControl'

afterEach(() => cleanup())
const TODAY = '2026-09-28'
const BLOCK = { id: 'b1', block_date: '2026-09-29', min_coaches: 1, max_coaches: 3, rosters: { status: 'published' }, shift_templates: { kind: 'class' }, shift_assignments: [] }

describe('OfferToTeamControl', () => {
  it('an empty published future shift offers "Offer to team"', () => {
    const onOffer = vi.fn()
    render(<OfferToTeamControl block={BLOCK} offer={null} todayIso={TODAY} onOffer={onOffer} onWithdraw={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Offer to team' }))
    expect(onOffer).toHaveBeenCalledTimes(1)
  })
  it('a staffed shift, a draft or a past one shows nothing', () => {
    const { container, rerender } = render(<OfferToTeamControl block={{ ...BLOCK, shift_assignments: [{ profile_id: 'x', status: 'scheduled' }] }} todayIso={TODAY} onOffer={vi.fn()} onWithdraw={vi.fn()} />)
    expect(container.innerHTML).toBe('')
    rerender(<OfferToTeamControl block={{ ...BLOCK, rosters: { status: 'draft' } }} todayIso={TODAY} onOffer={vi.fn()} onWithdraw={vi.fn()} />)
    expect(container.innerHTML).toBe('')
    rerender(<OfferToTeamControl block={{ ...BLOCK, block_date: '2026-09-27' }} todayIso={TODAY} onOffer={vi.fn()} onWithdraw={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })
  it('an open offer shows its state and Withdraw', () => {
    const onWithdraw = vi.fn()
    render(<OfferToTeamControl block={BLOCK} offer={{ id: 'o1', notice_state: 'sent', broadcast_count: 3 }} todayIso={TODAY} onOffer={vi.fn()} onWithdraw={onWithdraw} />)
    expect(screen.getByText('Offered to 3 coaches')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Offer to team' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw offer' }))
    expect(onWithdraw).toHaveBeenCalledTimes(1)
  })
  it('busy disables both buttons', () => {
    const { rerender } = render(<OfferToTeamControl block={BLOCK} offer={null} todayIso={TODAY} busy onOffer={vi.fn()} onWithdraw={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Offer to team' }).disabled).toBe(true)
    rerender(<OfferToTeamControl block={BLOCK} offer={{ id: 'o1', notice_state: 'morning' }} todayIso={TODAY} busy onOffer={vi.fn()} onWithdraw={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Withdraw offer' }).disabled).toBe(true)
  })
})
