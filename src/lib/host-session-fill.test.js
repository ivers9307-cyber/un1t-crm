import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/registration-move', () => ({
  loadWaveRegistrations: vi.fn(),
  groupByWave: vi.fn(),
}))

import { sessionFill, loadSessionFill } from './host-session-fill'
import { loadWaveRegistrations, groupByWave } from '@/lib/registration-move'

const wave = (id, capacity, start_time = '10:00:00', label = null) => ({ id, capacity, start_time, label, display_order: 0 })
const reg = (status, size, registered_at = '2026-11-09T09:00:00Z') => ({ status, registered_at, team: { size } })
const NOW = Date.parse('2026-11-09T10:00:00Z')

describe('sessionFill', () => {
  it('counts confirmed people plus unpaid entries still holding a place', () => {
    const out = sessionFill([wave('w1', 30)], new Map([['w1', [reg('confirmed', 4), reg('pending_payment', 2)]]]), NOW, { capacity_mode: 'people' })
    expect(out.sessions[0]).toMatchObject({ id: 'w1', booked: 6, capacity: 30, full: false, time: '10:00' })
    expect(out.booked).toBe(6)
    expect(out.capacity).toBe(30)
  })

  it('drops an unpaid entry whose hold has lapsed', () => {
    const stale = reg('pending_payment', 2, '2026-11-01T09:00:00Z')
    expect(sessionFill([wave('w1', 30)], new Map([['w1', [stale]]]), NOW, { capacity_mode: 'people' }).sessions[0].booked).toBe(0)
  })

  it('marks a session full at capacity', () => {
    const out = sessionFill([wave('w1', 30), wave('w2', 30, '11:00:00')], new Map([
      ['w1', [reg('confirmed', 30)]],
      ['w2', [reg('confirmed', 29)]],
    ]), NOW, { capacity_mode: 'people' })
    expect(out.sessions[0].full).toBe(true)
    expect(out.sessions[1].full).toBe(false)
    expect(out.booked).toBe(59)
    expect(out.capacity).toBe(60)
  })

  it('handles a session with no capacity: booked count, capacity null, never full, total capacity null', () => {
    const out = sessionFill([wave('w1', null), wave('w2', 10, '12:30:00')], new Map([['w1', [reg('confirmed', 3)]]]), NOW, { capacity_mode: 'people' })
    expect(out.sessions[0]).toMatchObject({ booked: 3, capacity: null, full: false })
    expect(out.capacity).toBeNull()
    expect(out.booked).toBe(3)
  })

  it('counts teams, not people, on a teams-mode event', () => {
    const rows = new Map([['w1', [reg('confirmed', 4), reg('confirmed', 4)]]])
    expect(sessionFill([wave('w1', 5)], rows, NOW, { capacity_mode: 'teams' }).sessions[0].booked).toBe(2)
    expect(sessionFill([wave('w1', 5)], rows, NOW, {}).sessions[0].booked).toBe(2)
  })

  it('sorts waves by display_order then start_time and keeps the label', () => {
    const waves = [
      { ...wave('c', 5, '09:00:00'), display_order: 2 },
      { ...wave('b', 5, '11:00:00', 'Late'), display_order: 1 },
      { ...wave('a', 5, '10:00:00'), display_order: 1 },
    ]
    const out = sessionFill(waves, new Map(), NOW, { capacity_mode: 'people' })
    expect(out.sessions.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(out.sessions[1].label).toBe('Late')
  })

  it('returns no sessions for an event with no waves', () => {
    expect(sessionFill([], new Map(), NOW, {}).sessions).toEqual([])
  })
})

describe('loadSessionFill', () => {
  beforeEach(() => vi.clearAllMocks())

  it('answers ok:false when the wave read fails', async () => {
    loadWaveRegistrations.mockResolvedValue({ rows: null, error: { message: 'boom' } })
    const out = await loadSessionFill({}, { id: 'e1', capacity_mode: 'people', race_waves: [wave('w1', 10)] })
    expect(out).toEqual({ ok: false })
  })

  it('reads every wave once and returns ok with the fill', async () => {
    const rows = [{ wave_id: 'w1', status: 'confirmed', registered_at: new Date().toISOString(), team: { size: 3 } }]
    loadWaveRegistrations.mockResolvedValue({ rows, error: null })
    groupByWave.mockReturnValue(new Map([['w1', rows]]))
    const out = await loadSessionFill({}, { id: 'e1', capacity_mode: 'people', race_waves: [wave('w1', 10), wave('w2', 10, '11:00:00')] })
    expect(loadWaveRegistrations).toHaveBeenCalledWith({}, ['w1', 'w2'])
    expect(out.ok).toBe(true)
    expect(out.sessions[0]).toMatchObject({ id: 'w1', booked: 3 })
    expect(out.sessions[1]).toMatchObject({ id: 'w2', booked: 0 })
  })

  it('is ok with no sessions when the event has no waves, without reading', async () => {
    const out = await loadSessionFill({}, { id: 'e1', race_waves: [] })
    expect(out).toMatchObject({ ok: true, sessions: [], booked: 0 })
    expect(loadWaveRegistrations).not.toHaveBeenCalled()
  })
})
