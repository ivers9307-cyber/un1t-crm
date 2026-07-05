// src/lib/recon/statement-csv.js
//
// RCOV — CSV bridge for the coverage board. Xero's API cannot serve
// unactioned imported statement lines to this app (the Bank Statement
// report scope is RETIRED, the Finance API is ENTITLEMENT-GATED — see
// statement-lines.js), but Xero's UI can EXPORT statement lines to
// CSV. The operator exports per account and uploads here; parsed
// lines join recon_bank_lines under the `csv:` key namespace and flow
// through the same hunt/report machinery as API-pulled lines.
//
// The parser is deliberately TOLERANT about column headers — Xero's
// export shape isn't pinned by any contract, and bank-side exports
// (Revolut) should work too. It maps columns by header keyword,
// supports a signed Amount column OR a Spent/Received pair, and
// parses the date formats Xero and Irish banks actually emit. When it
// can't find the required columns it fails LOUDLY, listing the
// headers it saw — never a silent empty import.
//
// Line identity reuses the P0 tuple machinery (assignOrdinals +
// computeLineKey from ./bank-statement): ordinals are assigned over
// the FULL parsed set (pre-filter) so keys stay stable across
// re-uploads regardless of how many rows are already reconciled.
import { assignOrdinals, computeLineKey } from './bank-statement'

// RFC-4180-ish CSV: quoted fields, embedded commas/quotes/newlines.
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  const src = String(text ?? '')
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1 } else inQuotes = false
      } else field += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1
      row.push(field); field = ''
      if (row.some((f) => f.trim() !== '')) rows.push(row)
      row = []
    } else {
      field += c
    }
  }
  row.push(field)
  if (row.some((f) => f.trim() !== '')) rows.push(row)
  return rows
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const pad2 = (n) => String(n).padStart(2, '0')

// → 'yyyy-mm-dd' or null. Pure string work — no Date() (TZ-free by
// construction; cf. the guardrails ban on local-parse + ISO-format).
export function parseDateCell(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/) // dd/mm/yyyy — Irish locale, never US
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{2,4})$/) // 3 Jun 2026 / 03 June 26
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()]
    if (!mon) return null
    const year = m[3].length === 2 ? `20${m[3]}` : m[3]
    return `${year}-${pad2(mon)}-${pad2(m[1])}`
  }
  return null
}

// '1,234.56' / '€84.50' / '(12.00)' / '-12.00' → number or null
export function parseAmountCell(raw) {
  let s = String(raw ?? '').trim()
  if (!s) return null
  let negative = false
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1) }
  s = s.replace(/[€£$\s,]/g, '')
  if (!s || !/^-?\d*\.?\d+$/.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return negative ? -n : n
}

const HEADER_MAP = [
  ['date', ['date', 'transaction date', 'posted date', 'value date', 'date completed', 'started date', 'completed date']],
  ['amount', ['amount', 'value', 'amount (eur)', 'amount eur']],
  ['spent', ['spent', 'debit', 'money out', 'paid out', 'withdrawn', 'debit amount']],
  ['received', ['received', 'credit', 'money in', 'paid in', 'deposited', 'credit amount']],
  ['payee', ['payee', 'name']],
  ['description', ['description', 'details', 'transaction', 'narrative', 'particulars']],
  ['reference', ['reference', 'ref', 'transaction reference']],
  ['status', ['status', 'reconciled', 'reconciliation status', 'state']],
]

function mapHeaders(headerRow) {
  const col = {}
  headerRow.forEach((h, i) => {
    const norm = String(h).replace(/\s+/g, ' ').trim().toLowerCase()
    for (const [field, names] of HEADER_MAP) {
      if (col[field] === undefined && names.includes(norm)) col[field] = i
    }
  })
  return col
}

// Balance markers are statement furniture, not transactions.
const BALANCE_DESC = /^(opening|closing)\s+balance$/i

// text → { rows, warnings } where rows = FULL normalized set
// (money-in AND money-out, reconciled AND not), ordinal-assigned.
//
// Two input shapes are accepted, tried in order:
//   1. A column-headed export (Xero statement-lines export, or a
//      bank's own CSV) — mapped by header keyword.
//   2. Xero's Bank Reconciliation report — no headers, sectioned; we
//      read its "Unreconciled Statement Lines" section positionally.
// Throws (naming what it saw) only when NEITHER shape is recognised.
export function parseStatementCsv(text) {
  const raw = parseCsv(text)
  if (raw.length === 0) throw new Error('The file is empty — export the statement lines from Xero as CSV and try again.')

  const byHeader = parseWithHeaders(raw)
  if (byHeader) return byHeader

  const byReport = parseReconciliationReport(raw)
  if (byReport) return byReport

  const seen = raw[0].map((h) => String(h).trim()).filter(Boolean).join(', ')
  throw new Error(
    `Couldn't find the statement columns — need a Date column plus Amount (or Spent/Received), ` +
    `or a Xero "Unreconciled Statement Lines" section. Headers found: ${seen || '(none)'}`
  )
}

// Shape 1 — column-headed export. Returns { rows, warnings } or null
// when no header row (date + amount-ish) appears in the first 10 rows.
function parseWithHeaders(raw) {
  let headerIdx = -1
  let col = null
  for (let i = 0; i < Math.min(raw.length, 10); i += 1) {
    const candidate = mapHeaders(raw[i])
    if (candidate.date !== undefined && (candidate.amount !== undefined || candidate.spent !== undefined || candidate.received !== undefined)) {
      headerIdx = i
      col = candidate
      break
    }
  }
  if (headerIdx === -1) return null
  if (col.description === undefined && col.payee !== undefined) col.description = col.payee

  const rows = []
  const warnings = []
  for (const cells of raw.slice(headerIdx + 1)) {
    const desc = String(cells[col.description] ?? '').replace(/\s+/g, ' ').trim()
    if (BALANCE_DESC.test(desc)) continue
    const date = parseDateCell(cells[col.date])
    if (!date) {
      if (cells.some((f) => String(f).trim() !== '')) warnings.push(`Skipped a row with an unparseable date: "${String(cells[col.date] ?? '').trim()}"`)
      continue
    }
    let amount = null
    if (col.amount !== undefined) {
      amount = parseAmountCell(cells[col.amount])
    }
    if (amount === null && (col.spent !== undefined || col.received !== undefined)) {
      const spent = col.spent !== undefined ? parseAmountCell(cells[col.spent]) : null
      const received = col.received !== undefined ? parseAmountCell(cells[col.received]) : null
      if (spent) amount = -Math.abs(spent)
      else if (received) amount = Math.abs(received)
    }
    if (amount === null || amount === 0) continue

    // Payee + description both present → combine for the hunt query
    // (payee is usually the merchant; description carries the detail).
    const payee = col.payee !== undefined && col.payee !== col.description
      ? String(cells[col.payee] ?? '').replace(/\s+/g, ' ').trim()
      : ''
    const description = payee && desc ? `${payee} — ${desc}` : (payee || desc)

    const status = String(cells[col.status] ?? '').trim().toLowerCase()
    rows.push({
      date,
      amount,
      description,
      reference: String(cells[col.reference] ?? '').trim(),
      reconciled: status === 'reconciled',
    })
  }
  return { rows: assignOrdinals(rows), warnings }
}

const UNREC_MARKER = /unreconciled statement lines/i

// Shape 2 — Xero's Bank Reconciliation report. No column headers; a
// sectioned layout. We parse ONLY the "Unreconciled Statement Lines"
// section — those are bank-feed lines Xero hasn't reconciled yet (the
// receipt backlog). Other sections (un-presented payments/receipts)
// are Xero-side transactions the API pull already sees, so we skip
// them. Columns are positional: Date, Payee, Description, Amount;
// money-out is parenthesised (→ negative). Returns { rows, warnings }
// or null when the report has no such section.
function parseReconciliationReport(raw) {
  if (!raw.some((r) => UNREC_MARKER.test(String(r[0] ?? '')))) return null

  const rows = []
  const warnings = []
  let inSection = false
  for (const cells of raw) {
    const first = String(cells[0] ?? '').replace(/\s+/g, ' ').trim()
    const firstLc = first.toLowerCase()
    if (UNREC_MARKER.test(firstLc)) {
      // "Plus Unreconciled Statement Lines" opens the section;
      // "Total Unreconciled Statement Lines" closes it.
      inSection = !firstLc.startsWith('total')
      continue
    }
    // Any other subtotal / the Statement Balances block ends the section.
    if (firstLc.startsWith('total') || firstLc.startsWith('statement balance')) {
      inSection = false
      continue
    }
    if (!inSection) continue

    const date = parseDateCell(first)
    if (!date) {
      if (cells.some((f) => String(f).trim() !== '')) warnings.push(`Skipped a row with an unparseable date: "${first}"`)
      continue
    }
    // Amount = the rightmost non-empty cell (the report's last column).
    const amtCell = [...cells].reverse().find((c) => String(c).trim() !== '')
    const amount = parseAmountCell(amtCell)
    if (amount === null || amount === 0) continue

    const payee = String(cells[1] ?? '').replace(/\s+/g, ' ').trim()
    const desc = String(cells[2] ?? '').replace(/\s+/g, ' ').trim()
    rows.push({ date, amount, description: desc || payee, reference: '', reconciled: false })
  }
  if (rows.length === 0) return null
  return { rows: assignOrdinals(rows), warnings }
}

// Sync-input shape, csv: namespace. MONEY-OUT ONLY (Richard,
// 2026-07-04) and unreconciled-only — but keys are minted over the
// ordinal-assigned FULL set passed in, so identity survives rows
// flipping to reconciled between uploads.
export function csvLineRows(bankAccountId, rows) {
  return rows
    .filter((r) => !r.reconciled && r.amount < 0)
    .map((r) => ({
      key: `csv:${computeLineKey(bankAccountId, r)}`,
      date: r.date,
      amount: r.amount,
      description: r.description,
      reference: r.reference,
    }))
}

// Keys of money-out rows the CSV reports as ALREADY reconciled — the
// import marks matching tracked csv: lines covered.
export function csvReconciledKeys(bankAccountId, rows) {
  return rows
    .filter((r) => r.reconciled && r.amount < 0)
    .map((r) => `csv:${computeLineKey(bankAccountId, r)}`)
}
