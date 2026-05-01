// DEPRECATED — superseded by src/lib/xero/bills-email.js.
//
// The original Files API approach (POST PDF to Xero's Files Inbox
// folder) required the operator to flip the per-org "Convert files
// to bills" toggle in Xero Files settings before anything got
// auto-billed. The new path uses Xero's documented per-org
// Email-to-Bills address (UI: Bills to pay → Create bill from
// email) — works on every Xero org by default with no toggle.
//
// Nothing imports this file any more. Kept as a marker so anyone
// looking for the old upload path lands here and sees the redirect.
