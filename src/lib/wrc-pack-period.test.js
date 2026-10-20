// WRCPERIOD.1 — the pack's own period rule, shared by the card and the route.
import { describe, it, expect } from 'vitest'
import { defaultWrcPeriod, wrcPeriodDays, wrcPeriodError, WRC_PACK_MAX_DAYS } from './wrc-pack-period'

describe('wrc-pack-period', () => {
  it('counts inclusive days and refuses unreal dates', () => {
    expect(wrcPeriodDays('2026-10-20', '2026-10-20')).toBe(1)
    expect(wrcPeriodDays('2025-06-01', '2026-10-20')).toBe(507)
    expect(wrcPeriodDays('2026-02-30', '2026-03-01')).toBeNull()
    expect(wrcPeriodDays('', '2026-03-01')).toBeNull()
  })
  it('three years is the cap, one day over is refused, a reversed period is refused', () => {
    expect(WRC_PACK_MAX_DAYS).toBe(1096)
    expect(wrcPeriodError('2023-10-21', '2026-10-20')).toBeNull()                 // 1,096 days
    expect(wrcPeriodError('2023-10-20', '2026-10-20')).toMatch(/at most three years \(1096 days\); this period is 1097 days/)
    expect(wrcPeriodError('2025-06-01', '2026-10-20')).toBeNull()                 // the 507-day inspection ask
    expect(wrcPeriodError('2026-03-01', '2026-02-01')).toBe('To must be on or after From.')
    expect(wrcPeriodError('2026-02-30', '2026-03-01')).toBe('Pick a real From and To date.')
  })
  it('the default period is the 12 months ending today, inside the cap', () => {
    const d = defaultWrcPeriod('2026-10-20')
    expect(d).toEqual({ from: '2025-10-21', to: '2026-10-20' })
    expect(wrcPeriodError(d.from, d.to)).toBeNull()
  })
})
