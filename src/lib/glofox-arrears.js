// Arrears reconciliation — find Glofox invoices that are CURRENTLY still
// unpaid and predate webhook coverage (~12 May 2026), so the invoice-driven
// Overdue feature stops understating balances.
//
// Background: glofox_invoices is fed by the INVOICE_UPDATED webhook (live
// ~mid-May) + a one-time 2026-05-12 backfill that loaded PAID invoices only.
// So any invoice that went past-due in Jan–Apr is invisible. The Glofox
// /Analytics/report (TransactionsList) carries the full transaction history
// back to Jan; this module turns that into a list of missing PAST_DUE rows.
//
// Verified against live data (2026-06-14):
//  - Each row is a typed envelope, e.g. { StripeCharge: { ...fields } }.
//  - PAID charges carry `amount` (euros); FAILED charges carry amount:0 +
//    `failed_amount` (euros). 1144 euros → 114400 cents in glofox_invoices.
//  - A renewal that failed-then-paid shows BOTH a failed and a paid txn under
//    the SAME invoice_id → group by invoice_id, "any settled txn ⇒ settled".
//  - invoice_id is the same identifier as glofox_invoices.id (UUID), so a
//    later webhook upsert dedupes cleanly against a backfilled row.
//
// Pure function (no IO) so it's unit-testable; the route fetches the report +
// the set of invoice ids already in glofox_invoices and feeds them in.

function unwrap(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return { type: '(non-object)', t: {} }
  }
  const keys = Object.keys(row)
  if (
    keys.length === 1 &&
    row[keys[0]] &&
    typeof row[keys[0]] === 'object' &&
    !Array.isArray(row[keys[0]])
  ) {
    return { type: keys[0], t: row[keys[0]] }
  }
  return { type: '(flat)', t: row }
}

// A transaction marks its invoice as settled when it succeeded — directly
// (paid/status), or because Glofox flagged a later attempt as already_paid.
function isSettledTxn(t) {
  return (
    t?.paid === true ||
    t?.status === 'paid' ||
    t?.transaction_status === 'PAID' ||
    t?.metadata?.already_paid === true
  )
}

function isForgivenTxn(t) {
  return (
    t?.status === 'forgiven' ||
    t?.transaction_status === 'FORGIVEN' ||
    t?.metadata?.is_forgiven === true
  )
}

// Euros owed on a single transaction. Paid charges carry `amount`; failed
// charges carry `failed_amount` with amount:0.
function txEuros(t) {
  const amt = Number(t?.amount)
  if (Number.isFinite(amt) && amt > 0) return amt
  const failed = Number(t?.failed_amount)
  if (Number.isFinite(failed) && failed > 0) return failed
  return 0
}

function parseCreatedMs(s) {
  if (!s) return NaN
  // Glofox 'created' looks like '2026-06-14 17:27:51' (no TZ). Date.parse is
  // engine-local; good enough for a coarse before-cutoff + ordering. We only
  // store it as an approximate invoice_date anyway.
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : NaN
}

/**
 * @param {Array} details  TransactionsList.details from the Glofox report
 * @param {{ existingInvoiceIds?: Set<string>|string[], beforeDate?: string }} [opts]
 *   existingInvoiceIds — invoice ids already in glofox_invoices (skip these)
 *   beforeDate — ISO date; only invoices first seen strictly before this are candidates
 */
export function computeArrears(details, opts = {}) {
  const list = Array.isArray(details) ? details : []
  const existing =
    opts.existingInvoiceIds instanceof Set
      ? opts.existingInvoiceIds
      : new Set(opts.existingInvoiceIds || [])
  const beforeMs = opts.beforeDate ? Date.parse(opts.beforeDate) : null

  const taxonomy = { envelopeTypes: {}, events: {}, statuses: {} }
  const groups = new Map() // invoice_id -> { invoiceId, txns: [] }

  for (const row of list) {
    const { type, t } = unwrap(row)
    taxonomy.envelopeTypes[type] = (taxonomy.envelopeTypes[type] || 0) + 1
    const ev = t?.metadata?.glofox_event
    if (ev != null) taxonomy.events[ev] = (taxonomy.events[ev] || 0) + 1
    const st = t?.status ?? t?.transaction_status
    if (st != null) taxonomy.statuses[st] = (taxonomy.statuses[st] || 0) + 1

    const invId = t?.invoice_id
    if (!invId) continue
    if (!groups.has(invId)) groups.set(invId, { invoiceId: invId, txns: [] })
    groups.get(invId).txns.push(t)
  }

  const candidates = []
  const warnings = []
  let paidInvoices = 0
  let unpaidInvoices = 0
  let forgivenInvoices = 0
  let skippedAlreadyPresent = 0
  let skippedNoAmount = 0
  let skippedByDate = 0

  for (const g of groups.values()) {
    if (g.txns.some(isForgivenTxn)) {
      forgivenInvoices++
      continue
    }
    if (g.txns.some(isSettledTxn)) {
      paidInvoices++
      continue
    }
    unpaidInvoices++

    const owedEuros = g.txns.reduce((max, t) => Math.max(max, txEuros(t)), 0)
    if (owedEuros <= 0) {
      skippedNoAmount++
      warnings.push(`invoice ${g.invoiceId} is unpaid but carries no recoverable amount`)
      continue
    }
    if (existing.has(g.invoiceId)) {
      skippedAlreadyPresent++
      continue
    }

    const createdMsList = g.txns.map((t) => parseCreatedMs(t?.created)).filter(Number.isFinite)
    const earliestMs = createdMsList.length ? Math.min(...createdMsList) : NaN
    if (beforeMs != null && Number.isFinite(earliestMs) && earliestMs >= beforeMs) {
      skippedByDate++
      continue
    }

    // Representative txn for display metadata = the most recent attempt.
    const repr = g.txns.reduce((a, b) =>
      (parseCreatedMs(b?.created) || 0) > (parseCreatedMs(a?.created) || 0) ? b : a,
    )

    candidates.push({
      invoiceId: g.invoiceId,
      glofoxUserId: repr?.metadata?.user_id ?? null,
      userName: repr?.metadata?.user_name ?? null,
      amountCents: Math.round(owedEuros * 100),
      currency: repr?.currency || 'eur',
      status: 'PAST_DUE',
      invoiceDate: Number.isFinite(earliestMs) ? new Date(earliestMs).toISOString() : null,
      description: repr?.description ?? null,
      paymentMethod: repr?.metadata?.payment_method ?? null,
      glofoxEvent: repr?.metadata?.glofox_event ?? null,
      attempts: g.txns.length,
    })
  }

  candidates.sort((a, b) => b.amountCents - a.amountCents)

  // Roll up by member and by event so the dry-run is reviewable at a glance.
  const memberMap = new Map()
  const eventMap = {}
  for (const c of candidates) {
    const k = c.glofoxUserId || '(none)'
    if (!memberMap.has(k)) {
      memberMap.set(k, { glofoxUserId: c.glofoxUserId, userName: c.userName, invoices: 0, amountCents: 0 })
    }
    const m = memberMap.get(k)
    m.invoices++
    m.amountCents += c.amountCents
    const ev = c.glofoxEvent || '(none)'
    if (!eventMap[ev]) eventMap[ev] = { invoices: 0, amountCents: 0 }
    eventMap[ev].invoices++
    eventMap[ev].amountCents += c.amountCents
  }
  const byMember = Array.from(memberMap.values()).sort((a, b) => b.amountCents - a.amountCents)
  const candidateArrearsCents = candidates.reduce((s, c) => s + c.amountCents, 0)

  return {
    totals: {
      transactions: list.length,
      invoices: groups.size,
      paidInvoices,
      unpaidInvoices,
      forgivenInvoices,
      candidates: candidates.length,
      skippedAlreadyPresent,
      skippedNoAmount,
      skippedByDate,
    },
    taxonomy,
    candidatesByEvent: eventMap,
    candidateArrearsCents,
    candidates,
    byMember,
    warnings,
  }
}
