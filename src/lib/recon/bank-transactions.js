// src/lib/recon/bank-transactions.js
//
// RCOV hotfix 2026-07-04 — the coverage pull's data source moved from
// GET /Reports/BankStatement to GET /BankTransactions. Why: Xero's
// granular-scope migration RETIRED the broad 'accounting.reports.read'
// scope (the granular reports.* set has NO bank-statement scope at
// all), and requesting a retired scope breaks the AUTHORIZE step
// outright — operators hit Xero's "Sorry, something went wrong" page
// and can never (re)connect.
//
// KNOWN LIMITATION of this source (documented in the spec): imported
// statement lines that nobody has actioned yet are NOT BankTransactions
// and are invisible here. Coverage tracks unreconciled spend/receive
// transactions instead. Candidate upgrade: the Xero Finance API's
// BankStatementsPlus endpoint (scope finance.bankstatementsplus.read)
// serves true statement lines — verify its scope validity and
// availability BEFORE requesting it (tonight's lesson: an unverified
// scope string bricks the whole connect flow).
//
// UPSIDE of this source: BankTransactionID is a stable Xero identity,
// so line keys are `bt:<id>` — none of the hash/ordinal drift
// machinery the report path needed applies to these rows.

// '/Date(1783036800000+0000)/' → ms. Xero emits DateString (ISO) on
// current API versions; the legacy form is parsed as a fallback.
function msDateToIso(raw) {
  const m = String(raw || '').match(/\/Date\((\d+)/)
  if (!m) return ''
  return new Date(Number(m[1])).toISOString()
}

export function mapBankTransactions(payload) {
  const txns = payload?.BankTransactions
  if (!Array.isArray(txns)) return []
  const out = []
  for (const bt of txns) {
    if (!bt?.BankTransactionID) continue
    if (bt.Status !== 'AUTHORISED') continue // DELETED etc.
    const total = Number(bt.Total)
    if (!Number.isFinite(total)) continue
    const dateIso = bt.DateString || msDateToIso(bt.Date)
    const date = String(dateIso).slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    // Type families: SPEND / SPEND-OVERPAYMENT / SPEND-PREPAYMENT are
    // money out (negative, matching the report path's sign convention);
    // RECEIVE* are money in.
    const sign = String(bt.Type || '').startsWith('RECEIVE') ? 1 : -1
    out.push({
      id: bt.BankTransactionID,
      date,
      amount: sign * total,
      description: bt.Contact?.Name || bt.LineItems?.[0]?.Description || '',
      reference: bt.Reference || '',
      reconciled: bt.IsReconciled === true,
    })
  }
  return out
}

// Sync-input shape for coverage.syncBankLines. Keys are stable Xero
// ids — no per-pull recomputation, immune to description/order drift.
//
// MONEY-OUT ONLY (Richard, 2026-07-04): coverage is a receipts-for-
// spend ledger — inbound money (member payments, merchant settlements)
// is out of scope and was drowning the board (75 of the probe's 83
// lines were Revolut Merchant settlements). Inbound rows are still
// MAPPED (the zero-rows tripwire counts the raw fetch) — just never
// become tracked lines.
export function bankTransactionLines(rows) {
  return rows
    .filter((r) => !r.reconciled && r.amount < 0)
    .map((r) => ({
      key: `bt:${r.id}`,
      date: r.date,
      amount: r.amount,
      description: r.description,
      reference: r.reference,
    }))
}
