// src/lib/recon/statement-lines.js
//
// RCOV source upgrade 2026-07-04 — the coverage pull's data source is
// the Xero Finance API's BankStatementsPlus endpoint:
//
//   GET https://api.xero.com/finance.xro/1.0/BankStatementsPlus/statements
//       ?BankAccountID=&FromDate=&ToDate=&SummaryOnly=false
//   scope: finance.bankstatementsplus.read
//
// ⛔ INACTIVE — ENTITLEMENT-GATED (2026-07-04, same day it shipped).
// The scope string is real (verified in xero-finance.yaml), but the
// Finance API is restricted to Xero-approved apps (lending use-cases):
// our app's authorize failed live with "invalid_scope / Error code:
// 500" and the scope was reverted (see scopes.test.js, which now pins
// finance.* as forbidden). Lesson upgraded: verify ENTITLEMENT, not
// just spec-existence.
//
// Why this file stays: it serves TRUE bank statement lines — including
// imported feed lines nobody has actioned yet, which are invisible to
// GET /BankTransactions (the active source, bank-transactions.js).
// Each line carries a stable statementLineId and an isReconciled
// boolean — exactly the reconcile screen's work-list. If Xero ever
// grants this app Finance API access, re-adding the scope and swapping
// pull.js back to this mapper is the whole job (PR #802 has the diff).

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
