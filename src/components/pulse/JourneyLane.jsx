'use client'

// PULSE-90.4 — the first-90-days journey lane on the /pulse hub.
//
// Fetches /api/pulse/journey (the pulse_admin-gated, location-scoped lane
// from loadJourneyLane) and renders it worst-first: member name (→ profile),
// joined date, day X / windowDays, attended / target, a status chip, last
// attended, and the last coach touch. "Log touch" POSTs to
// /api/pulse/journey/touch and refreshes the lane so the touch column
// updates.
//
// Status chips follow the light-theme contrast rule (bg-<c>-500/10
// text-<c>-700 — never the -300/-400 ramp; lint no-low-contrast-chip
// enforces it): on_track + completed emerald, behind amber, at_risk red,
// expired a neutral grey (window over — nothing to intervene on).

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Loader2, Users } from 'lucide-react'
import { formatLastSeen } from '@/lib/person-view'

// Status → { label, chip } (chip = light-theme contrast recipe).
const STATUS_META = {
  on_track:  { label: 'On track', chip: 'bg-emerald-500/10 text-emerald-700' },
  completed: { label: 'Completed', chip: 'bg-emerald-500/10 text-emerald-700' },
  behind:    { label: 'Behind',    chip: 'bg-amber-500/10 text-amber-700' },
  at_risk:   { label: 'At risk',   chip: 'bg-red-500/10 text-red-700' },
  expired:   { label: 'Window over', chip: 'bg-gray-500/10 text-gray-600' },
}

function statusMeta(status) {
  return STATUS_META[status] || { label: status || '—', chip: 'bg-gray-500/10 text-gray-600' }
}

export default function JourneyLane() {
  const router = useRouter()

  const [state, setState] = useState({ status: 'loading', config: null, lane: [], error: null })
  const [touching, setTouching] = useState(null) // contactId currently being logged
  const [touchError, setTouchError] = useState(null)

  const load = useCallback(async () => {
    setTouchError(null)
    try {
      const res = await fetch('/api/pulse/journey')
      const json = await res.json()
      if (!res.ok || json.success === false) {
        if (res.status === 401 || res.status === 403) {
          router.replace('/dashboard')
          return
        }
        setState({ status: 'error', config: null, lane: [], error: json.error || `Failed to load (${res.status})` })
        return
      }
      setState({
        status: 'ready',
        config: json.data?.config || null,
        lane: json.data?.lane || [],
        error: null,
      })
    } catch (e) {
      setState({ status: 'error', config: null, lane: [], error: e.message || 'Network error' })
    }
  }, [router])

  useEffect(() => { load() }, [load])

  const logTouch = useCallback(async (contactId) => {
    setTouchError(null)
    setTouching(contactId)
    try {
      const res = await fetch('/api/pulse/journey/touch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId }),
      })
      const json = await res.json()
      if (!res.ok || json.success === false) {
        setTouchError(json.error || `Log failed (${res.status})`)
        return
      }
      // Re-fetch so the touch column reflects the new outreach.
      await load()
    } catch (e) {
      setTouchError(e.message || 'Network error')
    } finally {
      setTouching(null)
    }
  }, [load])

  if (state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-un1t-subtle text-sm py-8">
        <Loader2 size={14} className="animate-spin" /> Loading journey…
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-4">
        {state.error}
      </div>
    )
  }

  const { config, lane } = state
  const windowDays = config?.windowDays ?? 42
  const target = config?.targetClasses ?? 9

  if (lane.length === 0) {
    return (
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-8 text-center">
        <Users size={28} className="mx-auto text-un1t-subtle mb-3" />
        <p className="text-sm text-un1t-subtle">
          No members are in their first {windowDays} days right now.
        </p>
      </div>
    )
  }

  return (
    <>
      {touchError && (
        <div className="mb-4 bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3">
          {touchError}
        </div>
      )}

      <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-un1t-border text-un1t-subtle text-[11px] uppercase tracking-wider">
              <th className="text-left p-3">Member</th>
              <th className="text-left p-3">Joined</th>
              <th className="text-left p-3">Day</th>
              <th className="text-left p-3">Progress</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Last attended</th>
              <th className="text-left p-3">Last touch</th>
              <th className="text-right p-3">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-un1t-border">
            {lane.map((row) => {
              const meta = statusMeta(row.status)
              return (
                <tr key={row.contactId} className="hover:bg-un1t-border/20">
                  {/* Member → profile */}
                  <td className="p-3">
                    <Link
                      href={`/contacts/${row.contactId}`}
                      className="font-medium text-un1t-text hover:text-un1t-accent"
                    >
                      {row.name}
                    </Link>
                  </td>
                  {/* Joined */}
                  <td className="p-3 text-un1t-subtle text-xs whitespace-nowrap">
                    {formatLastSeen(row.joinedAt)}
                  </td>
                  {/* Day X / windowDays */}
                  <td className="p-3 text-un1t-subtle text-xs whitespace-nowrap">
                    Day {row.dayIndex}/{row.windowDays ?? windowDays}
                  </td>
                  {/* Attended / target */}
                  <td className="p-3 text-un1t-text text-xs whitespace-nowrap">
                    <span className="font-medium">{row.attended}</span>
                    <span className="text-un1t-muted">/{row.target ?? target}</span>
                  </td>
                  {/* Status chip */}
                  <td className="p-3">
                    <span className={`inline-block text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${meta.chip}`}>
                      {meta.label}
                    </span>
                  </td>
                  {/* Last attended */}
                  <td className="p-3 text-un1t-subtle text-xs whitespace-nowrap">
                    {row.lastAttendedAt ? formatLastSeen(row.lastAttendedAt) : '—'}
                  </td>
                  {/* Last touch */}
                  <td className="p-3 text-un1t-subtle text-xs whitespace-nowrap">
                    {row.lastTouch?.at ? formatLastSeen(row.lastTouch.at) : '—'}
                  </td>
                  {/* Log touch */}
                  <td className="p-3 text-right">
                    <button
                      type="button"
                      onClick={() => logTouch(row.contactId)}
                      disabled={touching === row.contactId}
                      className="inline-flex items-center gap-1 text-[11px] border border-un1t-border text-un1t-subtle hover:text-un1t-text px-2 py-1 rounded-md disabled:opacity-40"
                    >
                      {touching === row.contactId && <Loader2 size={11} className="animate-spin" />}
                      Log touch
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
