'use client'

// UN1TBOOK.13 — the roster-only /live view, for staff who hold `class_roster`
// but not `studio_management`. Polls /api/live/[locationId]/roster every 15 s
// and renders the who's-coming list and nothing else: no heart-rate grid, no
// straps, no pairing, no Detected tab, no test mode, no TV link. The full board
// (LiveClassClient) stays behind `studio_management`.
//
// Staff-facing copy, so the strings are hard-coded.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import ClassRosterPanel from './ClassRosterPanel'

const POLL_MS = 15_000

// `timeZone` is accepted for parity with LiveClassClient; the list has no
// clock of its own, so nothing here reads it yet.
export default function LiveRosterClient({ locationId, locationName }) {
  const [data, setData] = useState(null) // { occurrence, roster }
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    let handle
    async function load() {
      try {
        const res = await fetch(`/api/live/${locationId}/roster`, { cache: 'no-store' })
        const json = await res.json()
        if (!res.ok || !json.ok) throw new Error(json.error || 'Roster fetch failed')
        if (cancelled) return
        setData({
          occurrence: json.occurrence || null,
          roster: json.roster || [],
        })
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
      if (!cancelled) handle = setTimeout(load, POLL_MS)
    }
    load()
    return () => { cancelled = true; clearTimeout(handle) }
  }, [locationId])

  const occurrence = data?.occurrence || null
  const roster = data?.roster || []

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-un1t-subtle">Who&apos;s coming</p>
          <h1 className="text-2xl font-bold">{locationName}</h1>
        </div>
        <Link href="/" className="text-sm font-medium text-un1t-subtle hover:text-un1t-text">
          Done
        </Link>
      </header>

      {error && (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}

      {!data ? (
        !error && <p className="mt-10 text-center text-sm text-un1t-subtle">Loading the class list…</p>
      ) : !occurrence ? (
        <div className="mt-10 rounded-2xl border border-dashed border-un1t-border bg-white p-10 text-center">
          <p className="text-sm text-un1t-subtle">
            No class on right now. The list opens 20 minutes before a class starts.
          </p>
        </div>
      ) : roster.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed border-un1t-border bg-white p-10 text-center">
          <p className="text-sm text-un1t-subtle">
            Nobody is booked into {occurrence.class_name || occurrence.name || 'this class'}.
          </p>
        </div>
      ) : (
        <ClassRosterPanel roster={roster} occurrence={occurrence} showHr={false} />
      )}
    </main>
  )
}
