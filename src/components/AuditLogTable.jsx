'use client'

// AuditLogTable — interactive client component for the
// assignment_change_log viewer at /admin/audit-log. Filters,
// pagination, expandable rows showing the before/after diff, and
// CSV export.
//
// All reads go through /api/admin/audit-log; the parent page
// pre-loads only the dropdown source data (staff, locations) so the
// dropdowns render without an extra fetch.

import { useEffect, useState } from 'react'
import { Download, ChevronDown, ChevronRight, RefreshCw, AlertCircle, Loader2 } from 'lucide-react'

const ACTION_OPTIONS = [
  { value: '', label: 'All actions' },
  { value: 'assignment_create', label: 'Assignment created' },
  { value: 'assignment_update', label: 'Assignment updated' },
  { value: 'assignment_delete', label: 'Assignment deleted' },
  { value: 'master_promote', label: 'Master promoted' },
  { value: 'master_demote', label: 'Master demoted' },
  { value: 'profile_deactivate', label: 'Profile deactivated' },
  { value: 'profile_reactivate', label: 'Profile reactivated' },
]

const ACTION_LABELS = Object.fromEntries(ACTION_OPTIONS.map((o) => [o.value, o.label]))

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

  async function fetchRows() {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(filters)) {
        if (v) params.set(k, v)
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
    setFilters({ actor_id: '', target_profile_id: '', location_id: '', action: '', from: '', to: '' })
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
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(filters)) {
      if (v) params.set(k, v)
    }
    params.set('format', 'csv')
    // Trigger a regular download via window.location — the route's
    // Content-Disposition header makes the browser save it.
    window.location.href = `/api/admin/audit-log?${params}`
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
      {/* Filters */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
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
        <FilterSelect
          label="Action"
          value={filters.action}
          onChange={(v) => setFilters({ ...filters, action: v })}
          options={ACTION_OPTIONS}
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
        <div className="col-span-2 flex items-end gap-2">
          <button
            type="button"
            onClick={applyFilters}
            disabled={loading}
            className="text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium disabled:opacity-40"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={resetFilters}
            disabled={loading}
            className="text-xs text-un1t-light hover:text-un1t-white disabled:opacity-40"
          >
            Reset
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={loading || total === 0}
            className="text-xs text-un1t-light hover:text-un1t-white inline-flex items-center gap-1 disabled:opacity-40"
            title="Download the current filtered set as CSV"
          >
            <Download size={12} /> Export CSV
          </button>
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between mb-3 text-xs text-un1t-light">
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
          className="text-xs text-un1t-light hover:text-un1t-white inline-flex items-center gap-1 disabled:opacity-40"
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
            <tr className="text-un1t-light text-[11px] uppercase tracking-wider">
              <th className="text-left p-2 w-6"></th>
              <th className="text-left p-2 whitespace-nowrap">When</th>
              <th className="text-left p-2 whitespace-nowrap">Actor</th>
              <th className="text-left p-2 whitespace-nowrap">Action</th>
              <th className="text-left p-2 whitespace-nowrap">Affected user</th>
              <th className="text-left p-2 whitespace-nowrap">Location</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-un1t-gray/40">
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-un1t-light text-sm">
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
        <div className="flex items-center justify-between mt-4 text-xs text-un1t-light">
          <div>Page {page} of {totalPages}</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={loading || page === 1}
              className="text-xs px-2 py-1 rounded bg-un1t-black border border-un1t-gray hover:border-un1t-mid disabled:opacity-40"
            >
              ← Prev
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={loading || page === totalPages}
              className="text-xs px-2 py-1 rounded bg-un1t-black border border-un1t-gray hover:border-un1t-mid disabled:opacity-40"
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
  return (
    <>
      <tr className="hover:bg-un1t-gray/10 cursor-pointer" onClick={onToggle}>
        <td className="p-2 text-un1t-light">
          {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </td>
        <td className="p-2 whitespace-nowrap font-mono text-[11px]">{fmtDt(row.created_at)}</td>
        <td className="p-2 whitespace-nowrap">
          {row.actor ? (
            <span title={row.actor.email}>{row.actor.full_name}</span>
          ) : (
            <span className="text-un1t-mid italic">system</span>
          )}
        </td>
        <td className="p-2 whitespace-nowrap">
          <span className="text-[11px] text-un1t-white">{ACTION_LABELS[row.action] || row.action}</span>
        </td>
        <td className="p-2 whitespace-nowrap">
          {row.target ? (
            <span title={row.target.email}>{row.target.full_name}</span>
          ) : (
            <span className="text-un1t-mid">—</span>
          )}
        </td>
        <td className="p-2 whitespace-nowrap">
          {row.location ? row.location.name : <span className="text-un1t-mid">—</span>}
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={6} className="p-3 bg-un1t-black/40">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
              <DiffPanel title="Before" data={row.before} />
              <DiffPanel title="After" data={row.after} />
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function DiffPanel({ title, data }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-un1t-light mb-1">{title}</div>
      <pre className="bg-un1t-black border border-un1t-gray rounded p-2 text-[10px] text-un1t-white whitespace-pre-wrap break-words font-mono leading-relaxed">
        {data ? JSON.stringify(data, null, 2) : <span className="text-un1t-mid italic">(none)</span>}
      </pre>
    </div>
  )
}

function FilterSelect({ label, value, onChange, options }) {
  return (
    <label className="block">
      <div className="text-[11px] text-un1t-light mb-1">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full text-xs bg-un1t-black border border-un1t-gray rounded px-2 py-1.5 text-un1t-white"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

function FilterDate({ label, value, onChange }) {
  return (
    <label className="block">
      <div className="text-[11px] text-un1t-light mb-1">{label}</div>
      <input
        type="datetime-local"
        value={value}
        onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : '')}
        className="w-full text-xs bg-un1t-black border border-un1t-gray rounded px-2 py-1.5 text-un1t-white"
      />
    </label>
  )
}
