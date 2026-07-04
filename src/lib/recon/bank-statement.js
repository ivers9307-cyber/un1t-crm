// src/lib/recon/bank-statement.js
//
// RCOV.P0 — parse Xero's GET /Reports/BankStatement payload into
// normalized statement-line rows, and mint stable identity keys so a
// line can be tracked across weekly pulls. Statement lines have no ID
// in the report, so identity = sha256 of
//   accountId | date | amount (2dp) | normalized description | ordinal
// where "normalized" = whitespace-collapsed, trimmed, uppercased —
// bank feeds drift case/spacing between pulls and the key must not.
// Reference is deliberately NOT part of the key (noisy across bank
// feed re-imports). Parsed rows keep the raw trimmed description for
// display; normalization applies to identity only.
import { createHash } from 'crypto'

// Rows whose Description is a balance marker are report furniture, not
// transactions. Xero also leaves Amount empty on them.
const BALANCE_ROWS = new Set(['opening balance', 'closing balance'])

// Canonical description form for IDENTITY ONLY (rows keep the raw
// trimmed text for display): collapse whitespace runs, trim, uppercase.
const keyDescription = (d) => String(d ?? '').replace(/\s+/g, ' ').trim().toUpperCase()

// The one canonical identity tuple, shared by assignOrdinals and
// computeLineKey so the two can never disagree on what "identical" means
// (same amount form, same normalized description).
const identityTuple = (r) => `${r.date}|${Number(r.amount).toFixed(2)}|${keyDescription(r.description)}`

export function parseBankStatementReport(payload) {
  const report = payload?.Reports?.[0]
  if (!report?.Rows) return []

  const headerRow = report.Rows.find((r) => r.RowType === 'Header')
  if (!headerRow?.Cells) return []
  const col = {}
  headerRow.Cells.forEach((c, i) => { col[String(c.Value || '').trim().toLowerCase()] = i })
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
        // No Reconciled column ⇒ reconciled:false on every row — intentional:
        // fail toward "this line still needs a receipt", never silently drop.
        reconciled: cell('reconciled').toLowerCase() === 'yes',
        amount,
      })
    }
  }
  return out
}

// Identical identity tuples in one pull get 0,1,2… in report order.
//
// CONTRACT: call this on the FULL parsed report rows (reconciled AND
// unreconciled) BEFORE any reconciled filter. The Bank Statement report
// keeps reconciled lines in its output, so numbering over the full set
// keeps a surviving duplicate's ordinal stable when its sibling
// reconciles between pulls; numbering after filtering would renumber
// the survivor and change its key.
//
// LOAD-BEARING ASSUMPTION: the report preserves the within-day order of
// identical tuples across pulls (observed: report order is stable /
// chronological). If Xero ever reordered same-day identical lines
// between pulls, the duplicates' keys would swap.
export function assignOrdinals(rows) {
  const seen = new Map()
  return rows.map((r) => {
    const tuple = identityTuple(r)
    const ordinal = seen.get(tuple) ?? 0
    seen.set(tuple, ordinal + 1)
    return { ...r, ordinal }
  })
}

export function computeLineKey(bankAccountId, line) {
  return createHash('sha256')
    .update(`${bankAccountId}|${identityTuple(line)}|${line.ordinal}`)
    .digest('hex')
}
