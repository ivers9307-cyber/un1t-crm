// mobile/lib/availability-api.test.js
//
// AVAIL.2 — the wire contract of the phone's two availability calls. These
// wrappers are the ONLY place the phone spells the route, and nothing else
// checks them: a drifted path or body fails on a handset as an unexplained
// 400. Mocking ./api keeps this pure (no network, no Supabase, no RN).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./api', () => ({ api: vi.fn(() => Promise.resolve({ success: true, data: { weekly: [], dated: [] } })) }))

const { api } = await import('./api')
const availabilityApi = await import('./availability-api')
const { getMyAvailability, saveMyAvailability } = availabilityApi

beforeEach(() => { api.mockClear() })

describe('availability-api', () => {
  it('exports exactly these two helpers', () => {
    expect(Object.keys(availabilityApi).sort()).toEqual(['getMyAvailability', 'saveMyAvailability'])
  })

  it("reads the caller's own rules: no profile id, no studio, no query", async () => {
    await getMyAvailability()
    expect(api).toHaveBeenCalledTimes(1)
    // No locationId: availability is per PERSON, and the route pins it to the
    // caller (user.id, the viewed person under View as user).
    expect(api.mock.calls[0]).toEqual(['/api/schedule/availability'])
  })

  it('saves with ONE PUT whose body is { weekly, dated } exactly as given', async () => {
    const body = {
      weekly: [{ weekday: 'mon', all_day: true, start_time: null, end_time: null, note: null }],
      dated: [{ start_date: '2026-10-03', end_date: '2026-10-05', all_day: false, start_time: '17:00', end_time: '19:30', note: 'wedding' }],
    }
    await saveMyAvailability(body)
    expect(api).toHaveBeenCalledTimes(1)
    expect(api.mock.calls[0]).toEqual(['/api/schedule/availability', { method: 'PUT', body }])
  })

  it("hands back api()'s envelope untouched (the form reads transport, status and issues)", async () => {
    const envelope = { success: false, status: 400, error: 'Invalid availability', issues: [{ path: 'dated.0', message: 'That date has passed' }] }
    api.mockResolvedValueOnce(envelope)
    expect(await saveMyAvailability({ weekly: [], dated: [] })).toBe(envelope)
  })
})
