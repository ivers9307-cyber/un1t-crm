import { describe, it, expect } from 'vitest'
import { cronStatus, waNumberStatus, backlogStatus, worstStatus } from './integration-health.js'

describe('cronStatus', () => {
  it('ok when nothing is stale', () => {
    expect(cronStatus([{ name: 'a', is_stale: false }, { name: 'b', is_stale: false }]).status).toBe('ok')
  })
  it('down with worst lag + names when any is stale', () => {
    const s = cronStatus([{ name: 'a', is_stale: true, stale_seconds: 300 }, { name: 'b', is_stale: false }, { name: 'c', is_stale: true, stale_seconds: 900 }])
    expect(s.status).toBe('down')
    expect(s.staleCount).toBe(2)
    expect(s.worstLag).toBe(900)
    expect(s.staleNames).toEqual(['a', 'c'])
  })
  it('unknown with no rows', () => {
    expect(cronStatus([]).status).toBe('unknown')
    expect(cronStatus(null).status).toBe('unknown')
  })
})

describe('waNumberStatus', () => {
  it('down on invalid token (the silent-send-death case) — even if quality is green', () => {
    expect(waNumberStatus({ token_invalid_at: '2026-01-01', quality_rating: 'GREEN' }).status).toBe('down')
  })
  it('maps quality RED->down, YELLOW->warn, GREEN->ok', () => {
    expect(waNumberStatus({ quality_rating: 'RED' }).status).toBe('down')
    expect(waNumberStatus({ quality_rating: 'YELLOW' }).status).toBe('warn')
    expect(waNumberStatus({ quality_rating: 'GREEN' }).status).toBe('ok')
  })
  it('unknown for a missing number', () => {
    expect(waNumberStatus(null).status).toBe('unknown')
  })
})

describe('backlogStatus', () => {
  it('ok at 0, warn under 10, down at 10+', () => {
    expect(backlogStatus(0).status).toBe('ok')
    expect(backlogStatus(5).status).toBe('warn')
    expect(backlogStatus(25).status).toBe('down')
  })
})

describe('worstStatus', () => {
  it('rolls up to the most severe', () => {
    expect(worstStatus([{ status: 'ok' }, { status: 'warn' }, { status: 'ok' }])).toBe('warn')
    expect(worstStatus([{ status: 'ok' }, { status: 'down' }, { status: 'warn' }])).toBe('down')
    expect(worstStatus([{ status: 'ok' }, { status: 'ok' }])).toBe('ok')
    expect(worstStatus([{ status: 'unknown' }, { status: 'ok' }])).toBe('unknown')
  })
})
