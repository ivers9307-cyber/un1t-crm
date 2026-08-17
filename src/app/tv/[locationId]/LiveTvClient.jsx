'use client'

// Big-screen kiosk TV: live HR leaderboard, on the Repset system (P4a
// reskin of the Graft/Afterglow board — palette + signature only; layout,
// type and zone semantics unchanged).
//
// Polls /api/public/live/[locationId] every 2s. Renders an ink (#131316)
// full-viewport grid of attendee tiles, sorted by UN1T Points. Tile colour
// follows current zone via the shared dark-canvas palette
// (@/lib/tv-zone-colors); "stale" tiles dim themselves after 2min without
// samples.
//
// Layout choices for TV legibility (typically viewed from 5-10m):
//   - Tile font size scales with viewport (clamp + vw units)
//   - Landscape grid: ≤4 → 2 cols, ≤16 → 4 cols (8 tiles is the canonical
//     full screen on a 1080p landscape TV), ≤25 → 5, else 6. Portrait
//     (matchMedia-detected, ?orientation= override — same pattern as the
//     challenges board): ≤8 → 2, ≤18 → 3, else 4.
//   - Header is sparse: studio name + room total + clock + 'Live'
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
import { nextPollDelay, ACTIVE_POLL_MS } from '@/lib/live-poll'
import { createBrowserClient } from '@/lib/supabase'
import { repsetDisplay, repsetBody, repsetMono } from '@/fonts/repset'
import { zoneColorDark, dominantZone } from '@/lib/tv-zone-colors'

// Poll cadence (active few-seconds vs idle back-off) lives in @/lib/live-poll.

// How long a toast stays on screen before auto-dismiss.
const TOAST_MS = 6000
// Outro podium dwell before returning to the idle board.
const OUTRO_MS = 40000

// ── Repset tokens (P4a) ──────────────────────────────────────────
// Chrome only. The five zone DATA colours live in @/lib/tv-zone-colors and
// are untouched — Z4 amber still means Z4 wherever a zone is displayed.
const INK = '#131316'      // canvas — never pure black
const SURFACE = '#1C1C21'  // tile / card surface (raised ink)
const HAIRLINE = '#30303A' // hairline borders
const BONE = '#F1EEE7'     // primary text — never #FFF
const BONE_2 = '#B1AEA6'
const BONE_3 = '#75726B'
const PEARL = '#D8D4C9'    // resting chrome
const VOLT = '#D6FF3D'     // earned heat: burn ring, points, podium leader
const VOLT_INK = '#2A3305' // text on a volt fill
const REDLINE = '#FF4E42'  // Z5 / LIVE / attention (zone palette, untouched)
const FIELD = '#22C58B'    // Z3 green — bridge online, timer complete (zone palette, untouched)

// Board faces — the repset* next/font variables are mounted on the root
// <main> className below, so every child (overlays included) can reach them.
const FONT_DISPLAY = 'var(--font-repset-display), ui-sans-serif, system-ui, sans-serif'
const FONT_BODY = 'var(--font-repset-body), ui-sans-serif, system-ui, sans-serif'
const FONT_MONO = 'var(--font-repset-mono), ui-monospace, SFMono-Regular, Menlo, monospace'

// Display remap of the canonical SEG_COLOR (shared/class-timer — untouched;
// it also serves the coach screen + mobile) onto the dark-canvas palette.
// Any future segment type not mapped here falls back to its canonical colour.
const SEG_DISPLAY_COLOR = {
  work: REDLINE,
  rest: FIELD,
  prep: '#A3ABB6',
  station: '#4D9FFF',
  custom: PEARL,
}

export default function LiveTvClient({ locationId, endpoint, device }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [now, setNow] = useState(new Date())
  const [kiosk] = useState(() => typeof window !== 'undefined' && isKioskParam(window.location.search))
  const [failures, setFailures] = useState(0)

  // Orientation: matchMedia-detected, ?orientation=portrait|landscape forces
  // it (the challenges board's pattern). Read the override once, like kiosk.
  const [orientationOverride] = useState(() => {
    if (typeof window === 'undefined') return null
    const v = new URLSearchParams(window.location.search).get('orientation')
    return v === 'portrait' || v === 'landscape' ? v : null
  })
  const [portrait, setPortrait] = useState(false)
  useEffect(() => {
    if (orientationOverride) {
      setPortrait(orientationOverride === 'portrait')
      return
    }
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(orientation: portrait)')
    const handler = (e) => setPortrait(e.matches)
    setPortrait(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [orientationOverride])

  // P0-3: the data URL. Defaults to the location-keyed endpoint (unchanged for
  // the live /tv/[locationId] TV). The token-gated /tv/live/[token] page passes
  // an explicit `endpoint` so the same client polls /api/public/tv-live/[token]
  // instead. Same payload either way — the client is agnostic to which it hits.
  // FLEET-CMD.2 appends ?device= so the poll doubles as this kiosk's render
  // heartbeat. Only on the location-keyed entrypoint: the token URL already
  // identifies a specific display, so it needs no hint from the client.
  const dataUrl = endpoint
    || `/api/public/live/${locationId}${device ? `?device=${encodeURIComponent(device)}` : ''}`

  // TIMER-PUSH.1 — realtime nudge. The timer routes broadcast a ping on
  // `timer:<locationId>` after every start/pause/resume/skip/stop; bumping
  // this counter re-runs the poll effect below, which fetches immediately.
  // The ping payload is never trusted — it only moves the NEXT poll to now,
  // so a dropped websocket degrades to the normal cadence, never stale UI.
  // The token-gated /tv/live/[token] variant has no locationId and keeps
  // poll-only behaviour.
  const [pushBump, setPushBump] = useState(0)
  useEffect(() => {
    if (!locationId) return undefined
    let client
    try { client = createBrowserClient() } catch { return undefined }
    const chan = client.channel(`timer:${locationId}`)
    chan.on('broadcast', { event: 'timer' }, () => setPushBump((b) => b + 1))
    chan.subscribe()
    return () => { client.removeChannel(chan) }
  }, [locationId])

  // Poll the public endpoint. Self-scheduling so the cadence can adapt: fast
  // while a class / straps / timer is live, idle back-off otherwise, so an
  // all-day/overnight TV stops hammering the function when nothing is on.
  // Errors retry at the active cadence (same as before).
  useEffect(() => {
    let cancelled = false
    let handle
    async function tick() {
      let delay = ACTIVE_POLL_MS
      try {
        const res = await fetch(dataUrl, { cache: 'no-store' })
        const json = await res.json()
        if (cancelled) return
        if (!res.ok || !json.ok) throw new Error(json.error || 'Live fetch failed')
        setData(json)
        setError(null)
        setFailures(0)
        delay = nextPollDelay(json)
      } catch (e) {
        if (!cancelled) {
          setError(e.message)
          setFailures((f) => f + 1)
        }
      }
      if (!cancelled) handle = setTimeout(tick, delay)
    }
    tick()
    return () => { cancelled = true; clearTimeout(handle) }
  }, [dataUrl, pushBump])

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

  // Landscape lock (kiosk only, best-effort). Skipped when the operator
  // explicitly mounts the panel portrait via ?orientation=portrait — the
  // lock would fight the override on rotatable kiosks.
  useEffect(() => {
    if (!kiosk || orientationOverride === 'portrait') return
    try { screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {}) } catch {}
  }, [kiosk, orientationOverride])

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
  const cols = gridColsFor(tiles.length, portrait)

  // ── Room-total ticker (replaces "N active") ──────────────────────
  const roomTotal = useMemo(() => roomTotalPoints(sessions), [sessions])

  // The room-dominant-zone glow behind the header — the board runs hot
  // when the class does. Pearl at rest (empty room / no straps).
  const glowColor = useMemo(() => zoneColorDark(dominantZone(sessions)) || PEARL, [sessions])

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
    <main
      className={`${repsetDisplay.variable} ${repsetBody.variable} ${repsetMono.variable} relative flex min-h-screen flex-col`}
      style={{
        background: INK,
        color: BONE,
        fontFamily: FONT_BODY,
        ...(kiosk ? { cursor: 'none' } : {}),
      }}
    >
      {/* Room-dominant-zone glow behind the header. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 -translate-x-1/2"
        style={{
          top: -70,
          width: '70%',
          height: 240,
          background: `radial-gradient(closest-side, ${glowColor}24, transparent)`,
        }}
      />
      {kiosk && reconnecting && (
        <div
          className="absolute top-4 right-4 z-40 rounded-full px-3 py-1 text-xs"
          style={{ fontFamily: FONT_MONO, background: SURFACE, border: `1px solid ${HAIRLINE}`, color: BONE_3 }}
        >
          ● reconnecting…
        </div>
      )}
      <header className={`relative flex items-start justify-between ${portrait ? 'px-4 py-3' : 'px-6 py-4'}`} style={{ borderBottom: `1px solid ${HAIRLINE}` }}>
        <div>
          <p className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: REDLINE, boxShadow: `0 0 8px ${REDLINE}AA` }}
            />
            <span className="text-[11px] font-medium uppercase tracking-[0.28em]" style={{ fontFamily: FONT_MONO, color: REDLINE }}>
              Live
            </span>
            <span
              className={`inline-block h-2 w-2 rounded-full ${bridgeOnline ? 'animate-pulse' : ''}`}
              style={{ background: bridgeOnline ? FIELD : BONE_3 }}
              role="img"
              aria-label={bridgeStatusLabel}
              title={bridgeStatusLabel}
            />
          </p>
          <h1 className="mt-1 text-2xl font-bold" style={{ fontFamily: FONT_DISPLAY, color: BONE }}>
            {data?.location?.name || 'Studio'}
          </h1>
        </div>
        <div className="flex items-start gap-6">
          {/* Room-total ticker — counts up smoothly between polls. */}
          <div className="text-right">
            <p className="text-3xl leading-none tabular-nums" style={{ fontFamily: FONT_DISPLAY, fontWeight: 800, color: BONE }}>
              <CountUp value={roomTotal} />
              <span className="ml-1.5 text-xs tracking-[0.14em]" style={{ fontFamily: FONT_MONO, fontWeight: 500, color: VOLT }}>PTS</span>
            </p>
            <p className="mt-0.5 text-[10px] uppercase tracking-[0.22em]" style={{ fontFamily: FONT_MONO, color: BONE_3 }}>Room total</p>
          </div>
          {/* Portrait drops the clock column (approved portrait frame) — the
              room total is the header's one number; 'n live' moves under it. */}
          {!portrait && (
            <div className="text-right">
              <p className="text-xl tabular-nums" style={{ fontFamily: FONT_MONO, color: BONE }}>
                {now.toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </p>
              <p className="text-xs" style={{ fontFamily: FONT_MONO, color: BONE_3 }}>
                {sessions.length} live
              </p>
            </div>
          )}
        </div>
      </header>

      {!kiosk && error && (
        <p className="m-4 rounded-lg p-3 text-sm" style={{ border: `1px solid ${REDLINE}66`, background: SURFACE, color: BONE_2 }}>
          Connection issue: {error}. Retrying…
        </p>
      )}

      {/* TV-TIMER.1 — the timer follows the bands, not the class.
          Nobody strapped in means there is nothing to rank, so the countdown
          takes the screen; the first band to connect drops it to the bottom
          bar and the tiles take over. A class with no timer still gets the
          original idle board. */}
      {tiles.length === 0 ? (
        data?.timer
          ? <TimerBanner placement="hero" portrait={portrait} timer={data?.timer} serverTime={data?.server_time} />
          : <EmptyBoard />
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
          <p className="mb-2 text-xs uppercase tracking-[0.18em]" style={{ fontFamily: FONT_MONO, color: BONE_3 }}>Unpaired straps</p>
          <div className="flex flex-wrap gap-3">
            {availableStraps.map((s, i) => (
              <div
                key={`strap-${i}`}
                className="flex items-center gap-3 rounded-xl px-4 py-3 opacity-70"
                style={{ background: SURFACE, border: `1px solid ${HAIRLINE}` }}
              >
                <span className="text-sm" style={{ fontFamily: FONT_MONO, color: BONE_2 }}>{s.label}</span>
                <span className="text-lg tabular-nums" style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, color: BONE }}>
                  {s.currentBpm ?? '—'}
                  <span className="ml-1 text-[10px] tracking-[0.12em]" style={{ fontFamily: FONT_MONO, fontWeight: 400, color: BONE_3 }}>BPM</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TV-TIMER.1 — timer and signature ride down together.
          mt-auto on the WRAPPER, not on the signature: it keeps the pair
          welded to the bottom whether or not a timer is running, and leaves
          the tile grid the whole middle of the screen. */}
      <div className="mt-auto">
        {tiles.length > 0 && (
          <TimerBanner placement="bottom" portrait={portrait} timer={data?.timer} serverTime={data?.server_time} />
        )}
        {/* The Repset signature — every board signs off the same way. */}
        <RepsetSignature caption="Scores land in your app" />
      </div>

      <ClassStartIntro current={data?.current_class} serverTime={data?.server_time} />

      <ToastLayer queue={toastQueue} onDone={(t) => setToastQueue((q) => q.filter((x) => x !== t))} />

      {outro && <OutroPodium podium={outro.podium} total={outro.total} />}
    </main>
  )
}

// The board's footer signature: mono handoff caption left, tally mark +
// 'repset' wordmark right. The tally: three rounded bone bars struck through
// by a volt diagonal — reps counted, set done. Container classes are
// IDENTICAL to the Graft signature's (px-6 py-2, h-4 mark, 13px wordmark):
// the ~34px height is load-bearing for the 8-tile 4×2 fit on a 1080p
// landscape screen.
function RepsetSignature({ caption, className = '' }) {
  return (
    <div
      className={`flex items-center justify-between px-6 py-2 ${className}`}
      style={{ borderTop: `1px solid ${HAIRLINE}`, background: INK }}
    >
      <span className="text-[10px] uppercase tracking-[0.18em]" style={{ fontFamily: FONT_MONO, color: BONE_3 }}>{caption}</span>
      <span className="flex items-center gap-2">
        <svg viewBox="0 0 1024 1024" className="h-4 w-4 rounded" aria-hidden="true">
          <rect width="1024" height="1024" fill="#131316" />
          <rect x="230" y="200" width="116" height="624" rx="58" fill="#F1EEE7" />
          <rect x="454" y="200" width="116" height="624" rx="58" fill="#F1EEE7" />
          <rect x="678" y="200" width="116" height="624" rx="58" fill="#F1EEE7" />
          <line x1="176" y1="812" x2="848" y2="212" stroke="#D6FF3D" strokeWidth="116" strokeLinecap="round" />
        </svg>
        <span className="text-[13px] lowercase" style={{ fontFamily: FONT_DISPLAY, fontWeight: 800, letterSpacing: '-0.01em', color: BONE }}>
          repset<span style={{ color: VOLT }}>.</span>
        </span>
      </span>
    </div>
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
// Broadcast-clean: slides down from the top, holds, fades out. Burn toasts
// run volt (earned) with ink-dark text; Zone-5 toasts Redline-on-bone. No emoji — the
// system's voice is type, so any emoji in the message string is stripped.
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
  const burnToast = active.event === 'burn'
  const message = String(active.message || '').replace(/[🔥🔴]/gu, '').replace(/\s{2,}/g, ' ').trim()
  return (
    <div style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', zIndex: 45,
      display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
      <div style={{
        marginTop: shown ? 22 : -80,
        opacity: shown ? 1 : 0,
        transition: 'margin-top .5s cubic-bezier(.2,.7,.2,1), opacity .5s ease',
        background: burnToast ? VOLT : REDLINE,
        color: burnToast ? VOLT_INK : BONE,
        fontFamily: FONT_DISPLAY, fontWeight: 800, fontSize: 26, letterSpacing: 1,
        padding: '14px 34px', borderRadius: 999,
        boxShadow: '0 10px 40px rgba(0,0,0,.5)', whiteSpace: 'nowrap',
      }}>
        {message}
      </div>
    </div>
  )
}

// CLASS COMPLETE — TOP MOVERS podium. Shown for OUTRO_MS then the board
// returns to idle. Top 3 by effort points + room total + app nudge.
// De-metaled: heat is earned, not awarded — the winner runs volt (with
// the Burn-style glow), 2nd reads bone, 3rd bone-2. No medals.
function OutroPodium({ podium, total }) {
  const [shown, setShown] = useState(false)
  useEffect(() => { const t = setTimeout(() => setShown(true), 40); return () => clearTimeout(t) }, [])
  const order = [1, 0, 2] // render 2nd, 1st, 3rd for a real podium shape
  const heights = { 1: 220, 2: 160, 3: 120 }
  const heat = { 1: VOLT, 2: BONE, 3: BONE_2 }
  const barWash = { 1: 'rgba(214,255,61,.16)', 2: 'rgba(241,238,231,.10)', 3: 'rgba(177,174,166,.08)' }
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 55, background: INK,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      opacity: shown ? 1 : 0, transition: 'opacity .6s ease' }}>
      <span style={{ position: 'absolute', top: 24, left: 28, fontFamily: FONT_DISPLAY, fontWeight: 700, letterSpacing: 6, color: BONE }}>UN1T</span>
      <span style={{ fontFamily: FONT_MONO, fontSize: 14, fontWeight: 500, letterSpacing: '0.5em', color: BONE_3, textTransform: 'uppercase' }}>Class complete</span>
      <span style={{ fontFamily: FONT_DISPLAY, fontSize: '5.5vw', lineHeight: 1, fontWeight: 800, color: BONE, letterSpacing: 2, margin: '6px 0 30px' }}>TOP MOVERS</span>

      {podium.length === 0 ? (
        <span style={{ fontSize: 26, color: BONE_2 }}>Great work, everyone.</span>
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 28, height: 260 }}>
          {order.map((slot) => {
            const p = podium[slot]
            if (!p) return <div key={slot} style={{ width: 200 }} />
            const c = heat[p.place]
            return (
              <div key={p.key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 200 }}>
                <span style={{ fontSize: 24, fontWeight: 600, color: BONE, marginBottom: 6, textAlign: 'center' }}>{p.name}</span>
                <span style={{ fontFamily: FONT_DISPLAY, fontSize: 30, fontWeight: 700, color: c, marginBottom: 10, fontVariantNumeric: 'tabular-nums' }}>
                  {p.points}
                  <span style={{ fontFamily: FONT_MONO, fontSize: 13, fontWeight: 400, letterSpacing: '0.1em', color: p.place === 1 ? VOLT : BONE_3, marginLeft: 4 }}>PTS</span>
                </span>
                <div style={{
                  width: '100%', height: shown ? heights[p.place] : 0,
                  background: `linear-gradient(180deg, ${barWash[p.place]} 0%, #18181E 100%)`,
                  borderTop: `4px solid ${c}`, borderRadius: '10px 10px 0 0',
                  boxShadow: p.place === 1 ? '0 0 26px rgba(214,255,61,.18)' : undefined,
                  transition: `height .8s cubic-bezier(.2,.7,.2,1) ${0.15 * p.place}s`,
                  display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 12,
                }}>
                  <span style={{ fontFamily: FONT_DISPLAY, fontSize: 44, fontWeight: 900, color: c }}>{p.place}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <RepsetSignature
        caption={`Room total ${total} PTS · full results in Repset`}
        className="absolute bottom-0 left-0 right-0"
      />
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
    <div style={{ position: 'absolute', inset: 0, zIndex: 50, background: INK,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      opacity: shown ? 1 : 0, transition: 'opacity .6s ease' }}>
      <span style={{ position: 'absolute', top: 24, left: 28, fontFamily: FONT_DISPLAY, fontWeight: 700, letterSpacing: 6, color: BONE }}>UN1T</span>
      <span style={{ position: 'absolute', top: 24, right: 28, fontFamily: FONT_MONO, fontSize: 12, fontWeight: 500, letterSpacing: '0.28em', color: REDLINE, textTransform: 'uppercase' }}>● Live</span>
      <span style={{ fontFamily: FONT_MONO, fontSize: 15, fontWeight: 500, letterSpacing: '0.5em', color: BONE_3, textTransform: 'uppercase',
        opacity: shown ? 1 : 0, transform: shown ? 'translateY(0)' : 'translateY(8px)', transition: 'all .6s ease .1s' }}>Now starting</span>
      <span style={{ fontFamily: FONT_DISPLAY, fontSize: '11vw', lineHeight: 1, fontWeight: 800, color: BONE, letterSpacing: 2, marginTop: 8,
        opacity: shown ? 1 : 0, transform: shown ? 'scale(1)' : 'scale(.92)', transition: 'all .7s cubic-bezier(.2,.7,.2,1) .25s' }}>{cls.class_name || 'CLASS'}</span>
      <span style={{ height: 4, width: shown ? 160 : 0, background: REDLINE, borderRadius: 2, margin: '22px 0 14px', transition: 'width .7s cubic-bezier(.4,0,.1,1) .5s' }} />
      {meta ? <span style={{ fontSize: 22, fontWeight: 500, letterSpacing: 2, color: BONE_2,
        opacity: shown ? 1 : 0, transform: shown ? 'translateY(0)' : 'translateY(8px)', transition: 'all .6s ease .7s' }}>{meta}</span> : null}
    </div>
  )
}

// TV-TIMER.1 — one timer, two placements.
//
//   bottom — bands are live. The tiles own the middle of the screen and the
//            countdown runs along the foot, with its progress bar full-bleed
//            on the very bottom edge: an unbroken line whose colour and length
//            carry the state from the back of the floor without anyone reading
//            a number.
//   hero   — nobody is wearing a band, so there is nothing to rank and the
//            clock becomes the board.
//
// This is a MOVE, not an addition: the strip that used to sit under the header
// is gone, so the board's height budget is roughly unchanged and the grid still
// fits 8 tiles on a 1080p landscape screen (see RepsetSignature).
//
// None of the timing logic below differs by placement — the server-clock
// offset, the 250ms tick and the segment resolution are shared, so the two
// layouts cannot disagree about what time it is.
function TimerBanner({ timer, serverTime, placement = 'bottom', portrait = false }) {
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
  const segColor = SEG_DISPLAY_COLOR[cur?.type] || SEG_COLOR[cur?.type] || '#A3ABB6'
  const segPct = cur && cur.seconds ? Math.min(100, (st.segmentElapsedMs / (cur.seconds * 1000)) * 100) : 0
  const paused = timer.status === 'paused'
  const activeColor = st.finished ? FIELD : segColor

  const clock = st.finished ? '0:00' : fmtClock(st.segmentRemainingMs)
  const stepLabel = st.finished ? 'Complete' : (cur?.label || '—')
  const roundLabel = `${timer.name || 'Class timer'}${st.roundCount ? ` · Round ${st.roundIndex}/${st.roundCount}` : ''}`

  // The progress rail. Square and full-bleed at the foot of the board, rounded
  // and inset when it sits under the hero — the bottom edge of a screen is a
  // natural line, the middle of one is not.
  const rail = (flush) => (
    <div
      className={`h-1.5 w-full overflow-hidden ${flush ? '' : 'rounded-full'}`}
      style={{ background: 'rgba(0,0,0,.4)' }}
    >
      <div
        className="h-full transition-[width] duration-200"
        style={{ width: `${segPct}%`, backgroundColor: segColor }}
      />
    </div>
  )

  if (placement === 'hero') {
    // "Restrained" from the mockup — Richard's pick of four. Big enough to read
    // down the length of the gym, short of shouting. Capped against viewport
    // HEIGHT too so a portrait panel or an unusual aspect cannot overflow it.
    const heroSize = portrait ? 'min(16vw, 20vh)' : 'min(8vw, 22vh)'
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
        <p className="text-3xl" style={{ fontFamily: FONT_DISPLAY, fontWeight: 800, color: activeColor }}>
          {stepLabel}
          {paused && <span className="ml-4 align-middle text-xl font-medium" style={{ fontFamily: FONT_BODY, color: BONE_2 }}>paused</span>}
        </p>

        <p
          className="mt-2 leading-[0.84] tabular-nums"
          style={{ fontFamily: FONT_DISPLAY, fontWeight: 800, color: activeColor, fontSize: heroSize, letterSpacing: '-0.02em' }}
        >
          {clock}
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-10 gap-y-2 text-lg" style={{ fontFamily: FONT_MONO, color: BONE_2 }}>
          <span>{roundLabel}</span>
          {st.nextStep && !st.finished && (
            <span>next <span style={{ color: BONE }}>{st.nextStep.label} {fmtClock(st.nextStep.seconds * 1000)}</span></span>
          )}
          <span className="tabular-nums" style={{ color: BONE_3 }}>
            {fmtClock(st.totalElapsedMs)} / {fmtClock(st.totalRemainingMs)}
          </span>
        </div>

        <p className="mt-10 text-xs uppercase tracking-[0.22em]" style={{ fontFamily: FONT_MONO, color: BONE_3 }}>
          No heart-rate bands connected
        </p>

        <div className="mt-6 w-2/3 max-w-3xl">{rail(false)}</div>
      </div>
    )
  }

  return (
    <div>
      <div
        className="flex items-center gap-6 px-6 pb-3 pt-4"
        style={{ borderTop: `1px solid ${HAIRLINE}`, background: `linear-gradient(0deg, ${segColor}22, transparent 78%)` }}
      >
        <div className="min-w-0">
          <p className="truncate text-xs uppercase tracking-[0.22em]" style={{ fontFamily: FONT_MONO, color: BONE_2 }}>
            {roundLabel}
          </p>
          <p className="mt-0.5 text-3xl leading-tight" style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, color: activeColor }}>
            {stepLabel}
            {paused && <span className="ml-3 align-middle text-base font-medium" style={{ fontFamily: FONT_BODY, color: BONE_2 }}>paused</span>}
          </p>
        </div>

        {/* Up from text-6xl: moving the clock out of the crowded band under the
            header is what buys the room to enlarge it. */}
        <div className="ml-auto text-right">
          <p className="text-7xl leading-none tabular-nums" style={{ fontFamily: FONT_DISPLAY, fontWeight: 800, color: activeColor }}>
            {clock}
          </p>
        </div>

        <div className="min-w-[9rem] text-right text-xs" style={{ fontFamily: FONT_MONO, color: BONE_2 }}>
          {st.nextStep && !st.finished && (
            <p>next: {st.nextStep.label} {fmtClock(st.nextStep.seconds * 1000)}</p>
          )}
          <p className="mt-1 tabular-nums" style={{ color: BONE_3 }}>
            {fmtClock(st.totalElapsedMs)} / {fmtClock(st.totalRemainingMs)}
          </p>
        </div>
      </div>

      {rail(true)}
    </div>
  )
}

function Tile({ session, rank }) {
  const zoneId = Number(session.currentZone?.id)
  const zoneColor = zoneColorDark(zoneId)
  // Burn = a session that has spent ≥12 min in Zone 4+ (shared helper).
  const burn = !session.stale && isBurn(session.zonesSeconds)

  return (
    <div
      className={`relative flex flex-col rounded-[14px] p-4 sm:p-5 transition-all duration-500 ${
        session.stale ? 'opacity-40' : ''
      }`}
      style={{
        // Approved mockup: flat iron surface; the 6px zone edge carries the
        // colour. (A zone-tinted wash variant was tried and cut in review.)
        background: SURFACE,
        border: `1px solid ${HAIRLINE}`,
        borderLeft: `6px solid ${zoneColor || HAIRLINE}`,
        // Burn — volt ring + soft outer glow (the chip carries the word).
        boxShadow: burn ? '0 0 0 1.5px rgba(214,255,61,.65), 0 0 22px rgba(214,255,61,.25)' : undefined,
      }}
    >
      {/* Rank pill (points rank — position is fixed, this is the leaderboard) */}
      <span
        className="absolute right-3 top-3 rounded-full px-2 py-0.5 text-xs tabular-nums"
        style={{ fontFamily: FONT_MONO, color: BONE_2, background: 'rgba(0,0,0,.35)' }}
      >
        #{rank ?? '—'}
      </span>

      {/* Burn chip — bordered mono, volt (earned). No emoji anywhere on the board. */}
      {burn && (
        <span
          className="absolute left-3 top-3 rounded-full px-2 py-0.5 text-xs uppercase tracking-[0.14em]"
          style={{ fontFamily: FONT_MONO, color: VOLT, border: '1px solid rgba(214,255,61,.5)' }}
        >
          BURN
        </span>
      )}

      {/* Name — clear of the rank/burn pills above. */}
      <p className="mt-6 text-lg font-semibold leading-tight" style={{ color: BONE }}>{session.displayName}</p>

      {/* BPM — the hero number */}
      <div className="mt-2 flex items-baseline gap-1.5">
        <span
          className="text-5xl leading-none tabular-nums sm:text-6xl"
          style={{ fontFamily: FONT_DISPLAY, fontWeight: 800, letterSpacing: '-0.01em', color: zoneColor || BONE_3 }}
        >
          {session.currentBpm ?? '—'}
        </span>
        <span className="text-xs tracking-[0.12em]" style={{ fontFamily: FONT_MONO, color: BONE_3 }}>BPM</span>
      </div>

      {/* Zone chip + UN1T points */}
      <div className="mt-3 flex items-center justify-between">
        {session.stale ? (
          <span className="text-xs uppercase tracking-[0.1em]" style={{ fontFamily: FONT_MONO, color: BONE_3 }}>strap silent</span>
        ) : zoneColor ? (
          <span
            className="rounded-full border px-2 py-0.5 text-xs uppercase tracking-[0.14em]"
            style={{ fontFamily: FONT_MONO, color: zoneColor, borderColor: `${zoneColor}80` }}
          >
            {zoneWord(zoneId)}
          </span>
        ) : (
          <span className="text-xs" style={{ fontFamily: FONT_MONO, color: BONE_3 }}>—</span>
        )}
        <span className="text-base tabular-nums" style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, color: BONE }}>
          {session.effortPoints ?? 0}
          <span className="ml-1 text-[10px] tracking-[0.1em]" style={{ fontFamily: FONT_MONO, fontWeight: 400, color: BONE_3 }}>PTS</span>
        </span>
      </div>

      {/* Inline zone breakdown bar — gap-separated rounded segments */}
      <ZoneBar zonesSeconds={session.zonesSeconds} />
    </div>
  )
}

function ZoneBar({ zonesSeconds }) {
  if (!zonesSeconds) return null
  const totals = [1, 2, 3, 4, 5].map((id) => Number(zonesSeconds[id] ?? zonesSeconds[String(id)] ?? 0))
  const sum = totals.reduce((a, b) => a + b, 0)
  if (sum === 0) return null
  return (
    <div className="mt-2 flex h-1.5 w-full gap-[2px]">
      {totals.map((sec, i) => {
        if (sec === 0) return null
        return (
          <div
            key={i}
            className="rounded-[3px]"
            style={{ flex: sec, backgroundColor: zoneColorDark(i + 1) }}
          />
        )
      })}
    </div>
  )
}

function EmptyBoard() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <p className="text-2xl font-semibold" style={{ fontFamily: FONT_DISPLAY, color: BONE_2 }}>Waiting for class to start</p>
      <p className="mt-3 text-sm" style={{ color: BONE_3 }}>
        Heart rate tiles appear automatically when members start training.
      </p>
    </div>
  )
}

// ── helpers ──────────────────────────────────────────────────────

// Landscape: 8 tiles is the canonical full screen on a 1080p landscape TV
// (2×4). Portrait stacks narrower columns.
function gridColsFor(n, portrait = false) {
  if (portrait) {
    if (n <= 8) return 2
    if (n <= 18) return 3
    return 4
  }
  // <=4 keeps 2 big columns (a 3-person class gets huge tiles); from 5 up the
  // 4-column grid applies — 8 tiles fill a 1080p landscape panel exactly
  // (the canonical full screen, per the approved board spec).
  if (n <= 4) return 2
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
