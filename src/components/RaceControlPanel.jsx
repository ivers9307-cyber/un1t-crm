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
// Polls /api/events/[id]/control-board every 2 seconds so multiple
// operators stay in sync.
//
// Each row shows: team name + size badge + member names with captain
// highlighted. Cancelled / no_show registrations are filtered from
// the active sections.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Square, RotateCcw, Loader2, Trophy, Clock, Users, AlertCircle, BadgeCheck, Filter, SlidersHorizontal } from 'lucide-react'
import { formatElapsed, classifyBookingState, penaltySumSeconds, elapsedWithPenalties, canStartRace } from '@/lib/race-control'
import RaceAdjustModal from './RaceAdjustModal'

const COMPOSITION_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'all_members', label: 'Members only' },
  { id: 'mixed', label: 'Mixed' },
  { id: 'all_non_members', label: 'Non-members' },
]

export default function RaceControlPanel({ raceId }) {
  const [board, setBoard] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [actionBusy, setActionBusy] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [compositionFilter, setCompositionFilter] = useState('all')
  const [, setTick] = useState(0)
  const pollRef = useRef(null)
  // Mig 124 (RD3): which registration is open in the Adjust modal.
  // null = closed. Holds the registration id; the modal reads the
  // live row from board.registrations on every render so penalty
  // adds/deletes inside the modal reflect immediately when the
  // 2s polling tick lands.
  const [adjustingId, setAdjustingId] = useState(null)

  async function fetchBoard() {
    try {
      const r = await fetch(`/api/events/${raceId}/control-board`, { cache: 'no-store' })
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

  // Wave lookup so each registration row can render its wave badge
  // without N round-trips. Built once per board update.
  const wavesById = useMemo(() => {
    const m = new Map()
    for (const w of (board?.race?.waves || [])) m.set(w.id, w)
    return m
  }, [board])

  const sections = useMemo(() => {
    if (!board) return { next_up: [], on_course: [], completed: [] }
    const buckets = { next_up: [], on_course: [], completed: [], no_show: [] }
    const matchesFilter = (r) => {
      if (compositionFilter === 'all') return true
      return r.team_composition === compositionFilter
    }
    for (const r of (board.registrations || [])) {
      if (!matchesFilter(r)) continue
      // classifyBookingState reads { status, race_started_at,
      // race_finished_at } — same shape as race_registrations.
      const state = classifyBookingState(r)
      buckets[state].push(r)
    }
    // Next Up: sort by wave start_time first (so the next wave's
    // teams cluster together at the top), then by registered_at
    // within each wave. Falls back to registered_at when wave_id
    // is missing.
    buckets.next_up.sort((a, b) => {
      const wa = wavesById.get(a.wave_id)?.start_time || ''
      const wb = wavesById.get(b.wave_id)?.start_time || ''
      const cmp = wa.localeCompare(wb)
      if (cmp !== 0) return cmp
      return (a.registered_at || '').localeCompare(b.registered_at || '')
    })
    buckets.on_course.sort((a, b) => (a.race_started_at || '').localeCompare(b.race_started_at || ''))
    buckets.completed.sort((a, b) => {
      // Mig 124: rank by adjusted time (base + penalties) so a team
      // with a +30s penalty doesn't keep their pre-adjustment podium
      // position. Falls back to Infinity for half-stamped rows so
      // they sort to the bottom rather than throwing.
      const ea = elapsedWithPenalties(a.race_started_at, a.race_finished_at, a.penalties) ?? Infinity
      const eb = elapsedWithPenalties(b.race_started_at, b.race_finished_at, b.penalties) ?? Infinity
      return ea - eb
    })
    return buckets
  }, [board, wavesById, compositionFilter])

  if (loadError && !board) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md p-4 inline-flex items-start gap-2">
        <AlertCircle size={14} className="mt-0.5 shrink-0" /> {loadError}
      </div>
    )
  }
  if (!board) {
    return (
      <div className="text-sm text-un1t-subtle inline-flex items-center gap-2">
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

      <div className="flex items-center gap-2 flex-wrap">
        <Filter size={13} className="text-un1t-subtle" />
        <span className="text-[11px] uppercase tracking-wider text-un1t-subtle mr-1">Composition</span>
        {COMPOSITION_FILTERS.map((f) => {
          const on = compositionFilter === f.id
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setCompositionFilter(f.id)}
              className={`text-xs px-2.5 py-1 rounded-full border ${
                on
                  ? 'bg-un1t-text text-un1t-bg border-un1t-text'
                  : 'border-un1t-border text-un1t-subtle hover:border-un1t-muted'
              }`}
            >
              {f.label}
            </button>
          )
        })}
      </div>


      <Section title="On Course" icon={Clock} count={sections.on_course.length} emptyText="No teams currently on the course.">
        {sections.on_course.map((r) => (
          <OnCourseRow key={r.id} registration={r} wave={wavesById.get(r.wave_id)} busy={actionBusy === r.id} onFinish={() => fireAction(r.id, 'race-finish')} onAdjust={() => setAdjustingId(r.id)} />
        ))}
      </Section>

      <Section title="Next Up" icon={Play} count={sections.next_up.length} emptyText="No teams registered yet.">
        {sections.next_up.map((r) => (
          <NextUpRow key={r.id} registration={r} wave={wavesById.get(r.wave_id)} busy={actionBusy === r.id} onStart={() => fireAction(r.id, 'race-start')} onAdjust={() => setAdjustingId(r.id)} />
        ))}
      </Section>

      <Section title="Completed" icon={Trophy} count={sections.completed.length} emptyText="No teams have finished yet.">
        {sections.completed.map((r, i) => (
          <CompletedRow key={r.id} registration={r} wave={wavesById.get(r.wave_id)} rank={i + 1} busy={actionBusy === r.id} onReset={() => fireAction(r.id, 'race-reset')} onAdjust={() => setAdjustingId(r.id)} />
        ))}
      </Section>

      {/* Adjust modal — opens against the live registration row from
          board.registrations so penalty edits inside the modal reflect
          immediately when the 2s polling tick lands. Closes on outside
          click + the X button. */}
      <RaceAdjustModal
        open={adjustingId != null}
        registration={(board?.registrations || []).find((r) => r.id === adjustingId) || null}
        teamName={(board?.registrations || []).find((r) => r.id === adjustingId)?.teams?.name || ''}
        onClose={() => setAdjustingId(null)}
        onChanged={fetchBoard}
      />
    </div>
  )
}

function Section({ title, icon: Icon, count, emptyText, children }) {
  const items = Array.isArray(children) ? children : (children ? [children] : [])
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <Icon size={16} className="text-un1t-subtle" />
        <h3 className="text-base font-semibold">{title}</h3>
        <span className="text-xs bg-un1t-border/40 text-un1t-subtle px-2 py-0.5 rounded-full">{count}</span>
      </div>
      <div className="space-y-2">
        {items.length === 0 ? (
          <div className="text-xs text-un1t-subtle italic px-2 py-3">{emptyText}</div>
        ) : items}
      </div>
    </section>
  )
}

function TeamHeader({ registration, wave, accent = 'default' }) {
  const team = registration.teams
  const teamName = team?.name || '(no team)'
  const size = team?.size
  const members = team?.team_members || []
  const composition = registration.team_composition
  const accentClass = accent === 'on_course'
    ? 'border-amber-500/50 bg-amber-500/5'
    : accent === 'completed'
      ? 'border-emerald-500/30 bg-emerald-500/5'
      : 'border-un1t-border bg-un1t-surface'
  // Wave badge label: prefer "Label (HH:MM)", fall back to just HH:MM,
  // fall back to "(no wave)" only when the registration is unlinked.
  const waveTime = wave?.start_time ? wave.start_time.slice(0, 5) : null
  const waveBadge = wave
    ? wave.label ? `${wave.label} · ${waveTime}` : waveTime
    : null
  return (
    <div className={`flex-1 min-w-0 border rounded-md p-3 ${accentClass}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-base font-semibold text-un1t-text">{teamName}</span>
        {size && (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-un1t-border/40 text-un1t-subtle inline-flex items-center gap-1">
            <Users size={10} /> {size}-person
          </span>
        )}
        {waveBadge && (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-700 inline-flex items-center gap-1">
            <Clock size={10} /> {waveBadge}
          </span>
        )}
        {composition === 'all_members' && (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 inline-flex items-center gap-1" title="All team members are verified UN1T members">
            <BadgeCheck size={10} /> Members
          </span>
        )}
        {composition === 'mixed' && (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-700" title="Mixed team — members + non-members">
            Mixed
          </span>
        )}
      </div>
      {members.length > 0 && (
        <div className="text-[11px] text-un1t-subtle mt-1">
          {members.map((m, i) => (
            <span key={m.id || i}>
              {i > 0 && ', '}
              <span className={m.role === 'captain' ? 'text-un1t-text font-medium' : ''}>
                {m.name}
                {m.role === 'captain' && <span className="text-amber-700 ml-0.5">★</span>}
                {m.is_member && (
                  <span title="Verified UN1T member" className="ml-1 inline-flex items-center text-emerald-700">
                    <BadgeCheck size={10} />
                  </span>
                )}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// Small annotation rendered next to elapsed time when penalties
// are present. e.g. " (+30s)" or " (-15s)". Hidden when penalty
// total is zero. Title hover lists individual penalties.
function PenaltyBadge({ penalties }) {
  const total = penaltySumSeconds(penalties)
  if (total === 0) return null
  const sign = total > 0 ? '+' : ''
  const tone = total > 0 ? 'text-amber-700' : 'text-emerald-700'
  const breakdown = (penalties || [])
    .map((p) => `${p.seconds > 0 ? '+' : ''}${p.seconds}s — ${p.reason}`)
    .join('\n')
  return (
    <span className={`text-[11px] font-mono tabular-nums ml-1 ${tone}`} title={breakdown}>
      ({sign}{total}s)
    </span>
  )
}

function AdjustButton({ onAdjust }) {
  return (
    <button
      type="button"
      onClick={onAdjust}
      className="text-[11px] text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1"
      title="Adjust times + manage penalties"
    >
      <SlidersHorizontal size={11} />
      Adjust
    </button>
  )
}

// RACEDAY.3 — a Start button the server can only refuse is worse than no
// button. race-start 409s anything but `confirmed`, and classifyBookingState
// only diverts no_show/cancelled, so a pending_payment registration sits in
// Next Up looking startable. Live in the 5 Sep field (registration 8f714b71,
// "Allen Thomson", 11:12 wave), and the operator would only discover it with
// a competitor already on the line. Show WHY instead — the row stays, because
// the team is really there and somebody has to sort the payment out.
function NextUpRow({ registration, wave, busy, onStart, onAdjust }) {
  const startable = canStartRace(registration)
  return (
    <div className="flex items-stretch gap-2">
      <TeamHeader registration={registration} wave={wave} />
      <div className="flex flex-col items-end justify-center gap-1 min-w-[110px]">
        {startable ? (
          <button
            type="button"
            onClick={onStart}
            disabled={busy}
            className="bg-emerald-500 hover:bg-emerald-600 text-white font-semibold px-4 py-3 rounded-md inline-flex items-center gap-1.5 disabled:opacity-40 text-sm"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {busy ? 'Starting…' : 'Start'}
          </button>
        ) : (
          <span
            className="bg-rose-500/10 text-rose-700 text-xs font-semibold px-2.5 py-2 rounded-md text-center"
            title="This registration can't be started until its status is confirmed."
          >
            {String(registration?.status || 'not confirmed').replace(/_/g, ' ')}
          </span>
        )}
        <AdjustButton onAdjust={onAdjust} />
      </div>
    </div>
  )
}

function OnCourseRow({ registration, wave, busy, onFinish, onAdjust }) {
  const nowMs = Date.now()
  const startedMs = registration.race_started_at ? Date.parse(registration.race_started_at) : nowMs
  // Live elapsed = wallclock - start. Penalties shown separately
  // alongside (sums into displayed value during On Course too —
  // operator might apply mid-race, e.g. "false start, +10s").
  const baseElapsed = Math.max(0, Math.floor((nowMs - startedMs) / 1000))
  const totalElapsed = Math.max(0, baseElapsed + penaltySumSeconds(registration.penalties))

  return (
    <div className="flex items-stretch gap-2">
      <TeamHeader registration={registration} wave={wave} accent="on_course" />
      <div className="flex flex-col items-end justify-center gap-1 min-w-[110px]">
        <div className="font-mono text-base font-semibold text-amber-700 tabular-nums">
          {formatElapsed(totalElapsed)}
          <PenaltyBadge penalties={registration.penalties} />
        </div>
        <button
          type="button"
          onClick={onFinish}
          disabled={busy}
          className="bg-un1t-text hover:bg-un1t-accent text-un1t-bg font-semibold px-4 py-3 rounded-md inline-flex items-center gap-1.5 disabled:opacity-40 text-sm"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
          {busy ? 'Finishing…' : 'Finish'}
        </button>
        <AdjustButton onAdjust={onAdjust} />
      </div>
    </div>
  )
}

function CompletedRow({ registration, wave, rank, busy, onReset, onAdjust }) {
  // Use the new helper — base elapsed + penalties — so the Completed
  // section's leaderboard sort + display reflect adjusted times.
  const elapsed = elapsedWithPenalties(registration.race_started_at, registration.race_finished_at, registration.penalties)
  return (
    <div className="flex items-stretch gap-2">
      <div className="flex items-center justify-center min-w-[40px] text-base font-semibold text-un1t-subtle">
        #{rank}
      </div>
      <TeamHeader registration={registration} wave={wave} accent="completed" />
      <div className="flex flex-col items-end justify-center gap-1 min-w-[110px]">
        <div className="font-mono text-base font-semibold text-emerald-700 tabular-nums">
          {formatElapsed(elapsed)}
          <PenaltyBadge penalties={registration.penalties} />
        </div>
        <div className="flex items-center gap-3">
          <AdjustButton onAdjust={onAdjust} />
          <button
            type="button"
            onClick={onReset}
            disabled={busy}
            className="text-[11px] text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1 disabled:opacity-40"
            title="Clear this team's race timing (operator mistake undo)"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
            Reset
          </button>
        </div>
      </div>
    </div>
  )
}
