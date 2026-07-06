// src/lib/xero/aged-payables.js
//
// Aged payables = who we owe and how overdue. Sourced from Xero
// unpaid supplier bills (GET /Invoices, Type ACCPAY, Status AUTHORISED)
// rather than the AgedPayablesByContact report: the report is strictly
// per-contact (contactID is mandatory) so a whole-supplier view means
// N calls, whereas the invoices endpoint returns the full unpaid list
// in one paginated pass with the line-level detail we actually want
// (AmountDue + DueDate). Scope: accounting.invoices (already held) —
// NOT the aged-reports scope.
//
// Pure functions only; the fetch/pagination lives in the route.

// Xero emits DateString (ISO) on current API versions; '/Date(ms+off)/'
// is the legacy fallback. Returns 'yyyy-mm-dd' or ''.
function toDateStr(dateString, legacy) {
  const iso = dateString || ''
  if (/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso.slice(0, 10)
  const m = String(legacy || '').match(/\/Date\((\d+)/)
  if (!m) return ''
  return new Date(Number(m[1])).toISOString().slice(0, 10)
}

// One Xero /Invoices page payload → normalized unpaid-bill rows. Keeps
// only AUTHORISED ACCPAY bills with a positive AmountDue (a PAID bill
// is Status PAID and excluded server-side; guard AmountDue>0 anyway so
// a fully-allocated-but-still-AUTHORISED edge never shows as owed).
export function mapPayableInvoices(payload) {
  const invoices = payload?.Invoices
  if (!Array.isArray(invoices)) return []
  const out = []
  for (const inv of invoices) {
    if (inv?.Type !== 'ACCPAY') continue
    if (inv.Status !== 'AUTHORISED') continue
    const amountDue = Number(inv.AmountDue)
    if (!Number.isFinite(amountDue) || amountDue <= 0) continue
    out.push({
      invoiceId: inv.InvoiceID || '',
      invoiceNumber: inv.InvoiceNumber || '',
      contactId: inv.Contact?.ContactID || '',
      contactName: inv.Contact?.Name || '(no supplier)',
      date: toDateStr(inv.DateString, inv.Date),
      dueDate: toDateStr(inv.DueDateString, inv.DueDate),
      amountDue,
      currency: inv.CurrencyCode || '',
    })
  }
  return out
}

// Whole-days from dueDate → today (both 'yyyy-mm-dd'). Positive =
// overdue, 0 = due today, negative = not yet due. Pure date math on
// UTC midnights (no DST drift — dates are calendar days, not instants).
export function daysOverdue(dueDateStr, todayStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDateStr) || !/^\d{4}-\d{2}-\d{2}$/.test(todayStr)) return null
  const due = Date.parse(`${dueDateStr}T00:00:00Z`)
  const today = Date.parse(`${todayStr}T00:00:00Z`)
  return Math.round((today - due) / 86_400_000)
}

// Standard AP aging ladder. `overdue` is days past due (>0).
export const AGE_BUCKETS = ['not_due', 'd1_30', 'd31_60', 'd61_90', 'd90_plus']

export function bucketFor(days) {
  if (days === null || days <= 0) return 'not_due'
  if (days <= 30) return 'd1_30'
  if (days <= 60) return 'd31_60'
  if (days <= 90) return 'd61_90'
  return 'd90_plus'
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100

// rows (mapPayableInvoices output) → per-supplier aggregation, each
// with a bucketed breakdown, total owed, overdue total, oldest bill,
// and its bills. Suppliers sorted MOST OVERDUE first (by oldest days,
// then by total owed). Also returns whole-board totals.
export function agePayables(rows, todayStr) {
  const bySupplier = new Map()
  const totals = { total: 0, overdue: 0, not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, billCount: rows.length }

  for (const r of rows) {
    const days = daysOverdue(r.dueDate, todayStr)
    const bucket = bucketFor(days)
    const key = r.contactId || r.contactName

    let s = bySupplier.get(key)
    if (!s) {
      s = {
        contactId: r.contactId,
        contactName: r.contactName,
        total: 0,
        overdue: 0,
        oldestDays: null,
        buckets: { not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 },
        bills: [],
      }
      bySupplier.set(key, s)
    }
    s.total += r.amountDue
    s.buckets[bucket] += r.amountDue
    if (bucket !== 'not_due') s.overdue += r.amountDue
    if (days !== null && (s.oldestDays === null || days > s.oldestDays)) s.oldestDays = days
    s.bills.push({ ...r, daysOverdue: days, bucket })

    totals.total += r.amountDue
    totals[bucket] += r.amountDue
    if (bucket !== 'not_due') totals.overdue += r.amountDue
  }

  const suppliers = [...bySupplier.values()].map((s) => ({
    ...s,
    total: round2(s.total),
    overdue: round2(s.overdue),
    buckets: {
      not_due: round2(s.buckets.not_due),
      d1_30: round2(s.buckets.d1_30),
      d31_60: round2(s.buckets.d31_60),
      d61_90: round2(s.buckets.d61_90),
      d90_plus: round2(s.buckets.d90_plus),
    },
    bills: s.bills.sort((a, b) => (b.daysOverdue ?? -Infinity) - (a.daysOverdue ?? -Infinity)),
  }))

  // Most-overdue first: suppliers with older debt rank higher; ties
  // break on the larger balance. Suppliers with nothing overdue
  // (oldestDays <= 0 or null) fall to the bottom.
  suppliers.sort((a, b) => {
    const ao = a.oldestDays ?? -Infinity
    const bo = b.oldestDays ?? -Infinity
    if (bo !== ao) return bo - ao
    return b.total - a.total
  })

  for (const k of Object.keys(totals)) {
    if (k !== 'billCount') totals[k] = round2(totals[k])
  }

  return { suppliers, totals, supplierCount: suppliers.length }
}
