// ACCOUNTING-HUB.1 — pure routing for the mobile Accounting hub.
//
// One "Accounting" tile in the More grid nests the money surfaces; it
// routes by access level (same flow as the Reports hub):
//
//   canExpenses      — own expense receipts             (FTE: `expenses`)
//   canInvoices      — own invoice submissions           (contractor: `invoices`)
//   canInbox         — supplier-invoice approver inbox    (owner/master: `invoices_inbox`)
//   canCardReceipts  — company-card receipts (SPEND.P3)   (card holders: `card_receipts`)
//   canOrders        — revenue ledger / orders            (manager+: `orders`)
//
// 0 surfaces → null (the tile is access-gated so this shouldn't render)
// 1 surface  → that surface's key (go straight there)
// 2+         → 'chooser' (show the picker)
// Pure — unit-tested in CI.

export function accountingLanding({ canExpenses, canInvoices, canInbox, canCardReceipts, canOrders } = {}) {
  const available = [
    canExpenses ? 'expenses' : null,
    canInvoices ? 'invoices' : null,
    canInbox ? 'inbox' : null,
    canCardReceipts ? 'card_receipts' : null,
    canOrders ? 'orders' : null,
  ].filter(Boolean)
  if (available.length === 0) return null
  if (available.length === 1) return available[0]
  return 'chooser'
}

// Landing key → route. The single-surface keys reuse the exact routes
// the old standalone tiles pushed, so the destination screens are
// untouched; 'chooser' opens the hub itself.
export const ACCOUNTING_ROUTES = Object.freeze({
  expenses: '/expenses',
  invoices: '/invoices',
  inbox: '/invoices/inbox',
  card_receipts: '/card-receipts',
  orders: '/orders',
  chooser: '/accounting',
})
