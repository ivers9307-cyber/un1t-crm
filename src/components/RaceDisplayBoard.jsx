'use client'

// RaceDisplayBoard — TV-friendly race-day board for /event/[slug]/display.
//
// Two sections:
//   1. Active on course — teams currently racing, sorted by elapsed
//      (longest at top), live ticking timer per team.
//   2. Completed today — finishers ranked by adjusted finish time
//      (fastest first).
//
// LANDSCAPE (the original layout): one section at a time, the operator
// taps anywhere to switch. PORTRAIT (RACEDAY.1): both sections stacked,
// sized against each other by portraitPanelFlex, and the tap-to-switch
// handler goes inert — with both sections already on screen a stray tap
// on a touchscreen TV could only blank half the board.
//
// Orientation is detected with matchMedia('(orientation: portrait)') and
// re-read on change, so physically rotating a wall-mounted screen
// re-lays-out without a reload. `?orientation=portrait|landscape` forces
// either mode and skips detection — for a screen whose reported
// orientation lies (some digital-signage players report landscape while
// the panel is rotated in hardware) and for previewing the other layout
// from a desk.
//
// Refreshes data every 2s via /api/public/events/[slug]/display so a
// finish-line operator marking a team done in RaceControlPanel
// surfaces on the TV within ~2 ticks. Live elapsed time is computed
// against the server clock returned by the API (server_now) plus the
// drift since last poll, so the board doesn't wobble when the TV's
// own clock disagrees with the server.
//
// Design: dark, big type, so spectators can read it from across the
// studio. This file is path-excluded from the light-theme chip lint in
// eslint.guardrails.config.mjs — white-on-black is the idiom here.

import { useEffect, useMemo, useState } from 'react'
import { Activity, Trophy, Loader2, Users, User } from 'lucide-react'
import { formatElapsed, elapsedWithPenalties, waveDisplayLabel, portraitPanelFlex } from '@/lib/race-control'

// The display API (mig 124) ships penalty_total_seconds per row
// instead of the full penalties[] array — operator reasons are
// kept off the public TV. Wrap as a single-element pseudo-array
// for elapsedWithPenalties + penaltySumSeconds (which both expect
// {seconds} shaped entries) so we can reuse the helpers without
// branching on shape.
function penaltyArrayFromTotal(row) {
  const n = Number(row?.penalty_total_seconds)
  if (!Number.isFinite(n) || n === 0) return []
  return [{ seconds: n }]
}

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

// Orientation override: /event/<slug>/display?orientation=portrait.
const ORIENTATION_QUERY = '(orientation: portrait)'
const ORIENTATION_PARAM = 'orientation'
const FORCE_PORTRAIT = 'portrait'
const FORCE_LANDSCAPE = 'landscape'

// Portrait row capacity — CONSTANT height estimates against the live
// viewport height, deliberately NOT a ResizeObserver measurement of the
// panels themselves.
//
// Why the constant: rows are a fixed type scale on a board whose only
// job is to be read from across a studio, so a row's height is knowable
// (py-3 = 24px, a text-3xl name ≈ 36px, plus the optional competitor
// sub-line ≈ 32px → ~92px; 100 here to round up). A measured capacity
// would have to re-run whenever the row set changes — every 2s poll —
// and its first frame is always wrong, which on a wall-mounted TV is a
// visible reflow every time a team finishes. The viewport height is
// still read live so the same board is honest on a laptop or phone
// previewing it in portrait, where the constants alone would be wildly
// optimistic.
//
// Every estimate rounds AGAINST showing a row: the panel clips with
// overflow-hidden, so over-estimating slices a row through the middle —
// the exact failure the "+N more" foot exists to avoid — while
// under-estimating only surfaces that foot a row early.
const PORTRAIT_ROW_PX = 100            // one row, competitor sub-line included
const PORTRAIT_PANEL_HEADER_PX = 60    // the panel's own title + count strip
const PORTRAIT_OVERFLOW_NOTE_PX = 32   // the "+N more" foot, when there is one
const PORTRAIT_CHROME_PX = 520         // board header + footer + main padding/gap
// SSR + first-paint assumption: the 1080x1920 CSS viewport a rotated
// studio TV reports. Replaced with the real innerHeight on mount.
const PORTRAIT_VIEWPORT_PX = 1920

// Rows a portrait panel may render, from the flex weight it was given.
// Weights come from portraitPanelFlex and sum to 1, so the two panels
// divide the same main area their limits are computed from.
//
// The "+N more" foot costs height only when there IS a foot, so the fit
// is computed twice: once without it, and — only if that shows the panel
// genuinely overflows — again with its height taken off. Reserving it
// unconditionally drops a row from every panel that had nothing to
// overflow. A populated panel always gets at least one row: a "+12 more"
// line with nothing above it tells a spectator nothing.
function portraitRowLimit(grow, viewportPx, rowCount) {
  if (!(grow > 0)) return 0
  const mainPx = Math.max(0, viewportPx - PORTRAIT_CHROME_PX)
  const bodyPx = mainPx * grow - PORTRAIT_PANEL_HEADER_PX
  const fits = Math.floor(bodyPx / PORTRAIT_ROW_PX)
  if (rowCount <= fits) return rowCount
  return Math.max(1, Math.floor((bodyPx - PORTRAIT_OVERFLOW_NOTE_PX) / PORTRAIT_ROW_PX))
}

// Read the forced orientation off the URL. Returns null when the param
// is absent or holds anything we don't recognise — an unknown value
// falls through to detection rather than picking a layout at random.
function forcedOrientation() {
  if (typeof window === 'undefined') return null
  const value = new URLSearchParams(window.location.search).get(ORIENTATION_PARAM)
  return value === FORCE_PORTRAIT || value === FORCE_LANDSCAPE ? value : null
}

// Whether the board should render its stacked portrait layout, and the
// viewport height its row capacity is estimated from.
//
// `portrait` starts false — i.e. today's landscape layout — on BOTH the
// server render and the first client render. This is a 'use client'
// component but the page still server-renders it, and a hydration
// mismatch here swaps the entire layout on the first client paint: a
// visible flash on a board that is never reloaded and always watched.
// The real orientation (or the ?orientation override) is applied in the
// effect, which runs after hydration, and at that point the board is
// still on its loading spinner because no poll has resolved yet. Same
// reasoning for the viewport height, which starts at the studio TV's.
function usePortraitLayout() {
  const [portrait, setPortrait] = useState(false)
  const [viewportPx, setViewportPx] = useState(PORTRAIT_VIEWPORT_PX)

  // Viewport height feeds portraitRowLimit. `resize` covers a physical
  // rotation too (it fires on orientation change), so the row budget
  // follows the panel weights when the board is turned.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const apply = () => setViewportPx(window.innerHeight || PORTRAIT_VIEWPORT_PX)
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const forced = forcedOrientation()
    if (forced) {
      // Forced: skip detection entirely, and subscribe to nothing — a
      // physical rotation must not override an explicit operator choice.
      setPortrait(forced === FORCE_PORTRAIT)
      return undefined
    }

    if (typeof window.matchMedia !== 'function') return undefined
    const mq = window.matchMedia(ORIENTATION_QUERY)
    const apply = () => setPortrait(mq.matches)
    apply()

    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
    // Smart-TV browsers ship old WebKit builds where MediaQueryList only
    // has the deprecated listener API. Without this branch a rotation
    // would need a reload to take effect.
    mq.addListener(apply)
    return () => mq.removeListener(apply)
  }, [])

  return { portrait, viewportPx }
}

export default function RaceDisplayBoard({ slug }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [screen, setScreen] = useState(0) // 0 = active, 1 = completed (landscape only)
  const { portrait, viewportPx } = usePortraitLayout()
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
    // (Inert in portrait, but the button is shared by both layouts.)
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

  // 500ms ticker for the live elapsed clock on the on-course rows.
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

  // Sort completed by ADJUSTED finish time (mig 124 — fastest first
  // after penalty offsets). A team with a +30s penalty correctly
  // drops in the ranking against a clean run.
  const completedSorted = useMemo(() => {
    if (!data?.completed) return []
    return data.completed.slice().sort((a, b) => {
      const ea = elapsedWithPenalties(a.race_started_at, a.race_finished_at, penaltyArrayFromTotal(a)) ?? Infinity
      const eb = elapsedWithPenalties(b.race_started_at, b.race_finished_at, penaltyArrayFromTotal(b)) ?? Infinity
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

  // Portrait panel sizing. portraitPanelFlex gives an empty panel 0 and
  // its partner 1, so 12 racing + 3 finished doesn't spend half the
  // screen on three finishers. It returns 0/0 when BOTH are empty (the
  // pre-race board) and leaves that case to the caller: give them equal
  // growth so the two empty states share the screen instead of huddling
  // at the top of a mostly-black one.
  const panelFlex = portraitPanelFlex(activeSorted.length, completedSorted.length)
  const bothPanelsEmpty = panelFlex.active === 0 && panelFlex.completed === 0
  const activeGrow = bothPanelsEmpty ? 1 : panelFlex.active
  const completedGrow = bothPanelsEmpty ? 1 : panelFlex.completed

  return (
    <div
      className={`bg-black text-white flex flex-col select-none ${
        portrait ? 'h-screen overflow-hidden cursor-default' : 'min-h-screen cursor-pointer'
      }`}
      // Tap-to-switch is LANDSCAPE ONLY. In portrait both sections are
      // already on screen, so the handler has nothing useful to do and a
      // stray tap on a touchscreen TV would swap the board to a layout
      // showing half the information. No handler at all rather than a
      // no-op one, so the cursor and any assistive semantics agree.
      onClick={portrait ? undefined : () => setScreen((s) => (s + 1) % 2)}
    >
      {/* Header.
          Landscape: race name on the left, sponsor logos centred, screen
          indicator + count on the right — a 3-column grid (1fr / auto /
          1fr) so the centre stays dead-centre regardless of how wide the
          side blocks get.
          Portrait: that grid is far too wide for a ~1080px screen, so it
          stacks — name + date, then logos on their own centred row, with
          the name free to wrap rather than truncate. */}
      <header
        className={portrait
          ? 'flex flex-col items-center gap-4 px-10 pt-6 pb-5 text-center'
          : 'grid grid-cols-[1fr_auto_1fr] items-center px-12 pt-10 pb-6 gap-8'}
      >
        <div className={portrait ? 'w-full' : 'min-w-0'}>
          <div className={`text-5xl font-bold tracking-tight ${portrait ? '' : 'truncate'}`}>{race.name}</div>
          {dateLabel && <div className="text-2xl opacity-60 mt-2">{dateLabel}</div>}
        </div>
        <div className={`flex items-center justify-center min-h-[96px] ${portrait ? 'gap-8' : 'gap-10'}`}>
          {(race.tv_logos || []).map((src, i) => (
             
            <img
              key={`${src}-${i}`}
              src={src}
              alt=""
              className={portrait
                ? 'max-h-[100px] max-w-[220px] object-contain'
                : 'max-h-[115px] max-w-[264px] object-contain'}
            />
          ))}
        </div>
        {/* Toggle: team-name view vs competitor-names view. Landscape
            sits it to the LEFT of the count block so the operator's eye
            finds it without crowding the count. Portrait drops the count
            block — each panel header carries its own count — and pulls
            the toggle onto its own right-aligned row ABOVE the name via
            `order-first`, so it never overlaps a wrapped race name the
            way a corner-pinned absolute control would on a narrow screen.
            stopPropagation on the button so the outer "tap to switch
            screens" handler doesn't also fire in landscape. */}
        <div className={portrait ? 'order-first w-full flex justify-end' : 'flex items-start justify-end gap-4 min-w-0'}>
          <button
            type="button"
            onClick={toggleNameMode}
            title={nameMode === NAME_MODE_TEAM ? 'Showing team names — tap for competitor names' : 'Showing competitor names — tap for team names'}
            className={`inline-flex items-center gap-3 rounded-full bg-white/15 hover:bg-white/25 active:bg-white/30 border border-white/30 px-5 py-3 text-xl font-semibold uppercase tracking-widest transition shrink-0 ${portrait ? '' : 'mt-2'}`}
          >
            {nameMode === NAME_MODE_TEAM ? <Users size={22} /> : <User size={22} />}
            {nameMode === NAME_MODE_TEAM ? 'Teams' : 'Names'}
          </button>
          {!portrait && (
            <div className="text-right min-w-0">
              <div className="text-xl uppercase tracking-widest opacity-70">
                {screen === 0 ? 'On course' : 'Finished'}
              </div>
              <div className="text-5xl font-bold mt-1">
                {screen === 0 ? activeSorted.length : completedSorted.length}
              </div>
            </div>
          )}
        </div>
      </header>

      <main
        className={portrait
          ? 'flex-1 min-h-0 flex flex-col gap-5 px-10 pb-6'
          : 'flex-1 px-12 pb-10 overflow-hidden'}
      >
        {portrait ? (
          <>
            <PortraitPanel icon={Activity} title="On course" count={activeSorted.length} grow={activeGrow}>
              <ActiveScreen
                rows={activeSorted}
                serverNowMs={serverNowMs}
                nameMode={nameMode}
                singleColumn
                limit={portraitRowLimit(activeGrow, viewportPx, activeSorted.length)}
              />
            </PortraitPanel>
            <PortraitPanel icon={Trophy} title="Finished" count={completedSorted.length} grow={completedGrow}>
              <CompletedScreen
                rows={completedSorted}
                nameMode={nameMode}
                singleColumn
                limit={portraitRowLimit(completedGrow, viewportPx, completedSorted.length)}
              />
            </PortraitPanel>
          </>
        ) : screen === 0 ? (
          <ActiveScreen rows={activeSorted} serverNowMs={serverNowMs} nameMode={nameMode} />
        ) : (
          <CompletedScreen rows={completedSorted} nameMode={nameMode} />
        )}
      </main>

      {/* Footer — landscape: current screen + tap hint + reconnecting
          state. Portrait: the tap hint would be a lie (tapping does
          nothing) and the screen dots have no screen to indicate, so
          only the reconnecting state survives. */}
      <footer className={`flex items-center justify-between text-base opacity-60 ${portrait ? 'px-10 pb-6' : 'px-12 pb-8'}`}>
        <div>{error ? 'Reconnecting…' : (portrait ? null : 'Tap to switch screens')}</div>
        {!portrait && (
          <div className="flex items-center gap-3">
            <Dot active={screen === 0} icon={Activity} label="On course" />
            <Dot active={screen === 1} icon={Trophy} label="Finished" />
          </div>
        )}
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

// One of the two stacked portrait sections: a compact header carrying
// the section's own count, and a body that clips.
//
// `grow` is the weight from portraitPanelFlex. Above 0 the panel is a
// flex child with basis 0, so the two panels divide the main area by
// weight alone and each clips its own overflow. At exactly 0 — an empty
// panel — it takes its NATURAL height instead of collapsing to nothing:
// the header and its zero count are the operator's confirmation that
// the section exists and is empty, and the populated partner still gets
// everything else because it is the only growing child.
function PortraitPanel({ icon: Icon, title, count, grow, children }) {
  const growing = grow > 0
  return (
    <section
      className={`flex flex-col min-h-0 ${growing ? '' : 'flex-none'}`}
      style={growing ? { flexGrow: grow, flexBasis: 0 } : undefined}
    >
      <div className="flex items-baseline justify-between gap-6 border-b border-white/20 pb-2 mb-3 shrink-0">
        <span className="inline-flex items-center gap-3 text-2xl uppercase tracking-widest opacity-70">
          <Icon size={26} />
          {title}
        </span>
        <span className="text-4xl font-bold tabular-nums">{count}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
    </section>
  )
}

// Row grid. Landscape keeps its two columns; portrait passes
// singleColumn because two columns of text-3xl names don't fit a
// ~1080px-wide screen.
function rowGridClass(singleColumn) {
  return singleColumn
    ? 'grid grid-cols-1 gap-y-4 content-start'
    : 'grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-4 content-start'
}

function ActiveScreen({ rows, serverNowMs, nameMode, singleColumn = false, limit = null }) {
  if (rows.length === 0) {
    return singleColumn
      ? <PanelEmptyLine text="Teams appear here the moment a wave starts." />
      : (
        <EmptyState
          icon={Activity}
          title="No teams on course"
          sub="Teams will appear here the moment a wave starts."
        />
      )
  }
  const visible = limit == null ? rows : rows.slice(0, limit)
  const hidden = rows.length - visible.length
  return (
    <div className={rowGridClass(singleColumn)}>
      {visible.map((r, i) => (
        <ActiveRow key={r.id} row={r} rank={i + 1} serverNowMs={serverNowMs} nameMode={nameMode} />
      ))}
      {hidden > 0 && <OverflowNote count={hidden} />}
    </div>
  )
}

function ActiveRow({ row, rank, serverNowMs, nameMode }) {
  const startedMs = row.race_started_at ? Date.parse(row.race_started_at) : null
  // Live elapsed = wallclock - start, plus any mid-race penalties
  // (operator might apply during the run, e.g. "false start: +10s").
  const baseElapsed = startedMs ? Math.max(0, Math.floor((serverNowMs - startedMs) / 1000)) : null
  const penaltyTotal = Number(row.penalty_total_seconds) || 0
  const elapsed = baseElapsed == null ? null : Math.max(0, baseElapsed + penaltyTotal)
  return (
    <div className="flex items-baseline justify-between border-b border-white/10 py-3 gap-6">
      <div className="min-w-0 flex-1">
        <RowNames row={row} rank={rank} nameMode={nameMode} rankClass="opacity-50" />
      </div>
      <span className="text-4xl font-mono font-bold tabular-nums shrink-0">
        {formatElapsed(elapsed)}
        {penaltyTotal !== 0 && (
          <span className={`text-xl ml-2 ${penaltyTotal > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>
            ({penaltyTotal > 0 ? '+' : ''}{penaltyTotal}s)
          </span>
        )}
      </span>
    </div>
  )
}

function CompletedScreen({ rows, nameMode, singleColumn = false, limit = null }) {
  if (rows.length === 0) {
    return singleColumn
      ? <PanelEmptyLine text="The first team across the line shows up here." />
      : (
        <EmptyState
          icon={Trophy}
          title="No finishers yet"
          sub="The first team across the line shows up here."
        />
      )
  }
  const visible = limit == null ? rows : rows.slice(0, limit)
  const hidden = rows.length - visible.length
  return (
    <div className={rowGridClass(singleColumn)}>
      {visible.map((r, i) => (
        <CompletedRow key={r.id} row={r} rank={i + 1} nameMode={nameMode} />
      ))}
      {hidden > 0 && <OverflowNote count={hidden} />}
    </div>
  )
}

function CompletedRow({ row, rank, nameMode }) {
  // Adjusted finish time (mig 124 — base + penalty offset). Same
  // value used in the sort above, displayed here.
  const elapsed = elapsedWithPenalties(row.race_started_at, row.race_finished_at, penaltyArrayFromTotal(row))
  const penaltyTotal = Number(row.penalty_total_seconds) || 0
  // Top-3 podium accent on the rank number.
  const accent = rank === 1 ? 'text-yellow-300' : rank === 2 ? 'text-zinc-200' : rank === 3 ? 'text-amber-500' : 'text-white'
  return (
    <div className="flex items-baseline justify-between border-b border-white/10 py-3 gap-6">
      <div className="min-w-0 flex-1">
        <RowNames row={row} rank={rank} nameMode={nameMode} rankClass={accent} />
      </div>
      <span className="text-4xl font-mono font-bold tabular-nums shrink-0">
        {formatElapsed(elapsed)}
        {penaltyTotal !== 0 && (
          <span className={`text-xl ml-2 ${penaltyTotal > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>
            ({penaltyTotal > 0 ? '+' : ''}{penaltyTotal}s)
          </span>
        )}
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

  // RACEDAY.1: this used to render row.wave_label alone, which put the
  // wave on the board for exactly zero of a typical race's rows — waves
  // are commonly identified by START TIME with the label left null
  // (every wave of the current live race is), and a null label rendered
  // nothing. waveDisplayLabel falls back to the wave's HH:MM, which the
  // API already ships alongside the label as wave_start_time.
  const waveLabel = waveDisplayLabel({ label: row.wave_label, start_time: row.wave_start_time })

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
        {waveLabel && (
          // shrink-0, and NOT `hidden lg:inline`: that breakpoint hid the
          // wave on every narrow viewport, which is every portrait screen
          // — the one layout where the wave matters most.
          <span className="text-base uppercase tracking-widest opacity-50 shrink-0">
            {waveLabel}
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

// Foot of a portrait panel that couldn't fit all its rows. Better than
// clipping a row through the middle, which reads as a rendering fault
// from across a studio.
function OverflowNote({ count }) {
  return (
    <div className="pt-2 text-xl uppercase tracking-widest opacity-60">
      +{count} more
    </div>
  )
}

// Portrait empty state — one line. The full-height EmptyState below owns
// a whole screen; a portrait panel with no rows is deliberately given no
// growth, so its content has to sit under its own header in a couple of
// lines.
function PanelEmptyLine({ text }) {
  return <div className="text-xl opacity-50 py-3">{text}</div>
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
