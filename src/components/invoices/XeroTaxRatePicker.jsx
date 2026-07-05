// src/components/invoices/XeroTaxRatePicker.jsx
// XERO-BILL-VAT.2 — VAT-rate selector for /invoices review. Fetches
// the location's active expense-applicable rates, defaults to the
// rate derived from the bill, and lets the bookkeeper override.
'use client'
import { useEffect, useState } from 'react'
import { resolveBillTaxType } from '@/lib/invoices-queue/vat'

export default function XeroTaxRatePicker({ locationId, fields, value, onChange }) {
  const [rates, setRates] = useState([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let live = true
    fetch(`/api/locations/${locationId}/xero/tax-rates`)
      .then((r) => r.json())
      .then((j) => { if (live && j.success) setRates(j.taxRates || []) })
      .catch(() => {})
      .finally(() => { if (live) setLoaded(true) })
    return () => { live = false }
  }, [locationId])

  // Derive a default once rates are loaded and nothing is chosen yet.
  const derived = loaded ? resolveBillTaxType(fields, rates) : null
  useEffect(() => {
    if (!value && derived && derived.taxType) {
      onChange(derived.taxType, 'derived')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, derived?.taxType])

  const hint = derived && derived.status !== 'matched' && derived.status !== 'zero'
    ? `Couldn’t auto-detect (derived ${derived.derivedRate == null ? '—' : derived.derivedRate.toFixed(1) + '%'}) — pick one`
    : null

  return (
    <label className="block">
      <span className="text-xs text-un1t-subtle">VAT rate {hint && <span className="text-amber-700">· {hint}</span>}</span>
      <select
        className="mt-1 w-full rounded-md border border-un1t-border bg-un1t-surface px-2 py-1.5 text-sm"
        value={value || ''}
        onChange={(e) => onChange(e.target.value || null, 'manual')}
      >
        <option value="">{loaded ? 'Select VAT rate…' : 'Loading…'}</option>
        {rates.map((r) => (
          <option key={r.tax_type} value={r.tax_type}>
            {r.name} — {r.effective_rate == null ? '?' : r.effective_rate}%
          </option>
        ))}
      </select>
    </label>
  )
}
