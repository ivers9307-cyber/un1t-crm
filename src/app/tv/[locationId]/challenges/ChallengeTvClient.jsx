'use client'

// In-studio challenge TV board — Repset ledger (P4a reskin of the
// Graft/Afterglow board — palette + signature only; layout unchanged).
//
// Polls /api/public/challenges/[locationId] every 45s (+ on mount).
// Shows the first active individual challenge's standings, rolling 8 rows
// at a time in landscape / 12 in portrait. If the first active challenge is
// collective, shows a big progress bar instead. Falls back to "this month"
// gym points board when no active challenge exists.
//
// Auto-roll: 2.6 s interval advances pageIndex; resets on fresh poll data.
// Orientation: detected via matchMedia; forced via ?orientation=portrait|landscape.
//
// Presentation: ink canvas, Archivo Expanded earned numbers, Figtree names,
// IBM Plex Mono telemetry. Flat ledger rows with distance-to-leader pips —
// no medals, no pills: only the leader runs volt, ranks 1-3 read full
// bone, everyone else rests at bone-2. Kicker + glow in volt (a
// challenge is earned heat; the floor board's LIVE is Redline).
//
// Sizing note: the approved mockup draws the board inside a 900px-wide TV
// frame; a kiosk TV renders at ~1920 CSS px, so the mockup's px values are
// scaled ×2 here (9px kicker → 18px, 5px pips → 10px, …). Proportions and
// letterspacings are kept verbatim.

import { useEffect, useCallback, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { pageSlice } from '@/lib/tv-roll'
import { repsetDisplay, repsetBody, repsetMono } from '@/fonts/repset'
import { ZONE_COLORS_DARK } from '@/lib/tv-zone-colors'

const POLL_MS = 45_000
const ROLL_MS = 2_600

// Repset tokens (P4a) — dark-canvas board chrome. Zone DATA colours stay in
// @/lib/tv-zone-colors, untouched.
const INK = '#131316' // canvas (never pure black)
const BONE = '#F1EEE7' // primary text (never #FFF)
const BONE_2 = '#B1AEA6'
const BONE_3 = '#75726B'
const HAIRLINE = '#30303A'
const ROW_RULE = '#292931' // board row separators + pip track
const RAISED = '#26262D'
const PIP_FILL = '#92909A'
const VOLT = '#D6FF3D' // heat is earned: kicker, glow, the leader
const REDLINE = ZONE_COLORS_DARK[5] // attention only (connection issue)

// Font stacks off the next/font CSS variables set on the root <main>.
const DISPLAY = { fontFamily: 'var(--font-repset-display), system-ui, sans-serif' }
const BODY = { fontFamily: 'var(--font-repset-body), system-ui, sans-serif' }
const MONO = { fontFamily: 'var(--font-repset-mono), ui-monospace, monospace' }

function metricLabel(metric) {
  if (metric === 'points') return 'UN1T Points'
  if (metric === 'classes') return 'Classes'
  if (metric === 'z4plus_minutes') return 'Zone 4+ minutes'
  return metric
}

// Mono unit tag rendered beside each value (the ledger shows the unit as
// telemetry, not appended prose).
function metricUnit(metric) {
  if (metric === 'classes') return 'CLASSES'
  if (metric === 'z4plus_minutes') return 'MIN'
  return 'PTS'
}

function formatValue(value) {
  return Math.round(value).toLocaleString('en-IE')
}

// Distance-to-leader pips: 10 discrete segments, always at least one lit.
function filledPips(value, leaderValue) {
  if (!(leaderValue > 0)) return 1
  return Math.min(10, Math.max(1, Math.round((value / leaderValue) * 10)))
}

export default function ChallengeTvClient({ locationId }) {
  const searchParams = useSearchParams()
  const forcedOrientation = searchParams.get('orientation') // 'portrait' | 'landscape' | null
  const [portrait, setPortrait] = useState(false)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [pageIndex, setPageIndex] = useState(0)
  const [now, setNow] = useState(new Date())
  const rollRef = useRef(null)

  // Orientation detection via matchMedia.
  useEffect(() => {
    if (forcedOrientation) {
      setPortrait(forcedOrientation === 'portrait')
      return
    }
    const mq = window.matchMedia('(orientation: portrait)')
    const handler = (e) => setPortrait(e.matches)
    setPortrait(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [forcedOrientation])

  // Poll the public endpoint.
  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/public/challenges/${locationId}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || 'Fetch failed')
      setData(json)
      setError(null)
      setPageIndex(0) // reset roll on fresh data
    } catch (e) {
      setError(e.message)
    }
  }, [locationId])

  useEffect(() => {
    fetchData()
    const t = setInterval(fetchData, POLL_MS)
    return () => clearInterval(t)
  }, [fetchData])

  // Wall clock — ticks every second so the header time is live.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1_000)
    return () => clearInterval(t)
  }, [])

  // Auto-roll.
  useEffect(() => {
    rollRef.current = setInterval(() => setPageIndex((n) => n + 1), ROLL_MS)
    return () => clearInterval(rollRef.current)
  }, [])

  // Decide what to show.
  const challenges = data?.challenges || []
  const gymBoard = data?.gymBoard || []
  const firstActive = challenges[0] || null
  const locationName = data?.location?.name || 'Studio'

  const size = portrait ? 12 : 8

  const rootClass = `relative flex min-h-screen flex-col overflow-hidden ${repsetDisplay.variable} ${repsetBody.variable} ${repsetMono.variable}`
  const rootStyle = { backgroundColor: INK, color: BONE, ...BODY }

  // Collective challenge → big progress bar.
  if (firstActive?.mode === 'collective') {
    const { total, target, pct } = firstActive.collective || {}
    const pctDisplay = Math.round((pct || 0) * 100)
    return (
      <main className={rootClass} style={rootStyle}>
        <VoltGlow />
        <Header
          locationName={locationName}
          challengeName={firstActive.name}
          metric={firstActive.metric}
          now={now}
          endsOn={firstActive.endsOn}
        />

        <div className="flex flex-1 flex-col items-center justify-center gap-10 px-8 py-12">
          <div className="text-center">
            <p
              className="text-lg uppercase"
              style={{ ...MONO, letterSpacing: '0.28em', color: VOLT }}
            >
              {metricLabel(firstActive.metric)}
            </p>
            <p
              className="mt-3 text-7xl tabular-nums leading-none"
              style={{ ...DISPLAY, fontWeight: 800, color: BONE }}
            >
              {pctDisplay}
              <span className="text-4xl">%</span>
            </p>
            <p className="mt-3 text-2xl tabular-nums" style={{ ...MONO, color: BONE_2 }}>
              {total ?? 0} / {target ?? '?'}
            </p>
          </div>

          <div className="w-full max-w-3xl">
            <div
              className="h-8 w-full overflow-hidden rounded-full"
              style={{ backgroundColor: RAISED }}
            >
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${pctDisplay}%`, backgroundColor: VOLT }}
              />
            </div>
            <p
              className="mt-4 text-center text-sm uppercase"
              style={{ ...MONO, letterSpacing: '0.22em', color: BONE_3 }}
            >
              gym-wide goal
            </p>
          </div>
        </div>

        <FooterSignature />
      </main>
    )
  }

  // Individual challenge or gym board fallback.
  const activeBoard = firstActive?.mode === 'individual' ? firstActive.standings : null
  const rows = activeBoard || gymBoard
  const boardLabel = firstActive?.mode === 'individual' ? firstActive.name : 'This month'
  const boardMetric = firstActive?.mode === 'individual' ? firstActive.metric : 'points'

  const { rows: visible, page, pages } = pageSlice(rows, pageIndex, size)

  const isEmpty = rows.length === 0

  // Pips measure distance to the overall leader (rank 1 across the whole
  // board, not just the visible page).
  const leaderValue = (rows.find((r) => r.rank === 1) || rows[0])?.value ?? 0

  // Landscape reads column-major like the mockup: first half of the page
  // down the left column, second half down the right.
  const splitAt = Math.ceil(visible.length / 2)
  const leftRows = portrait ? visible : visible.slice(0, splitAt)
  const rightRows = portrait ? [] : visible.slice(splitAt)

  return (
    <main className={rootClass} style={rootStyle}>
      <VoltGlow />
      <Header
        locationName={locationName}
        challengeName={boardLabel}
        metric={boardMetric}
        now={now}
        endsOn={firstActive?.mode === 'individual' ? firstActive.endsOn : null}
      />

      {error && (
        <p
          className="mx-12 mt-4 rounded-lg border px-4 py-2 text-base"
          style={{
            ...MONO,
            borderColor: `${REDLINE}80`,
            backgroundColor: `${REDLINE}1A`,
            color: BONE,
          }}
        >
          Connection issue: {error}. Retrying…
        </p>
      )}

      {isEmpty ? (
        <EmptyBoard />
      ) : (
        <>
          <div className="flex-1 px-12 py-5">
            {portrait ? (
              <div>
                {leftRows.map((row) => (
                  <Row
                    key={row.rank + ':' + row.name}
                    row={row}
                    metric={boardMetric}
                    leaderValue={leaderValue}
                    portrait={portrait}
                  />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-16">
                <div>
                  {leftRows.map((row) => (
                    <Row
                      key={row.rank + ':' + row.name}
                      row={row}
                      metric={boardMetric}
                      leaderValue={leaderValue}
                      portrait={portrait}
                    />
                  ))}
                </div>
                <div>
                  {rightRows.map((row) => (
                    <Row
                      key={row.rank + ':' + row.name}
                      row={row}
                      metric={boardMetric}
                      leaderValue={leaderValue}
                      portrait={portrait}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {pages > 1 && (
            <p
              className="pb-4 text-center text-sm tabular-nums"
              style={{ ...MONO, color: BONE_3 }}
            >
              {page + 1} / {pages}
            </p>
          )}
        </>
      )}

      <FooterSignature />
    </main>
  )
}

// ── sub-components ────────────────────────────────────────────────────────────

// Volt glow, top-centre — the challenge board runs on earned heat.
function VoltGlow() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute -top-32 left-1/2 h-72 w-[70%] -translate-x-1/2"
      style={{ background: `radial-gradient(closest-side, ${VOLT}24, transparent)` }}
    />
  )
}

function Header({ locationName, challengeName, metric, now, endsOn }) {
  return (
    <header
      className="relative flex items-start justify-between px-12 pb-5 pt-7"
      style={{ borderBottom: `2px solid ${BONE}` }}
    >
      <div>
        <p
          className="flex items-center gap-3 text-lg uppercase"
          style={{ ...MONO, letterSpacing: '0.28em', color: VOLT }}
        >
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 rounded-full"
            style={{ backgroundColor: VOLT, boxShadow: `0 0 12px ${VOLT}99` }}
          />
          Challenge
        </p>
        <h1
          className="mt-2 text-4xl leading-tight"
          style={{ ...DISPLAY, fontWeight: 700, color: BONE }}
        >
          {locationName}
        </h1>
        <p className="mt-1 text-xl leading-tight" style={{ ...BODY, color: BONE_2 }}>
          {challengeName}
          {metric ? ` · ${metricLabel(metric)}` : ''}
        </p>
      </div>
      <div className="text-right" style={MONO}>
        <p className="text-3xl tabular-nums" style={{ color: BONE }}>
          {now.toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' })}
        </p>
        {endsOn && (
          <p className="mt-1 text-base" style={{ color: BONE_3 }}>
            ends {endsOn}
          </p>
        )}
      </div>
    </header>
  )
}

// One ledger row: rank · name (· LEADER chip) · distance-to-leader pips · value.
// Heat is earned, not awarded: the leader runs volt, ranks 1-3 read full
// bone, everyone else rests at bone-2. No medals.
function Row({ row, metric, leaderValue, portrait }) {
  const isLeader = row.rank === 1
  const isTop = row.rank <= 3
  const filled = filledPips(row.value, leaderValue)
  const valueColor = isLeader ? VOLT : isTop ? BONE : BONE_2
  const unitColor = isLeader ? VOLT : BONE_3

  return (
    <div className="flex items-center gap-5 py-4" style={{ borderBottom: `1px solid ${ROW_RULE}` }}>
      {/* Rank — mono, two digits */}
      <span
        className="w-12 shrink-0 text-right text-xl tabular-nums leading-none"
        style={{ ...MONO, color: isLeader ? VOLT : BONE_3 }}
      >
        {String(row.rank).padStart(2, '0')}
      </span>

      {/* Name (width-capped) + leader chip */}
      <span className="flex w-64 min-w-0 shrink-0 items-center">
        <span
          className="truncate text-2xl font-semibold leading-tight"
          style={{ ...BODY, color: BONE }}
        >
          {row.name}
        </span>
        {isLeader && !portrait && (
          <span
            className="ml-3 shrink-0 rounded-full border px-2.5 py-0.5 text-sm uppercase leading-tight"
            style={{ ...MONO, letterSpacing: '0.16em', color: VOLT, borderColor: `${VOLT}80` }}
          >
            Leader
          </span>
        )}
      </span>

      {/* Distance-to-leader pips */}
      <span aria-hidden="true" className="flex flex-1 items-center gap-1.5">
        {Array.from({ length: 10 }, (_, i) => (
          <span
            key={i}
            className="h-2.5 flex-1 rounded-full"
            style={{ backgroundColor: i < filled ? (isLeader ? VOLT : PIP_FILL) : ROW_RULE }}
          />
        ))}
      </span>

      {/* Value + mono unit tag */}
      <span
        className="shrink-0 whitespace-nowrap text-3xl tabular-nums leading-none"
        style={{ ...DISPLAY, fontWeight: 700, color: valueColor }}
      >
        {formatValue(row.value)}
        <span
          className="ml-2 text-base"
          style={{ ...MONO, fontWeight: 400, letterSpacing: '0.1em', color: unitColor }}
        >
          {metricUnit(metric)}
        </span>
      </span>
    </div>
  )
}

// The Repset signature bar — mono handoff line left, tally mark + wordmark
// right. The tally: three rounded bone bars struck through by a volt
// diagonal — reps counted, set done. Same shape as the live board's footer
// (duplicated inline on purpose; no shared component file).
function FooterSignature() {
  return (
    <div
      className="flex items-center justify-between px-12 py-4"
      style={{ borderTop: `1px solid ${HAIRLINE}`, backgroundColor: INK }}
    >
      <span
        className="text-sm uppercase"
        style={{ ...MONO, letterSpacing: '0.18em', color: BONE_3 }}
      >
        Full board in your app
      </span>
      <div className="flex items-center gap-2.5">
        <svg viewBox="0 0 1024 1024" className="h-6 w-6 rounded-md" aria-hidden="true">
          <rect width="1024" height="1024" fill="#131316" />
          <rect x="230" y="200" width="116" height="624" rx="58" fill="#F1EEE7" />
          <rect x="454" y="200" width="116" height="624" rx="58" fill="#F1EEE7" />
          <rect x="678" y="200" width="116" height="624" rx="58" fill="#F1EEE7" />
          <line x1="176" y1="812" x2="848" y2="212" stroke="#D6FF3D" strokeWidth="116" strokeLinecap="round" />
        </svg>
        <span
          className="text-2xl lowercase"
          style={{ ...DISPLAY, fontWeight: 800, letterSpacing: '-0.01em', color: BONE }}
        >
          repset<span style={{ color: VOLT }}>.</span>
        </span>
      </div>
    </div>
  )
}

function EmptyBoard() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
      <p className="text-2xl font-semibold" style={{ ...BODY, color: BONE_2 }}>
        No active challenge
      </p>
      <p className="mt-3 text-sm" style={{ ...MONO, color: BONE_3 }}>
        The leaderboard appears automatically when a challenge is running.
      </p>
    </div>
  )
}
