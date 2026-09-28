import { describe, it, expect } from 'vitest'
import { healthCellState, STATUS_CHIPS } from './tenants-format'

describe('healthCellState (HUBREAD.1)', () => {
  it('zero and zero is OK', () => {
    expect(healthCellState({ attentionCount: 0, staleHeartbeatCount: 0 })).toMatchObject({ ok: true, unknown: [] })
  })

  it('a null count is unknown, never OK', () => {
    expect(healthCellState({ attentionCount: null, staleHeartbeatCount: 0 })).toMatchObject({ ok: false, unknown: ['integrations'] })
    expect(healthCellState({ attentionCount: 0, staleHeartbeatCount: null })).toMatchObject({ ok: false, unknown: ['heartbeats'] })
  })

  it('missing health is unknown on both, never OK', () => {
    expect(healthCellState(undefined)).toMatchObject({ ok: false, unknown: ['integrations', 'heartbeats'] })
  })

  it('real problems are not OK', () => {
    expect(healthCellState({ attentionCount: 2, staleHeartbeatCount: 0 })).toMatchObject({ ok: false, unknown: [], attentionCount: 2 })
  })

  it('has an amber chip for an unknown hub row', () => {
    expect(STATUS_CHIPS.unknown).toBe('bg-amber-500/10 text-amber-700')
  })
})
