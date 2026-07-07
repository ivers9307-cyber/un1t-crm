'use client'

// EVENTS-HOST.2 — event hosts list + create form. Client component that
// fetches the /api/hosts routes directly (session cookies ride along;
// standard { success, data?, error? } envelope). Built on the shared
// components/ui primitives (UI-FOUND.2).
//
// The status chip reuses hostCanTakePayments() from src/lib/event-hosts
// so "Ready to take payments" here means exactly what the checkout path
// enforces server-side.

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Store, Plus, AlertTriangle } from 'lucide-react'
import { Button, Card, Field, Table, EmptyState, Loading } from '@/components/ui'
import { hostCanTakePayments, PROVIDER_STRIPE_CONNECT } from '@/lib/event-hosts'

const PROVIDER_LABELS = {
  stripe_connect: 'Stripe Connect',
  revolut: 'Revolut',
}

// Operators think in euros; the API + DB store the booking fee in cents
// (a €2 fee = 200). Convert on the boundary in both directions.
function centsToEuroInput(cents) {
  const n = Number(cents)
  if (!Number.isFinite(n) || n <= 0) return ''
  return (n / 100).toFixed(2)
}
function euroInputToCents(euros) {
  const n = parseFloat(String(euros).replace(',', '.'))
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(n * 100)
}

// Resolve the light-theme status chip (bg-<c>-500/10 text-<c>-700 — the
// only recipe check:guardrails accepts on operator surfaces).
function statusChip(host) {
  if (hostCanTakePayments(host)) {
    return { label: 'Ready to take payments', cls: 'bg-green-500/10 text-green-700' }
  }
  if (host.stripe_connected_account_id) {
    return { label: 'Onboarding incomplete', cls: 'bg-amber-500/10 text-amber-700' }
  }
  return { label: 'Not connected', cls: 'bg-gray-500/10 text-gray-700' }
}

const INPUT_CLASS =
  'w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm ' +
  'text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted'

export default function HostsManager() {
  const router = useRouter()
  const [hosts, setHosts] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [feeEuros, setFeeEuros] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch('/api/hosts')
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      setHosts(Array.isArray(j.data) ? j.data : [])
    } catch (e) {
      setLoadError(e.message || 'Failed to load hosts')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function createHost(e) {
    e.preventDefault()
    if (!name.trim() || creating) return
    setCreating(true)
    setCreateError(null)
    try {
      const res = await fetch('/api/hosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim() || undefined,
          platform_fee_cents: euroInputToCents(feeEuros),
          // The whole point of this surface is Stripe Connect onboarding
          // for third-party payees, so new hosts are created as
          // stripe_connect and the detail page offers "Connect with Stripe".
          payment_provider: PROVIDER_STRIPE_CONNECT,
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      // Land the operator on the new host's page — the natural next step
      // is "Connect with Stripe".
      if (j.data?.id) router.push(`/settings/hosts/${j.data.id}`)
      else await load()
    } catch (err) {
      setCreateError(err.message || 'Failed to create host')
      setCreating(false)
    }
  }

  const columns = [
    { key: 'name', header: 'Host', render: (h) => (
      <span className="font-medium text-un1t-text">{h.name}</span>
    ) },
    { key: 'provider', header: 'Payout', render: (h) => (
      <span className="text-un1t-subtle">{PROVIDER_LABELS[h.payment_provider] || h.payment_provider || '—'}</span>
    ) },
    { key: 'status', header: 'Status', render: (h) => {
      const chip = statusChip(h)
      return (
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${chip.cls}`}>
          {chip.label}
        </span>
      )
    } },
  ]

  return (
    <div className="space-y-6">
      {/* Create */}
      <Card title="New host">
        <p className="text-xs text-un1t-subtle mb-4">
          Add a third-party organiser. After creating, open the host to connect their Stripe account —
          their event tickets will settle to that account with UN1T&rsquo;s booking fee kept per ticket.
        </p>
        <form onSubmit={createHost} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="host-name" label="Name" required>
              {(p) => (
                <input
                  {...p}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Dublin Run Club"
                  className={INPUT_CLASS}
                />
              )}
            </Field>
            <Field id="host-email" label="Email" hint="Where Stripe sends onboarding + payout notices.">
              {(p) => (
                <input
                  {...p}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="organiser@example.com"
                  className={INPUT_CLASS}
                />
              )}
            </Field>
          </div>
          <Field
            id="host-fee"
            label="Booking fee per ticket (€)"
            hint="UN1T keeps this on every ticket the host sells. Leave blank for no fee. e.g. 2.00"
            className="sm:max-w-xs"
          >
            {(p) => (
              <input
                {...p}
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={feeEuros}
                onChange={(e) => setFeeEuros(e.target.value)}
                placeholder="0.00"
                className={INPUT_CLASS}
              />
            )}
          </Field>
          {createError && (
            <p className="text-xs text-stage-lost flex items-center gap-1">
              <AlertTriangle size={12} /> {createError}
            </p>
          )}
          <Button type="submit" icon={Plus} loading={creating} disabled={!name.trim()}>
            Create host
          </Button>
        </form>
      </Card>

      {/* List */}
      <Card title="Hosts" padding="none">
        {loading ? (
          <Loading label="Loading hosts…" />
        ) : loadError ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-stage-lost flex items-center justify-center gap-1">
              <AlertTriangle size={12} /> {loadError}
            </p>
            <Button variant="secondary" size="sm" onClick={load} className="mt-3">Retry</Button>
          </div>
        ) : hosts.length === 0 ? (
          <EmptyState
            icon={<Store size={24} />}
            title="No hosts yet"
            description="Create your first third-party event host above to start taking payments on their behalf."
          />
        ) : (
          <Table
            columns={columns}
            rows={hosts}
            onRowClick={(h) => router.push(`/settings/hosts/${h.id}`)}
            rowKey={(h) => h.id}
          />
        )}
      </Card>
    </div>
  )
}
