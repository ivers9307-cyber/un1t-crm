'use client'

// Big-screen kiosk TV: live HR leaderboard.
//
// Polls /api/public/live/[locationId] every 2s. Renders a black
// full-viewport grid of attendee tiles, sorted by UN1T Points.
// Tile colour follows current zone; "stale" tiles dim themselves
// after 2min without samples.
//
// Layout choices for TV legibility (typically viewed from 5-10m):
//   - Tile font size scales with viewport (clamp + vw units)
//   - Tile count adapts the grid: ≤4 → 2 cols, ≤9 → 3 cols, ≤16 →
//     4 cols, ≤25 → 5 cols, else 6 cols
//   - Header is sparse: studio name + clock + 'Live'
//   - No interactivity — touch input on TV browsers is unreliable

import { useEffect, useMemo, useState } from 'react'
import { buildTimeline, computeEffectiveElapsedMs, resolveTimerState } from '@/lib/class-timer'

const POLL_MS = 2000

const ZONE_BG = {
  1: '#374151', // grey
  2: '#1d4ed8', // blue
  3: '#047857', // green
  4: '#b45309', // amber/yellow
  5: '#b91c1c', // red
}

// CLASS-TIMER — segment-type colours on the black TV (bright-on-dark).
const SEG_COLOR = {
  work: '#EF4444',    // red — push
  rest: '#10B981',    // green — recover
  prep: '#9CA3AF',    // grey
  station: '#3B82F6', // blue
  custom: '#A78BFA',  // violet
}

export default function LiveTvClient({ locationId }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [now, setNow] = useState(new Date())

  // Poll the public endpoint.
  useEffect(() => {
    let cancelled = false
    async function tick() {
      try {
        const res = await fetch(`/api/public/live/${locationId}`, { cache: 'no-store' })
        const json = await res.json()
        if (cancelled) return
        if (!res.ok || !json.ok) throw new Error(json.error || 'Live fetch failed')
        setData(json)
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
    }
    tick()
    const t = setInterval(tick, POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [locationId])

  // Live wall clock — refreshes every second so the header time
  // ticks visibly, helping the coach confirm the screen isn't frozen.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const sessions = data?.sessions || []
  const cols = gridColsFor(sessions.length)

  // Green dot to the right of "Live" = the studio's HR bridge (Pi) is
  // streaming. Driven by last_seen_at freshness server-side (see the
  // live API); no green dot ⇒ bridge offline.
  const bridgeOnline = !!data?.bridge?.online
  const bridgeStatusLabel = bridgeOnline
    ? 'Heart-rate bridge connected'
    : 'Heart-rate bridge offline'

  return (
    <main className="min-h-screen bg-black text-white">
      <header className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
        <div>
          <p className="flex items-center gap-2 text-xs uppercase tracking-[0.3em] text-red-500 font-bold">
            <span>● Live</span>
            <span
              className={`inline-block h-3 w-3 rounded-full ${
                bridgeOnline ? 'bg-emerald-500 animate-pulse' : 'bg-neutral-600'
              }`}
              role="img"
              aria-label={bridgeStatusLabel}
              title={bridgeStatusLabel}
            />
          </p>
          <h1 className="mt-1 text-2xl font-bold">{data?.location?.name || 'Studio'}</h1>
        </div>
        <div className="text-right">
          <p className="text-xl font-mono tabular-nums">
            {now.toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </p>
          <p className="text-xs text-neutral-400">
            {sessions.length} active
          </p>
        </div>
      </header>

      <TimerBanner timer={data?.timer} serverTime={data?.server_time} />

      {error && (
        <p className="m-4 rounded-lg border border-red-700 bg-red-950 p-3 text-sm">
          Connection issue: {error}. Retrying…
        </p>
      )}

      {sessions.length === 0 ? (
        <EmptyBoard />
      ) : (
        <div
          className="grid gap-3 p-4"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {sessions.map((s, idx) => (
            <Tile key={s.id} session={s} rank={idx + 1} />
          ))}
        </div>
      )}
    </main>
  )
}

function TimerBanner({ timer, serverTime }) {
  // Anchor the countdown on the server clock so a mis-set TV clock can't drift
  // the display. offset = serverNow − localNow, refreshed on each poll.
  const [offset, setOffset] = useState(0)
  useEffect(() => {
    if (serverTime) setOffset(new Date(serverTime).getTime() - Date.now())
  }, [serverTime])

  // Local 250ms ticker so the countdown moves smoothly between 2s data polls.
  const [, force] = useState(0)
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 250)
    return () => clearInterval(t)
  }, [])

  const timeline = useMemo(
    () => (timer?.structure_snapshot ? buildTimeline(timer.structure_snapshot) : null),
    [timer],
  )
  if (!timer || !timeline) return null

  const nowMs = Date.now() + offset
  const st = resolveTimerState(timeline, computeEffectiveElapsedMs(timer, nowMs))
  const cur = st.currentStep
  const segColor = SEG_COLOR[cur?.type] || '#374151'
  const segPct = cur && cur.seconds ? Math.min(100, (st.segmentElapsedMs / (cur.seconds * 1000)) * 100) : 0
  const paused = timer.status === 'paused'

  return (
    <div
      className="border-b border-neutral-800 px-6 py-4"
      style={{ background: `linear-gradient(90deg, ${segColor}22 0%, #000 70%)` }}
    >
      <div className="flex items-center gap-6">
        <div className="min-w-0">
          <p className="truncate text-xs uppercase tracking-[0.25em] text-neutral-400">{timer.name || 'Class timer'}</p>
          <p className="mt-0.5 text-3xl font-bold leading-tight" style={{ color: st.finished ? '#10B981' : segColor }}>
            {st.finished ? 'Complete' : (cur?.label || '—')}
            {paused && <span className="ml-3 align-middle text-base font-medium text-neutral-400">paused</span>}
          </p>
        </div>

        <div className="ml-auto text-right">
          <p className="text-6xl font-bold tabular-nums leading-none" style={{ color: st.finished ? '#10B981' : segColor }}>
            {st.finished ? '0:00' : fmtClock(st.segmentRemainingMs)}
          </p>
        </div>

        <div className="min-w-[9rem] text-right text-sm text-neutral-300">
          {st.roundCount
            ? <p className="font-bold">Round {st.roundIndex}/{st.roundCount}</p>
            : <p className="text-neutral-600">—</p>}
          {st.nextStep && !st.finished && (
            <p className="text-neutral-400">next: {st.nextStep.label} {fmtClock(st.nextStep.seconds * 1000)}</p>
          )}
          <p className="mt-1 font-mono tabular-nums text-neutral-400">
            {fmtClock(st.totalElapsedMs)} / {fmtClock(st.totalRemainingMs)}
          </p>
        </div>
      </div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-black/40">
        <div
          className="h-full transition-[width] duration-200"
          style={{ width: `${segPct}%`, backgroundColor: segColor }}
        />
      </div>
    </div>
  )
}

function Tile({ session, rank }) {
  const zoneColor = session.currentZone?.color || '#374151'
  const zoneBg = ZONE_BG[session.currentZone?.id] || '#1f2937'

  return (
    <div
      className={`relative flex flex-col rounded-2xl p-4 sm:p-5 transition ${
        session.stale ? 'opacity-40' : ''
      }`}
      style={{
        background: `linear-gradient(135deg, ${zoneBg} 0%, #000 140%)`,
        borderLeft: `8px solid ${zoneColor}`,
      }}
    >
      {/* Rank badge */}
      <span className="absolute right-3 top-3 rounded-full bg-black/40 px-2 py-0.5 text-xs font-bold text-white">
        #{rank}
      </span>

      {/* Name */}
      <p className="text-lg font-semibold leading-tight">{session.displayName}</p>

      {/* BPM — the hero number */}
      <div className="mt-2 flex items-baseline gap-2">
        <span
          className="text-5xl sm:text-6xl font-bold tabular-nums leading-none"
          style={{ color: zoneColor }}
        >
          {session.currentBpm ?? '—'}
        </span>
        <span className="text-sm font-medium text-neutral-300">bpm</span>
      </div>

      {/* Zone label + UN1T points */}
      <div className="mt-3 flex items-center justify-between text-sm">
        <span
          className="rounded-md px-2 py-0.5 font-bold"
          style={{ backgroundColor: zoneColor, color: '#000' }}
        >
          {session.currentZone?.label || '—'}
        </span>
        <span className="font-bold tabular-nums">
          {session.effortPoints ?? 0}
          <span className="ml-1 text-[10px] font-medium text-neutral-300">UN1T</span>
        </span>
      </div>

      {/* Inline zone breakdown bar */}
      <ZoneBar zonesSeconds={session.zonesSeconds} />

      {session.stale && (
        <p className="mt-2 text-xs text-neutral-300">strap silent</p>
      )}
    </div>
  )
}

function ZoneBar({ zonesSeconds }) {
  if (!zonesSeconds) return null
  const totals = [1, 2, 3, 4, 5].map((id) => Number(zonesSeconds[id] ?? zonesSeconds[String(id)] ?? 0))
  const sum = totals.reduce((a, b) => a + b, 0)
  if (sum === 0) return null
  const colors = { 1: '#9CA3AF', 2: '#3B82F6', 3: '#10B981', 4: '#F59E0B', 5: '#EF4444' }
  return (
    <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-black/30">
      {totals.map((sec, i) => {
        if (sec === 0) return null
        const pct = (sec / sum) * 100
        return (
          <div
            key={i}
            style={{ width: `${pct}%`, backgroundColor: colors[i + 1] }}
          />
        )
      })}
    </div>
  )
}

function EmptyBoard() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <p className="text-2xl font-semibold text-neutral-300">Waiting for class to start</p>
      <p className="mt-3 text-sm text-neutral-500">
        Heart rate tiles appear automatically when members start training.
      </p>
    </div>
  )
}

// ── helpers ──────────────────────────────────────────────────────

function gridColsFor(n) {
  if (n <= 4) return 2
  if (n <= 9) return 3
  if (n <= 16) return 4
  if (n <= 25) return 5
  return 6
}

// ms → "m:ss" for the timer banner.
function fmtClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
