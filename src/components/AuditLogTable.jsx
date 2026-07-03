'use client'

// AuditLogTable — interactive client component for the unified
// audit log viewer at /admin/audit-log.
//
// AUDIT-EXPAND.1: previously a viewer for assignment_change_log
// only; now reads from audit_events which covers auth, business,
// mutation, and assignment events. The filter bar gains a
// Category control to slice by top-level event type, and the
// Action dropdown is populated dynamically from facets returned by
// the API (so newly-instrumented actions show up without a code
// change here).
//
// Expandable rows render the JSONB `details` payload. For
// assignment + mutation events `details` carries `before` / `after`
// snapshots; for auth + business events it's whatever the
// instrumentation site supplied. The panel handles both shapes.

import { useEffect, useMemo, useState } from 'react'
import { Download, ChevronDown, ChevronRight, RefreshCw, AlertCircle, Loader2 } from 'lucide-react'

const CATEGORY_LABELS = {
  auth: 'Authentication',
  business: 'Business event',
  mutation: 'Data mutation',
  assignment: 'Assignment / role',
}

const CATEGORY_OPTIONS = [
  { value: '', label: 'All categories' },
  { value: 'auth', label: CATEGORY_LABELS.auth },
  { value: 'business', label: CATEGORY_LABELS.business },
  { value: 'mutation', label: CATEGORY_LABELS.mutation },
  { value: 'assignment', label: CATEGORY_LABELS.assignment },
]

// Friendly labels for known actions. Anything not in this map
// falls through to the raw action key (e.g. 'contract.issued').
const ACTION_LABELS = {
  // legacy assignment events (still present from mig 080 backfill)
  'assignment.assignment_create': 'Assignment created',
  'assignment.assignment_update': 'Assignment updated',
  'assignment.assignment_delete': 'Assignment deleted',
  'assignment.master_promote': 'Master promoted',
  'assignment.master_demote': 'Master demoted',
  'assignment.profile_deactivate': 'Profile deactivated',
  'assignment.profile_reactivate': 'Profile reactivated',
  // auth
  'auth.sign_in': 'Sign-in',
  'auth.sign_out': 'Sign-out',
  'auth.password_reset_requested': 'Password reset requested',
  'auth.password_changed': 'Password changed',
  'auth.impersonate_start': 'Impersonation started',
  'auth.impersonate_stop': 'Impersonation stopped',
  'master.granted': 'Master granted',
  'master.revoked': 'Master revoked',
  // business
  'contract.issued': 'Contract issued',
  'contract.signed': 'Contract signed',
  'contract.declined': 'Contract declined',
  'contract.revoked': 'Contract revoked',
  'policy.published': 'Policy version published',
  'profile.deactivated': 'Profile deactivated',
  'profile.reactivated': 'Profile reactivated',
  'permissions.updated': 'Permissions updated',
}

function fmtDt(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-IE', {
      timeZone: 'Europe/Dublin',
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  } catch {
    return iso
  }
}

export default function AuditLogTable({ staff, locations }) {
  const [filters, setFilters] = useState({
    actor_id: '',
    target_profile_id: '',
    location_id: '',
    category: '',
    action: '',
    from: '',
    to: '',
  })
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 50

  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState(new Set())
  const [facetActions, setFacetActions] = useState([])

  async function fetchRows() {
    setLoading(true)
    setError(null)
    try {
      // AUDIT-DATE-FIX — `from` and `to` live in state as the native
      // datetime-local string (YYYY-MM-DDTHH:MM, local time). Convert
      // to ISO only here at the API boundary; everywhere else keeps
      // the input-friendly shape so the picker can round-trip cleanly.
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(filters)) {
        if (!v) continue
        if (k === 'from' || k === 'to') {
          const iso = toApiDate(v)
          if (iso) params.set(k, iso)
        } else {
          params.set(k, v)
        }
      }
      params.set('page', String(page))
      params.set('page_size', String(PAGE_SIZE))
      const r = await fetch(`/api/admin/audit-log?${params}`)
      const body = await r.json()
      if (!r.ok || body.success === false) {
        throw new Error(body.error || `Fetch failed (${r.status})`)
      }
      setRows(body.data || [])
      setTotal(body.total || 0)
      // Facets only come back on page=1; otherwise leave the
      // existing dropdown alone so the user's choice doesn't reset.
      if (body.facets?.actions) setFacetActions(body.facets.actions)
    } catch (e) {
      setError(e.message || 'Fetch failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchRows() }, [page]) // eslint-disable-line

  function applyFilters() {
    setPage(1)
    fetchRows()
  }
  function resetFilters() {
    setFilters({
      actor_id: '', target_profile_id: '', location_id: '',
      category: '', action: '', from: '', to: '',
    })
    setPage(1)
    setTimeout(fetchRows, 0)
  }
  function toggleExpand(id) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleExportCsv() {
    // Same ISO conversion as fetchRows — see comment there.
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(filters)) {
      if (!v) continue
      if (k === 'from' || k === 'to') {
        const iso = toApiDate(v)
        if (iso) params.set(k, iso)
      } else {
        params.set(k, v)
      }
    }
    params.set('format', 'csv')
    // Trigger a regular download via window.location — the route's
    // Content-Disposition header makes the browser save it.
    window.location.href = `/api/admin/audit-log?${params}`
  }

  // Action options derive from the facets the API returns, scoped
  // to the active category. If the user changes category we reset
  // the action filter so a stale value doesn't survive.
  const actionOptions = useMemo(() => {
    const base = [{ value: '', label: 'All actions' }]
    for (const a of facetActions) {
      base.push({ value: a, label: ACTION_LABELS[a] || a })
    }
    return base
  }, [facetActions])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
      {/* Filters */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <FilterSelect
          label="Category"
          value={filters.category}
          onChange={(v) => setFilters({ ...filters, category: v, action: '' })}
          options={CATEGORY_OPTIONS}
        />
        <FilterSelect
          label="Action"
          value={filters.action}
          onChange={(v) => setFilters({ ...filters, action: v })}
          options={actionOptions}
        />
        <FilterSelect
          label="Actor"
          value={filters.actor_id}
          onChange={(v) => setFilters({ ...filters, actor_id: v })}
          options={[{ value: '', label: 'Anyone' }, ...staff.map((s) => ({ value: s.id, label: s.full_name }))]}
        />
        <FilterSelect
          label="Affected user"
          value={filters.target_profile_id}
          onChange={(v) => setFilters({ ...filters, target_profile_id: v })}
          options={[{ value: '', label: 'Anyone' }, ...staff.map((s) => ({ value: s.id, label: s.full_name }))]}
        />
        <FilterSelect
          label="Location"
          value={filters.location_id}
          onChange={(v) => setFilters({ ...filters, location_id: v })}
          options={[{ value: '', label: 'Any location' }, ...locations.map((l) => ({ value: l.id, label: l.name }))]}
        />
        <FilterDate
          label="From"
          value={filters.from}
          onChange={(v) => setFilters({ ...filters, from: v })}
        />
        <FilterDate
          label="To"
          value={filters.to}
          onChange={(v) => setFilters({ ...filters, to: v })}
        />
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={applyFilters}
            disabled={loading}
            className="text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium disabled:opacity-40"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={resetFilters}
            disabled={loading}
            className="text-xs text-un1t-subtle hover:text-un1t-text disabled:opacity-40"
          >
            Reset
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={loading || total === 0}
            className="text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1 disabled:opacity-40"
            title="Download the current filtered set as CSV"
          >
            <Download size={12} /> Export CSV
          </button>
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between mb-3 text-xs text-un1t-subtle">
        <div>
          {loading ? (
            <span className="inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> Loading…</span>
          ) : (
            <span>{total.toLocaleString()} entries</span>
          )}
        </div>
        <button
          type="button"
          onClick={fetchRows}
          disabled={loading}
          className="text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1 disabled:opacity-40"
          title="Reload"
        >
          <RefreshCw size={11} /> Reload
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded-md p-2 mb-3 inline-flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-un1t-subtle text-[11px] uppercase tracking-wider">
              <th className="text-left p-2 w-6"></th>
              <th className="text-left p-2 whitespace-nowrap">When</th>
              <th className="text-left p-2 whitespace-nowrap">Category</th>
              <th className="text-left p-2 whitespace-nowrap">Actor</th>
              <th className="text-left p-2 whitespace-nowrap">Action</th>
              <th className="text-left p-2 whitespace-nowrap">Affected user</th>
              <th className="text-left p-2 whitespace-nowrap">Location</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-un1t-border/40">
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-un1t-subtle text-sm">
                  No audit entries match the current filters.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const isOpen = expanded.has(r.id)
              return (
                <Row
                  key={r.id}
                  row={r}
                  isOpen={isOpen}
                  onToggle={() => toggleExpand(r.id)}
                />
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-4 text-xs text-un1t-subtle">
          <div>Page {page} of {totalPages}</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={loading || page === 1}
              className="text-xs px-2 py-1 rounded bg-un1t-bg border border-un1t-border hover:border-un1t-muted disabled:opacity-40"
            >
              ← Prev
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={loading || page === totalPages}
              className="text-xs px-2 py-1 rounded bg-un1t-bg border border-un1t-border hover:border-un1t-muted disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ row, isOpen, onToggle }) {
  const actorName = row.actor?.full_name || row.actor_label
  const targetName = row.target?.full_name || row.target_label
  // Details may carry the legacy { before, after } shape (assignment
  // events) OR be a flat payload (auth/business). Detect and render.
  const details = row.details || null
  const hasBeforeAfter = details && (Object.prototype.hasOwnProperty.call(details, 'before')
    || Object.prototype.hasOwnProperty.call(details, 'after'))
  return (
    <>
      <tr className="hover:bg-un1t-border/10 cursor-pointer" onClick={onToggle}>
        <td className="p-2 text-un1t-subtle">
          {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </td>
        <td className="p-2 whitespace-nowrap font-mono text-[11px]">{fmtDt(row.occurred_at)}</td>
        <td className="p-2 whitespace-nowrap">
          <CategoryPill category={row.category} />
        </td>
        <td className="p-2 whitespace-nowrap">
          {actorName ? (
            <span title={row.actor?.email || row.actor_label || ''}>{actorName}</span>
          ) : (
            <span className="text-un1t-muted italic">system</span>
          )}
        </td>
        <td className="p-2 whitespace-nowrap">
          <span className="text-[11px] text-un1t-text">{ACTION_LABELS[row.action] || row.action}</span>
        </td>
        <td className="p-2 whitespace-nowrap">
          {targetName ? (
            <span title={row.target?.email || ''}>{targetName}</span>
          ) : (
            <span className="text-un1t-muted">—</span>
          )}
        </td>
        <td className="p-2 whitespace-nowrap">
          {row.location ? row.location.name : <span className="text-un1t-muted">—</span>}
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={7} className="p-3 bg-un1t-bg/40">
            {hasBeforeAfter ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
                <DiffPanel title="Before" data={details.before} />
                <DiffPanel title="After" data={details.after} />
              </div>
            ) : (
              <DetailsPanel row={row} />
            )}
          </td>
        </tr>
      )}
    </>
  )
}

function CategoryPill({ category }) {
  const styles = {
    auth: 'bg-blue-500/10 text-blue-700 border-blue-500/30',
    business: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
    mutation: 'bg-orange-500/10 text-orange-700 border-orange-500/30',
    assignment: 'bg-purple-500/10 text-purple-700 border-purple-500/30',
  }
  const cls = styles[category] || 'bg-un1t-border/20 text-un1t-subtle border-un1t-border'
  return (
    <span className={`text-[10px] uppercase tracking-wider border rounded px-1.5 py-0.5 ${cls}`}>
      {category || '—'}
    </span>
  )
}

function DetailsPanel({ row }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-un1t-subtle mb-1">Details</div>
        <pre className="bg-un1t-bg border border-un1t-border rounded p-2 text-[10px] text-un1t-text whitespace-pre-wrap break-words font-mono leading-relaxed">
          {row.details
            ? JSON.stringify(row.details, null, 2)
            : <span className="text-un1t-muted italic">(none)</span>}
        </pre>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wider text-un1t-subtle mb-1">Context</div>
        <dl className="bg-un1t-bg border border-un1t-border rounded p-2 text-[11px] grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
          <dt className="text-un1t-subtle">Resource</dt>
          <dd className="text-un1t-text font-mono break-all">{row.target_resource || '—'}</dd>
          <dt className="text-un1t-subtle">IP</dt>
          <dd className="text-un1t-text font-mono">{row.ip_address || '—'}</dd>
          <dt className="text-un1t-subtle">User agent</dt>
          <dd className="text-un1t-text break-words">{row.user_agent || '—'}</dd>
        </dl>
      </div>
    </div>
  )
}

function DiffPanel({ title, data }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-un1t-subtle mb-1">{title}</div>
      <pre className="bg-un1t-bg border border-un1t-border rounded p-2 text-[10px] text-un1t-text whitespace-pre-wrap break-words font-mono leading-relaxed">
        {data ? JSON.stringify(data, null, 2) : <span className="text-un1t-muted italic">(none)</span>}
      </pre>
    </div>
  )
}

function FilterSelect({ label, value, onChange, options }) {
  return (
    <label className="block">
      <div className="text-[11px] text-un1t-subtle mb-1">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full text-xs bg-un1t-bg border border-un1t-border rounded px-2 py-1.5 text-un1t-text"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

// AUDIT-DATE-FIX — `<input type="datetime-local">` expects values in
// the form `YYYY-MM-DDTHH:MM` (local-time, no seconds or tz). The
// previous version of this component converted the input value to an
// ISO 8601 string (`new Date(value).toISOString()`) on every change
// and fed that ISO string back to the input. The browser rejected the
// out-of-spec value, the input rendered empty, and the user could
// never lock in a date.
//
// Fix: store the input's NATIVE local-time string in state. Convert
// to ISO ONLY at the moment the value leaves the component (the
// audit-log API call), via the helper exported below. That way the
// round-trip into the input stays valid and the picker locks in.
function FilterDate({ label, value, onChange }) {
  return (
    <label className="block">
      <div className="text-[11px] text-un1t-subtle mb-1">{label}</div>
      <input
        type="datetime-local"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full text-xs bg-un1t-bg border border-un1t-border rounded px-2 py-1.5 text-un1t-text"
      />
    </label>
  )
}

// Convert the input's `YYYY-MM-DDTHH:MM` (local time) into the ISO
// string the API expects. Empty string → '' (signal "no filter").
function toApiDate(localValue) {
  if (!localValue) return ''
  const d = new Date(localValue)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString()
}
