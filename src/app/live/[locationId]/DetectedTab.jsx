// src/app/live/[locationId]/DetectedTab.jsx
'use client'

// HR-DETECT.1 — durable "Detected" tab: every strap the bridge has recorded at
// this location (linked or not), with appearance history + linking. Polls
// /api/live/[id]/detections slower than the 2s live board.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plug, ChevronDown, ChevronRight, Link2, Check } from 'lucide-react'

const POLL_MS = 12000

export default function DetectedTab({ locationId, contacts }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('all')   // all | unlinked | live
  const [query, setQuery] = useState('')
  const [linking, setLinking] = useState(null)   // detection row being linked

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/live/${locationId}/detections`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || 'Failed to load detections')
      setRows(json.detections || [])
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [locationId])

  useEffect(() => {
    load()
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      if (filter === 'unlinked' && r.linked_contact) return false
      if (filter === 'live' && !r.live_now) return false
      if (q) {
        const hay = `${r.last_name || ''} ${r.device_key} ${r.linked_contact?.name || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [rows, filter, query])

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-center gap-2">
        <Plug size={16} className="text-un1t-subtle" />
        <h2 className="text-sm font-semibold">Detected heart-rate devices</h2>
        <span className="ml-auto text-xs text-un1t-subtle">{filtered.length} shown</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {[['all', 'All'], ['unlinked', 'Unlinked'], ['live', 'Live now']].map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${filter === key ? 'bg-un1t-accent text-white' : 'border border-un1t-border bg-white text-un1t-subtle hover:bg-un1t-surface'}`}
          >
            {label}
          </button>
        ))}
        <input
          type="search"
          placeholder="Search name or key…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="ml-auto w-44 rounded-md border border-un1t-border bg-white px-3 py-1 text-sm"
        />
      </div>

      {error && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}

      {loading && rows.length === 0 ? (
        <p className="mt-8 text-center text-sm text-un1t-subtle">Loading detections…</p>
      ) : filtered.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-dashed border-un1t-border bg-white p-10 text-center">
          <p className="font-medium">No detections{filter !== 'all' ? ' match this filter' : ' yet'}</p>
          <p className="mt-1 text-sm text-un1t-subtle">Straps appear here once the bridge sees them broadcasting during a class.</p>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-un1t-border rounded-2xl border border-un1t-border bg-white">
          {filtered.map((r) => (
            <DetectionRow key={r.id} row={r} locationId={locationId} onLink={() => setLinking(r)} />
          ))}
        </ul>
      )}

      {linking && (
        <LinkModal
          row={linking}
          locationId={locationId}
          contacts={contacts}
          onClose={() => setLinking(null)}
          onDone={() => { setLinking(null); load() }}
        />
      )}
    </section>
  )
}

function DetectionRow({ row, locationId, onLink }) {
  const [open, setOpen] = useState(false)
  const [visits, setVisits] = useState(null)

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next && visits == null) {
      try {
        const res = await fetch(`/api/live/${locationId}/detection-visits?detection_id=${row.id}`, { cache: 'no-store' })
        const json = await res.json()
        setVisits(json.ok ? (json.visits || []) : [])
      } catch { setVisits([]) }
    }
  }

  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-3">
        <button type="button" onClick={toggle} className="text-un1t-subtle hover:text-un1t-text" title="Show visit history">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{row.last_name || 'Heart-rate strap'}</span>
            <span className="shrink-0 rounded-full bg-un1t-border px-1.5 py-0.5 text-[10px] font-semibold uppercase text-un1t-subtle">
              {row.protocol === 'ant' ? 'ANT+' : 'BLE'}
            </span>
            {row.live_now && <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">live</span>}
          </div>
          <p className="truncate font-mono text-xs text-un1t-subtle">{row.device_key}</p>
        </div>
        <div className="text-right">
          {row.linked_contact ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700"><Check size={12} /> {row.linked_contact.name}</span>
          ) : (
            <button type="button" onClick={onLink} className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-indigo-500">
              <Link2 size={12} /> Link
            </button>
          )}
          <p className="mt-0.5 text-[11px] text-un1t-subtle">
            {row.visit_count} visit{row.visit_count === 1 ? '' : 's'} · {row.last_bpm != null ? `${row.last_bpm} bpm · ` : ''}{formatSince(row.last_seen_at)}
          </p>
        </div>
      </div>

      {open && (
        <div className="mt-2 pl-7">
          {visits == null ? (
            <p className="text-xs text-un1t-subtle">Loading…</p>
          ) : visits.length === 0 ? (
            <p className="text-xs text-un1t-subtle">No recorded visits.</p>
          ) : (
            <ul className="space-y-1">
              {visits.map((v) => (
                <li key={v.id} className="text-xs text-un1t-subtle">
                  {formatDateTime(v.started_at)}{v.class_name ? ` · ${v.class_name}` : ''}
                  {v.peak_bpm != null ? ` · peak ${v.peak_bpm} bpm` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}

function LinkModal({ row, locationId, contacts, onClose, onDone }) {
  const [query, setQuery] = useState('')
  const [contactId, setContactId] = useState(null)
  const [deviceType, setDeviceType] = useState('chest_strap')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return contacts.slice(0, 50)
    return contacts.filter((c) => c.name?.toLowerCase().includes(q)).slice(0, 50)
  }, [contacts, query])

  async function pairForToday() {
    if (!contactId) return
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/live/${locationId}/pair`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_key: row.device_key, contact_id: contactId, bridge_id: row.last_bridge_id }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || 'Pair failed')
      onDone()
    } catch (e) { setError(e.message); setBusy(false) }
  }

  async function rememberDevice() {
    if (!contactId) return
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/live/${locationId}/register-device`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_key: row.device_key, contact_id: contactId, device_type: deviceType }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || 'Register failed')
      onDone()
    } catch (e) { setError(e.message); setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <h2 className="text-lg font-semibold">Link strap to member</h2>
        <p className="mt-1 font-mono text-sm text-un1t-subtle">{row.device_key}</p>

        <input
          type="search"
          autoFocus
          placeholder="Search members…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="mt-3 w-full rounded-md border border-un1t-border bg-white px-3 py-2 text-sm"
        />
        <ul className="mt-2 max-h-48 overflow-auto rounded-md border border-un1t-border">
          {filtered.length === 0 ? (
            <li className="p-3 text-center text-xs text-un1t-subtle">No matches</li>
          ) : (
            filtered.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setContactId(c.id)}
                  className={`block w-full px-3 py-2 text-left text-sm hover:bg-un1t-surface ${contactId === c.id ? 'bg-indigo-50 font-medium' : ''}`}
                >
                  {c.name}
                </button>
              </li>
            ))
          )}
        </ul>

        <div className="mt-3 flex items-center gap-2 text-xs">
          <span className="text-un1t-subtle">Device type:</span>
          {[['chest_strap', 'Chest strap'], ['watch', 'Watch']].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setDeviceType(key)}
              className={`rounded-full px-2 py-0.5 ${deviceType === key ? 'bg-un1t-accent text-white' : 'border border-un1t-border text-un1t-subtle'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="text-sm font-medium text-un1t-subtle hover:text-un1t-text">Cancel</button>
          <button
            type="button"
            disabled={!contactId || busy}
            onClick={pairForToday}
            className="rounded-md border border-indigo-600 px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
          >
            Pair for today
          </button>
          <button
            type="button"
            disabled={!contactId || busy}
            onClick={rememberDevice}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            Remember this device
          </button>
        </div>
        <p className="mt-2 text-[11px] text-un1t-subtle">
          &quot;Pair for today&quot; shows them on the board for this class only. &quot;Remember this device&quot; saves it to their profile so it auto-routes every future class.
        </p>
      </div>
    </div>
  )
}

function formatSince(iso) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

function formatDateTime(iso) {
  if (!iso) return ''
  try {
    return new Intl.DateTimeFormat('en-IE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin' }).format(new Date(iso))
  } catch { return iso }
}
