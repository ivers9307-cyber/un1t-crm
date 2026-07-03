// src/lib/recon/bank-statement.js
//
// RCOV.P0 — parse Xero's GET /Reports/BankStatement payload into
// normalized statement-line rows, and mint stable identity keys so a
// line can be tracked across weekly pulls. Statement lines have no ID
// in the report, so identity = sha256 of the tuple + an ordinal that
// disambiguates identical same-day duplicates.
import { createHash } from 'crypto'

// Rows whose Description is a balance marker are report furniture, not
// transactions. Xero also leaves Amount empty on them.
const BALANCE_ROWS = new Set(['opening balance', 'closing balance'])

export function parseBankStatementReport(payload) {
  const report = payload?.Reports?.[0]
  if (!report?.Rows) return []

  const headerRow = report.Rows.find((r) => r.RowType === 'Header')
  if (!headerRow?.Cells) return []
  const col = {}
  headerRow.Cells.forEach((c, i) => { col[String(c.Value || '').toLowerCase()] = i })
  if (col.date === undefined || col.amount === undefined) return []

  const out = []
  for (const section of report.Rows) {
    if (section.RowType !== 'Section' || !Array.isArray(section.Rows)) continue
    for (const row of section.Rows) {
      if (row.RowType !== 'Row' || !Array.isArray(row.Cells)) continue
      const cell = (name) => String(row.Cells[col[name]]?.Value ?? '').trim()
      const description = cell('description')
      if (BALANCE_ROWS.has(description.toLowerCase())) continue
      const amountRaw = cell('amount')
      if (amountRaw === '') continue
      const amount = Number(amountRaw)
      if (!Number.isFinite(amount)) continue
      out.push({
        date: cell('date').slice(0, 10),
        description,
        reference: col.reference !== undefined ? cell('reference') : '',
        reconciled: cell('reconciled').toLowerCase() === 'yes',
        amount,
      })
    }
  }
  return out
}

// Identical (date, amount, description) tuples in one pull get 0,1,2…
// in report order, so two same-day identical card taps stay distinct
// AND keep the same key next week (report order is chronological).
export function assignOrdinals(rows) {
  const seen = new Map()
  return rows.map((r) => {
    const tuple = `${r.date}|${r.amount}|${r.description}`
    const ordinal = seen.get(tuple) ?? 0
    seen.set(tuple, ordinal + 1)
    return { ...r, ordinal }
  })
}

export function computeLineKey(bankAccountId, { date, amount, description, ordinal }) {
  return createHash('sha256')
    .update(`${bankAccountId}|${date}|${Number(amount).toFixed(2)}|${description}|${ordinal}`)
    .digest('hex')
}
