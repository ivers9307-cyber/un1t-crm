'use client'

// Attendance report — table view with date range + status filter +
// CSV export. Reads /api/attendance which already does the bucketing.

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Download, RefreshCw } from 'lucide-react'

const STATUS_META = {
  on_time:  { label: 'On time', cls: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  late:     { label: 'Late',    cls: 'bg-amber-100  text-amber-800  border-amber-200' },
  no_show:  { label: 'No-show', cls: 'bg-red-100    text-red-800    border-red-200' },
  pending:  { label: 'Pending', cls: 'bg-neutral-100 text-neutral-700 border-neutral-200' },
}

function defaultFromIso() {
  const d = new Date(Date.now() - 14 * 24 * 3600_000)
  return d.toISOString().slice(0, 10)
}
function todayIso() { return new Date().toISOString().slice(0, 10) }

export default function AttendanceReportClient({ activeLocationName }) {
  const [from, setFrom] = useState(defaultFromIso())
  const [to, setTo]     = useState(todayIso())
  const [statusFilter, setStatusFilter] = useState('all') // all | on_time | late | no_show | pending
  const [profileFilter, setProfileFilter] = useState('') // free-text search by name
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  async function load() {
    setLoading(true); setError(null)
    try {
      const url = new URL('/api/attendance', window.location.origin)
      url.searchParams.set('from', from)
      url.searchParams.set('to', to)
      const res = await fetch(url.toString(), { cache: 'no-store' })
      const json = await res.json()
      if (!json.success) throw new Error(json.error || 'failed')
      setData(json)
    } catch (e) {
      setError(e.message || 'Network error')
    } finally {
      setLoading(false)
    }
  }

  // Initial + on-change load. `load` is defined in this component so
  // it's stable across renders; refiring only when the from/to window
  // changes is intentional. Excluding `load` from the deps avoids the
  // refire-loop that would happen if the linter auto-fix added it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [from, to])

  const filtered = useMemo(() => {
    if (!data?.rows) return []
    let rows = data.rows
    if (statusFilter !== 'all') rows = rows.filter((r) => r.status === statusFilter)
    if (profileFilter.trim()) {
      const q = profileFilter.toLowerCase()
      rows = rows.filter((r) => r.profile_name.toLowerCase().includes(q))
    }
    return rows
  }, [data, statusFilter, profileFilter])

  function downloadCsv() {
    const header = ['Date', 'Staff', 'Role', 'Scheduled start', 'Actual start', 'Status', 'Minutes late']
    const lines = [header.join(',')]
    for (const r of filtered) {
      lines.push([
        r.block_date,
        csvEscape(r.profile_name),
        r.profile_role || '',
        r.scheduled_start,
        r.actual_start || '',
        r.status,
        r.minutes_late ?? '',
      ].join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `attendance_${from}_to_${to}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 bg-white p-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-700">From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-700">To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-700">Status</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm">
            <option value="all">All</option>
            <option value="late">Late</option>
            <option value="on_time">On time</option>
            <option value="no_show">No-show</option>
            <option value="pending">Pending</option>
          </select>
        </div>
        <div className="min-w-[200px] flex-1">
          <label className="mb-1 block text-xs font-medium text-neutral-700">Search staff</label>
          <input type="search" value={profileFilter} onChange={(e) => setProfileFilter(e.target.value)}
            placeholder="Name…"
            className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm" />
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={load} disabled={loading}
            className="inline-flex items-center gap-1 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Refresh
          </button>
          <button type="button" onClick={downloadCsv} disabled={!filtered.length}
            className="inline-flex items-center gap-1 rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50">
            <Download size={14} /> CSV
          </button>
        </div>
      </div>

      {/* Summary tiles */}
      {data?.summary && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <SummaryTile label="Shifts" value={data.summary.total} />
          <SummaryTile label="On time" value={data.summary.on_time} accent="emerald" />
          <SummaryTile label="Late" value={data.summary.late} accent="amber" />
          <SummaryTile label="No-show" value={data.summary.no_show} accent="red" />
          <SummaryTile label="Pending" value={data.summary.pending} accent="neutral" />
        </div>
      )}

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase text-un1t-light">
            <tr>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Staff</th>
              <th className="px-3 py-2">Scheduled</th>
              <th className="px-3 py-2">Actual</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2 text-right">Minutes late</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && !loading && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-un1t-light">No shifts in this window.</td></tr>
            )}
            {filtered.map((r) => (
              <tr key={r.assignment_id} className="border-t border-neutral-200">
                <td className="px-3 py-2 tabular-nums">{r.block_date}</td>
                <td className="px-3 py-2">
                  <span className="font-medium">{r.profile_name}</span>
                  {r.profile_role && <span className="ml-2 text-xs text-un1t-light">{r.profile_role}</span>}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{(r.scheduled_start || '').slice(0, 5)}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.actual_start ? r.actual_start.slice(0, 5) : '—'}</td>
                <td className="px-3 py-2">
                  <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_META[r.status]?.cls || ''}`}>
                    {STATUS_META[r.status]?.label || r.status}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <SourceBadges sources={r.sources} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.minutes_late == null ? '—' : (r.minutes_late > 0 ? `+${r.minutes_late}` : r.minutes_late)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* P2.7 — Tailgate / unmatched-Protect surfacing.
          Protect events where the face wasn't enrolled at this
          location. Three legitimate causes: actual tailgate (member
          walks in behind a staff card-tap), staff member not yet in
          the Protect face library, or staff face enrolled but not
          linked in the CRM (operator forgot the ProtectFacePicker).
          Show them in a panel below the main report so the operator
          either enrols/links the face or investigates. */}
      {data?.tailgates?.length > 0 && (
        <TailgatesPanel tailgates={data.tailgates} totalCount={data.tailgate_count} />
      )}

      <p className="mt-3 text-xs text-un1t-light">
        Showing data for <strong>{activeLocationName || data?.location?.name || 'active location'}</strong>.
        Switch locations with the location picker to see other studios.
      </p>
    </div>
  )
}

function SummaryTile({ label, value, accent }) {
  const cls =
    accent === 'emerald' ? 'border-emerald-200 bg-emerald-50' :
    accent === 'amber'   ? 'border-amber-200 bg-amber-50' :
    accent === 'red'     ? 'border-red-200 bg-red-50' :
    accent === 'neutral' ? 'border-neutral-200 bg-neutral-50' :
                            'border-neutral-200 bg-white'
  return (
    <div className={`rounded-lg border px-3 py-2 ${cls}`}>
      <p className="text-xs uppercase tracking-wide text-neutral-600">{label}</p>
      <p className="mt-0.5 text-2xl font-bold tabular-nums">{value ?? 0}</p>
    </div>
  )
}

// P2.6 — Source badges per stamped shift. Multiple sources can
// contribute when both Access (card tap) and Protect (face match)
// fire within seconds — we surface both so the operator can see
// the corroboration.
function SourceBadges({ sources }) {
  if (!sources || sources.length === 0) {
    return <span className="text-xs text-un1t-light">—</span>
  }
  const meta = {
    unifi_access: { label: 'Access', cls: 'bg-blue-50 text-blue-800 border-blue-200',  title: 'Card tap (UniFi Access)' },
    protect:      { label: 'Face',   cls: 'bg-purple-50 text-purple-800 border-purple-200', title: 'Face match (UniFi Protect)' },
    manual:       { label: 'Manual', cls: 'bg-neutral-100 text-neutral-700 border-neutral-200', title: 'Manually entered' },
  }
  return (
    <div className="flex flex-wrap gap-1">
      {sources.map((s) => {
        const m = meta[s] || { label: s, cls: 'bg-neutral-100 text-neutral-700 border-neutral-200', title: s }
        return (
          <span key={s} title={m.title}
                className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium ${m.cls}`}>
            {m.label}
          </span>
        )
      })}
    </div>
  )
}

// P2.7 — Tailgate / unmatched-Protect panel.
function TailgatesPanel({ tailgates, totalCount }) {
  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-amber-200 bg-amber-50">
      <div className="px-3 py-2 border-b border-amber-200 bg-amber-100/50 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-amber-900">
            Unmatched face-recognition events ({totalCount})
          </h3>
          <p className="text-xs text-amber-800 mt-0.5">
            Camera saw a face that isn&apos;t enrolled OR isn&apos;t linked to a CRM staff profile. Could be a tailgate (member walks in behind a staff tap), an unenrolled staff member, or a missing CRM link.
          </p>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-amber-100/30 text-left text-xs uppercase text-amber-900/80">
          <tr>
            <th className="px-3 py-2">When</th>
            <th className="px-3 py-2">Camera</th>
            <th className="px-3 py-2">Face id</th>
            <th className="px-3 py-2">Event type</th>
          </tr>
        </thead>
        <tbody>
          {tailgates.map((t) => (
            <tr key={t.id} className="border-t border-amber-200">
              <td className="px-3 py-2 tabular-nums text-xs">{new Date(t.event_at).toLocaleString()}</td>
              <td className="px-3 py-2 font-mono text-xs">{t.camera_id || '—'}</td>
              <td className="px-3 py-2 font-mono text-xs">
                {t.face_id ? (t.face_id.length > 16 ? t.face_id.slice(0, 12) + '…' : t.face_id) : <span className="text-amber-700/70">no face id</span>}
              </td>
              <td className="px-3 py-2 text-xs">{t.event_type || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 text-[11px] text-amber-800 bg-amber-100/30 border-t border-amber-200">
        To resolve: copy a face id, open the staff member&apos;s profile, paste it into the Protect face picker. Or enrol them in UniFi Protect → Cameras → Smart Detections → Known Faces first if the face id isn&apos;t known yet.
      </p>
    </div>
  )
}

function csvEscape(s) {
  const v = String(s ?? '')
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}
