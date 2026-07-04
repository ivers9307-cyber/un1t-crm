// src/lib/recon/statement-lines.js
//
// RCOV source upgrade 2026-07-04 — the coverage pull's data source is
// the Xero Finance API's BankStatementsPlus endpoint:
//
//   GET https://api.xero.com/finance.xro/1.0/BankStatementsPlus/statements
//       ?BankAccountID=&FromDate=&ToDate=&SummaryOnly=false
//   scope: finance.bankstatementsplus.read
//
// Endpoint, scope string and field names were verified against Xero's
// own OpenAPI spec (XeroAPI/Xero-OpenAPI, xero-finance.yaml) BEFORE
// requesting the scope — an unverified scope string bricks the whole
// authorize step (the accounting.reports.read incident).
//
// Why this source: it serves TRUE bank statement lines — including
// imported feed lines nobody has actioned yet, which are invisible to
// GET /BankTransactions (Richard hit this: Revolut EUR Main showed 2
// lines on the board vs more in Xero's reconcile screen). Each line
// carries a stable statementLineId and an isReconciled boolean, so
// this is exactly the reconcile screen's work-list.
//
// The previous /BankTransactions source (bank-transactions.js) is kept
// but inactive until this source is probe-proven on the real org.

export function mapStatementLines(payload) {
  const statements = payload?.statements
  if (!Array.isArray(statements)) return []
  const out = []
  for (const st of statements) {
    const lines = Array.isArray(st?.statementLines) ? st.statementLines : []
    for (const sl of lines) {
      if (!sl?.statementLineId) continue
      if (sl.isDeleted === true) continue
      const amount = Number(sl.amount)
      if (!Number.isFinite(amount)) continue
      const date = String(sl.postedDate || '').slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      // On a bank statement, DEBIT = money out of the account.
      const sign = String(sl.type || '').toUpperCase() === 'CREDIT' ? 1 : -1
      out.push({
        id: sl.statementLineId,
        date,
        amount: sign * Math.abs(amount),
        description: sl.payee || '',
        reference: sl.reference || '',
        reconciled: sl.isReconciled === true,
      })
    }
  }
  return out
}

// Sync-input shape for coverage.syncBankLines. Keys are stable Xero
// statement-line ids — immune to description/order drift.
//
// MONEY-OUT ONLY (Richard, 2026-07-04): coverage is a receipts-for-
// spend ledger — inbound money never becomes a tracked line. Inbound
// and reconciled rows are still MAPPED above (the zero-rows tripwire
// counts the raw fetch) — just filtered out here.
export function statementLineRows(rows) {
  return rows
    .filter((r) => !r.reconciled && r.amount < 0)
    .map((r) => ({
      key: `sl:${r.id}`,
      date: r.date,
      amount: r.amount,
      description: r.description,
      reference: r.reference,
    }))
}
