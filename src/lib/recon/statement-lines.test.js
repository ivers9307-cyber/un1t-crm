import { describe, it, expect } from 'vitest'
import { mapStatementLines, statementLineRows } from './statement-lines'

// Shape per Xero's Finance API OpenAPI spec (BankStatementsPlus,
// SummaryOnly=false): statements[] each carrying statementLines[].
const payload = {
  statements: [
    {
      statementId: 'st-1',
      statementLines: [
        {
          statementLineId: 'sl-001',
          postedDate: '2026-06-03',
          amount: 84.5,
          type: 'DEBIT',
          payee: 'MUSCLEFOOD LTD',
          reference: 'CARD 1234',
          isReconciled: false,
          isDeleted: false,
          isDuplicate: false,
        },
        {
          statementLineId: 'sl-002',
          postedDate: '2026-06-05',
          amount: 230,
          type: 'DEBIT',
          payee: 'ELECTRIC IRELAND',
          reference: 'DD 8871',
          isReconciled: true,
          isDeleted: false,
        },
        {
          statementLineId: 'sl-003',
          postedDate: '2026-06-06',
          amount: 99,
          type: 'CREDIT', // inbound — mapped, excluded from tracked rows
          payee: 'A CUSTOMER',
          isReconciled: false,
          isDeleted: false,
        },
        {
          statementLineId: 'sl-004',
          postedDate: '2026-06-07',
          amount: 10,
          type: 'DEBIT',
          payee: 'GONE',
          isReconciled: false,
          isDeleted: true, // deleted feed line — skipped entirely
        },
      ],
    },
    {
      statementId: 'st-2',
      statementLines: [
        {
          statementLineId: 'sl-005',
          postedDate: '2026-06-10',
          amount: 12,
          type: 'DEBIT',
          payee: 'COFFEE SUPPLIES',
          isReconciled: false,
          isDeleted: false,
        },
      ],
    },
  ],
}

describe('mapStatementLines', () => {
  it('flattens statements, signs amounts by type, skips deleted lines', () => {
    const rows = mapStatementLines(payload)
    expect(rows).toHaveLength(4) // sl-004 deleted → skipped
    expect(rows[0]).toEqual({
      id: 'sl-001',
      date: '2026-06-03',
      amount: -84.5, // DEBIT → money out → negative
      description: 'MUSCLEFOOD LTD',
      reference: 'CARD 1234',
      reconciled: false,
    })
    expect(rows.find((r) => r.id === 'sl-003').amount).toBe(99) // CREDIT → positive
    expect(rows.find((r) => r.id === 'sl-002').reconciled).toBe(true)
    expect(rows.find((r) => r.id === 'sl-005').description).toBe('COFFEE SUPPLIES')
  })

  it('returns [] for empty/odd payloads', () => {
    expect(mapStatementLines({})).toEqual([])
    expect(mapStatementLines(null)).toEqual([])
    expect(mapStatementLines({ statements: [{ statementLines: [{ postedDate: '2026-01-01', amount: 1, type: 'DEBIT' }] }] })).toEqual([]) // no id → dropped
  })
})

describe('statementLineRows', () => {
  it('keeps only unreconciled MONEY-OUT lines, keyed sl:<id>', () => {
    const lines = statementLineRows(mapStatementLines(payload))
    // sl-002 reconciled, sl-003 inbound, sl-004 deleted → only sl-001 + sl-005
    expect(lines.map((l) => l.key)).toEqual(['sl:sl-001', 'sl:sl-005'])
    expect(lines[0]).toEqual({
      key: 'sl:sl-001',
      date: '2026-06-03',
      amount: -84.5,
      description: 'MUSCLEFOOD LTD',
      reference: 'CARD 1234',
    })
    expect(lines.every((l) => l.amount < 0)).toBe(true)
  })
})
