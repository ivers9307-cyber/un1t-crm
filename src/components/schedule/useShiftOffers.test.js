// @vitest-environment jsdom
//
// REPLACE.1b — the manager's open offers for the visible period.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { renderHook, waitFor, cleanup, act } from '@testing-library/react'
import { useShiftOffers } from '@/components/schedule/useShiftOffers'

const okJson = (data) => ({ ok: true, json: async () => ({ success: true, data }) })
beforeEach(() => { globalThis.fetch = vi.fn() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('useShiftOffers', () => {
  it('loads the period\'s open offers keyed by shift, manager view', async () => {
    fetch.mockResolvedValue(okJson([{ id: 'o1', block_id: 'b1', notice_state: 'sent', broadcast_count: 2 }]))
    const { result } = renderHook(() => useShiftOffers({ locationId: 'loc-1', startDate: '2026-09-28', endDate: '2026-10-04', enabled: true }))
    await waitFor(() => expect(result.current.byBlockId.b1?.id).toBe('o1'))
    expect(fetch.mock.calls[0][0]).toBe('/api/schedule/offers?location_id=loc-1&view=manage&start_date=2026-09-28&end_date=2026-10-04')
  })
  it('does nothing when disabled (a coach never asks)', async () => {
    renderHook(() => useShiftOffers({ locationId: 'loc-1', startDate: 'a', endDate: 'b', enabled: false }))
    await act(async () => {})
    expect(fetch).not.toHaveBeenCalled()
  })
  it('a failed reload keeps what was loaded and says so', async () => {
    fetch.mockResolvedValueOnce(okJson([{ id: 'o1', block_id: 'b1' }])).mockResolvedValueOnce({ ok: false, json: async () => ({ success: false }) })
    const { result } = renderHook(() => useShiftOffers({ locationId: 'loc-1', startDate: 's', endDate: 'e', enabled: true }))
    await waitFor(() => expect(result.current.byBlockId.b1).toBeTruthy())
    await act(async () => { await result.current.reload() })
    expect(result.current.failed).toBe(true)
    expect(result.current.byBlockId.b1).toBeTruthy()
  })
  it('a slow answer for a period already left never paints over the current one', async () => {
    let releaseOld
    fetch.mockImplementationOnce(() => new Promise((r) => { releaseOld = () => r(okJson([{ id: 'old', block_id: 'b-old' }])) }))
      .mockResolvedValueOnce(okJson([{ id: 'new', block_id: 'b-new' }]))
    const { result, rerender } = renderHook((props) => useShiftOffers(props), { initialProps: { locationId: 'loc-1', startDate: 'w1', endDate: 'w1e', enabled: true } })
    rerender({ locationId: 'loc-1', startDate: 'w2', endDate: 'w2e', enabled: true })
    await waitFor(() => expect(result.current.byBlockId['b-new']).toBeTruthy())
    await act(async () => { releaseOld() })
    expect(result.current.byBlockId['b-old']).toBeUndefined()
  })
})
