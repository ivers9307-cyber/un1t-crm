'use client'

// /admin/plans editor (INTEG-C1). Master-only surface, rendered by
// src/app/admin/plans/page.js.
//
// Editing model: plan NUMBERS are immutable per version — the only
// write for pricing is "New version" (POST /api/admin/plans/[id]/versions)
// with an effective_from date. The form prefills from the newest
// version so a price change is edit-one-field-and-save. Plan metadata
// (name, active) PATCHes /api/admin/plans/[id].

import { useState } from 'react'
import { Plus, Loader2, Save, X, Pencil, ChevronUp } from 'lucide-react'
import { METERS, UNIT_RATE_KEYS, FEATURE_KEYS } from '@shared/plans'

const METER_ENTRIES = Object.entries(METERS)
const RATE_ENTRIES = Object.entries(UNIT_RATE_KEYS)
const FEATURE_ENTRIES = Object.entries(FEATURE_KEYS)

function pad2(n) {
  return String(n).padStart(2, '0')
}
// Local calendar date for DISPLAY grouping of current vs scheduled
// versions (a master eyeballing the editor). Server-side date logic
// uses dublinTodayStr() — see src/lib/plans.js.
function localTodayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function euro(cents) {
  if (cents == null || Number.isNaN(Number(cents))) return '—'
  return `€${(Number(cents) / 100).toFixed(2)}`
}
function centsFromEuroInput(value) {
  if (value === '' || value == null) return null
  const n = Number.parseFloat(String(value).replace(',', '.'))
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100)
}

async function api(path, method, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!json.success) {
    const detail = (json.issues || []).map((i) => `${i.path}: ${i.message}`).join('; ')
    throw new Error(detail || json.error || `Request failed (${res.status})`)
  }
  return json.data
}

export default function PlansAdmin({ initial }) {
  const [plans, setPlans] = useState(initial)
  const [error, setError] = useState(null)

  function upsertPlan(updated) {
    setPlans((ps) => {
      const exists = ps.some((p) => p.id === updated.id)
      const next = exists
        ? ps.map((p) => (p.id === updated.id ? { ...p, ...updated } : p))
        : [...ps, { ...updated, versions: updated.versions || [] }]
      return next.sort((a, b) => (a.sort - b.sort) || a.slug.localeCompare(b.slug))
    })
  }
  function addVersion(planId, version) {
    setPlans((ps) => ps.map((p) => (
      p.id === planId
        ? {
            ...p,
            versions: [version, ...(p.versions || [])].sort((a, b) =>
              b.effective_from.localeCompare(a.effective_from)),
          }
        : p
    )))
  }

  const tiers = plans.filter((p) => p.kind === 'tier')
  const addons = plans.filter((p) => p.kind === 'addon')

  return (
    <div className="space-y-10">
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}

      <Section
        title="Tiers"
        blurb="Per-location monthly tiers with metered allowances. Overage rates apply beyond the included quantities."
        kind="tier"
        plans={tiers}
        onError={setError}
        onPlanChange={upsertPlan}
        onVersionCreated={addVersion}
      />
      <Section
        title="Add-ons"
        blurb="Monthly module add-ons a location can stack on top of its tier (extra pins to add-on plan versions)."
        kind="addon"
        plans={addons}
        onError={setError}
        onPlanChange={upsertPlan}
        onVersionCreated={addVersion}
      />
    </div>
  )
}

function Section({ title, blurb, kind, plans, onError, onPlanChange, onVersionCreated }) {
  const [adding, setAdding] = useState(false)
  return (
    <section>
      <div className="mb-1 flex items-center gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">{title}</h3>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md border border-un1t-border px-2 py-1 text-xs text-un1t-text hover:bg-un1t-border/30"
        >
          <Plus size={12} /> New {kind === 'tier' ? 'tier' : 'add-on'}
        </button>
      </div>
      <p className="mb-3 text-xs text-un1t-subtle max-w-3xl">{blurb}</p>
      {adding && (
        <NewPlanForm
          kind={kind}
          onCancel={() => setAdding(false)}
          onCreated={(plan) => { setAdding(false); onPlanChange(plan) }}
          onError={onError}
        />
      )}
      <div className="space-y-4">
        {plans.length === 0 && !adding && (
          <p className="text-sm italic text-un1t-muted">None yet.</p>
        )}
        {plans.map((p) => (
          <PlanCard
            key={p.id}
            plan={p}
            onError={onError}
            onPlanChange={onPlanChange}
            onVersionCreated={onVersionCreated}
          />
        ))}
      </div>
    </section>
  )
}

function NewPlanForm({ kind, onCancel, onCreated, onError }) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    onError(null)
    try {
      const created = await api('/api/admin/plans', 'POST', {
        name: name.trim(),
        slug: slug.trim(),
        kind,
      })
      onCreated({ ...created, versions: [] })
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-un1t-border bg-un1t-surface p-4">
      <Field label="Name">
        <input className="ipt w-48" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'tier' ? 'e.g. Pro' : 'e.g. Extra AI pack'} required />
      </Field>
      <Field label="Slug (snake_case, permanent)">
        <input className="ipt w-48 font-mono" type="text" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={kind === 'tier' ? 'pro' : 'extra_ai_pack'} required />
      </Field>
      <div className="flex items-center gap-2 pb-0.5">
        <button type="submit" disabled={busy} className="btn-primary">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create
        </button>
        <button type="button" onClick={onCancel} className="btn-ghost"><X size={14} /> Cancel</button>
      </div>
      <p className="w-full text-xs text-un1t-subtle">
        Creates the plan shell only — add the first pricing version next. It can&apos;t be
        assigned to a location until it has a version in effect.
      </p>
      <FormStyles />
    </form>
  )
}

function PlanCard({ plan, onError, onPlanChange, onVersionCreated }) {
  const [showForm, setShowForm] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [busyMeta, setBusyMeta] = useState(false)
  const today = localTodayStr()

  const versions = plan.versions || []
  const current = versions.find((v) => v.effective_from <= today) || null

  async function patchMeta(patch) {
    setBusyMeta(true)
    onError(null)
    try {
      const updated = await api(`/api/admin/plans/${plan.id}`, 'PATCH', patch)
      onPlanChange({ ...plan, ...updated })
      return true
    } catch (err) {
      onError(err.message)
      return false
    } finally {
      setBusyMeta(false)
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-un1t-border bg-un1t-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-un1t-border px-4 py-3">
        {renaming ? (
          <RenameForm
            name={plan.name}
            busy={busyMeta}
            onCancel={() => setRenaming(false)}
            onSave={async (name) => { if (await patchMeta({ name })) setRenaming(false) }}
          />
        ) : (
          <>
            <span className="font-semibold">{plan.name}</span>
            <button type="button" onClick={() => setRenaming(true)} className="text-un1t-muted hover:text-un1t-text" title="Rename">
              <Pencil size={12} />
            </button>
          </>
        )}
        <code className="rounded bg-un1t-border/40 px-1.5 py-0.5 text-xs text-un1t-subtle">{plan.slug}</code>
        {plan.active ? (
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-700">active</span>
        ) : (
          <span className="rounded-full bg-neutral-500/10 px-2 py-0.5 text-xs font-semibold text-neutral-700">retired</span>
        )}
        <span className="text-sm text-un1t-subtle">
          {current ? `${euro(current.price_cents)}/mo` : 'no version in effect'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={busyMeta}
            onClick={() => patchMeta({ active: !plan.active })}
            className="btn-ghost"
          >
            {plan.active ? 'Retire' : 'Reactivate'}
          </button>
          <button type="button" onClick={() => setShowForm((v) => !v)} className="btn-primary">
            {showForm ? <ChevronUp size={14} /> : <Plus size={14} />} New version
          </button>
        </div>
      </div>

      {showForm && (
        <NewVersionForm
          plan={plan}
          prefill={versions[0] || null}
          onCancel={() => setShowForm(false)}
          onCreated={(v) => { setShowForm(false); onVersionCreated(plan.id, v) }}
          onError={onError}
        />
      )}

      <VersionHistory versions={versions} currentId={current?.id} today={today} kind={plan.kind} />
    </div>
  )
}

function RenameForm({ name, busy, onSave, onCancel }) {
  const [value, setValue] = useState(name)
  return (
    <span className="inline-flex items-center gap-2">
      <input className="ipt w-40" type="text" value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="button" disabled={busy || !value.trim()} onClick={() => onSave(value.trim())} className="btn-primary">
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
      </button>
      <button type="button" onClick={onCancel} className="btn-ghost"><X size={14} /></button>
      <FormStyles />
    </span>
  )
}

function VersionHistory({ versions, currentId, today, kind }) {
  if (versions.length === 0) {
    return (
      <p className="px-4 py-3 text-sm italic text-un1t-muted">
        No versions yet — this plan has no price until one is created.
      </p>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-un1t-border/20 text-left text-xs uppercase text-un1t-subtle">
          <tr>
            <th className="px-4 py-2">Effective</th>
            <th className="px-4 py-2">Status</th>
            <th className="px-4 py-2">Price /mo</th>
            {kind === 'tier' && (
              <>
                <th className="px-4 py-2">WA templates</th>
                <th className="px-4 py-2">Emails</th>
                <th className="px-4 py-2">AI msgs</th>
                <th className="px-4 py-2">Overage (WA mktg / WA util / email·1k / AI)</th>
              </>
            )}
            <th className="px-4 py-2">Features</th>
            <th className="px-4 py-2">Notes</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.id} className="border-t border-un1t-border align-top">
              <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">{v.effective_from}</td>
              <td className="px-4 py-2">
                {v.id === currentId ? (
                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-700">current</span>
                ) : v.effective_from > today ? (
                  <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-semibold text-blue-700">scheduled</span>
                ) : (
                  <span className="rounded-full bg-neutral-500/10 px-2 py-0.5 text-xs font-semibold text-neutral-700">superseded</span>
                )}
              </td>
              <td className="whitespace-nowrap px-4 py-2">{euro(v.price_cents)}</td>
              {kind === 'tier' && (
                <>
                  <td className="px-4 py-2">{fmtQty(v.allowances?.wa_template_send)}</td>
                  <td className="px-4 py-2">{fmtQty(v.allowances?.email_send)}</td>
                  <td className="px-4 py-2">{fmtQty(v.allowances?.ai_message)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-un1t-subtle">
                    {euro(v.unit_rates_cents?.wa_marketing)} / {euro(v.unit_rates_cents?.wa_utility)} / {euro(v.unit_rates_cents?.email_per_1k)} / {euro(v.unit_rates_cents?.ai_message)}
                  </td>
                </>
              )}
              <td className="px-4 py-2 text-xs">
                {FEATURE_ENTRIES.filter(([k]) => v.features?.[k]).map(([k, def]) => (
                  <span key={k} className="mr-1 inline-block rounded-full bg-blue-500/10 px-2 py-0.5 font-medium text-blue-700">{def.label}</span>
                ))}
              </td>
              <td className="max-w-56 px-4 py-2 text-xs text-un1t-subtle">{v.notes || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function fmtQty(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString('en-IE')
}

function NewVersionForm({ plan, prefill, onCancel, onCreated, onError }) {
  const [effectiveFrom, setEffectiveFrom] = useState(localTodayStr())
  const [priceEuro, setPriceEuro] = useState(
    prefill ? (prefill.price_cents / 100).toFixed(2) : ''
  )
  const [allowances, setAllowances] = useState(() =>
    Object.fromEntries(METER_ENTRIES.map(([k]) => [k, prefill?.allowances?.[k] ?? ''])))
  const [rates, setRates] = useState(() =>
    Object.fromEntries(RATE_ENTRIES.map(([k]) => [
      k,
      prefill?.unit_rates_cents?.[k] != null ? (prefill.unit_rates_cents[k] / 100).toFixed(2) : '',
    ])))
  const [features, setFeatures] = useState(() =>
    Object.fromEntries(FEATURE_ENTRIES.map(([k]) => [k, Boolean(prefill?.features?.[k])])))
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)

  const isTier = plan.kind === 'tier'

  async function submit(e) {
    e.preventDefault()
    onError(null)
    const priceCents = centsFromEuroInput(priceEuro)
    if (priceCents == null) { onError('Price is required (EUR).'); return }

    const body = {
      effective_from: effectiveFrom,
      price_cents: priceCents,
      features,
      notes: notes.trim() || null,
    }
    if (isTier) {
      const allowancesOut = {}
      for (const [k] of METER_ENTRIES) {
        const n = Number.parseInt(allowances[k], 10)
        allowancesOut[k] = Number.isFinite(n) && n > 0 ? n : 0
      }
      const ratesOut = {}
      for (const [k] of RATE_ENTRIES) {
        const cents = centsFromEuroInput(rates[k])
        if (cents == null) { onError(`Overage rate "${UNIT_RATE_KEYS[k].label}" is required (EUR).`); return }
        ratesOut[k] = cents
      }
      body.allowances = allowancesOut
      body.unit_rates_cents = ratesOut
    }

    setBusy(true)
    try {
      const created = await api(`/api/admin/plans/${plan.id}/versions`, 'POST', body)
      onCreated(created)
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 border-b border-un1t-border bg-un1t-border/10 px-4 py-4">
      <p className="text-xs text-un1t-subtle max-w-3xl">
        Creates a new immutable version of <span className="font-semibold">{plan.name}</span> — existing
        versions (and any locations pinned to them) are untouched. The version becomes the live price
        on its effective date.
      </p>
      <div className="flex flex-wrap gap-4">
        <Field label="Effective from">
          <input className="ipt w-40" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required />
        </Field>
        <Field label="Price € / month">
          <input className="ipt w-32" type="number" min="0" step="0.01" value={priceEuro} onChange={(e) => setPriceEuro(e.target.value)} required />
        </Field>
      </div>

      {isTier && (
        <>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Monthly allowances (included quantities)</div>
            <div className="flex flex-wrap gap-4">
              {METER_ENTRIES.map(([k, def]) => (
                <Field key={k} label={def.label}>
                  <input
                    className="ipt w-32" type="number" min="0" step="1"
                    value={allowances[k]}
                    onChange={(e) => setAllowances((a) => ({ ...a, [k]: e.target.value }))}
                    placeholder="0"
                  />
                </Field>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Overage rates € (beyond allowance)</div>
            <div className="flex flex-wrap gap-4">
              {RATE_ENTRIES.map(([k, def]) => (
                <Field key={k} label={`${def.label} / ${def.per}`}>
                  <input
                    className="ipt w-32" type="number" min="0" step="0.01"
                    value={rates[k]}
                    onChange={(e) => setRates((r) => ({ ...r, [k]: e.target.value }))}
                    placeholder="0.00"
                  />
                </Field>
              ))}
            </div>
          </div>
        </>
      )}

      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Included features</div>
        <div className="flex flex-wrap gap-4">
          {FEATURE_ENTRIES.map(([k, def]) => (
            <label key={k} className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={features[k]}
                onChange={(e) => setFeatures((f) => ({ ...f, [k]: e.target.checked }))}
              />
              {def.label}
            </label>
          ))}
        </div>
      </div>

      <Field label="Notes (operator-only)">
        <textarea className="ipt" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why this version exists — e.g. 2027 price review" />
      </Field>

      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className="btn-primary">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Create version
        </button>
        <button type="button" onClick={onCancel} className="btn-ghost"><X size={14} /> Cancel</button>
      </div>
      <FormStyles />
    </form>
  )
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-xs font-medium text-un1t-subtle">{label}</span>
      {children}
    </label>
  )
}

function FormStyles() {
  return (
    <style jsx>{`
      :global(.ipt) {
        width: 100%; padding: 0.4rem 0.6rem;
        border: 1px solid #d4d4d8; border-radius: 6px;
        background: white; font-size: 0.875rem;
      }
      :global(.ipt:focus) { outline: none; border-color: #71717a; box-shadow: 0 0 0 1px #71717a; }
      :global(.btn-primary) {
        display: inline-flex; align-items: center; gap: 0.25rem;
        border-radius: 6px; background: #171717; color: white;
        padding: 0.4rem 0.8rem; font-size: 0.8125rem; font-weight: 500;
      }
      :global(.btn-primary:hover) { background: #404040; }
      :global(.btn-primary:disabled) { opacity: 0.5; }
      :global(.btn-ghost) {
        display: inline-flex; align-items: center; gap: 0.25rem;
        border-radius: 6px; border: 1px solid #d4d4d8;
        padding: 0.35rem 0.7rem; font-size: 0.8125rem; color: #404040;
      }
      :global(.btn-ghost:hover) { background: #f5f5f5; }
      :global(.btn-ghost:disabled) { opacity: 0.5; }
    `}</style>
  )
}
