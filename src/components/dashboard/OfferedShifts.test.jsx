// @vitest-environment jsdom
//
// REPLACE.1b — "Shifts up for grabs" on web Today: the list the server says
// is mine, Claim, and the server's words for a win or a lost race.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
const { default: OfferedShifts } = await import('@/components/dashboard/OfferedShifts')

const ROW = { id: 'o1', block_id: 'b1', block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00', shift_name: 'Morning', studio_name: 'Studio North' }
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

beforeEach(() => { globalThis.fetch = vi.fn(); refresh.mockClear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('OfferedShifts', () => {
  it('renders nothing when nothing is on offer', async () => {
    fetch.mockResolvedValue(json(200, { success: true, data: [] }))
    const { container } = render(<OfferedShifts locationId="loc-1" />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(fetch.mock.calls[0][0]).toBe('/api/schedule/offers?location_id=loc-1')
    expect(container.innerHTML).toBe('')
  })
  it('renders nothing when the list cannot be read', async () => {
    fetch.mockResolvedValue(json(500, { success: false }))
    const { container } = render(<OfferedShifts locationId="loc-1" />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
  })
  it('lists each offer with when, what and where; Claim posts and says it is yours', async () => {
    fetch.mockResolvedValueOnce(json(200, { success: true, data: [ROW] }))
      .mockResolvedValueOnce(json(200, { success: true, data: { assignment_id: 'as-9' } }))
      .mockResolvedValueOnce(json(200, { success: true, data: [] }))
    render(<OfferedShifts locationId="loc-1" />)
    expect(await screen.findByText('Morning · Studio North')).toBeTruthy()
    expect(screen.getByText('Tue 29 Sep · 06:00-07:00')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Claim Morning, Tue 29 Sep · 06:00-07:00' }))
    expect(await screen.findByText("It's yours. It is on your roster now.")).toBeTruthy()
    expect(fetch.mock.calls[1]).toEqual(['/api/schedule/offers/o1/claim', { method: 'POST' }])
    expect(refresh).toHaveBeenCalled()
  })
  it('a lost race says so in the server\'s words and reloads the list', async () => {
    fetch.mockResolvedValueOnce(json(200, { success: true, data: [ROW] }))
      .mockResolvedValueOnce(json(409, { success: false, error: 'Someone else has just taken this shift.' }))
      .mockResolvedValueOnce(json(200, { success: true, data: [] }))
    render(<OfferedShifts locationId="loc-1" />)
    fireEvent.click(await screen.findByRole('button', { name: /^Claim / }))
    expect(await screen.findByText('Someone else has just taken this shift.')).toBeTruthy()
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /^Claim / })).toBeNull()
  })
})
