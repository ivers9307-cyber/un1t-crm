import { describe, it, expect } from 'vitest'
import { mapBankTransactions, bankTransactionLines } from './bank-transactions'

const payload = {
  BankTransactions: [
    {
      BankTransactionID: 'bt-001',
      Type: 'SPEND',
      Status: 'AUTHORISED',
      IsReconciled: false,
      DateString: '2026-06-03T00:00:00',
      Total: 84.5,
      Contact: { Name: 'MUSCLEFOOD LTD' },
      Reference: 'CARD 1234',
      LineItems: [{ Description: 'Protein order' }],
    },
    {
      BankTransactionID: 'bt-002',
      Type: 'RECEIVE',
      Status: 'AUTHORISED',
      IsReconciled: true,
      DateString: '2026-06-05T00:00:00',
      Total: 250,
      Contact: { Name: 'A MEMBER' },
    },
    {
      BankTransactionID: 'bt-003',
      Type: 'SPEND',
      Status: 'DELETED', // skipped
      IsReconciled: false,
      DateString: '2026-06-06T00:00:00',
      Total: 10,
    },
    {
      BankTransactionID: 'bt-004',
      Type: 'SPEND-OVERPAYMENT',
      Status: 'AUTHORISED',
      IsReconciled: false,
      // no DateString — legacy /Date(ms)/ form must still parse
      Date: '/Date(1783036800000+0000)/', // 2026-07-03T00:00:00Z
      Total: 12,
      // no Contact — falls back to first line item description
      LineItems: [{ Description: 'Overpayment' }],
    },
  ],
}

describe('mapBankTransactions', () => {
  it('maps authorised transactions with signed amounts and stable ids', () => {
    const rows = mapBankTransactions(payload)
    expect(rows).toHaveLength(3) // DELETED skipped
    expect(rows[0]).toEqual({
      id: 'bt-001',
      date: '2026-06-03',
      amount: -84.5, // SPEND → money out → negative
      description: 'MUSCLEFOOD LTD',
      reference: 'CARD 1234',
      reconciled: false,
    })
    expect(rows[1].amount).toBe(250) // RECEIVE → positive
    expect(rows[1].reconciled).toBe(true)
  })

  it('parses the legacy /Date(ms)/ form and falls back to line-item description', () => {
    const rows = mapBankTransactions(payload)
    const over = rows.find((r) => r.id === 'bt-004')
    expect(over.date).toBe('2026-07-03') // 1783036800000 ms UTC
    expect(over.amount).toBe(-12) // SPEND-* variants are money out
    expect(over.description).toBe('Overpayment')
    expect(over.reference).toBe('')
  })

  it('returns [] for empty/odd payloads', () => {
    expect(mapBankTransactions({})).toEqual([])
    expect(mapBankTransactions(null)).toEqual([])
    expect(mapBankTransactions({ BankTransactions: [{ Type: 'SPEND', Status: 'AUTHORISED', Total: 1 }] })).toEqual([]) // no id → dropped
  })
})

describe('bankTransactionLines', () => {
  it('keeps only unreconciled rows, keyed bt:<id>', () => {
    const lines = bankTransactionLines(mapBankTransactions(payload))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual({
      key: 'bt:bt-001',
      date: '2026-06-03',
      amount: -84.5,
      description: 'MUSCLEFOOD LTD',
      reference: 'CARD 1234',
    })
    expect(lines.map((l) => l.key)).toEqual(['bt:bt-001', 'bt:bt-004'])
  })
})
