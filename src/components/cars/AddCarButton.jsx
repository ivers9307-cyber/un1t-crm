'use client'

// Inline "Add car" form. Click to expand, fill in identifiers + UK
// purchase + Irish sale figures, save → POST /api/cars and the page
// re-fetches via router.refresh().

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, X } from 'lucide-react'

export default function AddCarButton({ locationId }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const router = useRouter()
  const [form, setForm] = useState({
    uk_reg: '', irish_reg: '', vin: '',
    make: 'Tesla', model: '', vehicle_year: '',
    uk_purchase_price_ex_vat: '', uk_vat: '',
    irish_sale_price_inc_vat: '', irish_sale_price_ex_vat: '',
    notes: '',
  })

  function n(v) {
    if (v === '' || v == null) return null
    const num = Number(v)
    return Number.isFinite(num) ? num : null
  }

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const body = {
      ...form,
      vehicle_year: form.vehicle_year ? Number(form.vehicle_year) : null,
      uk_purchase_price_ex_vat: n(form.uk_purchase_price_ex_vat),
      uk_vat: n(form.uk_vat),
      irish_sale_price_inc_vat: n(form.irish_sale_price_inc_vat),
      irish_sale_price_ex_vat: n(form.irish_sale_price_ex_vat),
      location_id: locationId,
    }
    const res = await fetch('/api/cars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await res.json()
    setSaving(false)
    if (!j.success) { setError(j.error || 'Failed to save'); return }
    setOpen(false)
    setForm({
      uk_reg: '', irish_reg: '', vin: '',
      make: 'Tesla', model: '', vehicle_year: '',
      uk_purchase_price_ex_vat: '', uk_vat: '',
      irish_sale_price_inc_vat: '', irish_sale_price_ex_vat: '',
      notes: '',
    })
    router.refresh()
    router.push(`/cars/${j.data.id}`)
  }

  // Compute live profit hint as the user types — the same number the
  // list view will show after save.
  const sale = Number(form.irish_sale_price_ex_vat || 0)
  const cost = Number(form.uk_purchase_price_ex_vat || 0)
  const profit = sale && cost ? sale - cost : null

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mb-4 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-un1t-white text-un1t-black text-sm font-semibold hover:bg-un1t-accent transition-colors"
      >
        <Plus size={16} /> Add car
      </button>
    )
  }

  return (
    <form onSubmit={submit} className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5 mb-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-un1t-white">Add car</h3>
        <button type="button" onClick={() => setOpen(false)} className="text-un1t-light hover:text-un1t-white">
          <X size={18} />
        </button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg p-3">
          {error}
        </div>
      )}

      {/* Identifiers */}
      <Section title="Vehicle">
        <Field label="UK registration" value={form.uk_reg} onChange={v => setForm(f => ({ ...f, uk_reg: v }))} placeholder="e.g. AB12 CDE" />
        <Field label="Irish registration" value={form.irish_reg} onChange={v => setForm(f => ({ ...f, irish_reg: v }))} placeholder="optional, set after re-reg" />
        <Field label="VIN" value={form.vin} onChange={v => setForm(f => ({ ...f, vin: v }))} placeholder="17-char VIN" />
        <div className="grid grid-cols-3 gap-3">
          <Field label="Make" value={form.make} onChange={v => setForm(f => ({ ...f, make: v }))} />
          <Field label="Model" value={form.model} onChange={v => setForm(f => ({ ...f, model: v }))} placeholder="e.g. Model 3" />
          <Field label="Year" type="number" value={form.vehicle_year} onChange={v => setForm(f => ({ ...f, vehicle_year: v }))} />
        </div>
      </Section>

      <Section title="UK purchase">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Price ex-VAT (£)" type="number" step="0.01" value={form.uk_purchase_price_ex_vat} onChange={v => setForm(f => ({ ...f, uk_purchase_price_ex_vat: v }))} />
          <Field label="UK VAT (£)" type="number" step="0.01" value={form.uk_vat} onChange={v => setForm(f => ({ ...f, uk_vat: v }))} />
        </div>
      </Section>

      <Section title="Irish sale">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Sale inc-VAT (€)" type="number" step="0.01" value={form.irish_sale_price_inc_vat} onChange={v => setForm(f => ({ ...f, irish_sale_price_inc_vat: v }))} />
          <Field label="Sale ex-VAT (€)" type="number" step="0.01" value={form.irish_sale_price_ex_vat} onChange={v => setForm(f => ({ ...f, irish_sale_price_ex_vat: v }))} />
        </div>
      </Section>

      {profit != null && (
        <div className="text-xs text-un1t-light bg-black/30 rounded-md px-3 py-2">
          Estimated profit (ex-VAT both sides): <span className={profit >= 0 ? 'text-green-500 font-semibold' : 'text-red-400 font-semibold'}>€{Math.round(profit)}</span>
        </div>
      )}

      <div>
        <label className="block text-sm text-un1t-light mb-1">Notes</label>
        <textarea
          value={form.notes}
          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
          rows={3}
          className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
          placeholder="Anything not covered above"
        />
      </div>

      <button
        type="submit"
        disabled={saving}
        className="w-full bg-un1t-white text-un1t-black font-semibold text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Add car'}
      </button>
    </form>
  )
}

function Section({ title, children }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-2">{title}</h4>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function Field({ label, value, onChange, type = 'text', placeholder, step }) {
  return (
    <div>
      <label className="block text-xs text-un1t-light mb-1">{label}</label>
      <input
        type={type}
        step={step}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
      />
    </div>
  )
}
