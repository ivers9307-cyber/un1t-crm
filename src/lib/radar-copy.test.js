// UN1TRADAR.2 — the staff copy for arrears un1t.online cannot read, or reports
// without an amount: never "0", estimates always labelled.
import { describe, it, expect } from 'vitest'
import { UN1T_UNAVAILABLE, ESTIMATE_NOTE, AMOUNT_UNAVAILABLE, amountOrUnavailable, countOrUnavailable, owedLabel, totalLabel, syncedAtLine, overdueCardBreakdown, rowAmountLabel, arrearsBriefingLabel } from './radar-copy'

describe('radar copy', () => {
  it('UN1T_UNAVAILABLE is exact', () => expect(UN1T_UNAVAILABLE).toBe('not available from un1t.online'))

  it('countOrUnavailable(null) is "not available from un1t.online", never "0"', () => {
    expect(countOrUnavailable(null)).toBe('not available from un1t.online')
    expect(countOrUnavailable(0)).toBe('0')
    expect(countOrUnavailable(7)).toBe('7')
    // a Glofox summary that lacks the key renders as it always did
    expect(countOrUnavailable(undefined)).toBe('0')
  })

  it('owedLabel estimate copy is exact', () => {
    expect(owedLabel(4500, { estimated: true })).toBe('about €45 (estimate: amount not reported by un1t.online)')
    expect(owedLabel(4500)).toBe('€45')
    expect(owedLabel(123456, {})).toBe('€1,235')
  })

  it('owedLabel for a debt with no euro figure never prints €0', () => {
    expect(owedLabel(0, { unknown: true })).toBe('amount not available from un1t.online')
  })

  it('totalLabel says "includes an estimate"', () => {
    expect(totalLabel(16500, { estimated: true })).toBe('€165, includes an estimate')
    expect(totalLabel(16500)).toBe('€165')
    expect(ESTIMATE_NOTE).toBe('includes an estimate')
    expect(totalLabel(0, { estimated: true })).toBe('amount not available from un1t.online')
    expect(totalLabel(0)).toBe('€0')
  })

  it('no em-dash in any copy', () => {
    for (const s of [UN1T_UNAVAILABLE, owedLabel(1, { estimated: true }), totalLabel(1, { estimated: true }), owedLabel(0, { unknown: true }), syncedAtLine('2026-10-18T11:45:00Z', 'Europe/Dublin')]) {
      expect(s).not.toMatch(/—/)
    }
  })

  it('syncedAtLine renders HH:MM on the studio clock; null without a time', () => {
    expect(syncedAtLine('2026-10-18T11:45:00Z', 'Europe/Dublin')).toBe('un1t.online data as of 12:45')
    expect(syncedAtLine('2026-10-18T11:45:00Z', 'America/New_York')).toBe('un1t.online data as of 07:45')
    expect(syncedAtLine(null, 'Europe/Dublin')).toBeNull()
  })
})

describe('radar page copy (ChurnRadar.jsx)', () => {
  it('Overdue stat card: Glofox text unchanged; an estimate says so', () => {
    expect(overdueCardBreakdown({ overdueValueCents: 16500 })).toBe('€165 owed')
    expect(overdueCardBreakdown({ overdueValueCents: 16500, overdueValueEstimated: true })).toBe('€165 owed, includes an estimate')
    expect(overdueCardBreakdown({ overdueValueCents: 0, overdueValueEstimated: true })).toBe('amount not available from un1t.online')
  })
  it('Overdue row amount: exact, estimate, unknown and awaiting', () => {
    expect(rowAmountLabel({ amountOwedCents: 4500 })).toBe('€45 owed')
    expect(rowAmountLabel({ amountOwedCents: 4500, amountEstimated: true })).toBe('about €45 (estimate: amount not reported by un1t.online)')
    expect(rowAmountLabel({ amountOwedCents: 0, amountUnknown: true })).toBe('amount not available from un1t.online')
    expect(rowAmountLabel({ amountOwedCents: 1000 }, { awaiting: true })).toBe('€10 awaiting authorization')
  })
  it('business briefing label: Glofox unchanged; an estimate says so', () => {
    expect(arrearsBriefingLabel({ memberCount: 3, totalCents: 45000 })).toBe('3 in arrears (€450)')
    expect(arrearsBriefingLabel({ memberCount: 1, totalCents: 16500, estimated: true })).toBe('1 in arrears (€165, includes an estimate)')
  })
})

describe('amountOrUnavailable (card values)', () => {
  const fmt = (c) => `F${c}`
  it('no known amount (flagged and not above 0) is AMOUNT_UNAVAILABLE, never a formatted 0', () => {
    expect(AMOUNT_UNAVAILABLE).toBe('amount not available from un1t.online')
    expect(amountOrUnavailable(0, { estimated: true }, fmt)).toBe(AMOUNT_UNAVAILABLE)
    expect(amountOrUnavailable(0, { unknown: true }, fmt)).toBe(AMOUNT_UNAVAILABLE)
    expect(amountOrUnavailable(null, { estimated: true }, fmt)).toBe(AMOUNT_UNAVAILABLE)
  })
  it('a known amount, or an unflagged (Glofox) one, goes through the formatter unchanged', () => {
    expect(amountOrUnavailable(16500, { estimated: true }, fmt)).toBe('F16500')
    expect(amountOrUnavailable(0, {}, fmt)).toBe('F0')
    expect(amountOrUnavailable(0, undefined, fmt)).toBe('F0')
    expect(amountOrUnavailable(4500)).toBe('€45')
  })
  it('agrees with totalLabel on when there is no number', () => {
    expect(totalLabel(0, { estimated: true })).toBe(AMOUNT_UNAVAILABLE)
    expect(owedLabel(0, { unknown: true })).toBe(AMOUNT_UNAVAILABLE)
  })
})
