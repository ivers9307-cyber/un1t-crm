// Read-only diagnostic: analyse the SHAPE of a Glofox /Analytics/report
// (TransactionsList) response so we can see, at scale, what transaction
// envelope types exist, whether they carry a usable `amount`, and where a
// known invoice's true amount surfaces — BEFORE building any write path that
// backfills arrears from this data into glofox_invoices.
//
// Context: the report returns ~2,425 transactions for Stillorgan, but the one
// sampled row (a `subscription_payment_failed` StripeCharge) had amount: 0
// while the real invoice (b847cdac) is €1,144 in our table (the webhook
// carried that, not the report). So before summing arrears from the report we
// must learn which envelope types / fields carry the real amount.
//
// Pure function (no IO) so it's unit-testable; the route just feeds it
// `response_body.TransactionsList.details`.

const MAX_SAMPLES = 2

function classifyRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return { type: '(non-object)', inner: {} }
  }
  const keys = Object.keys(row)
  // A transaction is wrapped in a single typed envelope, e.g.
  // { StripeCharge: { ...fields } }. Detect that; otherwise treat the row
  // itself as the inner object.
  if (
    keys.length === 1 &&
    row[keys[0]] &&
    typeof row[keys[0]] === 'object' &&
    !Array.isArray(row[keys[0]])
  ) {
    return { type: keys[0], inner: row[keys[0]] }
  }
  return { type: '(flat)', inner: row }
}

function emptyBucket() {
  return {
    count: 0,
    amount: { populated: 0, zero: 0, missing: 0, min: null, max: null, sum: 0 },
    paid: { true: 0, false: 0, missing: 0 },
    status: {},
    event: {},
    _fields: new Set(),
    _metaFields: new Set(),
    samples: [],
  }
}

/**
 * @param {Array} details  the TransactionsList.details array from the report
 * @param {{ probeInvoiceId?: string }} [opts]
 * @returns {{ total, types, byType, probe? }}
 */
export function analyzeReportShape(details, opts = {}) {
  const list = Array.isArray(details) ? details : []
  const byType = {}
  const probeInvoiceId = opts.probeInvoiceId || null
  const probeMatches = []

  for (const row of list) {
    const { type, inner } = classifyRow(row)
    const b = (byType[type] = byType[type] || emptyBucket())
    b.count++

    // amount: populated (finite & non-zero) vs zero vs missing/non-numeric
    const amt = Number(inner?.amount)
    if (!Number.isFinite(amt)) {
      b.amount.missing++
    } else if (amt === 0) {
      b.amount.zero++
    } else {
      b.amount.populated++
      b.amount.sum += amt
      b.amount.min = b.amount.min === null ? amt : Math.min(b.amount.min, amt)
      b.amount.max = b.amount.max === null ? amt : Math.max(b.amount.max, amt)
    }

    // paid flag
    if (inner?.paid === true) b.paid.true++
    else if (inner?.paid === false) b.paid.false++
    else b.paid.missing++

    // status / glofox_event histograms
    const st = inner?.transaction_status
    if (st != null) b.status[st] = (b.status[st] || 0) + 1
    const ev = inner?.metadata?.glofox_event
    if (ev != null) b.event[ev] = (b.event[ev] || 0) + 1

    // field unions — reveals any amount-bearing field other than `amount`
    if (inner && typeof inner === 'object') {
      for (const k of Object.keys(inner)) b._fields.add(k)
      if (inner.metadata && typeof inner.metadata === 'object') {
        for (const k of Object.keys(inner.metadata)) b._metaFields.add(k)
      }
    }

    if (b.samples.length < MAX_SAMPLES) b.samples.push(inner)

    if (probeInvoiceId && inner?.invoice_id === probeInvoiceId) {
      probeMatches.push({ type, inner })
    }
  }

  // finalise: Set → sorted array
  for (const t of Object.keys(byType)) {
    const b = byType[t]
    b.fields = Array.from(b._fields).sort()
    b.metaFields = Array.from(b._metaFields).sort()
    delete b._fields
    delete b._metaFields
  }

  const out = {
    total: list.length,
    types: Object.keys(byType).sort(),
    byType,
  }
  if (probeInvoiceId) {
    out.probe = { invoiceId: probeInvoiceId, matches: probeMatches }
  }
  return out
}
