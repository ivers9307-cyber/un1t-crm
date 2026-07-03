import { describe, it, expect } from 'vitest'
import { parseBankStatementReport, computeLineKey, assignOrdinals } from './bank-statement'
import fixture from './__fixtures__/bank-statement-report.json'

describe('parseBankStatementReport', () => {
  it('extracts transaction rows and skips balance rows', () => {
    const rows = parseBankStatementReport(fixture)
    expect(rows).toHaveLength(3) // Opening/Closing Balance skipped
    expect(rows[0]).toEqual({
      date: '2026-06-03',
      description: 'MUSCLEFOOD LTD',
      reference: 'CARD 1234',
      reconciled: false,
      amount: -84.5,
    })
    expect(rows[1].reconciled).toBe(true)
  })

  it('returns [] for an empty/odd report payload', () => {
    expect(parseBankStatementReport({})).toEqual([])
    expect(parseBankStatementReport({ Reports: [] })).toEqual([])
  })
})

describe('assignOrdinals + computeLineKey', () => {
  it('gives identical (date, amount, description) tuples distinct ordinals → distinct keys', () => {
    const rows = parseBankStatementReport(fixture).filter((r) => !r.reconciled)
    const withOrdinals = assignOrdinals(rows)
    expect(withOrdinals[0].ordinal).toBe(0)
    expect(withOrdinals[1].ordinal).toBe(1) // second identical MUSCLEFOOD line
    const k1 = computeLineKey('acct-1', withOrdinals[0])
    const k2 = computeLineKey('acct-1', withOrdinals[1])
    expect(k1).not.toBe(k2)
    expect(k1).toMatch(/^[a-f0-9]{64}$/)
  })

  it('is stable across pulls (same inputs → same key)', () => {
    const line = { date: '2026-06-03', amount: -84.5, description: 'MUSCLEFOOD LTD', ordinal: 0 }
    expect(computeLineKey('acct-1', line)).toBe(computeLineKey('acct-1', { ...line }))
  })
})
