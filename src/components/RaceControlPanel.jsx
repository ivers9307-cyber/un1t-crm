'use client'

// RaceControlPanel — race-day operator UI for standalone race events
// (mig 082). Sources race_registrations (not bookings) so race
// timing is fully decoupled from the booking flow.
//
// Three sections, designed for tablet-finger-friendly interaction:
//   1. Next Up   — registrations not started yet, sorted by
//                  registered_at ascending. Big "Start" button per
//                  row. Tap → POSTs /api/registrations/[id]/race-start.
//   2. On Course — started but not finished. Sorted longest-on-course
//                  first (oldest race_started_at at top — most likely
//                  next finisher, makes the operator's tap target
//                  most accurate). Live elapsed timer ticks at 500ms.
//   3. Completed — finished registrations. Sorted fastest first.
//                  Reset button per row in case the operator tapped
//                  the wrong team.
//
// Polls /api/races/[id]/control-board every 2 seconds so multiple
// operators stay in sync.
//
// Each row shows: team name + size badge + member names with captain
// highlighted. Cancelled / no_show registrations are filtered from
// the active sections.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Square, RotateCcw, Loader2, Trophy, Clock, Users, AlertCircle } from 'lucide-react'
import { formatElapsed, classifyBookingState, elapsedSecondsBetween } from '@/lib/race-control'

export default function RaceControlPanel({ raceId }) {
  const [board, setBoard] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [actionBusy, setActionBusy] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [, setTick] = useState(0)
  const pollRef = useRef(null)

  async function fetchBoard() {
    try {
      const r = await fetch(`/api/races/${raceId}/control-board`, { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setLoadError(j.error || `Fetch failed (${r.status})`)
        return
      }
      setBoard(j)
      setLoadError(null)
    } catch (e) {
      setLoadError(e.message || 'Network error')
    }
  }

  useEffect(() => {
    fetchBoard()
    pollRef.current = setInterval(fetchBoard, 2000)
    const tickInt = setInterval(() => setTick((t) => t + 1), 500)
    return () => {
      clearInterval(pollRef.current)
      clearInterval(tickInt)
    }
    // eslint-disable-next-line
  }, [raceId])

  async function fireAction(registrationId, action) {
    setActionBusy(registrationId)
    setActionError(null)
    try {
      const r = await fetch(`/api/registrations/${registrationId}/${action}`, { method: 'POST' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        throw new Error(j.error || `${action} failed (${r.status})`)
      }
      await fetchBoard()
    } catch (e) {
      setActionError(`${action}: ${e.message || 'failed'}`)
    } finally {
      setActionBusy(null)
    }
  }

  const sections = useMemo(() => {
    if (!board) return { next_up: [], on_course: [], completed: [] }
    const buckets = { next_up: [], on_course: [], completed: [], no_show: [] }
    for (const r of (board.registrations || [])) {
      // classifyBookingState reads { status, race_started_at,
      // race_finished_at } — same shape as race_registrations.
      const state = classifyBookingState(r)
      buckets[state].push(r)
    }
    buckets.next_up.sort((a, b) => (a.registered_at || '').localeCompare(b.registered_at || ''))
    buckets.on_course.sort((a, b) => (a.race_started_at || '').localeCompare(b.race_started_at || ''))
    buckets.completed.sort((a, b) => {
      const ea = elapsedSecondsBetween(a.race_started_at, a.race_finished_at) ?? Infinity
      const eb = elapsedSecondsBetween(b.race_started_at, b.race_finished_at) ?? Infinity
      return ea - eb
    })
    return buckets
  }, [board])

  if (loadError && !board) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md p-4 inline-flex items-start gap-2">
        <AlertCircle size={14} className="mt-0.5 shrink-0" /> {loadError}
      </div>
    )
  }
  if (!board) {
    return (
      <div className="text-sm text-un1t-light inline-flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Loading race board…
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {actionError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md p-3 inline-flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {actionError}
        </div>
      )}

      <Section title="On Course" icon={Clock} count={sections.on_course.length} emptyText="No teams currently on the course.">
        {sections.on_course.map((r) => (
          <OnCourseRow key={r.id} registration={r} busy={actionBusy === r.id} onFinish={() => fireAction(r.id, 'race-finish')} />
        ))}
      </Section>

      <Section title="Next Up" icon={Play} count={sections.next_up.length} emptyText="No teams registered yet.">
        {sections.next_up.map((r) => (
          <NextUpRow key={r.id} registration={r} busy={actionBusy === r.id} onStart={() => fireAction(r.id, 'race-start')} />
        ))}
      </Section>

      <Section title="Completed" icon={Trophy} count={sections.completed.length} emptyText="No teams have finished yet.">
        {sections.completed.map((r, i) => (
          <CompletedRow key={r.id} registration={r} rank={i + 1} busy={actionBusy === r.id} onReset={() => fireAction(r.id, 'race-reset')} />
        ))}
      </Section>
    </div>
  )
}

function Section({ title, icon: Icon, count, emptyText, children }) {
  const items = Array.isArray(children) ? children : (children ? [children] : [])
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <Icon size={16} className="text-un1t-light" />
        <h3 className="text-base font-semibold">{title}</h3>
        <span className="text-xs bg-un1t-gray/40 text-un1t-light px-2 py-0.5 rounded-full">{count}</span>
      </div>
      <div className="space-y-2">
        {items.length === 0 ? (
          <div className="text-xs text-un1t-light italic px-2 py-3">{emptyText}</div>
        ) : items}
      </div>
    </section>
  )
}

function TeamHeader({ registration, accent = 'default' }) {
  const team = registration.teams
  const teamName = team?.name || '(no team)'
  const size = team?.size
  const members = team?.team_members || []
  const accentClass = accent === 'on_course'
    ? 'border-amber-500/50 bg-amber-500/5'
    : accent === 'completed'
      ? 'border-emerald-500/30 bg-emerald-500/5'
      : 'border-un1t-gray bg-un1t-dark'
  return (
    <div className={`flex-1 min-w-0 border rounded-md p-3 ${accentClass}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-base font-semibold text-un1t-white">{teamName}</span>
        {size && (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-un1t-gray/40 text-un1t-light inline-flex items-center gap-1">
            <Users size={10} /> {size}-person
          </span>
        )}
      </div>
      {members.length > 0 && (
        <div className="text-[11px] text-un1t-light mt-1">
          {members.map((m, i) => (
            <span key={m.id || i}>
              {i > 0 && ', '}
              <span className={m.role === 'captain' ? 'text-un1t-white font-medium' : ''}>
                {m.name}
                {m.role === 'captain' && <span className="text-amber-700 ml-0.5">★</span>}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function NextUpRow({ registration, busy, onStart }) {
  return (
    <div className="flex items-stretch gap-2">
      <TeamHeader registration={registration} />
      <div className="flex flex-col items-end justify-center gap-1 min-w-[110px]">
        <button
          type="button"
          onClick={onStart}
          disabled={busy}
          className="bg-emerald-500 hover:bg-emerald-600 text-white font-semibold px-4 py-3 rounded-md inline-flex items-center gap-1.5 disabled:opacity-40 text-sm"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          {busy ? 'Starting…' : 'Start'}
        </button>
      </div>
    </div>
  )
}

function OnCourseRow({ registration, busy, onFinish }) {
  const nowMs = Date.now()
  const startedMs = registration.race_started_at ? Date.parse(registration.race_started_at) : nowMs
  const elapsed = Math.max(0, Math.floor((nowMs - startedMs) / 1000))

  return (
    <div className="flex items-stretch gap-2">
      <TeamHeader registration={registration} accent="on_course" />
      <div className="flex flex-col items-end justify-center gap-1 min-w-[110px]">
        <div className="font-mono text-base font-semibold text-amber-700 tabular-nums">
          {formatElapsed(elapsed)}
        </div>
        <button
          type="button"
          onClick={onFinish}
          disabled={busy}
          className="bg-un1t-white hover:bg-un1t-accent text-un1t-black font-semibold px-4 py-3 rounded-md inline-flex items-center gap-1.5 disabled:opacity-40 text-sm"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
          {busy ? 'Finishing…' : 'Finish'}
        </button>
      </div>
    </div>
  )
}

function CompletedRow({ registration, rank, busy, onReset }) {
  const elapsed = elapsedSecondsBetween(registration.race_started_at, registration.race_finished_at)
  return (
    <div className="flex items-stretch gap-2">
      <div className="flex items-center justify-center min-w-[40px] text-base font-semibold text-un1t-light">
        #{rank}
      </div>
      <TeamHeader registration={registration} accent="completed" />
      <div className="flex flex-col items-end justify-center gap-1 min-w-[110px]">
        <div className="font-mono text-base font-semibold text-emerald-700 tabular-nums">
          {formatElapsed(elapsed)}
        </div>
        <button
          type="button"
          onClick={onReset}
          disabled={busy}
          className="text-[11px] text-un1t-light hover:text-un1t-white inline-flex items-center gap-1 disabled:opacity-40"
          title="Clear this team's race timing (operator mistake undo)"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
          Reset
        </button>
      </div>
    </div>
  )
}
