'use client'

// RaceDisplayBoard — TV-friendly race-day board for /race/[slug]/display.
//
// Two screens, auto-rotating every 20s:
//   1. Active on course — teams currently racing, sorted by elapsed
//      (longest at top), live ticking timer per team.
//   2. Completed today — finishers ranked by finish time (fastest
//      first).
//
// Refreshes data every 2s via /api/public/events/[slug]/display so a
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
import { Activity, Trophy, Loader2, Users, User } from 'lucide-react'
import { formatElapsed, elapsedSecondsBetween } from '@/lib/race-control'

// Persisted display preference. localStorage key shared across all
// race-display tabs on this device so toggling on one TV is sticky.
const NAME_MODE_KEY = 'un1t.race-display.nameMode'
const NAME_MODE_TEAM        = 'team'        // big team name + small competitor sub-line (default)
const NAME_MODE_COMPETITORS = 'competitors' // big competitor names, no team name
const NAME_MODES = [NAME_MODE_TEAM, NAME_MODE_COMPETITORS]

// Auto-rotation removed at operator request — the screen stays on
// whichever view the operator picked (default: on-course). Tap
// anywhere on the screen to flip between on-course and finished.
// Data polling stays at 2s so timer ticks + finishes appear live.
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
  // Team-name vs competitor-names toggle. Hydrated from localStorage
  // on mount so a TV restart picks up the operator's last choice.
  const [nameMode, setNameMode] = useState(NAME_MODE_TEAM)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = window.localStorage.getItem(NAME_MODE_KEY)
    if (stored && NAME_MODES.includes(stored)) setNameMode(stored)
  }, [])
  function toggleNameMode(e) {
    // Stop the outer "tap to switch screens" handler from also firing.
    e.stopPropagation()
    const next = nameMode === NAME_MODE_TEAM ? NAME_MODE_COMPETITORS : NAME_MODE_TEAM
    setNameMode(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(NAME_MODE_KEY, next)
    }
  }

  // Poll the API. First call waits for data; subsequent calls refresh
  // silently. Errors don't blank the screen — we keep the last good
  // payload visible and overlay a small reconnecting hint.
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const r = await fetch(`/api/public/events/${slug}/display`, { cache: 'no-store' })
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

  // Auto-rotation deliberately removed. The operator clicks (or taps
  // on the TV's touchscreen) to switch between on-course and finished.
  // `screen` is still state-driven so manual switching keeps working.

  // Compute "now" in server time so the active-team timer is honest.
  // Plain const (no useMemo) — we WANT this to recompute every
  // render so the 500ms tick state actually advances the live timer.
  // The previous useMemo froze it between polls. `tick` is referenced
  // here only so the lint dep checker sees the dependency on the
  // ticker.
  void tick
  const serverNowMs = (!clockSync.server || !clockSync.browser)
    ? Date.now()
    : clockSync.server + (Date.now() - clockSync.browser)

  // Sort active by longest elapsed first (= earliest start_at first,
  // since they're all running). Equivalent without needing serverNowMs.
  const activeSorted = useMemo(() => {
    if (!data?.active) return []
    return data.active.slice().sort((a, b) => {
      const sa = a.race_started_at ? Date.parse(a.race_started_at) : Infinity
      const sb = b.race_started_at ? Date.parse(b.race_started_at) : Infinity
      return sa - sb
    })
  }, [data])

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
      {/* Header — race name on the left, sponsor logos centred,
          screen indicator + count on the right. The three slots use
          a 3-column grid (1fr / auto / 1fr) so the centre stays
          dead-centre regardless of how wide the side blocks get. */}
      <header className="grid grid-cols-[1fr_auto_1fr] items-center px-12 pt-10 pb-6 gap-8">
        <div className="min-w-0">
          <div className="text-5xl font-bold tracking-tight truncate">{race.name}</div>
          {dateLabel && <div className="text-2xl opacity-60 mt-2">{dateLabel}</div>}
        </div>
        <div className="flex items-center justify-center gap-10 min-h-[96px]">
          {(race.tv_logos || []).map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={`${src}-${i}`}
              src={src}
              alt=""
              className="max-h-[115px] max-w-[264px] object-contain"
            />
          ))}
        </div>
        <div className="flex items-start justify-end gap-4 min-w-0">
          {/* Toggle: team-name view vs competitor-names view. Sits to
              the LEFT of the count block so the operator's eye finds
              it without crowding the count. stopPropagation on the
              button so the outer "tap to switch screens" handler
              doesn't also fire. */}
          <button
            type="button"
            onClick={toggleNameMode}
            title={nameMode === NAME_MODE_TEAM ? 'Showing team names — tap for competitor names' : 'Showing competitor names — tap for team names'}
            className="inline-flex items-center gap-3 rounded-full bg-white/15 hover:bg-white/25 active:bg-white/30 border border-white/30 px-5 py-3 text-xl font-semibold uppercase tracking-widest transition mt-2 shrink-0"
          >
            {nameMode === NAME_MODE_TEAM ? <Users size={22} /> : <User size={22} />}
            {nameMode === NAME_MODE_TEAM ? 'Teams' : 'Names'}
          </button>
          <div className="text-right min-w-0">
            <div className="text-xl uppercase tracking-widest opacity-70">
              {screen === 0 ? 'On course' : 'Finished'}
            </div>
            <div className="text-5xl font-bold mt-1">
              {screen === 0 ? activeSorted.length : completedSorted.length}
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 px-12 pb-10 overflow-hidden">
        {screen === 0 ? (
          <ActiveScreen rows={activeSorted} serverNowMs={serverNowMs} nameMode={nameMode} />
        ) : (
          <CompletedScreen rows={completedSorted} nameMode={nameMode} />
        )}
      </main>

      {/* Footer — current screen + tap hint + reconnecting state. */}
      <footer className="flex items-center justify-between px-12 pb-8 text-base opacity-60">
        <div>{error ? 'Reconnecting…' : 'Tap to switch screens'}</div>
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

function ActiveScreen({ rows, serverNowMs, nameMode }) {
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
        <ActiveRow key={r.id} row={r} rank={i + 1} serverNowMs={serverNowMs} nameMode={nameMode} />
      ))}
    </div>
  )
}

function ActiveRow({ row, rank, serverNowMs, nameMode }) {
  const startedMs = row.race_started_at ? Date.parse(row.race_started_at) : null
  const elapsed = startedMs ? Math.max(0, Math.floor((serverNowMs - startedMs) / 1000)) : null
  return (
    <div className="flex items-baseline justify-between border-b border-white/10 py-3 gap-6">
      <div className="min-w-0 flex-1">
        <RowNames row={row} rank={rank} nameMode={nameMode} rankClass="opacity-50" />
      </div>
      <span className="text-4xl font-mono font-bold tabular-nums shrink-0">
        {formatElapsed(elapsed)}
      </span>
    </div>
  )
}

function CompletedScreen({ rows, nameMode }) {
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
        <CompletedRow key={r.id} row={r} rank={i + 1} nameMode={nameMode} />
      ))}
    </div>
  )
}

function CompletedRow({ row, rank, nameMode }) {
  const elapsed = elapsedSecondsBetween(row.race_started_at, row.race_finished_at)
  // Top-3 podium accent on the rank number.
  const accent = rank === 1 ? 'text-yellow-300' : rank === 2 ? 'text-zinc-200' : rank === 3 ? 'text-amber-500' : 'text-white'
  return (
    <div className="flex items-baseline justify-between border-b border-white/10 py-3 gap-6">
      <div className="min-w-0 flex-1">
        <RowNames row={row} rank={rank} nameMode={nameMode} rankClass={accent} />
      </div>
      <span className="text-4xl font-mono font-bold tabular-nums shrink-0">
        {formatElapsed(elapsed)}
      </span>
    </div>
  )
}

// Render the rank + names according to the operator-toggled mode.
//
//   NAME_MODE_TEAM        — big team name, small competitor sub-line
//                           (omitted entirely if no member names).
//   NAME_MODE_COMPETITORS — big competitor names, no team name. Falls
//                           back to the team name if a team has no
//                           registered competitor names so the row
//                           is never blank.
//
// Wave label sits inline next to whichever name acts as the headline.
function RowNames({ row, rank, nameMode, rankClass }) {
  const names = Array.isArray(row.member_names) ? row.member_names : []
  const hasNames = names.length > 0
  const showCompetitorsHeadline = nameMode === NAME_MODE_COMPETITORS && hasNames

  // Build the comma-separated names string with a "+N more" overflow
  // hint past 4 names so the row never wraps and ruins the grid.
  const visible = names.slice(0, 4)
  const overflow = Math.max(0, names.length - visible.length)
  const headlineNames = visible.join(' · ')

  return (
    <>
      <div className="flex items-baseline gap-5 min-w-0">
        <span className={`text-3xl font-bold w-12 shrink-0 ${rankClass}`}>{rank}</span>
        <span className="text-3xl font-semibold truncate">
          {showCompetitorsHeadline ? headlineNames : row.team_name}
          {showCompetitorsHeadline && overflow > 0 && (
            <span className="opacity-60"> · +{overflow} more</span>
          )}
        </span>
        {row.wave_label && (
          <span className="text-base uppercase tracking-widest opacity-50 hidden lg:inline">
            {row.wave_label}
          </span>
        )}
      </div>
      {nameMode === NAME_MODE_TEAM && hasNames && (
        <div className="ml-[3.25rem] mt-1 text-lg opacity-70 truncate">
          {headlineNames}
          {overflow > 0 && <span className="opacity-60"> · +{overflow} more</span>}
        </div>
      )}
    </>
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
