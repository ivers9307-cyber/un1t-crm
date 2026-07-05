import { describe, it, expect } from 'vitest'
import { parseBankStatementReport, computeLineKey, assignOrdinals } from './bank-statement'
import fixture from './__fixtures__/bank-statement-report.json'

// Inline payload builders for the report-shape variant tests below.
const HEADER = ['Date', 'Description', 'Reference', 'Reconciled', 'Source', 'Amount', 'Balance']
const cells = (values) => values.map((v) => ({ Value: v }))
const txRow = (date, description, reference, reconciled, amount, balance) => ({
  RowType: 'Row',
  Cells: cells([date, description, reference, reconciled, 'Import', amount, balance]),
})
const makeReport = ({ header = HEADER, sections }) => ({
  Reports: [
    {
      ReportID: 'BankStatement',
      Rows: [
        { RowType: 'Header', Cells: cells(header) },
        ...sections.map((rows) => ({ RowType: 'Section', Title: '', Rows: rows })),
      ],
    },
  ],
})

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

  it('tolerates padded header cells (e.g. "Date ")', () => {
    const payload = makeReport({
      header: ['Date ', ' Description', 'Reference', 'Reconciled', 'Source', 'Amount ', 'Balance'],
      sections: [[txRow('2026-06-03T00:00:00', 'MUSCLEFOOD LTD', 'CARD 1234', 'No', '-84.50', '1165.50')]],
    })
    const rows = parseBankStatementReport(payload)
    expect(rows).toHaveLength(1)
    expect(rows[0].date).toBe('2026-06-03')
    expect(rows[0].description).toBe('MUSCLEFOOD LTD')
    expect(rows[0].amount).toBe(-84.5)
  })

  it('parses rows from every Section, not just the first', () => {
    const payload = makeReport({
      sections: [
        [txRow('2026-06-03T00:00:00', 'MUSCLEFOOD LTD', 'CARD 1234', 'No', '-84.50', '1165.50')],
        [txRow('2026-06-10T00:00:00', 'BORD GAIS', 'DD 4410', 'Yes', '-120.00', '1045.50')],
      ],
    })
    const rows = parseBankStatementReport(payload)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.description)).toEqual(['MUSCLEFOOD LTD', 'BORD GAIS'])
  })

  it('treats a report with no Reconciled column as all-unreconciled', () => {
    const payload = makeReport({
      header: ['Date', 'Description', 'Reference', 'Source', 'Amount', 'Balance'],
      sections: [[
        { RowType: 'Row', Cells: cells(['2026-06-03T00:00:00', 'MUSCLEFOOD LTD', 'CARD 1234', 'Import', '-84.50', '1165.50']) },
        { RowType: 'Row', Cells: cells(['2026-06-05T00:00:00', 'ELECTRIC IRELAND', 'DD 8871', 'Import', '-230.00', '935.50']) },
      ]],
    })
    const rows = parseBankStatementReport(payload)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.reconciled === false)).toBe(true)
  })
})

describe('assignOrdinals + computeLineKey', () => {
  it('gives identical (date, amount, description) tuples distinct ordinals → distinct keys', () => {
    // Contract: assign ordinals over the FULL parsed set, THEN filter.
    const withOrdinals = assignOrdinals(parseBankStatementReport(fixture)).filter((r) => !r.reconciled)
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

describe('identity normalization', () => {
  it('case/whitespace description variants mint ONE key', () => {
    // The same bank line can drift "MUSCLEFOOD LTD" → "Musclefood Ltd" →
    // "MUSCLEFOOD  LTD" between weekly pulls; identity must not care.
    const base = { date: '2026-06-03', amount: -84.5, ordinal: 0 }
    const keys = ['MUSCLEFOOD LTD', 'Musclefood Ltd', 'MUSCLEFOOD  LTD'].map((description) =>
      computeLineKey('acct-1', { ...base, description })
    )
    expect(new Set(keys).size).toBe(1)
  })

  it('case/whitespace-variant duplicates share one ordinal sequence', () => {
    const rows = [
      { date: '2026-06-03', amount: -84.5, description: 'MUSCLEFOOD LTD', reconciled: false },
      { date: '2026-06-03', amount: -84.5, description: 'Musclefood  Ltd', reconciled: false },
    ]
    expect(assignOrdinals(rows).map((r) => r.ordinal)).toEqual([0, 1])
  })
})

describe('ordinal contract: assign over the FULL row set before filtering', () => {
  // Two identical same-day card taps. Between week1 and week2 the FIRST
  // one gets reconciled (the report keeps reconciled lines in its output).
  // Assigning ordinals over the full parsed set keeps the survivor on
  // ordinal 1 both weeks, so its key is stable across pulls.
  const week1 = [
    { date: '2026-06-03', amount: -84.5, description: 'MUSCLEFOOD LTD', reconciled: false },
    { date: '2026-06-03', amount: -84.5, description: 'MUSCLEFOOD LTD', reconciled: false },
  ]
  const week2 = [
    { date: '2026-06-03', amount: -84.5, description: 'MUSCLEFOOD LTD', reconciled: true },
    { date: '2026-06-03', amount: -84.5, description: 'MUSCLEFOOD LTD', reconciled: false },
  ]

  it('keeps the surviving duplicate on ordinal 1 → identical key across pulls', () => {
    const w1Survivor = assignOrdinals(week1)[1]
    const w2Survivor = assignOrdinals(week2).filter((r) => !r.reconciled)[0]
    expect(w1Survivor.ordinal).toBe(1)
    expect(w2Survivor.ordinal).toBe(1)
    expect(computeLineKey('acct-1', w2Survivor)).toBe(computeLineKey('acct-1', w1Survivor))
  })

  it('filtering before assigning would renumber the survivor and change its key', () => {
    const contractKey = computeLineKey('acct-1', assignOrdinals(week2).filter((r) => !r.reconciled)[0])
    const filteredFirst = assignOrdinals(week2.filter((r) => !r.reconciled))[0]
    expect(filteredFirst.ordinal).toBe(0) // the renumbering the contract prevents
    expect(computeLineKey('acct-1', filteredFirst)).not.toBe(contractKey)
  })
})
