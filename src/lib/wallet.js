// INTEG-C2a — per-location prepaid usage wallet helpers
// (wallets / wallet_transactions + wallet_apply RPC, mig 420).
//
// The wallet is a MONTHLY USAGE BUDGET, not stored value: the balance
// resets to zero at the start of each billing month and unused credit
// expires via an explicit 'expiry_reset' ledger entry posted by the
// wallet-monthly-reset cron. wallet_apply() in the DB is the ONLY
// write path — balance_cents is never edited directly, and the ledger
// is append-only.
//
// BILLING-MONTH ASSUMPTION (v1): billing month = Dublin CALENDAR
// month (period boundaries are the 1st, per dublinTodayStr()
// conventions). When the Stripe top-up leg lands and subscriptions
// get real billing anchors, the wallets/billing track revisits this —
// nextPeriodStart/currentPeriodStart/shouldReset are the only places
// that encode it.
//
// Participation: only locations with an ACTIVE tier pinning in
// location_plans (getLocationPlan() !== null) are touched by the
// reset cron; unpinned locations — every UN1T location today — are
// skipped by everything.
//
// Pure parts (currentPeriodStart, nextPeriodStart, shouldReset) are
// exported for unit tests; DB access goes through an injected service
// client so route handlers stay the only place that constructs one.

import { dublinTodayStr } from '@/lib/dublin-time'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function assertDateStr(value, label) {
  const s = String(value)
  if (!DATE_RE.test(s)) throw new Error(`${label}: expected YYYY-MM-DD, got ${value}`)
  return s
}

/**
 * Pure: first day of the billing period containing a date.
 * Billing month = Dublin calendar month (v1 — see header).
 *
 * @param {string} dateStr - 'YYYY-MM-DD' (Dublin business date — use
 *   dublinTodayStr() for "today", never a UTC-derived date string)
 * @returns {string} 'YYYY-MM-01'
 */
export function currentPeriodStart(dateStr) {
  return assertDateStr(dateStr, 'currentPeriodStart').slice(0, 7) + '-01'
}

/**
 * Pure: first day of the billing period AFTER the one containing a
 * date. Pure string math — no Date parsing, no timezone involvement
 * (the input/output are timezoneless calendar dates).
 *
 * @param {string} dateStr - 'YYYY-MM-DD'
 * @returns {string} 'YYYY-MM-01' of the following month
 */
export function nextPeriodStart(dateStr) {
  const s = assertDateStr(dateStr, 'nextPeriodStart')
  const y = Number(s.slice(0, 4))
  const m = Number(s.slice(5, 7))
  const ny = m === 12 ? y + 1 : y
  const nm = m === 12 ? 1 : m + 1
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-01`
}

/**
 * Pure: has this wallet crossed a billing-period boundary (so the
 * reset cron must act on it)?
 *
 * True when period_start is missing (never initialised) or belongs to
 * an EARLIER period than today's — which is exactly what makes missed
 * cron days self-healing: a wallet whose period_start is stale past a
 * boundary keeps answering true until the cron advances it, and a
 * same-day rerun (period_start already == this period) answers false.
 *
 * @param {{ period_start?: string|null }|null} wallet
 * @param {string} [todayDublin] - 'YYYY-MM-DD'; defaults to the Dublin
 *   business today (repo TZ convention — see CLAUDE.md)
 * @returns {boolean}
 */
export function shouldReset(wallet, todayDublin = dublinTodayStr()) {
  if (!wallet) return false
  if (!wallet.period_start) return true
  return String(wallet.period_start) < currentPeriodStart(todayDublin)
}

/**
 * Post a wallet ledger entry via the atomic wallet_apply RPC — the
 * ONLY write path for wallet balances (row lock + ledger insert +
 * balance update in one transaction; -1000-cent grace floor enforced
 * in the function AND by the table CHECK).
 *
 * Kind semantics (validated again in SQL):
 *   topup        amountCents required, positive
 *   draw         amountCents required, negative (signed)
 *   adjustment   amountCents required, non-zero
 *   expiry_reset amountCents IGNORED — the RPC computes -balance
 *                under the row lock so the balance lands on exactly
 *                0; a wallet already at 0 is a no-op (returns 0, no
 *                ledger row).
 *
 * Throws on RPC error — callers on cron/fan-out paths wrap in their
 * own try/catch (supabase builders are thenables with no .catch;
 * awaiting inside try/catch is the safe pattern per CLAUDE.md).
 *
 * @param {object} db - service-role client
 * @param {object} entry
 * @param {string} entry.locationId
 * @param {'topup'|'draw'|'adjustment'|'expiry_reset'} entry.kind
 * @param {number|null} [entry.amountCents] - signed EUR cents
 * @param {string|null} [entry.meter] - draws: the billing meter drawn
 * @param {number|null} [entry.qty] - draws: units drawn
 * @param {number|null} [entry.unitRateCents] - draws: overage rate applied
 * @param {string|null} [entry.invoiceRef] - top-ups: the VAT invoice ref (deferred leg)
 * @param {string|null} [entry.note]
 * @param {string|null} [entry.createdBy] - profile id for operator-initiated entries
 * @returns {Promise<number>} the new balance in cents
 */
export async function applyWalletEntry(db, {
  locationId,
  kind,
  amountCents = null,
  meter = null,
  qty = null,
  unitRateCents = null,
  invoiceRef = null,
  note = null,
  createdBy = null,
} = {}) {
  if (!locationId) throw new Error('applyWalletEntry: locationId is required')
  if (!kind) throw new Error('applyWalletEntry: kind is required')
  if (kind !== 'expiry_reset' && !Number.isInteger(amountCents)) {
    throw new Error(`applyWalletEntry: integer amountCents is required for kind ${kind}`)
  }

  const { data, error } = await db.rpc('wallet_apply', {
    p_location_id: locationId,
    p_kind: kind,
    p_amount_cents: kind === 'expiry_reset' ? null : amountCents,
    p_meter: meter,
    p_qty: qty,
    p_unit_rate_cents: unitRateCents,
    p_invoice_ref: invoiceRef,
    p_note: note,
    p_created_by: createdBy,
  })
  if (error) throw new Error(`applyWalletEntry: ${error.message}`)
  return data
}

/**
 * Fetch a location's wallet row, or null when it has none yet (no
 * wallet row is the normal state — wallet_apply creates it lazily on
 * the first ledger entry).
 *
 * @param {object} db - service-role client
 * @param {string} locationId
 * @returns {Promise<object|null>}
 */
export async function getWallet(db, locationId) {
  if (!locationId) throw new Error('getWallet: locationId is required')
  const { data, error } = await db
    .from('wallets')
    .select('*')
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) throw new Error(`getWallet: ${error.message}`)
  return data || null
}
