// PromoCodesManager — operator CRUD surface for event checkout discount codes
// (EVENTS-PROMO.1). Backed by /api/promo-codes (list + create) and
// /api/promo-codes/[id] (activate/deactivate + delete). The `events` prop is
// the active location's own events, used both for the create-form picker and
// to resolve the Scope column's event name.
//
// Money maths note: the API stores a `fixed` discount as CENTS. The form takes
// euros and converts on submit; a `percent` discount is the integer percent
// (0-100) as-is.

'use client'

import { useState, useEffect, useCallback } from 'react'
import { AlertCircle, CheckCircle2, Plus, Trash2 } from 'lucide-react'
import { Button, Card, Field, Table } from '@/components/ui'

const inputClass =
  'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted'

// ── Formatters ────────────────────────────────────────────────────
function valueLabel(row) {
  if (row.discount_type === 'percent') return `${row.discount_value}%`
  return `€${(Number(row.discount_value || 0) / 100).toFixed(2)}`
}

function usedLabel(row) {
  const cap = row.max_redemptions == null ? '∞' : row.max_redemptions
  return `${row.redeemed_count ?? 0} / ${cap}`
}

function expiryLabel(iso) {
  if (!iso) return 'Never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-IE', { dateStyle: 'medium' })
}

export default function PromoCodesManager({ events = [] }) {
  const [codes, setCodes] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [listError, setListError] = useState(null)

  const eventNameById = new Map(events.map((e) => [e.id, e.name]))

  const fetchList = useCallback(async () => {
    setLoading(true)
    setListError(null)
    try {
      const res = await fetch('/api/promo-codes', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || 'Could not load codes.')
      setCodes(json.data || [])
    } catch (e) {
      setListError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchList() }, [fetchList])

  async function toggleActive(row) {
    setBusyId(row.id)
    try {
      const res = await fetch(`/api/promo-codes/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !row.active }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || 'Update failed.')
      setCodes((prev) => prev.map((c) => (c.id === row.id ? json.data : c)))
    } catch (e) {
      setListError(e.message)
    } finally {
      setBusyId(null)
    }
  }

  async function remove(row) {
    if (!window.confirm(`Delete code ${row.code}? Past redemptions keep their record.`)) return
    setBusyId(row.id)
    try {
      const res = await fetch(`/api/promo-codes/${row.id}`, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || 'Delete failed.')
      setCodes((prev) => prev.filter((c) => c.id !== row.id))
    } catch (e) {
      setListError(e.message)
    } finally {
      setBusyId(null)
    }
  }

  function scopeCell(row) {
    const label = row.event_id
      ? (eventNameById.get(row.event_id) || 'Specific event')
      : 'Global'
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span className={row.event_id ? 'text-un1t-text' : 'text-un1t-subtle'}>{label}</span>
        {row.member_only && (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-indigo-500/10 text-indigo-700">
            Members
          </span>
        )}
      </span>
    )
  }

  const columns = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-mono font-medium text-un1t-text">{r.code}</span> },
    { key: 'type', header: 'Type', render: (r) => (r.discount_type === 'percent' ? 'Percent' : 'Fixed') },
    { key: 'value', header: 'Value', render: (r) => valueLabel(r) },
    { key: 'scope', header: 'Scope', render: scopeCell },
    { key: 'used', header: 'Used', render: (r) => usedLabel(r) },
    { key: 'expiry', header: 'Expiry', render: (r) => expiryLabel(r.expires_at) },
    {
      key: 'active',
      header: 'Status',
      render: (r) => (
        <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${
          r.active ? 'bg-emerald-500/10 text-emerald-700' : 'bg-gray-500/10 text-gray-700'
        }`}>
          {r.active ? 'Active' : 'Inactive'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => (
        <div className="inline-flex items-center gap-3 whitespace-nowrap">
          <button
            type="button"
            onClick={() => toggleActive(r)}
            disabled={busyId === r.id}
            className="text-[11px] text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
          >
            {r.active ? 'Deactivate' : 'Activate'}
          </button>
          <button
            type="button"
            onClick={() => remove(r)}
            disabled={busyId === r.id}
            className="inline-flex items-center gap-1 text-[11px] text-red-700 hover:text-red-800 disabled:opacity-50"
          >
            <Trash2 size={11} /> Delete
          </button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-8">
      <CreateForm events={events} onCreated={fetchList} />

      <div>
        <div className="flex items-center justify-between gap-3 mb-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">
            Codes · {codes.length}
          </h3>
        </div>
        {listError && (
          <div className="mb-3 text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded p-2 inline-flex items-start gap-1.5">
            <AlertCircle size={12} className="mt-0.5 shrink-0 text-red-600" /> {listError}
          </div>
        )}
        <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden">
          <Table
            className="overflow-x-auto"
            columns={columns}
            rows={codes}
            loading={loading}
            empty="No promo codes yet. Create one above."
            rowKey={(r) => r.id}
          />
        </div>
      </div>
    </div>
  )
}

// ── Create form ───────────────────────────────────────────────────

function CreateForm({ events, onCreated }) {
  const [code, setCode] = useState('')
  const [discountType, setDiscountType] = useState('percent')
  const [value, setValue] = useState('')
  const [eventId, setEventId] = useState('')
  const [cap, setCap] = useState('')
  const [expiry, setExpiry] = useState('')
  const [memberOnly, setMemberOnly] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(false)

  function reset() {
    setCode('')
    setDiscountType('percent')
    setValue('')
    setEventId('')
    setCap('')
    setExpiry('')
    setMemberOnly(false)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSuccess(false)

    const trimmed = code.trim()
    if (!trimmed) {
      setError('Enter a code.')
      return
    }
    const numValue = Number(value)
    if (!Number.isFinite(numValue) || numValue < 0) {
      setError('Enter a valid discount amount.')
      return
    }
    if (discountType === 'percent' && numValue > 100) {
      setError('A percent discount cannot exceed 100.')
      return
    }
    if (discountType === 'fixed' && numValue === 0) {
      setError('A fixed discount must be more than €0.')
      return
    }

    const body = {
      code: trimmed,
      discount_type: discountType,
      // percent → integer percent; fixed → cents (form takes euros).
      discount_value: discountType === 'percent'
        ? Math.round(numValue)
        : Math.round(numValue * 100),
    }
    if (eventId) body.event_id = eventId
    if (cap !== '') {
      const capNum = Math.round(Number(cap))
      if (!Number.isFinite(capNum) || capNum < 1) {
        setError('Usage cap must be at least 1 (or leave it blank).')
        return
      }
      body.max_redemptions = capNum
    }
    if (expiry) {
      // Date-only input → end of that day in the operator's local (Dublin)
      // wall clock, then to a UTC ISO string the API accepts.
      const d = new Date(`${expiry}T23:59:59`)
      if (Number.isNaN(d.getTime())) {
        setError('Invalid expiry date.')
        return
      }
      body.expires_at = d.toISOString()
    }
    if (memberOnly) body.member_only = true

    setSubmitting(true)
    try {
      const res = await fetch('/api/promo-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `Create failed (${res.status}).`)
      setSuccess(true)
      reset()
      onCreated?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const isPercent = discountType === 'percent'

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">New code</h3>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field id="promo-code" label="Code" required hint="Case-insensitive; stored uppercase.">
            {(props) => (
              <input
                {...props}
                type="text"
                value={code}
                onChange={(ev) => setCode(ev.target.value.toUpperCase())}
                placeholder="SUMMER25"
                maxLength={64}
                className={`${inputClass} font-mono`}
              />
            )}
          </Field>

          <Field id="promo-type" label="Discount type">
            {(props) => (
              <select
                {...props}
                value={discountType}
                onChange={(ev) => setDiscountType(ev.target.value)}
                className={inputClass}
              >
                <option value="percent">Percent (%)</option>
                <option value="fixed">Fixed (€)</option>
              </select>
            )}
          </Field>

          <Field
            id="promo-value"
            label={isPercent ? 'Discount (%)' : 'Discount (€)'}
            required
            hint={isPercent ? '0 to 100.' : 'Amount off each order, in euros.'}
          >
            {(props) => (
              <input
                {...props}
                type="number"
                value={value}
                onChange={(ev) => setValue(ev.target.value)}
                min={0}
                max={isPercent ? 100 : undefined}
                step={isPercent ? 1 : '0.01'}
                placeholder={isPercent ? '25' : '5.00'}
                className={inputClass}
              />
            )}
          </Field>

          <Field id="promo-event" label="Applies to" hint="Leave global to allow any event at this location.">
            {(props) => (
              <select
                {...props}
                value={eventId}
                onChange={(ev) => setEventId(ev.target.value)}
                className={inputClass}
              >
                <option value="">Global — any event</option>
                {events.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}{e.race_date ? ` (${e.race_date})` : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field id="promo-cap" label="Usage cap" hint="Total redemptions allowed. Blank = unlimited.">
            {(props) => (
              <input
                {...props}
                type="number"
                value={cap}
                onChange={(ev) => setCap(ev.target.value)}
                min={1}
                step={1}
                placeholder="Unlimited"
                className={inputClass}
              />
            )}
          </Field>

          <Field id="promo-expiry" label="Expiry" hint="Blank = never expires.">
            {(props) => (
              <input
                {...props}
                type="date"
                value={expiry}
                onChange={(ev) => setExpiry(ev.target.value)}
                className={inputClass}
              />
            )}
          </Field>
        </div>

        <label className="inline-flex items-center gap-2 text-sm text-un1t-text">
          <input
            type="checkbox"
            checked={memberOnly}
            onChange={(ev) => setMemberOnly(ev.target.checked)}
            className="h-4 w-4 rounded border-un1t-border text-un1t-accent focus:ring-un1t-accent"
          />
          Members only
        </label>

        {error && (
          <div className="text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded p-2 inline-flex items-start gap-1.5">
            <AlertCircle size={12} className="mt-0.5 shrink-0 text-red-600" /> {error}
          </div>
        )}
        {success && (
          <div className="text-xs text-emerald-700 bg-emerald-500/10 border border-emerald-500/30 rounded p-2 inline-flex items-start gap-1.5">
            <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-600" /> Code created ✓
          </div>
        )}

        <Button type="submit" loading={submitting} icon={submitting ? undefined : Plus}>
          {submitting ? 'Creating…' : 'Create code'}
        </Button>
      </form>
    </Card>
  )
}
