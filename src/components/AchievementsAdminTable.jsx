'use client'

// Operator UI for /achievements (ADMIN.2h Task 1 moved it out of
// /admin). Lists rules with inline
// edit, add-new, backfill, and a read-only "test against contact"
// preview panel.
//
// Conventions match /settings/audit-log: client component owns all
// mutation traffic via /api/admin/*; the server page just hydrates
// the initial list.

import { useState } from 'react'
import {
  Plus, Pencil, Trash2, ArrowUp, ArrowDown, Power, PowerOff,
  RefreshCw, FlaskConical, Save, X, ChevronDown, ChevronUp, Loader2,
  CheckCircle2,
} from 'lucide-react'

const RULE_TYPES = [
  { value: 'first_event',         label: 'First event' },
  { value: 'streak',              label: 'Streak (consecutive days)' },
  { value: 'aggregate_threshold', label: 'Aggregate threshold' },
  { value: 'session_property',    label: 'Session property' },
  { value: 'class_type_count',    label: 'Class type count' },
  { value: 'location_visit',      label: 'Location visit count' },
]
const CATEGORIES = ['milestone', 'streak', 'volume', 'class_type', 'session_quality', 'exploration']
const FIELDS = [
  { value: 'effort_points',   label: 'UN1T points' },
  { value: 'classes',         label: 'Classes' },
  { value: 'z3_minutes',      label: 'Z3 minutes' },
  { value: 'z4_minutes',      label: 'Z4 minutes' },
  { value: 'z5_minutes',      label: 'Z5 minutes' },
  { value: 'z3plus_minutes',  label: 'Z3+ minutes' },
  { value: 'total_minutes',   label: 'Total minutes' },
]
const PERIODS = ['week', 'month', 'year', 'all_time']

export default function AchievementsAdminTable({ initialRules, eventTypes, locations }) {
  const [rules, setRules] = useState(initialRules)
  const [expandedId, setExpandedId] = useState(null)
  const [adding, setAdding] = useState(false)
  const [globalError, setGlobalError] = useState(null)
  const [busyMap, setBusyMap] = useState({})

  function setBusy(id, state) {
    setBusyMap((m) => ({ ...m, [id]: state }))
  }

  async function refresh() {
    const res = await fetch('/api/admin/achievements')
    const json = await res.json()
    if (json.ok) setRules(json.rules)
  }

  async function patchRule(id, patch) {
    setBusy(id, 'saving')
    setGlobalError(null)
    const res = await fetch(`/api/admin/achievements/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const json = await res.json()
    setBusy(id, null)
    if (!json.ok) {
      setGlobalError(json.error || 'Update failed')
      return false
    }
    setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...json.rule } : r)))
    return true
  }

  async function createRule(payload) {
    setGlobalError(null)
    const res = await fetch('/api/admin/achievements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const json = await res.json()
    if (!json.ok) {
      setGlobalError(json.error || 'Create failed')
      return false
    }
    await refresh()
    setAdding(false)
    return true
  }

  async function deleteRule(id, slug, earnedCount) {
    const msg = earnedCount > 0
      ? `Delete "${slug}"? This will remove ${earnedCount} earned achievement${earnedCount === 1 ? '' : 's'} from members. They'll lose this badge.`
      : `Delete "${slug}"?`
    if (!confirm(msg)) return
    setBusy(id, 'deleting')
    const res = await fetch(`/api/admin/achievements/${id}`, { method: 'DELETE' })
    const json = await res.json()
    setBusy(id, null)
    if (!json.ok) {
      setGlobalError(json.error || 'Delete failed')
      return
    }
    setRules((rs) => rs.filter((r) => r.id !== id))
  }

  async function moveRule(id, direction) {
    const idx = rules.findIndex((r) => r.id === id)
    const swap = direction === 'up' ? idx - 1 : idx + 1
    if (swap < 0 || swap >= rules.length) return
    const a = rules[idx]
    const b = rules[swap]
    // Swap sort_orders. If they're equal we still need distinct values,
    // so nudge by 1.
    const aOrder = a.sort_order
    const bOrder = b.sort_order === a.sort_order ? a.sort_order + (direction === 'up' ? -1 : 1) : b.sort_order
    await Promise.all([
      patchRule(a.id, { sort_order: bOrder }),
      patchRule(b.id, { sort_order: aOrder }),
    ])
    await refresh()
  }

  async function backfillRule(id, slug) {
    if (!confirm(`Backfill "${slug}" against all members? This grants the achievement retroactively to anyone who already qualifies.`)) return
    setBusy(id, 'backfilling')
    setGlobalError(null)
    const res = await fetch(`/api/admin/achievements/${id}/backfill`, { method: 'POST' })
    const json = await res.json()
    setBusy(id, null)
    if (!json.ok) {
      setGlobalError(json.error || 'Backfill failed')
      return
    }
    alert(`Backfill complete: granted ${json.granted} of ${json.candidates_total} candidates (skipped ${json.already_earned} who already had it).`)
    await refresh()
  }

  return (
    <div>
      {globalError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {globalError}
        </div>
      )}

      <TestPanel />

      <div className="mt-6 mb-3 flex items-center justify-between">
        <p className="text-sm text-un1t-subtle">{rules.length} rules ({rules.filter((r) => r.is_active).length} active)</p>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700"
          >
            <Plus size={14} /> New rule
          </button>
        )}
      </div>

      {adding && (
        <div className="mb-4 rounded-xl border border-neutral-300 bg-neutral-50 p-4">
          <RuleEditor
            isCreate
            eventTypes={eventTypes}
            locations={locations}
            onCancel={() => setAdding(false)}
            onSubmit={createRule}
          />
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase text-un1t-subtle">
            <tr>
              <th className="w-10 px-3 py-2"></th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Slug</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Tier</th>
              <th className="px-3 py-2 text-right">Earned</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r, i) => (
              <RuleRow
                key={r.id}
                rule={r}
                expanded={expandedId === r.id}
                onToggleExpand={() => setExpandedId(expandedId === r.id ? null : r.id)}
                onMoveUp={i > 0 ? () => moveRule(r.id, 'up') : null}
                onMoveDown={i < rules.length - 1 ? () => moveRule(r.id, 'down') : null}
                onToggleActive={() => patchRule(r.id, { is_active: !r.is_active })}
                onBackfill={() => backfillRule(r.id, r.slug)}
                onDelete={() => deleteRule(r.id, r.slug, r.earned_count)}
                onSubmitEdit={(patch) => patchRule(r.id, patch).then((ok) => ok && setExpandedId(null))}
                eventTypes={eventTypes}
                locations={locations}
                busy={busyMap[r.id]}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Single row ────────────────────────────────────────────────

function RuleRow({
  rule, expanded, onToggleExpand, onMoveUp, onMoveDown, onToggleActive,
  onBackfill, onDelete, onSubmitEdit, eventTypes, locations, busy,
}) {
  return (
    <>
      <tr className={`border-t border-neutral-200 ${rule.is_active ? '' : 'opacity-50'}`}>
        <td className="px-3 py-2">
          <div className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={onMoveUp}
              disabled={!onMoveUp}
              className="rounded p-0.5 text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 disabled:cursor-default"
              title="Move up"
            >
              <ArrowUp size={12} />
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={!onMoveDown}
              className="rounded p-0.5 text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 disabled:cursor-default"
              title="Move down"
            >
              <ArrowDown size={12} />
            </button>
          </div>
        </td>
        <td className="px-3 py-2 font-medium">{rule.name}</td>
        <td className="px-3 py-2 font-mono text-xs text-un1t-subtle">{rule.slug}</td>
        <td className="px-3 py-2 text-xs">{rule.category}</td>
        <td className="px-3 py-2 text-xs">{rule.rule_type}</td>
        <td className="px-3 py-2 text-xs">T{rule.tier}</td>
        <td className="px-3 py-2 text-right tabular-nums">{rule.earned_count}</td>
        <td className="px-3 py-2 text-right">
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={onToggleActive}
              className="rounded p-1 text-neutral-500 hover:bg-neutral-100"
              title={rule.is_active ? 'Deactivate' : 'Activate'}
            >
              {rule.is_active ? <Power size={14} className="text-emerald-600" /> : <PowerOff size={14} />}
            </button>
            <button
              type="button"
              onClick={onBackfill}
              disabled={busy === 'backfilling'}
              className="rounded p-1 text-neutral-500 hover:bg-neutral-100 disabled:opacity-50"
              title="Backfill against all members"
            >
              {busy === 'backfilling' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            </button>
            <button
              type="button"
              onClick={onToggleExpand}
              className="rounded p-1 text-neutral-500 hover:bg-neutral-100"
              title="Edit"
            >
              <Pencil size={14} />
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={busy === 'deleting'}
              className="rounded p-1 text-red-600 hover:bg-red-50 disabled:opacity-50"
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-neutral-200 bg-neutral-50">
          <td colSpan={8} className="px-3 py-3">
            <RuleEditor
              rule={rule}
              eventTypes={eventTypes}
              locations={locations}
              onCancel={onToggleExpand}
              onSubmit={onSubmitEdit}
            />
          </td>
        </tr>
      )}
    </>
  )
}

// ── Editor (used for both add + edit) ─────────────────────────

function RuleEditor({ rule, isCreate, eventTypes, locations, onCancel, onSubmit }) {
  const [form, setForm] = useState(() => ({
    slug: rule?.slug || '',
    name: rule?.name || '',
    description: rule?.description || '',
    icon: rule?.icon || '',
    category: rule?.category || 'milestone',
    family: rule?.family || '',
    tier: rule?.tier || 1,
    rule_type: rule?.rule_type || 'first_event',
    rule_config: rule?.rule_config || {},
    is_active: rule?.is_active !== false,
    sort_order: rule?.sort_order || 0,
  }))
  const [busy, setBusy] = useState(false)

  function field(k, v) { setForm((f) => ({ ...f, [k]: v })) }

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    const payload = isCreate ? form : {
      // On edit we don't send slug or rule_type (we lock those).
      name: form.name, description: form.description, icon: form.icon,
      category: form.category, family: form.family, tier: form.tier,
      rule_config: form.rule_config, is_active: form.is_active,
      sort_order: form.sort_order,
    }
    await onSubmit(payload)
    setBusy(false)
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Name" required>
          <input
            type="text" required
            value={form.name}
            onChange={(e) => field('name', e.target.value)}
            className="ipt"
          />
        </Field>
        <Field label="Slug" hint={isCreate ? 'lowercase_underscored, immutable' : 'cannot be changed'}>
          <input
            type="text"
            value={form.slug}
            onChange={(e) => field('slug', e.target.value)}
            disabled={!isCreate}
            className="ipt font-mono text-xs"
          />
        </Field>
        <Field label="Category">
          <select
            value={form.category}
            onChange={(e) => field('category', e.target.value)}
            className="ipt"
          >
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
      </div>

      <Field label="Description">
        <textarea
          rows={2}
          value={form.description}
          onChange={(e) => field('description', e.target.value)}
          className="ipt"
        />
      </Field>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <Field label="Icon" hint="Lucide name (e.g. Heart, Flame, Trophy)">
          <input
            type="text"
            value={form.icon}
            onChange={(e) => field('icon', e.target.value)}
            className="ipt"
          />
        </Field>
        <Field label="Family" hint="groups tiers">
          <input
            type="text"
            value={form.family}
            onChange={(e) => field('family', e.target.value)}
            className="ipt"
          />
        </Field>
        <Field label="Tier (1–4)">
          <input
            type="number" min="1" max="4"
            value={form.tier}
            onChange={(e) => field('tier', parseInt(e.target.value, 10))}
            className="ipt"
          />
        </Field>
        <Field label="Sort order">
          <input
            type="number"
            value={form.sort_order}
            onChange={(e) => field('sort_order', parseInt(e.target.value, 10))}
            className="ipt"
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Rule type" hint={isCreate ? '' : 'cannot be changed'}>
          <select
            value={form.rule_type}
            onChange={(e) => field('rule_type', e.target.value)}
            disabled={!isCreate}
            className="ipt"
          >
            {RULE_TYPES.map((rt) => <option key={rt.value} value={rt.value}>{rt.label}</option>)}
          </select>
        </Field>
        <div className="md:col-span-2">
          <ConfigEditor
            ruleType={form.rule_type}
            config={form.rule_config}
            onChange={(c) => field('rule_config', c)}
            eventTypes={eventTypes}
            locations={locations}
          />
        </div>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {isCreate ? 'Create' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1 text-sm font-medium text-un1t-subtle hover:text-neutral-900"
        >
          <X size={14} /> Cancel
        </button>
        {!isCreate && (
          <label className="ml-auto inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => field('is_active', e.target.checked)}
            />
            Active
          </label>
        )}
      </div>

      <style jsx>{`
        :global(.ipt) {
          width: 100%; padding: 0.4rem 0.6rem;
          border: 1px solid #d4d4d8; border-radius: 6px;
          background: white; font-size: 0.875rem;
        }
        :global(.ipt:focus) { outline: none; border-color: #71717a; box-shadow: 0 0 0 1px #71717a; }
        :global(.ipt:disabled) { background: #f4f4f5; color: #71717a; }
      `}</style>
    </form>
  )
}

// ── ConfigEditor — switches form per rule_type ────────────────

function ConfigEditor({ ruleType, config, onChange, eventTypes, locations }) {
  function set(patch) { onChange({ ...config, ...patch }) }

  if (ruleType === 'first_event') {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Event">
          <select className="ipt" value={config.event || 'session'} onChange={(e) => set({ event: e.target.value, event_type_id: undefined, location_id: undefined })}>
            <option value="session">First session</option>
            <option value="z5_minute">First Z5 minute</option>
            <option value="class_type">First of a class type</option>
            <option value="location_visit">First visit to a location</option>
          </select>
        </Field>
        {config.event === 'class_type' && (
          <Field label="Class type">
            <select className="ipt" value={config.event_type_id || ''} onChange={(e) => set({ event_type_id: e.target.value || undefined })}>
              <option value="">Select…</option>
              {eventTypes.map((et) => <option key={et.id} value={et.id}>{et.name}</option>)}
            </select>
          </Field>
        )}
        {config.event === 'location_visit' && (
          <Field label="Location">
            <select className="ipt" value={config.location_id || ''} onChange={(e) => set({ location_id: e.target.value || undefined })}>
              <option value="">Select…</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
        )}
      </div>
    )
  }

  if (ruleType === 'streak') {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Days required" required>
          <input className="ipt" type="number" min="2" value={config.days || ''} onChange={(e) => set({ days: parseInt(e.target.value, 10) || 0 })} />
        </Field>
        <Field label="Gap tolerance (days)" hint="0 = strict consecutive">
          <input className="ipt" type="number" min="0" value={config.gap_tolerance_days || 0} onChange={(e) => set({ gap_tolerance_days: parseInt(e.target.value, 10) || 0 })} />
        </Field>
      </div>
    )
  }

  if (ruleType === 'aggregate_threshold') {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Field">
          <select className="ipt" value={config.field || 'effort_points'} onChange={(e) => set({ field: e.target.value })}>
            {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </Field>
        <Field label="Period">
          <select className="ipt" value={config.period || 'all_time'} onChange={(e) => set({ period: e.target.value })}>
            {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="Threshold" required>
          <input className="ipt" type="number" min="1" value={config.threshold || ''} onChange={(e) => set({ threshold: parseInt(e.target.value, 10) || 0 })} />
        </Field>
      </div>
    )
  }

  if (ruleType === 'session_property') {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Predicate">
          <select className="ipt" value={config.predicate || 'all_zones_present'} onChange={(e) => set({ predicate: e.target.value, threshold: undefined })}>
            <option value="all_zones_present">All zones present</option>
            <option value="sustained_z5">Sustained Z5 (seconds)</option>
            <option value="new_personal_record">New personal record (per class type)</option>
          </select>
        </Field>
        {config.predicate === 'sustained_z5' && (
          <Field label="Threshold (seconds)">
            <input className="ipt" type="number" min="60" value={config.threshold || 60} onChange={(e) => set({ threshold: parseInt(e.target.value, 10) || 60 })} />
          </Field>
        )}
      </div>
    )
  }

  if (ruleType === 'class_type_count') {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Class type" required>
          <select className="ipt" value={config.event_type_id || ''} onChange={(e) => set({ event_type_id: e.target.value || undefined })}>
            <option value="">Select…</option>
            {eventTypes.map((et) => <option key={et.id} value={et.id}>{et.name}</option>)}
          </select>
        </Field>
        <Field label="Count required">
          <input className="ipt" type="number" min="1" value={config.count || ''} onChange={(e) => set({ count: parseInt(e.target.value, 10) || 0 })} />
        </Field>
      </div>
    )
  }

  if (ruleType === 'location_visit') {
    return (
      <Field label="Distinct locations required">
        <input className="ipt" type="number" min="2" value={config.location_count || ''} onChange={(e) => set({ location_count: parseInt(e.target.value, 10) || 0 })} />
      </Field>
    )
  }

  return null
}

// ── Test panel: read-only "would Sarah unlock anything?" preview ──

function TestPanel() {
  const [contactId, setContactId] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [open, setOpen] = useState(false)

  async function run() {
    if (!contactId.trim()) return
    setBusy(true); setResult(null)
    const res = await fetch('/api/admin/achievements/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contact_id: contactId.trim() }),
    })
    const json = await res.json()
    setBusy(false)
    setResult(json)
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium hover:bg-neutral-50"
      >
        <span className="inline-flex items-center gap-2"><FlaskConical size={14} /> Test against contact (read-only preview)</span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="border-t border-neutral-200 px-4 py-3">
          <p className="mb-3 text-xs text-un1t-subtle">
            Paste a contact ID. We&apos;ll run every active rule against
            their session history and show what would unlock — without
            writing anything.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              placeholder="contact uuid"
              className="ipt font-mono text-xs"
              style={{ flex: 1 }}
            />
            <button
              type="button"
              onClick={run}
              disabled={busy || !contactId.trim()}
              className="inline-flex items-center gap-1 rounded-md bg-neutral-900 px-3 py-2 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />}
              Run
            </button>
          </div>

          {result && !result.ok && (
            <p className="mt-3 text-sm text-red-600">{result.error}</p>
          )}
          {result?.ok && result.fired.length === 0 && (
            <p className="mt-3 text-sm text-un1t-subtle">
              No rules would fire for this contact ({result.sessions_in_window} sessions in window).
            </p>
          )}
          {result?.ok && result.fired.length > 0 && (
            <div className="mt-3">
              <p className="mb-2 text-xs text-un1t-subtle">
                {result.fired.length} rule{result.fired.length === 1 ? '' : 's'} would fire (across {result.sessions_in_window} sessions):
              </p>
              <ul className="space-y-1">
                {result.fired.map((f) => (
                  <li key={f.rule_id} className="flex items-center justify-between rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm">
                    <span className="inline-flex items-center gap-2">
                      <CheckCircle2 size={14} className={f.already_earned_at ? 'text-neutral-400' : 'text-emerald-600'} />
                      <span className="font-medium">{f.name}</span>
                      <span className="font-mono text-xs text-un1t-subtle">{f.slug}</span>
                    </span>
                    {f.already_earned_at && (
                      <span className="text-xs text-un1t-subtle">already earned {new Date(f.already_earned_at).toLocaleDateString()}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <style jsx>{`
        :global(.ipt) {
          width: 100%; padding: 0.4rem 0.6rem;
          border: 1px solid #d4d4d8; border-radius: 6px;
          background: white; font-size: 0.875rem;
        }
      `}</style>
    </div>
  )
}

// ── Field label primitive ─────────────────────────────────────

function Field({ label, hint, required, children }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-xs font-medium text-neutral-700">
        {label}{required && <span className="text-red-600"> *</span>}
        {hint && <span className="ml-2 font-normal text-un1t-subtle">{hint}</span>}
      </span>
      {children}
    </label>
  )
}
