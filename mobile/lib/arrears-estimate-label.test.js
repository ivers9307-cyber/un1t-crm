// UN1TRADAR.2 — the phone labels an estimated arrears figure; a Glofox
// studio's text is unchanged.
import { describe, it, expect } from 'vitest'
import { ESTIMATE_NOTE, AMOUNT_UNAVAILABLE, overdueValueNote, arrearsSublabel, amountOrUnavailable, arrearsCardValue, overdueValueText } from './arrears-estimate-label'

describe('arrears estimate labels', () => {
  it("arrearsSublabel matches today's copy when not estimated", () => {
    expect(arrearsSublabel({ totalCents: 9000, memberCount: 1 })).toBe('1 member')
    expect(arrearsSublabel({ totalCents: 9000, memberCount: 3 })).toBe('3 members')
    expect(arrearsSublabel(null)).toBe('arrears unavailable')
  })
  it('arrearsSublabel adds the estimate note', () => {
    expect(arrearsSublabel({ totalCents: 9000, memberCount: 2, estimated: true })).toBe('2 members, includes an estimate')
  })
  it('overdueValueNote only when flagged', () => {
    expect(overdueValueNote({})).toBeNull()
    expect(overdueValueNote(null)).toBeNull()
    expect(overdueValueNote({ overdueValueCents: 16500, overdueValueEstimated: true })).toBe('includes an estimate')
    expect(ESTIMATE_NOTE).toBe('includes an estimate')
  })
})

describe('no known euro amount (UN1TRADAR.2 review)', () => {
  const fmt = (euros) => `F${euros}`
  it('In arrears card: no known amount says so, never "€0"; Glofox unchanged', () => {
    expect(arrearsCardValue({ totalCents: 0, memberCount: 3, estimated: true }, fmt)).toBe(AMOUNT_UNAVAILABLE)
    expect(arrearsCardValue({ totalCents: 16500, memberCount: 2, estimated: true }, fmt)).toBe('F165')
    expect(arrearsCardValue({ totalCents: 0, memberCount: 0 }, fmt)).toBe('F0')
    expect(arrearsCardValue(null, fmt)).toBe('—')
  })
  it('radar Overdue value row: no known amount says so; the note only beside a number', () => {
    const money = (c) => `M${c}`
    expect(overdueValueText({ overdueValueCents: 0, overdueValueEstimated: true }, money)).toBe(AMOUNT_UNAVAILABLE)
    expect(overdueValueText({ overdueValueCents: 16500, overdueValueEstimated: true }, money)).toBe('M16500')
    expect(overdueValueText({ overdueValueCents: 0 }, money)).toBe('M0')
    expect(overdueValueNote({ overdueValueCents: 0, overdueValueEstimated: true })).toBeNull()
    expect(overdueValueNote({ overdueValueCents: 16500, overdueValueEstimated: true })).toBe(ESTIMATE_NOTE)
  })
  it('amountOrUnavailable rule', () => {
    expect(AMOUNT_UNAVAILABLE).toBe('amount not available from un1t.online')
    expect(amountOrUnavailable(0, { unknown: true }, fmt)).toBe(AMOUNT_UNAVAILABLE)
    expect(amountOrUnavailable(0, {}, fmt)).toBe('F0')
  })
})
