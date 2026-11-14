// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => {
  const mk = (extra = {}) => ({
    approveLabel: 'Approve', declineLabel: 'Decline', reasonLabel: 'Reason', reasonRequired: true,
    approve: vi.fn(), decline: vi.fn(),
    approvedText: 'Approved it.', declinedText: 'Declined it.', pageLabel: 'Things',
    ...extra,
  })
  return { req: mk(), opt: mk({ reasonRequired: false, reasonLabel: 'Note' }), warn: mk({ approvedText: 'Approved. It goes to the queue.', declinedText: 'Declined. They were told.', approvedTextWithWarnings: 'Approved.', declinedTextWithWarnings: 'Declined.' }), confirm: mk({ approveLabel: 'Cancel their leave', declineLabel: 'Keep their leave', approveConfirm: 'Cancel this approved leave?', reasonRequired: false }) }
})
vi.mock('@/lib/approvals/team-actions', () => ({ TEAM_ACTIONS: { req: mocks.req, opt: mocks.opt, confirm: mocks.confirm, warn: mocks.warn } }))

import TeamDecideCard from './TeamDecideCard'

const item = {
  id: 'i1', title: 'Jane Doe', subtitle: 'November 2026 · 3 items', meta: 'UN1T Stillorgan',
  submittedAt: '2026-11-10T10:20:00Z', amount: 42.5, currency: 'EUR', reviewUrl: '/schedule/expenses?focus=i1',
}
const ok = (data) => ({ ok: true, status: 200, data })
const bad = (error) => ({ ok: false, status: 409, error })

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => { for (const a of Object.values(mocks)) { a.approve.mockReset(); a.decline.mockReset() } })
afterEach(cleanup)

const renderCard = (props = {}) => render(<TeamDecideCard item={item} providerKey="req" providerLabel="Employee expenses" timezone="Europe/Dublin" {...props} />)

describe('TeamDecideCard warnings and disabled guard', () => {
  it('approve with warnings shows each in amber under the short outcome', async () => {
    mocks.warn.approve.mockResolvedValue({ ok: true, status: 200, body: { success: true, warnings: ['Queue insert failed', 'Email failed'] } })
    renderCard({ providerKey: 'warn' })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByText('Approved.')
    expect(screen.queryByText('Approved. It goes to the queue.')).toBeNull()
    expect(screen.getByText('Queue insert failed').className).toMatch(/amber/)
    expect(screen.getByText('Email failed').className).toMatch(/amber/)
  })

  it('approve with no warnings shows the full sentence', async () => {
    mocks.warn.approve.mockResolvedValue({ ok: true, status: 200, body: { success: true, warnings: [] } })
    renderCard({ providerKey: 'warn' })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByText('Approved. It goes to the queue.')
  })

  it('decline with a warning shows it and the short outcome', async () => {
    mocks.warn.decline.mockResolvedValue({ ok: true, status: 200, body: { success: true, warnings: ['Email failed'] } })
    renderCard({ providerKey: 'warn' })
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await screen.findByText('Declined.')
    expect(screen.getByText('Email failed').className).toMatch(/amber/)
  })

  it('a singular warning string is shown for a provider with no warnings-specific text (default short outcome)', async () => {
    mocks.req.approve.mockResolvedValue({ ok: true, status: 200, body: { success: true, warning: 'Accountant not told' } })
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByText('Approved.')
    expect(screen.getByText('Accountant not told').className).toMatch(/amber/)
  })

  it('Confirm sends nothing when approve is disabled by a reason (not only the button)', async () => {
    mocks.confirm.approve.mockResolvedValue(ok())
    const { rerender } = renderCard({ providerKey: 'confirm' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel their leave' }))
    rerender(<TeamDecideCard item={item} providerKey="confirm" providerLabel="x" approveDisabledReason="Checking the roster…" />)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await Promise.resolve()
    expect(mocks.confirm.approve).not.toHaveBeenCalled()
  })
})

describe('TeamDecideCard', () => {
  it('renders the shell: source, name, meta, summary, when, amount, warning, extra, link', () => {
    renderCard({ item: { ...item, warning: 'Over budget' }, extra: <div>Extra body</div> })
    expect(screen.getByText('Employee expenses')).toBeTruthy()
    expect(screen.getByText('Jane Doe')).toBeTruthy()
    expect(screen.getByText('UN1T Stillorgan')).toBeTruthy()
    expect(screen.getByText('November 2026 · 3 items')).toBeTruthy()
    expect(screen.getByText(/^Submitted 10 Nov 2026, 10:20$/)).toBeTruthy()
    expect(screen.getByText('€42.50')).toBeTruthy()
    expect(screen.getByText('Over budget').className).toMatch(/amber/)
    expect(screen.getByText('Extra body')).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Open in Things' })
    expect(link.getAttribute('href')).toBe('/schedule/expenses?focus=i1')
  })

  it('shows no amount when item.amount is null', () => {
    renderCard({ item: { ...item, amount: null } })
    expect(screen.queryByText(/€/)).toBeNull()
  })

  it('Approve calls the action once, shows the outcome, hides the buttons, calls onDecided once', async () => {
    mocks.req.approve.mockResolvedValue(ok())
    const onDecided = vi.fn()
    renderCard({ onDecided })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByText('Approved it.')
    expect(mocks.req.approve).toHaveBeenCalledTimes(1)
    expect(mocks.req.approve).toHaveBeenCalledWith(item)
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull()
    expect(onDecided).toHaveBeenCalledTimes(1)
  })

  it('Decline opens a panel and does not call the route from one click', () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(mocks.req.decline).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Reason')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
  })

  it('a required reason blocks Confirm until non-empty; the trimmed reason is sent', async () => {
    mocks.req.decline.mockResolvedValue(ok())
    const onDecided = vi.fn()
    renderCard({ onDecided })
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '   ' } })
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '  No receipt  ' } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await screen.findByText('Declined it.')
    expect(mocks.req.decline).toHaveBeenCalledWith(item, 'No receipt')
    expect(onDecided).toHaveBeenCalledTimes(1)
  })

  it('an optional reason may be empty and is sent as null', async () => {
    mocks.opt.decline.mockResolvedValue(ok())
    renderCard({ providerKey: 'opt' })
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await screen.findByText('Declined it.')
    expect(mocks.opt.decline).toHaveBeenCalledWith(item, null)
  })

  it('approveConfirm: first press asks, Back cancels, Confirm fires once', async () => {
    mocks.confirm.approve.mockResolvedValue(ok())
    renderCard({ providerKey: 'confirm' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel their leave' }))
    expect(mocks.confirm.approve).not.toHaveBeenCalled()
    expect(screen.getByText('Cancel this approved leave?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(mocks.confirm.approve).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel their leave' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await screen.findByText('Approved it.')
    expect(mocks.confirm.approve).toHaveBeenCalledTimes(1)
  })

  it('a double press sends one request and disables the buttons while busy', async () => {
    const d = deferred()
    mocks.req.approve.mockReturnValue(d.promise)
    renderCard()
    const approve = screen.getByRole('button', { name: 'Approve' })
    fireEvent.click(approve)
    fireEvent.click(approve)
    expect(mocks.req.approve).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Decline' }).disabled).toBe(true)
    expect(approve.disabled).toBe(true)
    d.resolve(ok())
    await screen.findByText('Approved it.')
  })

  it('a double press on Confirm of a decline sends one request', async () => {
    const d = deferred()
    mocks.req.decline.mockReturnValue(d.promise)
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'x' } })
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(mocks.req.decline).toHaveBeenCalledTimes(1)
    d.resolve(ok())
    await screen.findByText('Declined it.')
  })

  it('failure shows the route text, keeps the buttons, allows a retry, onDecided not called', async () => {
    mocks.req.approve.mockResolvedValueOnce(bad('Claim is no longer submitted.')).mockResolvedValueOnce(ok())
    const onDecided = vi.fn()
    renderCard({ onDecided })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByText('Claim is no longer submitted.')
    expect(onDecided).not.toHaveBeenCalled()
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve.disabled).toBe(false)
    fireEvent.click(approve)
    await screen.findByText('Approved it.')
    expect(screen.queryByText('Claim is no longer submitted.')).toBeNull()
    expect(mocks.req.approve).toHaveBeenCalledTimes(2)
    expect(onDecided).toHaveBeenCalledTimes(1)
  })

  it('a failed decline keeps the panel and the typed reason', async () => {
    mocks.req.decline.mockResolvedValue(bad('Nope.'))
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'why' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await screen.findByText('Nope.')
    expect(screen.getByLabelText('Reason').value).toBe('why')
  })

  it('approveDisabledReason blocks Approve and shows the reason', () => {
    renderCard({ approveDisabledReason: 'Loading the roster check...' })
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve.disabled).toBe(true)
    expect(screen.getByText('Loading the roster check...')).toBeTruthy()
    fireEvent.click(approve)
    expect(mocks.req.approve).not.toHaveBeenCalled()
    // Decline stays available.
    expect(screen.getByRole('button', { name: 'Decline' }).disabled).toBe(false)
  })

  it('afterApprove receives the Result and its node renders under the outcome', async () => {
    const result = ok({ clashes: [1] })
    mocks.req.approve.mockResolvedValue(result)
    const afterApprove = vi.fn(() => <div>Follow up step</div>)
    renderCard({ afterApprove })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByText('Follow up step')
    expect(afterApprove).toHaveBeenCalledWith(result)
    expect(screen.getByText('Approved it.')).toBeTruthy()
  })

  it('afterApprove is not used for a decline', async () => {
    mocks.req.decline.mockResolvedValue(ok())
    const afterApprove = vi.fn(() => <div>Follow up step</div>)
    renderCard({ afterApprove })
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await screen.findByText('Declined it.')
    await waitFor(() => expect(afterApprove).not.toHaveBeenCalled())
  })
})
