'use client'

// INTEG-D2 — /admin/tenants/[orgId] drill-in. Rendered by the RSC page
// with the getTenantDetail() payload as props.
//
// Per-location blocks: pinned plan + version price, wallet balance +
// period + last-50 ledger (kind-labelled chips), MTD meters vs
// allowance (staff assistant shown separately — allowance-EXEMPT),
// integrations summary (hub-derived) and stale tenant heartbeats.
//
// The ONE write on the whole console lives here: "Adjust wallet"
// (master-only goodwill credit/debit) → POST
// /api/admin/tenants/wallet-adjust → wallet_apply kind='adjustment'.
// On success the returned balance is applied locally and the RSC data
// refreshed.

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Building2, Wallet } from 'lucide-react'
import { Button, Card, Modal, Field, Table } from '@/components/ui'
import {
  euro, euroSigned, num, shortDate, shortDateTime,
  LEDGER_KINDS, STATUS_CHIPS,
} from '@/components/admin/tenants-format'

const MAX_ADJUST_EUR = 10000

function KindChip({ kind }) {
  const k = LEDGER_KINDS[kind] || { label: kind, chip: 'bg-gray-500/10 text-gray-700' }
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${k.chip}`}>{k.label}</span>
}

function MeterRow({ label, used, allowance }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-un1t-subtle">{label}</span>
      <span className="text-un1t-text font-medium">
        {num(used)}
        {allowance != null && <span className="text-un1t-muted font-normal"> / {num(allowance)}</span>}
      </span>
    </div>
  )
}

const LEDGER_COLUMNS = [
  { key: 'created_at', header: 'When', render: (t) => <span className="whitespace-nowrap text-un1t-subtle">{shortDateTime(t.created_at)}</span> },
  { key: 'kind', header: 'Kind', render: (t) => <KindChip kind={t.kind} /> },
  { key: 'amount', header: 'Amount', align: 'right', render: (t) => (
    <span className={Number(t.amount_cents) < 0 ? 'text-red-700' : 'text-green-700'}>
      {euroSigned(t.amount_cents)}
    </span>
  ) },
  { key: 'balance', header: 'Balance', align: 'right', render: (t) => euro(t.balance_after_cents) },
  { key: 'note', header: 'Note', render: (t) => (
    <span className="text-un1t-subtle text-xs">
      {t.note || (t.meter ? `${t.meter}${t.qty != null ? ` ×${num(t.qty)}` : ''}` : '—')}
    </span>
  ) },
]

function AdjustWalletModal({ location, onClose, onApplied }) {
  const [direction, setDirection] = useState('credit')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const parsed = Number.parseFloat(String(amount).replace(',', '.'))
  const amountValid = Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_ADJUST_EUR
  const noteValid = note.trim().length >= 5
  const canSubmit = amountValid && noteValid && !busy

  async function submit() {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    const amountCents = Math.round(parsed * 100) * (direction === 'debit' ? -1 : 1)
    try {
      const res = await fetch('/api/admin/tenants/wallet-adjust', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locationId: location.id, amountCents, note: note.trim() }),
      })
      const json = await res.json().catch(() => ({}))
      if (!json.success) {
        const detail = (json.issues || []).map((i) => `${i.path}: ${i.message}`).join('; ')
        throw new Error(detail || json.error || `Request failed (${res.status})`)
      }
      onApplied(location.id, json.data.balanceCents)
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Adjust wallet — ${location.name}`}
      size="sm"
      footer={(
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="button" onClick={submit} loading={busy} disabled={!canSubmit}>
            {direction === 'credit' ? 'Apply credit' : 'Apply debit'}
          </Button>
        </>
      )}
    >
      <p className="text-xs text-un1t-subtle mb-4">
        Posts a signed adjustment to the wallet ledger via <code>wallet_apply</code> —
        append-only and recorded against your account. Use for goodwill credits
        or corrections; top-ups and usage draws post themselves.
      </p>

      <div className="space-y-4">
        <Field id="adjust-direction" label="Direction">
          {(props) => (
            <select {...props} className="ipt w-full" value={direction} onChange={(e) => setDirection(e.target.value)}>
              <option value="credit">Credit (add funds)</option>
              <option value="debit">Debit (remove funds)</option>
            </select>
          )}
        </Field>
        <Field
          id="adjust-amount"
          label="Amount (EUR)"
          required
          hint={`Up to €${MAX_ADJUST_EUR.toLocaleString('en-IE')} per adjustment.`}
          error={amount !== '' && !amountValid ? 'Enter an amount between €0.01 and €10,000.' : undefined}
        >
          {(props) => (
            <input
              {...props}
              className="ipt w-full"
              type="number"
              min="0.01"
              max={MAX_ADJUST_EUR}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="25.00"
            />
          )}
        </Field>
        <Field
          id="adjust-note"
          label="Note"
          required
          hint="Why this adjustment exists — required, lands on the ledger."
          error={note !== '' && !noteValid ? 'At least 5 characters.' : undefined}
        >
          {(props) => (
            <textarea
              {...props}
              className="ipt w-full"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Goodwill credit — WhatsApp outage on 14 Jul"
            />
          )}
        </Field>
        {error && <p className="text-sm text-red-700">{error}</p>}
      </div>
    </Modal>
  )
}

function LocationBlock({ loc, onAdjust }) {
  const usage = loc.usage || {}
  const allowances = loc.allowances || null
  return (
    <Card
      className="mb-4"
      title={(
        <span className="inline-flex items-center gap-2">
          {loc.name}
          {loc.active === false && (
            <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-gray-500/10 text-gray-700">inactive</span>
          )}
        </span>
      )}
      actions={(
        <Button type="button" variant="secondary" size="sm" icon={Wallet} onClick={() => onAdjust(loc)}>
          Adjust wallet
        </Button>
      )}
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        {/* Plan */}
        <div>
          <div className="text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-2">Plan</div>
          {loc.plan ? (
            <div className="text-sm">
              <div className="font-medium text-un1t-text">
                {loc.plan.name} · {euro(loc.plan.priceCents)}/mo
              </div>
              <div className="text-xs text-un1t-muted mt-0.5">
                Version effective {shortDate(loc.plan.effectiveFrom)}
              </div>
              {loc.plan.addons?.length > 0 && (
                <div className="text-xs text-un1t-subtle mt-1">
                  {loc.plan.addons.map((a) => `${a.name} (${euro(a.priceCents)}/mo)`).join(' · ')}
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-un1t-muted">No plan</div>
          )}
        </div>

        {/* Wallet */}
        <div>
          <div className="text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-2">Wallet</div>
          {loc.wallet ? (
            <div className="text-sm">
              <div className={`text-lg font-bold ${Number(loc.wallet.balanceCents) < 0 ? 'text-red-700' : 'text-un1t-text'}`}>
                {euro(loc.wallet.balanceCents)}
              </div>
              <div className="text-xs text-un1t-muted mt-0.5">
                Period {loc.wallet.periodStart ? shortDate(loc.wallet.periodStart) : '—'}
              </div>
            </div>
          ) : (
            <div className="text-sm text-un1t-muted">No wallet yet — created on the first ledger entry.</div>
          )}
        </div>

        {/* Usage MTD */}
        <div>
          <div className="text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-2">Usage MTD</div>
          <div className="space-y-1">
            <MeterRow label="WhatsApp templates" used={usage.wa_template_send} allowance={allowances?.wa_template_send} />
            <MeterRow label="Emails" used={usage.email_send} allowance={allowances?.email_send} />
            <MeterRow label="AI messages" used={usage.ai_message} allowance={allowances?.ai_message} />
            <div className="flex items-baseline justify-between gap-3 text-xs text-un1t-muted pt-1 border-t border-un1t-border">
              <span>Staff assistant (allowance-exempt)</span>
              <span>{num(usage.assistant_chat)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Integrations + heartbeats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-2">Integrations</div>
          {loc.integrations?.connections?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {loc.integrations.connections.map((c) => (
                <span key={c.key} className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CHIPS[c.status] || STATUS_CHIPS.not_connected}`}>
                  {c.label}{c.status !== 'connected' ? ` · ${c.status.replaceAll('_', ' ')}` : ''}
                </span>
              ))}
            </div>
          ) : (
            <div className="text-sm text-un1t-muted">No integrations configured.</div>
          )}
          {loc.integrations?.attention?.length > 0 && (
            <ul className="mt-2 space-y-1">
              {loc.integrations.attention.map((a, i) => (
                <li key={`${a.cardKey}-${i}`} className="text-xs text-amber-700">
                  {a.label}: {a.message}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-2">Tenant heartbeats</div>
          {loc.staleHeartbeats?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {loc.staleHeartbeats.map((h) => (
                <span key={h.name} className="inline-block rounded-full px-2 py-0.5 text-xs bg-red-500/10 text-red-700">
                  {h.name} · stale
                </span>
              ))}
            </div>
          ) : (
            <div className="text-sm text-un1t-muted">No stale heartbeats.</div>
          )}
        </div>
      </div>

      {/* Ledger */}
      <div>
        <div className="text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-2">
          Ledger <span className="font-normal normal-case text-un1t-muted">(last 50)</span>
        </div>
        <Table
          columns={LEDGER_COLUMNS}
          rows={loc.ledger || []}
          empty="No wallet activity yet."
        />
      </div>
    </Card>
  )
}

export default function TenantDetailView({ detail }) {
  const router = useRouter()
  const [adjusting, setAdjusting] = useState(null) // location or null
  const [balanceOverrides, setBalanceOverrides] = useState({})

  const { org } = detail
  const locations = detail.locations.map((loc) => (
    balanceOverrides[loc.id] != null
      ? { ...loc, wallet: { ...(loc.wallet || {}), balanceCents: balanceOverrides[loc.id] } }
      : loc
  ))

  function handleApplied(locationId, balanceCents) {
    setBalanceOverrides((prev) => ({ ...prev, [locationId]: balanceCents }))
    setAdjusting(null)
    router.refresh() // pull the fresh ledger row into the RSC payload
  }

  return (
    <div>
      <Link href="/admin/tenants" className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text mb-4">
        <ArrowLeft size={14} /> Tenants
      </Link>

      <div className="flex items-center gap-2 mb-1">
        <Building2 size={20} className="text-un1t-subtle" />
        <h2 className="text-2xl font-bold">{org.name}</h2>
        {org.active === false && (
          <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-gray-500/10 text-gray-700">suspended</span>
        )}
      </div>
      <p className="text-sm text-un1t-subtle mb-6">
        Created {shortDate(org.createdAt)} · {num(org.locationsCount)} location{org.locationsCount === 1 ? '' : 's'} · <span className="font-mono text-xs">{org.slug}</span>
      </p>

      {locations.length === 0 && (
        <Card><div className="text-sm text-un1t-muted">No locations in this organization yet.</div></Card>
      )}
      {locations.map((loc) => (
        <LocationBlock key={loc.id} loc={loc} onAdjust={setAdjusting} />
      ))}

      {adjusting && (
        <AdjustWalletModal
          location={adjusting}
          onClose={() => setAdjusting(null)}
          onApplied={handleApplied}
        />
      )}
    </div>
  )
}
