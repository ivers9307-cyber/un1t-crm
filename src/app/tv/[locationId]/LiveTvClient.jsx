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

import { useEffect, useMemo, useRef, useState } from 'react'
import { buildTimeline, computeEffectiveElapsedMs, resolveTimerState, SEG_COLOR } from '@/lib/class-timer'
import { planIntroTimers, isIntroPreview, demoIntroClass, INTRO_SHOW_DELAY_MS, INTRO_FADE_DELAY_MS, INTRO_HIDE_DELAY_MS, INTRO_DURATION_MS, INTRO_PREVIEW_GAP_MS } from '@/lib/tv-class-intro'
import { isKioskParam, showReconnecting } from '@/lib/tv-kiosk'
import { isBurn } from '@/lib/heart-rate'
import {
  roomTotalPoints,
  stableTileOrder,
  sameOrder,
  zoneWord,
  snapshotSessions,
  detectToastEvents,
  toastDedupeKey,
  selectPodium,
  classDidEnd,
} from '@/lib/tv-theatre'

const POLL_MS = 2000

// How long a toast stays on screen before auto-dismiss.
const TOAST_MS = 6000
// Outro podium dwell before returning to the idle board.
const OUTRO_MS = 40000

const ZONE_BG = {
  1: '#374151', // grey
  2: '#1d4ed8', // blue
  3: '#047857', // green
  4: '#b45309', // amber/yellow
  5: '#b91c1c', // red
}

export default function LiveTvClient({ locationId, endpoint }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [now, setNow] = useState(new Date())
  const [kiosk] = useState(() => typeof window !== 'undefined' && isKioskParam(window.location.search))
  const [failures, setFailures] = useState(0)

  // P0-3: the data URL. Defaults to the location-keyed endpoint (unchanged for
  // the live /tv/[locationId] TV). The token-gated /tv/live/[token] page passes
  // an explicit `endpoint` so the same client polls /api/public/tv-live/[token]
  // instead. Same payload either way — the client is agnostic to which it hits.
  const dataUrl = endpoint || `/api/public/live/${locationId}`

  // Poll the public endpoint.
  useEffect(() => {
    let cancelled = false
    async function tick() {
      try {
        const res = await fetch(dataUrl, { cache: 'no-store' })
        const json = await res.json()
        if (cancelled) return
        if (!res.ok || !json.ok) throw new Error(json.error || 'Live fetch failed')
        setData(json)
        setError(null)
        setFailures(0)
      } catch (e) {
        if (!cancelled) {
          setError(e.message)
          setFailures((f) => f + 1)
        }
      }
    }
    tick()
    const t = setInterval(tick, POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [dataUrl])

  // Screen Wake Lock (kiosk only) — prevents display sleep on the Pi.
  useEffect(() => {
    if (!kiosk || typeof navigator === 'undefined' || !navigator.wakeLock) return
    let lock = null
    let released = false
    const acquire = async () => { try { lock = await navigator.wakeLock.request('screen') } catch {} }
    const onVis = () => { if (document.visibilityState === 'visible' && !released) acquire() }
    acquire()
    document.addEventListener('visibilitychange', onVis)
    return () => { released = true; document.removeEventListener('visibilitychange', onVis); try { lock && lock.release() } catch {} }
  }, [kiosk])

  // Landscape lock (kiosk only, best-effort).
  useEffect(() => {
    if (!kiosk) return
    try { screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {}) } catch {}
  }, [kiosk])

  // Live wall clock — refreshes every second so the header time
  // ticks visibly, helping the coach confirm the screen isn't frozen.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const reconnecting = showReconnecting({ consecutiveFailures: failures })

  const sessions = useMemo(() => data?.sessions || [], [data])
  const availableStraps = data?.available_straps || []

  // ── Fixed tile positions (mockup C) ──────────────────────────────
  // The payload arrives sorted by points, which would teleport tiles
  // every 2s. Re-order by a STABLE key so each member keeps their slot
  // all class — colour is the drama, not position. A points-rank badge
  // still conveys the leaderboard. `slotOrder` (state) carries the
  // established slot order across polls; the memo consumes it, and an
  // effect feeds the new order back (only when it actually changes, so
  // we don't loop).
  const [slotOrder, setSlotOrder] = useState([])
  const { tiles, order } = useMemo(
    () => stableTileOrder(sessions, slotOrder),
    [sessions, slotOrder],
  )
  useEffect(() => {
    setSlotOrder((prev) => (sameOrder(prev, order) ? prev : order))
  }, [order])
  const cols = gridColsFor(tiles.length)

  // ── Room-total ticker (replaces "N active") ──────────────────────
  const roomTotal = useMemo(() => roomTotalPoints(sessions), [sessions])

  // ── Mid-class toasts (cross-poll threshold crossings) ────────────
  // Track previous per-session zone/burn state + the set of already-
  // announced member+event pairs, both across polls (refs — no re-render).
  const prevSnapshotRef = useRef(new Map())
  const announcedRef = useRef(new Set())
  const [toastQueue, setToastQueue] = useState([])
  useEffect(() => {
    if (!data) return
    const fresh = detectToastEvents(sessions, prevSnapshotRef.current, announcedRef.current)
    prevSnapshotRef.current = snapshotSessions(sessions)
    if (fresh.length > 0) {
      for (const t of fresh) announcedRef.current.add(toastDedupeKey(t.key, t.event))
      setToastQueue((q) => [...q, ...fresh])
    }
  }, [data, sessions])

  // ── Outro podium (class-end) ─────────────────────────────────────
  // Fires ONCE per class occurrence. hadClassRef tracks whether a live
  // class has been seen; firedForKeyRef records which occurrence already
  // triggered a podium so a timer-finished-but-class-still-present state
  // (or the class going null) can't loop it. A genuinely NEW occurrence
  // (different glofox_event_id) re-arms.
  const hadClassRef = useRef(false)
  const firedForKeyRef = useRef(null)
  const outroClassKeyRef = useRef(null)
  const [outro, setOutro] = useState(null) // { podium, total } while showing
  useEffect(() => {
    if (!data) return
    const currentClass = data.current_class || null
    const classKey = currentClass?.glofox_event_id || (currentClass ? 'live' : null)

    // A new occurrence appeared → re-arm (allow a fresh podium later).
    if (classKey && classKey !== firedForKeyRef.current) {
      hadClassRef.current = true
      outroClassKeyRef.current = classKey
    }

    const timerFinished = isTimerFinished(data.timer, data.server_time)
    const ended = classDidEnd({ hadClass: hadClassRef.current, currentClass, timerFinished })
    const armedKey = outroClassKeyRef.current
    if (ended && armedKey && armedKey !== firedForKeyRef.current) {
      firedForKeyRef.current = armedKey
      hadClassRef.current = false
      setOutro({ podium: selectPodium(sessions), total: roomTotalPoints(sessions) })
    }
  }, [data, sessions])

  // Auto-dismiss the outro after its dwell, returning to the idle board.
  useEffect(() => {
    if (!outro) return
    const t = setTimeout(() => setOutro(null), OUTRO_MS)
    return () => clearTimeout(t)
  }, [outro])

  // Green dot to the right of "Live" = the studio's HR bridge (Pi) is
  // streaming. Driven by last_seen_at freshness server-side (see the
  // live API); no green dot ⇒ bridge offline.
  const bridgeOnline = !!data?.bridge?.online
  const bridgeStatusLabel = bridgeOnline
    ? 'Heart-rate bridge connected'
    : 'Heart-rate bridge offline'

  return (
    <main className="relative min-h-screen bg-black text-white" style={kiosk ? { cursor: 'none' } : undefined}>
      {kiosk && reconnecting && (
        <div className="absolute top-4 right-4 z-40 rounded-full bg-white/10 px-3 py-1 text-xs text-white/60">● reconnecting…</div>
      )}
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
        <div className="flex items-center gap-6">
          {/* Room-total ticker — counts up smoothly between polls. */}
          <div className="text-right">
            <p className="text-3xl font-bold tabular-nums leading-none text-white">
              <CountUp value={roomTotal} />
              <span className="ml-1.5 text-xs font-medium uppercase tracking-widest text-neutral-400">UN1T</span>
            </p>
            <p className="mt-0.5 text-[10px] uppercase tracking-[0.25em] text-neutral-500">room total</p>
          </div>
          <div className="text-right">
            <p className="text-xl font-mono tabular-nums">
              {now.toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </p>
            <p className="text-xs text-neutral-400">
              {sessions.length} live
            </p>
          </div>
        </div>
      </header>

      <TimerBanner timer={data?.timer} serverTime={data?.server_time} />

      {!kiosk && error && (
        <p className="m-4 rounded-lg border border-red-700 bg-red-950 p-3 text-sm">
          Connection issue: {error}. Retrying…
        </p>
      )}

      {tiles.length === 0 ? (
        <EmptyBoard />
      ) : (
        <div
          className="grid gap-3 p-4"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {tiles.map((s) => (
            // key = the STABLE tile key, so React reuses the same DOM node
            // for a member all class → their tile never teleports; only its
            // colour/BPM update. When a member leaves, the grid reflows and
            // CSS transitions the survivors into place (no hard jump).
            <Tile key={s._key} session={s} rank={s._rank} />
          ))}
        </div>
      )}

      {availableStraps.length > 0 && (
        <div className="mt-6 px-4 pb-4">
          <p className="mb-2 text-xs uppercase tracking-wide text-white/40">Unpaired straps</p>
          <div className="flex flex-wrap gap-3">
            {availableStraps.map((s, i) => (
              <div key={`strap-${i}`} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 opacity-70">
                <span className="font-mono text-sm text-white/70">{s.label}</span>
                <span className="text-lg font-semibold tabular-nums text-white">
                  {s.currentBpm ?? '—'}<span className="ml-1 text-xs font-normal text-white/40">bpm</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <ClassStartIntro current={data?.current_class} serverTime={data?.server_time} />

      <ToastLayer queue={toastQueue} onDone={(t) => setToastQueue((q) => q.filter((x) => x !== t))} />

      {outro && <OutroPodium podium={outro.podium} total={outro.total} />}
    </main>
  )
}

// Smoothly animates a number toward `value` over ~0.9s (eased), so the
// room-total ticker counts up between 2s polls rather than snapping.
function CountUp({ value }) {
  const [display, setDisplay] = useState(value)
  const fromRef = useRef(value)
  const rafRef = useRef(0)
  useEffect(() => {
    const from = fromRef.current
    const to = Number(value) || 0
    if (from === to) return
    const start = performance.now()
    const dur = 900
    const step = (t) => {
      const p = Math.min(1, (t - start) / dur)
      const eased = 1 - Math.pow(1 - p, 3) // easeOutCubic
      const cur = Math.round(from + (to - from) * eased)
      setDisplay(cur)
      if (p < 1) { rafRef.current = requestAnimationFrame(step) } else { fromRef.current = to }
    }
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(rafRef.current)
  }, [value])
  return <span className="tabular-nums">{display}</span>
}

// Shows one toast at a time from the queue, auto-dismissing after TOAST_MS.
// Broadcast-clean: slides down from the top, holds, fades out.
function ToastLayer({ queue, onDone }) {
  const active = queue[0] || null
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!active) return
    setShown(false)
    const inT = setTimeout(() => setShown(true), 30)
    const outT = setTimeout(() => setShown(false), TOAST_MS - 500)
    const doneT = setTimeout(() => onDone(active), TOAST_MS)
    return () => { clearTimeout(inT); clearTimeout(outT); clearTimeout(doneT) }
  }, [active, onDone])
  if (!active) return null
  const amber = active.event === 'burn'
  return (
    <div style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', zIndex: 45,
      display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
      <div style={{
        marginTop: shown ? 22 : -80,
        opacity: shown ? 1 : 0,
        transition: 'margin-top .5s cubic-bezier(.2,.7,.2,1), opacity .5s ease',
        background: amber ? '#b45309' : '#b91c1c',
        color: '#fff', fontWeight: 800, fontSize: 26, letterSpacing: 1,
        padding: '14px 34px', borderRadius: 999,
        boxShadow: '0 10px 40px rgba(0,0,0,.5)', whiteSpace: 'nowrap',
      }}>
        {active.event === 'burn' ? '🔥 ' : '🔴 '}{active.message}
      </div>
    </div>
  )
}

// CLASS COMPLETE — TOP MOVERS podium. Shown for OUTRO_MS then the board
// returns to idle. Top 3 by effort points + room total + app nudge.
function OutroPodium({ podium, total }) {
  const [shown, setShown] = useState(false)
  useEffect(() => { const t = setTimeout(() => setShown(true), 40); return () => clearTimeout(t) }, [])
  const order = [1, 0, 2] // render 2nd, 1st, 3rd for a real podium shape
  const heights = { 1: 220, 2: 160, 3: 120 }
  const medal = { 1: '#F5C542', 2: '#C0C7CE', 3: '#B4783E' }
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 55, background: '#08080A',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      opacity: shown ? 1 : 0, transition: 'opacity .6s ease' }}>
      <span style={{ position: 'absolute', top: 24, left: 28, fontWeight: 700, letterSpacing: 6, color: '#fff' }}>UN1T</span>
      <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: 8, color: '#7a7a82' }}>CLASS COMPLETE</span>
      <span style={{ fontSize: '5.5vw', lineHeight: 1, fontWeight: 800, color: '#fff', letterSpacing: 2, margin: '6px 0 30px' }}>TOP MOVERS</span>

      {podium.length === 0 ? (
        <span style={{ fontSize: 26, color: '#b8b8be' }}>Great work, everyone.</span>
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 28, height: 260 }}>
          {order.map((slot) => {
            const p = podium[slot]
            if (!p) return <div key={slot} style={{ width: 200 }} />
            return (
              <div key={p.key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 200 }}>
                <span style={{ fontSize: 24, fontWeight: 700, color: '#fff', marginBottom: 6, textAlign: 'center' }}>{p.name}</span>
                <span style={{ fontSize: 30, fontWeight: 800, color: medal[p.place], marginBottom: 10, fontVariantNumeric: 'tabular-nums' }}>
                  {p.points}<span style={{ fontSize: 13, fontWeight: 600, color: '#888', marginLeft: 4 }}>UN1T</span>
                </span>
                <div style={{
                  width: '100%', height: shown ? heights[p.place] : 0,
                  background: `linear-gradient(180deg, ${medal[p.place]}33 0%, #111 100%)`,
                  borderTop: `4px solid ${medal[p.place]}`, borderRadius: '8px 8px 0 0',
                  transition: `height .8s cubic-bezier(.2,.7,.2,1) ${0.15 * p.place}s`,
                  display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 12,
                }}>
                  <span style={{ fontSize: 44, fontWeight: 900, color: medal[p.place] }}>{p.place}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div style={{ marginTop: 40, display: 'flex', alignItems: 'center', gap: 40 }}>
        <span style={{ fontSize: 20, color: '#b8b8be' }}>
          Room total <strong style={{ color: '#fff', fontVariantNumeric: 'tabular-nums' }}>{total}</strong> UN1T
        </span>
        <span style={{ fontSize: 20, color: '#b8b8be' }}>results in your app 📱</span>
      </div>
    </div>
  )
}

function ClassStartIntro({ current, serverTime }) {
  const [visible, setVisible] = useState(false)
  const [shown, setShown] = useState(false) // drives the fade/scale-in transition
  // Preview mode (?introPreview=1): force the card to loop for on-demand QA on
  // any TV. Read once. Falls back to a demo class when nothing is scheduled.
  const preview = useState(() => typeof window !== 'undefined' && isIntroPreview(window.location.search))[0]
  const demo = useMemo(() => (preview ? demoIntroClass() : null), [preview])
  const cls = current || demo

  // The 2s poll changes `serverTime` (and can re-supply `starts_at`) on every
  // tick. If the play-sequence effect depended on those, each poll would tear
  // down the in-flight fade/hide timers and re-run — and because the
  // occurrence is already marked played, early-return without rearming them,
  // stranding the full-screen overlay over the live board. So we read the
  // freshest clock/start via refs (kept current by a separate effect that does
  // NOT own any timers) and key the sequence effect purely on the occurrence.
  const serverTimeRef = useRef(serverTime)
  const startsAtRef = useRef(cls?.starts_at)
  useEffect(() => {
    serverTimeRef.current = serverTime
    startsAtRef.current = cls?.starts_at
  }, [serverTime, cls?.starts_at])

  const eventId = cls?.glofox_event_id
  useEffect(() => {
    if (preview || !eventId) return
    const nowMs = serverTimeRef.current ? Date.parse(serverTimeRef.current) : Date.now()
    let lastPlayedKey = null
    try { lastPlayedKey = sessionStorage.getItem('tvIntroLastKey') } catch {}
    const plan = planIntroTimers({ eventId, startsAt: startsAtRef.current, lastPlayedKey, nowMs })
    if (!plan.play) return
    try { sessionStorage.setItem('tvIntroLastKey', plan.key) } catch {}
    setVisible(true)
    setShown(false)
    const inT = setTimeout(() => setShown(true), plan.timers.showMs)
    const outT = setTimeout(() => setShown(false), plan.timers.fadeMs)
    const hideT = setTimeout(() => setVisible(false), plan.timers.hideMs)
    return () => { clearTimeout(inT); clearTimeout(outT); clearTimeout(hideT) }
    // Depend ONLY on the occurrence identity — NOT serverTime — so the 2s poll
    // never clears the fade/hide timers mid-play. Cleanup fires only on unmount
    // or a genuine occurrence change. (Deps are exhaustive: the clock/start are
    // read via refs and setVisible/setShown are stable — no disable needed.)
  }, [eventId, preview])

  // Preview loop — only when ?introPreview=1. Replays the show→fade→hide
  // sequence every DURATION+GAP so the card can be watched on any TV without
  // waiting for a scheduled class. Entirely inert in normal operation.
  useEffect(() => {
    if (!preview) return
    let inT, outT, hideT
    const run = () => {
      setVisible(true)
      setShown(false)
      inT = setTimeout(() => setShown(true), INTRO_SHOW_DELAY_MS)
      outT = setTimeout(() => setShown(false), INTRO_FADE_DELAY_MS)
      hideT = setTimeout(() => setVisible(false), INTRO_HIDE_DELAY_MS)
    }
    run()
    const loop = setInterval(run, INTRO_DURATION_MS + INTRO_PREVIEW_GAP_MS)
    return () => { clearInterval(loop); clearTimeout(inT); clearTimeout(outT); clearTimeout(hideT) }
  }, [preview])

  if (!visible || !cls) return null
  const meta = [cls.starts_at_label, cls.program].filter(Boolean).join('  ·  ')
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 50, background: '#08080A',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      opacity: shown ? 1 : 0, transition: 'opacity .6s ease' }}>
      <span style={{ position: 'absolute', top: 24, left: 28, fontWeight: 700, letterSpacing: 6, color: '#fff' }}>UN1T</span>
      <span style={{ position: 'absolute', top: 24, right: 28, fontSize: 14, fontWeight: 700, letterSpacing: 3, color: '#EF4444' }}>● LIVE</span>
      <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: 8, color: '#7a7a82',
        opacity: shown ? 1 : 0, transform: shown ? 'translateY(0)' : 'translateY(8px)', transition: 'all .6s ease .1s' }}>NOW STARTING</span>
      <span style={{ fontSize: '11vw', lineHeight: 1, fontWeight: 800, color: '#fff', letterSpacing: 2, marginTop: 8,
        opacity: shown ? 1 : 0, transform: shown ? 'scale(1)' : 'scale(.92)', transition: 'all .7s cubic-bezier(.2,.7,.2,1) .25s' }}>{cls.class_name || 'CLASS'}</span>
      <span style={{ height: 4, width: shown ? 160 : 0, background: '#EF4444', borderRadius: 2, margin: '22px 0 14px', transition: 'width .7s cubic-bezier(.4,0,.1,1) .5s' }} />
      {meta ? <span style={{ fontSize: 22, fontWeight: 500, letterSpacing: 2, color: '#b8b8be',
        opacity: shown ? 1 : 0, transform: shown ? 'translateY(0)' : 'translateY(8px)', transition: 'all .6s ease .7s' }}>{meta}</span> : null}
    </div>
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
  // Burn = a session that has spent ≥12 min in Zone 4+ (shared helper).
  const burn = !session.stale && isBurn(session.zonesSeconds)

  return (
    <div
      className={`relative flex flex-col rounded-2xl p-4 sm:p-5 transition-all duration-500 ${
        session.stale ? 'opacity-40' : ''
      }`}
      style={{
        background: `linear-gradient(135deg, ${zoneBg} 0%, #000 140%)`,
        borderLeft: `8px solid ${zoneColor}`,
        // Burn flare — a soft amber (Zone 4) glow ringing the tile.
        boxShadow: burn ? '0 0 0 2px #F59E0B, 0 0 26px 2px rgba(245,158,11,.5)' : undefined,
      }}
    >
      {/* Rank badge (points rank — position is fixed, this is the leaderboard) */}
      <span className="absolute right-3 top-3 rounded-full bg-black/40 px-2 py-0.5 text-xs font-bold text-white">
        #{rank ?? '—'}
      </span>

      {/* Burn flare flag — in the Zone-4 amber, top-left. */}
      {burn && (
        <span
          className="absolute left-3 top-3 rounded-md px-2 py-0.5 text-xs font-extrabold tracking-wide"
          style={{ backgroundColor: '#F59E0B', color: '#000' }}
        >
          🔥 BURN
        </span>
      )}

      {/* Name */}
      <p className={`text-lg font-semibold leading-tight ${burn ? 'mt-6' : ''}`}>{session.displayName}</p>

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
          {zoneWord(session.currentZone?.id) || '—'}
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

// Has the live class timer run to completion? Mirrors TimerBanner's
// server-clock anchoring (offset = serverTime − localNow) so the outro
// can fire off the timer finishing as well as the class going null.
// Returns false when there's no timer/structure (class-null is the
// other trigger).
function isTimerFinished(timer, serverTime) {
  if (!timer || !timer.structure_snapshot) return false
  const timeline = buildTimeline(timer.structure_snapshot)
  if (!timeline) return false
  const offset = serverTime ? new Date(serverTime).getTime() - Date.now() : 0
  const st = resolveTimerState(timeline, computeEffectiveElapsedMs(timer, Date.now() + offset))
  return !!st.finished
}

// ms → "m:ss" for the timer banner.
function fmtClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
