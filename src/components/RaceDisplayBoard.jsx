'use client'

// RaceDisplayBoard — TV-friendly race-day board for /race/[slug]/display.
//
// Two screens, auto-rotating every 20s:
//   1. Active on course — teams currently racing, sorted by elapsed
//      (longest at top), live ticking timer per team.
//   2. Completed today — finishers ranked by finish time (fastest
//      first).
//
// Refreshes data every 2s via /api/public/races/[slug]/display so a
// finish-line operator marking a team done in RaceControlPanel
// surfaces on the TV within ~2 ticks. Live elapsed time is computed
// against the server clock returned by the API (server_now) plus the
// drift since last poll, so the board doesn't wobble when the TV's
// own clock disagrees with the server.
//
// Design: dark, big type, single screen at a time so spectators can
// read it from across the studio. A row of dots at the bottom-right
// shows which screen we're on. Tap anywhere to skip rotation.

import { useEffect, useMemo, useState } from 'react'
import { Activity, Trophy, Loader2 } from 'lucide-react'
import { formatElapsed, elapsedSecondsBetween } from '@/lib/race-control'

// 20s rotation per spec. Polling is independent — every 2s the data
// refreshes regardless of which screen is showing.
const ROTATION_MS = 20_000
const POLL_MS = 2_000

export default function RaceDisplayBoard({ slug }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [screen, setScreen] = useState(0) // 0 = active, 1 = completed
  // Browser-time anchor for live elapsed. We capture (server_now,
  // browser_now) at every poll so the active timer ticks against the
  // server's clock even if the TV's clock is drifting.
  const [clockSync, setClockSync] = useState({ server: null, browser: null })
  // 'now' state purely to trigger re-renders for the live timer.
  const [tick, setTick] = useState(0)

  // Poll the API. First call waits for data; subsequent calls refresh
  // silently. Errors don't blank the screen — we keep the last good
  // payload visible and overlay a small reconnecting hint.
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const r = await fetch(`/api/public/races/${slug}/display`, { cache: 'no-store' })
        const j = await r.json()
        if (cancelled) return
        if (!j.success) {
          setError(j.error || 'Failed to load')
          return
        }
        setError(null)
        setData(j.data)
        setClockSync({
          server: j.data.server_now ? Date.parse(j.data.server_now) : Date.now(),
          browser: Date.now(),
        })
      } catch (e) {
        if (!cancelled) setError(e.message || 'Network error')
      }
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [slug])

  // 500ms ticker for the live elapsed clock on screen 1.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 500)
    return () => clearInterval(id)
  }, [])

  // Auto-rotate screens every ROTATION_MS. Resets the timer if the
  // operator taps the screen.
  useEffect(() => {
    if (!data) return
    const id = setInterval(() => setScreen((s) => (s + 1) % 2), ROTATION_MS)
    return () => clearInterval(id)
  }, [data, screen])

  // Compute "now" in server time so the active-team timer is honest.
  const serverNowMs = useMemo(() => {
    if (!clockSync.server || !clockSync.browser) return Date.now()
    return clockSync.server + (Date.now() - clockSync.browser)
    // tick included so the memo recomputes every render — cheap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clockSync.server, clockSync.browser, tick])

  // Sort active by longest elapsed first (most likely to finish next).
  const activeSorted = useMemo(() => {
    if (!data?.active) return []
    return data.active.slice().sort((a, b) => {
      const ea = a.race_started_at ? serverNowMs - Date.parse(a.race_started_at) : 0
      const eb = b.race_started_at ? serverNowMs - Date.parse(b.race_started_at) : 0
      return eb - ea
    })
  }, [data, serverNowMs])

  // Sort completed by finish time (fastest first).
  const completedSorted = useMemo(() => {
    if (!data?.completed) return []
    return data.completed.slice().sort((a, b) => {
      const ea = elapsedSecondsBetween(a.race_started_at, a.race_finished_at) ?? Infinity
      const eb = elapsedSecondsBetween(b.race_started_at, b.race_finished_at) ?? Infinity
      return ea - eb
    })
  }, [data])

  if (!data && !error) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <Loader2 size={48} className="animate-spin opacity-60" />
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-12">
        <div className="text-center">
          <div className="text-2xl font-semibold mb-2">Couldn&apos;t load the race board</div>
          <div className="text-base opacity-70">{error}</div>
        </div>
      </div>
    )
  }

  const race = data.race
  const dateLabel = race.race_date
    ? new Date(race.race_date + 'T00:00:00').toLocaleDateString('en-IE', {
        weekday: 'long', day: 'numeric', month: 'long',
      })
    : ''

  return (
    <div
      className="min-h-screen bg-black text-white flex flex-col select-none cursor-pointer"
      onClick={() => setScreen((s) => (s + 1) % 2)}
    >
      {/* Header — race name + date. Stays put across screens. */}
      <header className="flex items-center justify-between px-12 pt-10 pb-6">
        <div>
          <div className="text-5xl font-bold tracking-tight">{race.name}</div>
          {dateLabel && <div className="text-2xl opacity-60 mt-2">{dateLabel}</div>}
        </div>
        <div className="text-right">
          <div className="text-xl uppercase tracking-widest opacity-70">
            {screen === 0 ? 'On course' : 'Finished'}
          </div>
          <div className="text-5xl font-bold mt-1">
            {screen === 0 ? activeSorted.length : completedSorted.length}
          </div>
        </div>
      </header>

      <main className="flex-1 px-12 pb-10 overflow-hidden">
        {screen === 0 ? (
          <ActiveScreen rows={activeSorted} serverNowMs={serverNowMs} />
        ) : (
          <CompletedScreen rows={completedSorted} />
        )}
      </main>

      {/* Footer — rotation indicator + reconnecting hint. */}
      <footer className="flex items-center justify-between px-12 pb-8 text-base opacity-60">
        <div>{error ? 'Reconnecting…' : ''}</div>
        <div className="flex items-center gap-3">
          <Dot active={screen === 0} icon={Activity} label="On course" />
          <Dot active={screen === 1} icon={Trophy} label="Finished" />
        </div>
      </footer>
    </div>
  )
}

function Dot({ active, icon: Icon, label }) {
  return (
    <span className={`inline-flex items-center gap-2 ${active ? 'opacity-100' : 'opacity-30'}`}>
      <Icon size={20} />
      <span className="text-sm uppercase tracking-widest">{label}</span>
    </span>
  )
}

function ActiveScreen({ rows, serverNowMs }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title="No teams on course"
        sub="Teams will appear here the moment a wave starts."
      />
    )
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-4 content-start">
      {rows.map((r, i) => (
        <ActiveRow key={r.id} row={r} rank={i + 1} serverNowMs={serverNowMs} />
      ))}
    </div>
  )
}

function ActiveRow({ row, rank, serverNowMs }) {
  const startedMs = row.race_started_at ? Date.parse(row.race_started_at) : null
  const elapsed = startedMs ? Math.max(0, Math.floor((serverNowMs - startedMs) / 1000)) : null
  return (
    <div className="flex items-baseline justify-between border-b border-white/10 py-3">
      <div className="flex items-baseline gap-5 min-w-0">
        <span className="text-3xl font-bold opacity-50 w-12 shrink-0">{rank}</span>
        <span className="text-3xl font-semibold truncate">{row.team_name}</span>
        {row.wave_label && (
          <span className="text-base uppercase tracking-widest opacity-50 hidden lg:inline">
            {row.wave_label}
          </span>
        )}
      </div>
      <span className="text-4xl font-mono font-bold tabular-nums shrink-0 ml-6">
        {formatElapsed(elapsed)}
      </span>
    </div>
  )
}

function CompletedScreen({ rows }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Trophy}
        title="No finishers yet"
        sub="The first team across the line shows up here."
      />
    )
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-4 content-start">
      {rows.map((r, i) => (
        <CompletedRow key={r.id} row={r} rank={i + 1} />
      ))}
    </div>
  )
}

function CompletedRow({ row, rank }) {
  const elapsed = elapsedSecondsBetween(row.race_started_at, row.race_finished_at)
  // Top-3 podium accent.
  const accent = rank === 1 ? 'text-yellow-300' : rank === 2 ? 'text-zinc-200' : rank === 3 ? 'text-amber-500' : 'text-white'
  return (
    <div className="flex items-baseline justify-between border-b border-white/10 py-3">
      <div className="flex items-baseline gap-5 min-w-0">
        <span className={`text-3xl font-bold w-12 shrink-0 ${accent}`}>{rank}</span>
        <span className="text-3xl font-semibold truncate">{row.team_name}</span>
        {row.wave_label && (
          <span className="text-base uppercase tracking-widest opacity-50 hidden lg:inline">
            {row.wave_label}
          </span>
        )}
      </div>
      <span className="text-4xl font-mono font-bold tabular-nums shrink-0 ml-6">
        {formatElapsed(elapsed)}
      </span>
    </div>
  )
}

function EmptyState({ icon: Icon, title, sub }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center">
      <Icon size={64} className="opacity-30 mb-6" />
      <div className="text-4xl font-semibold mb-3">{title}</div>
      <div className="text-xl opacity-60">{sub}</div>
    </div>
  )
}
