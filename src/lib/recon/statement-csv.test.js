import { describe, it, expect } from 'vitest'
import { parseCsv, parseDateCell, parseAmountCell, parseStatementCsv, csvLineRows, csvReconciledKeys } from './statement-csv'

describe('parseCsv', () => {
  it('handles quoted fields, embedded commas/quotes, CRLF and blank rows', () => {
    const rows = parseCsv('a,"b,1","say ""hi"""\r\n\r\nc,d,e\n')
    expect(rows).toEqual([['a', 'b,1', 'say "hi"'], ['c', 'd', 'e']])
  })
})

describe('parseDateCell', () => {
  it('parses ISO, dd/mm/yyyy (Irish, never US) and d MMM yyyy', () => {
    expect(parseDateCell('2026-06-03')).toBe('2026-06-03')
    expect(parseDateCell('03/06/2026')).toBe('2026-06-03') // 3 June, not 6 March
    expect(parseDateCell('3 Jun 2026')).toBe('2026-06-03')
    expect(parseDateCell('03 June 26')).toBe('2026-06-03')
    expect(parseDateCell('garbage')).toBeNull()
    expect(parseDateCell('')).toBeNull()
  })
})

describe('parseAmountCell', () => {
  it('parses currency symbols, thousands separators and paren-negatives', () => {
    expect(parseAmountCell('1,234.56')).toBe(1234.56)
    expect(parseAmountCell('€84.50')).toBe(84.5)
    expect(parseAmountCell('(12.00)')).toBe(-12)
    expect(parseAmountCell('-12.00')).toBe(-12)
    expect(parseAmountCell('')).toBeNull()
    expect(parseAmountCell('n/a')).toBeNull()
  })
})

// The shape Xero's statement-lines export actually emits: signed
// Amount, a Status column, balance-marker furniture rows.
const XERO_CSV = [
  'Date,Description,Reference,Amount,Balance,Status',
  '1 Jun 2026,Opening Balance,,,"1,000.00",',
  '3 Jun 2026,MUSCLEFOOD LTD,CARD 1234,-84.50,915.50,Unreconciled',
  '5 Jun 2026,ELECTRIC IRELAND,DD 8871,-230.00,685.50,Reconciled',
  '6 Jun 2026,MEMBER PAYMENT,,99.00,784.50,Unreconciled',
  '10 Jun 2026,COFFEE SUPPLIES,,-12.00,772.50,Unreconciled',
  '30 Jun 2026,Closing Balance,,,772.50,',
].join('\n')

describe('parseStatementCsv', () => {
  it('parses the Xero export shape: skips balance rows, keeps in+out and both statuses', () => {
    const { rows, warnings } = parseStatementCsv(XERO_CSV)
    expect(warnings).toEqual([])
    expect(rows).toHaveLength(4)
    expect(rows[0]).toMatchObject({ date: '2026-06-03', amount: -84.5, description: 'MUSCLEFOOD LTD', reference: 'CARD 1234', reconciled: false, ordinal: 0 })
    expect(rows[1]).toMatchObject({ date: '2026-06-05', amount: -230, reconciled: true })
    expect(rows[2]).toMatchObject({ date: '2026-06-06', amount: 99, reconciled: false })
  })

  it('parses a Spent/Received pair (bank-side exports) with no status column', () => {
    const csv = [
      'Date,Details,Money Out,Money In',
      '03/06/2026,MUSCLEFOOD LTD,84.50,',
      '06/06/2026,MEMBER PAYMENT,,99.00',
    ].join('\n')
    const { rows } = parseStatementCsv(csv)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ date: '2026-06-03', amount: -84.5, reconciled: false })
    expect(rows[1]).toMatchObject({ amount: 99 })
  })

  it('finds the header row below title furniture and combines Payee with Description', () => {
    const csv = [
      'Bank Statement Export',
      '"UN1T Dublin",',
      'Date,Payee,Description,Amount,Status',
      '3 Jun 2026,MUSCLEFOOD,Protein order,-84.50,Unreconciled',
    ].join('\n')
    const { rows } = parseStatementCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0].description).toBe('MUSCLEFOOD — Protein order')
  })

  it('warns (not throws) on unparseable date rows and fails LOUDLY when columns are missing', () => {
    const { rows, warnings } = parseStatementCsv('Date,Description,Amount\nnot-a-date,X,-5.00\n3 Jun 2026,Y,-6.00')
    expect(rows).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(() => parseStatementCsv('Foo,Bar\n1,2')).toThrow(/Headers found: Foo, Bar/)
    expect(() => parseStatementCsv('')).toThrow(/empty/)
  })
})

// Xero's Bank Reconciliation report export — no column headers, a
// sectioned layout. Positional cols: Date, Payee, Description, Amount;
// money-out parenthesised. This is the shape Richard actually exported.
const XERO_RECON_REPORT = [
  'Revolut EUR Main Reconciliation Summary,,,',
  'Champ Fitness Ltd,,,',
  'As at 30 June 2026,,,',
  'Plus Unreconciled Statement Lines,,,',
  '07 May 2026,,Payment from Stripe GLOFOX PAYOUT ,"6,537.58"',
  '15 May 2026,Green Routed Freight,Green Routed Freight - Garrett Ivers  ,"(1,153.13)"',
  '03 Jun 2026,Supabase,Supabase - 25.00 USD - SUBSCRIPTIONS CARD  ,(21.51)',
  '02 Jun 2026,EUR Main,To EUR Main - 2958.58 EUR - Garrett Ivers  ,"2,958.58"',
  'Total Unreconciled Statement Lines,,,"25,912.88"',
  'Statement Balances,,,',
  '30 Jun 2026,Statement balance (calculated),,"3,558.91"',
  '30 Jun 2026,Calculated balance out by,,"(2,931.23)"',
].join('\n')

describe('parseStatementCsv — Xero Bank Reconciliation report', () => {
  it('reads only the Unreconciled Statement Lines section, positional cols, parens = money out', () => {
    const { rows, warnings } = parseStatementCsv(XERO_RECON_REPORT)
    expect(warnings).toEqual([])
    // 4 data rows in-section; the two Statement Balances rows are
    // excluded even though they lead with a parseable date.
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.amount)).toEqual([6537.58, -1153.13, -21.51, 2958.58])
    expect(rows.every((r) => r.reconciled === false)).toBe(true)
    // description prefers the detail column, falls back to payee
    expect(rows[0].description).toBe('Payment from Stripe GLOFOX PAYOUT')
    expect(rows[1].description).toBe('Green Routed Freight - Garrett Ivers')
  })

  it('tracks only money-out lines from the report (income + internal transfers excluded)', () => {
    const out = csvLineRows('acct-main', parseStatementCsv(XERO_RECON_REPORT).rows)
    // Stripe payout (in) and the +2958.58 transfer (in) drop out
    expect(out.map((l) => l.description)).toEqual(['Green Routed Freight - Garrett Ivers', 'Supabase - 25.00 USD - SUBSCRIPTIONS CARD'])
    expect(out.every((l) => l.amount < 0 && l.key.startsWith('csv:'))).toBe(true)
  })
})

describe('csvLineRows / csvReconciledKeys', () => {
  it('tracks unreconciled money-out only, with stable csv: keys over the full set', () => {
    const { rows } = parseStatementCsv(XERO_CSV)
    const lines = csvLineRows('acct-1', rows)
    expect(lines.map((l) => l.description)).toEqual(['MUSCLEFOOD LTD', 'COFFEE SUPPLIES'])
    expect(lines.every((l) => l.amount < 0)).toBe(true)
    expect(lines.every((l) => l.key.startsWith('csv:'))).toBe(true)

    // Same content re-uploaded later with MUSCLEFOOD now reconciled:
    // its key must be UNCHANGED so the import can cover the tracked row.
    const flipped = rows.map((r) => (r.description === 'MUSCLEFOOD LTD' ? { ...r, reconciled: true } : r))
    const recKeys = csvReconciledKeys('acct-1', flipped)
    expect(recKeys).toContain(lines[0].key)
    // …and the reconciled electric bill never entered tracking either way
    expect(csvLineRows('acct-1', flipped).map((l) => l.description)).toEqual(['COFFEE SUPPLIES'])
  })
})
