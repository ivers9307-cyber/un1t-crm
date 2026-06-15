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

// ── ARREARS-NETTING.1 — cross-invoice-id payment-retry netting ─────────
// Glofox issues a NEW invoice id per payment ATTEMPT for one-off purchases
// (class packs, single-class fees, signup upfront fees). When a card fails
// then succeeds, the failed attempts orphan as PAST_DUE rows under their own
// invoice ids while the success is a separate PAID row under yet another id.
// Glofox's own profile nets the purchase to €0, but anything keying on
// invoice_id counts each orphaned PAST_DUE as real arrears. The signal that
// a PAST_DUE row is a settled retry: the SAME member has a PAID row of the
// SAME amount within a few days. Concrete confirmed case (Fran Martin,
// 27 May): 2× €25 PAST_DUE at 10:36 + 1× €25 PAID at 10:40, three invoice
// ids, one purchase.

// Default match window — ±1 day. Cross-invoice-id retries (a one-off purchase
// whose card failed then succeeded under a NEW invoice id) happen in a single
// checkout session — minutes apart, same day (every confirmed case settled
// within ~4 min). Keep this TIGHT: a looser window risks netting a GENUINE
// separate same-amount debt for regular same-price buyers (e.g. a weekly €25
// class-pack buyer who truly missed one payment), and a known false match
// (Tara Diggin) sat exactly 48h away. Multi-day subscription dunning REUSES one
// invoice id, so it never produces the cross-id orphans this is here to net.
export const RETRY_NET_WINDOW_DAYS = 1
const RETRY_NET_WINDOW_MS = RETRY_NET_WINDOW_DAYS * 86_400_000

/**
 * Net cross-invoice-id payment retries out of a set of unpaid `glofox_invoices`
 * rows. A PAST_DUE row is a SETTLED RETRY — and excluded — when the same
 * member (`glofox_user_id`) has a PAID `glofox_invoices` row of the same
 * `amount_cents` within ±`windowDays` of the PAST_DUE row's `invoice_date`.
 *
 * PAID rows are consumed one-to-one so two identical failed attempts aren't
 * both netted away by a single success (a member who genuinely owes for one
 * of two same-amount purchases still surfaces).
 *
 * Pure: no I/O. Shared by the live Overdue feature (churn-radar-data's
 * fetchPastDue) so the radar list + total exclude settled retries, and the
 * same retry-netting concept backs `computeArrears` (which works off the
 * Glofox report's euro amounts rather than `amount_cents`).
 *
 * @param {Array<{id:string, glofox_user_id?:string|null, amount_cents:number, invoice_date?:string|null}>} pastDueRows
 * @param {Array<{glofox_user_id?:string|null, amount_cents:number, invoice_date?:string|null}>} paidRows
 * @param {{ windowDays?: number }} [opts]
 * @returns {{ kept: Array, nettedIds: Set<string> }}
 *   kept — the PAST_DUE rows that are NOT settled retries (order preserved)
 *   nettedIds — ids of the PAST_DUE rows excluded as settled retries
 */
export function nettedOutByRetry(pastDueRows, paidRows, opts = {}) {
  const windowMs =
    Number.isFinite(opts.windowDays) && opts.windowDays > 0
      ? opts.windowDays * 86_400_000
      : RETRY_NET_WINDOW_MS

  // Index the PAID rows by (member, amount_cents) → list of timestamps, each
  // with a `used` flag so a PAID row settles at most one PAST_DUE row.
  const paidIndex = new Map() // key -> [{ ms, used }]
  for (const p of Array.isArray(paidRows) ? paidRows : []) {
    const member = p?.glofox_user_id
    const cents = Number(p?.amount_cents)
    if (member == null || member === '' || !Number.isFinite(cents)) continue
    const key = `${member}|${cents}`
    const ms = Date.parse(p?.invoice_date)
    if (!Number.isFinite(ms)) continue
    if (!paidIndex.has(key)) paidIndex.set(key, [])
    paidIndex.get(key).push({ ms, used: false })
  }

  const kept = []
  const nettedIds = new Set()
  for (const pd of Array.isArray(pastDueRows) ? pastDueRows : []) {
    const member = pd?.glofox_user_id
    const cents = Number(pd?.amount_cents)
    const dueMs = Date.parse(pd?.invoice_date)
    let settled = false
    if (member != null && member !== '' && Number.isFinite(cents) && Number.isFinite(dueMs)) {
      const candidates = paidIndex.get(`${member}|${cents}`)
      if (candidates) {
        // Prefer the closest unused PAID match within the window.
        let best = null
        for (const c of candidates) {
          if (c.used) continue
          const delta = Math.abs(c.ms - dueMs)
          if (delta <= windowMs && (best === null || delta < best.delta)) {
            best = { ref: c, delta }
          }
        }
        if (best) {
          best.ref.used = true
          settled = true
        }
      }
    }
    if (settled) nettedIds.add(pd.id)
    else kept.push(pd)
  }
  return { kept, nettedIds }
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

  // ARREARS-NETTING.1 — index every SETTLED transaction across the WHOLE
  // report by (user_id, euros) so a failed attempt can be matched against a
  // same-amount success that landed under a DIFFERENT invoice_id (Glofox's
  // per-attempt-invoice behaviour for one-off purchases). Each entry carries
  // a `used` flag so one success settles at most one failed attempt.
  const settledIndex = new Map() // `${user_id}|${euros}` -> [{ ms, used }]

  for (const row of list) {
    const { type, t } = unwrap(row)
    taxonomy.envelopeTypes[type] = (taxonomy.envelopeTypes[type] || 0) + 1
    const ev = t?.metadata?.glofox_event
    if (ev != null) taxonomy.events[ev] = (taxonomy.events[ev] || 0) + 1
    const st = t?.status ?? t?.transaction_status
    if (st != null) taxonomy.statuses[st] = (taxonomy.statuses[st] || 0) + 1

    if (isSettledTxn(t)) {
      const member = t?.metadata?.user_id
      const euros = txEuros(t)
      const ms = parseCreatedMs(t?.created)
      if (member != null && member !== '' && euros > 0 && Number.isFinite(ms)) {
        const key = `${member}|${euros}`
        if (!settledIndex.has(key)) settledIndex.set(key, [])
        settledIndex.get(key).push({ ms, used: false })
      }
    }

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
  let skippedSettledRetry = 0

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

    // ARREARS-NETTING.1 — a settled retry: this member has a same-amount
    // SUCCESS within ±RETRY_NET_WINDOW_DAYS of this attempt, under a different
    // invoice_id. Glofox's own profile nets the purchase to €0, so the
    // orphaned PAST_DUE attempt is not real arrears. Consume the matching
    // success one-to-one so two genuine same-amount failures don't both net
    // against a single payment.
    const member = g.txns.find((t) => t?.metadata?.user_id != null)?.metadata?.user_id ?? null
    if (member != null && member !== '') {
      const candidatesPaid = settledIndex.get(`${member}|${owedEuros}`)
      if (candidatesPaid && candidatesPaid.length) {
        // Match against the attempt closest in time (any attempt in the group).
        let best = null
        for (const c of candidatesPaid) {
          if (c.used) continue
          let nearest = Infinity
          for (const am of createdMsList) {
            const d = Math.abs(c.ms - am)
            if (d < nearest) nearest = d
          }
          if (!Number.isFinite(nearest)) continue
          if (nearest <= RETRY_NET_WINDOW_MS && (best === null || nearest < best.delta)) {
            best = { ref: c, delta: nearest }
          }
        }
        if (best) {
          best.ref.used = true
          skippedSettledRetry++
          continue
        }
      }
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
      skippedSettledRetry,
    },
    taxonomy,
    candidatesByEvent: eventMap,
    candidateArrearsCents,
    candidates,
    byMember,
    warnings,
  }
}
