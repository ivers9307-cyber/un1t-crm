'use client'

// Coach live view client. Polls /api/live/[locationId] every 2s,
// renders the attendee grid + available-straps panel + override
// pairing flow + end-class button.

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Heart, RefreshCw, Plug, Square, Users, Tv } from 'lucide-react'
import { zoneForBpm } from '@/lib/heart-rate'

const POLL_MS = 2000
const STALE_MS = 2 * 60 * 1000  // strap silent for 2min → "stale"

export default function LiveClassClient({ locationId, locationName, contacts }) {
  const [data, setData] = useState({ sessions: [], available_straps: [], roster: [], occurrence: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [endingAll, setEndingAll] = useState(false)
  const [pairing, setPairing] = useState(null) // strap object being paired
  const lastTickRef = useRef(0)

  async function poll() {
    try {
      const res = await fetch(`/api/live/${locationId}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || 'Live fetch failed')
      setData({
        sessions: json.sessions || [],
        available_straps: json.available_straps || [],
        roster: json.roster || [],
        occurrence: json.occurrence || null,
      })
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
      lastTickRef.current = Date.now()
    }
  }

  useEffect(() => {
    poll()
    const t = setInterval(poll, POLL_MS)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId])

  async function endAll() {
    if (!confirm(`End all ${data.sessions.length} active sessions?`)) return
    setEndingAll(true)
    try {
      const res = await fetch(`/api/live/${locationId}/end-all`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || 'End-all failed')
    } catch (e) {
      setError(e.message)
    } finally {
      setEndingAll(false)
      poll()
    }
  }

  async function endOne(sessionId) {
    try {
      const res = await fetch(`/api/live/sessions/${sessionId}/end`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || 'End failed')
    } catch (e) {
      setError(e.message)
    }
    poll()
  }

  async function pair({ strap, contactId }) {
    try {
      const res = await fetch(`/api/live/${locationId}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          device_key: strap.device_key,
          contact_id: contactId,
          bridge_id: strap.bridgeId,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || 'Pair failed')
      setPairing(null)
      poll()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <main className="mx-auto max-w-7xl p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-un1t-subtle">Live class</p>
          <h1 className="text-2xl font-bold">{locationName}</h1>
        </div>
        <div className="flex items-center gap-2">
          <RefreshIndicator lastTickRef={lastTickRef} />
          {/* Open the in-class TV display (the public board this location casts
              to the studio screen) in a new tab. */}
          <Link
            href={`/tv/${locationId}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-un1t-border bg-white px-3 py-1.5 text-sm font-medium hover:bg-un1t-surface"
          >
            <Tv size={14} /> TV display
          </Link>
          {data.sessions.length > 0 && (
            <button
              type="button"
              onClick={endAll}
              disabled={endingAll}
              className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
            >
              <Square size={14} /> {endingAll ? 'Ending…' : 'End all sessions'}
            </button>
          )}
          <Link
            href="/"
            className="text-sm font-medium text-un1t-subtle hover:text-un1t-text"
          >
            Done
          </Link>
        </div>
      </header>

      {error && (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}

      {loading && data.sessions.length === 0 ? (
        <p className="mt-10 text-center text-sm text-un1t-subtle">Loading live class…</p>
      ) : (
        <>
          <SessionGrid
            sessions={data.sessions}
            onEndOne={endOne}
          />

          <ClassRosterPanel roster={data.roster} occurrence={data.occurrence} />

          <AvailableStrapsPanel
            straps={data.available_straps}
            onStartPair={(strap) => setPairing(strap)}
          />

          {pairing && (
            <PairModal
              strap={pairing}
              contacts={contacts}
              onCancel={() => setPairing(null)}
              onConfirm={(contactId) => pair({ strap: pairing, contactId })}
            />
          )}
        </>
      )}
    </main>
  )
}

// ── components ───────────────────────────────────────────────────

function SessionGrid({ sessions, onEndOne }) {
  if (sessions.length === 0) {
    return (
      <div className="mt-10 rounded-2xl border border-dashed border-un1t-border bg-white p-10 text-center">
        <Heart size={28} className="mx-auto text-un1t-subtle" />
        <p className="mt-3 font-medium">No active sessions</p>
        <p className="mt-1 text-sm text-un1t-subtle">
          Sessions auto-create when a registered strap starts broadcasting
          during a booked class. Walk-ins can be paired below.
        </p>
      </div>
    )
  }
  return (
    <section className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {sessions.map((s) => (
        <SessionTile key={s.id} session={s} onEnd={() => onEndOne(s.id)} />
      ))}
    </section>
  )
}

function SessionTile({ session, onEnd }) {
  const zone = session.currentBpm != null
    ? zoneForBpm(session.currentBpm, session.maxHrUsed)
    : null
  const stale = isStale(session.lastSampleAt)

  return (
    <div
      className="relative overflow-hidden rounded-2xl border bg-white p-4 transition"
      style={{
        borderColor: zone ? zone.color : '#E2E5E9',
      }}
    >
      {/* Big zone-coloured background tint */}
      {zone && (
        <div
          className="absolute inset-0 opacity-10"
          style={{ backgroundColor: zone.color }}
          aria-hidden="true"
        />
      )}
      <div className="relative">
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{session.contactFirstName}</p>
            <p className="truncate text-xs text-un1t-subtle">{session.contactName}</p>
          </div>
          <button
            type="button"
            onClick={onEnd}
            className="rounded p-1 text-un1t-subtle hover:bg-un1t-border"
            title="End this session"
          >
            <Square size={12} />
          </button>
        </div>

        <div className="mt-3 flex items-baseline justify-between">
          <p className="text-3xl font-bold tabular-nums">
            {session.currentBpm ?? '—'}
            <span className="ml-1 text-xs font-medium text-un1t-subtle">bpm</span>
          </p>
          {zone && (
            <span
              className="rounded-full px-2 py-0.5 text-xs font-bold text-white"
              style={{ backgroundColor: zone.color }}
            >
              {zone.label}
            </span>
          )}
        </div>

        <p className="mt-2 text-[11px] text-un1t-subtle">
          {stale ? (
            <span className="text-red-600">Strap silent · {formatSinceShort(session.lastSampleAt)}</span>
          ) : (
            <>
              Started {formatSinceShort(session.startedAt)}
              {session.deviceIdentifier && (
                <span className="ml-1 font-mono">· {session.deviceIdentifier.slice(-5)}</span>
              )}
            </>
          )}
        </p>
      </div>
    </div>
  )
}

function ClassRosterPanel({ roster, occurrence }) {
  // Only shown while a class is live (occurrence resolved) and there's a roster
  // or walk-ins to show. HR-CLASS-ALLOC.2.
  if (!occurrence || roster.length === 0) return null
  const booked = roster.filter((r) => r.booked)
  const presentBooked = booked.filter((r) => r.hasHr).length
  const walkins = roster.filter((r) => !r.booked)

  return (
    <section className="mt-8 rounded-2xl border border-un1t-border bg-white p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Users size={16} className="text-un1t-subtle" />
        <h2 className="text-sm font-semibold">Class roster</h2>
        {occurrence.class_name && (
          <span className="rounded-full bg-un1t-border px-2 py-0.5 text-[11px] font-medium text-un1t-subtle">
            {occurrence.class_name}
          </span>
        )}
        <span className="ml-auto text-xs text-un1t-subtle">
          {presentBooked}/{booked.length} booked here
          {walkins.length > 0 && ` · ${walkins.length} walk-in${walkins.length > 1 ? 's' : ''}`}
        </span>
      </div>

      <ul className="mt-3 divide-y divide-un1t-border">
        {roster.map((r, i) => (
          <li key={r.sessionId || `roster-${i}`} className="flex items-center gap-3 py-2">
            <span className={`min-w-0 flex-1 truncate text-sm ${r.hasHr ? 'font-medium' : 'text-un1t-subtle'}`}>
              {r.anon ? <span className="font-mono">{r.label}</span> : r.label}
              {r.anon && <span className="ml-1.5 text-[10px] font-semibold uppercase text-indigo-700">walk-in</span>}
              {!r.booked && !r.anon && <span className="ml-1.5 text-[10px] text-amber-700">not booked</span>}
            </span>
            {r.hasHr ? (
              <span className="shrink-0 text-sm font-semibold tabular-nums">
                {r.currentBpm ?? '—'}<span className="ml-0.5 text-[10px] font-normal text-un1t-subtle">bpm</span>
              </span>
            ) : (
              <span className="shrink-0 text-[11px] text-un1t-subtle">no strap</span>
            )}
            {r.booked && (
              <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                booked
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function AvailableStrapsPanel({ straps, onStartPair }) {
  if (straps.length === 0) {
    return null
  }
  return (
    <section className="mt-8 rounded-2xl border border-un1t-border bg-white p-5">
      <div className="flex items-center gap-2">
        <Plug size={16} className="text-un1t-subtle" />
        <h2 className="text-sm font-semibold">Available straps</h2>
        <span className="ml-auto text-xs text-un1t-subtle">
          Broadcasting · not yet routed
        </span>
      </div>
      <p className="mt-1 text-xs text-un1t-subtle">
        Members with a registered strap auto-route to their session
        when they walk in. Use this list to pair a walk-in or lent
        strap to someone.
      </p>
      <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {straps.map((s) => (
          <li
            key={s.device_key}
            className="flex items-center gap-3 rounded-lg border border-un1t-border bg-un1t-surface p-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-sm font-medium">{s.name || 'Heart-rate strap'}</p>
                <span className="shrink-0 rounded-full bg-un1t-border px-1.5 py-0.5 text-[10px] font-semibold uppercase text-un1t-subtle">
                  {s.protocol === 'ant' ? 'ANT+' : 'BLE'}
                </span>
              </div>
              <p className="truncate font-mono text-xs text-un1t-subtle">{s.device_key}</p>
            </div>
            <div className="text-right">
              {s.lastBpm != null && (
                <p className="text-sm font-semibold tabular-nums">{s.lastBpm}<span className="ml-0.5 text-[10px] text-un1t-subtle">bpm</span></p>
              )}
              <button
                type="button"
                onClick={() => onStartPair(s)}
                className="mt-1 inline-flex items-center rounded-md bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-indigo-500"
              >
                Pair
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function PairModal({ strap, contacts, onCancel, onConfirm }) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return contacts.slice(0, 50)
    return contacts.filter((c) => c.name?.toLowerCase().includes(q)).slice(0, 50)
  }, [contacts, query])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <h2 className="text-lg font-semibold">Pair strap</h2>
        <p className="mt-1 font-mono text-sm text-un1t-subtle">{strap.device_key}</p>
        <p className="mt-3 text-sm">
          Pick a member to assign this strap to for the rest of class.
          You can also register the strap permanently on their profile
          afterward so it auto-routes next time.
        </p>

        <input
          type="search"
          autoFocus
          placeholder="Search members…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="mt-3 w-full rounded-md border border-un1t-border bg-white px-3 py-2 text-sm"
        />

        <ul className="mt-2 max-h-60 overflow-auto rounded-md border border-un1t-border">
          {filtered.length === 0 ? (
            <li className="p-3 text-center text-xs text-un1t-subtle">No matches</li>
          ) : (
            filtered.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    await onConfirm(c.id)
                    setBusy(false)
                  }}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-un1t-surface disabled:opacity-50"
                >
                  {c.name}
                </button>
              </li>
            ))
          )}
        </ul>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="text-sm font-medium text-un1t-subtle hover:text-un1t-text"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function RefreshIndicator({ lastTickRef }) {
  const [, force] = useState(0)
  // Re-render once a second so the "Xs ago" stays fresh.
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  // eslint-disable-next-line react-hooks/refs -- reading lastTickRef.current during render is intentional: the parent component mutates this ref each time it refreshes; we re-render via the force-tick above and read the ref here to compute the freshness label. Moving the timestamp into state would force a re-render on every parent tick, which is the opposite of what we want.
  const sinceMs = Date.now() - lastTickRef.current
  return (
    <span className="inline-flex items-center gap-1 text-xs text-un1t-subtle">
      <RefreshCw size={12} className={sinceMs < 4000 ? '' : 'animate-spin'} />
      Updated {Math.floor(sinceMs / 1000)}s ago
    </span>
  )
}

// ── helpers ──────────────────────────────────────────────────────

function isStale(lastSampleAt) {
  if (!lastSampleAt) return false
  return Date.now() - new Date(lastSampleAt).getTime() > STALE_MS
}

function formatSinceShort(iso) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  return `${Math.floor(ms / 3_600_000)}h ago`
}
