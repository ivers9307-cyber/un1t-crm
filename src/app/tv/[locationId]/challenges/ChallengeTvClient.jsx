'use client'

// In-studio challenge TV board.
//
// Polls /api/public/challenges/[locationId] every 45s (+ on mount).
// Shows the first active individual challenge's standings, rolling 8 rows
// at a time in landscape / 12 in portrait. If the first active challenge is
// collective, shows a big progress bar instead. Falls back to "this month"
// gym points board when no active challenge exists.
//
// Auto-roll: 2.6 s interval advances pageIndex; resets on fresh poll data.
// Orientation: detected via matchMedia; forced via ?orientation=portrait|landscape.
// Podium ranks 1/2/3 in tier metals (gold/silver/bronze).
// Kiosk: black background, big Poppins type, no interactivity.

import { useEffect, useCallback, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { pageSlice } from '@/lib/tv-roll'

const POLL_MS = 45_000
const ROLL_MS = 2_600

const EMBER = '#ff5a1f'

// Podium metal colours for ranks 1/2/3.
const METALS = {
  1: '#e8b931', // gold
  2: '#c2c8ce', // silver
  3: '#c77b3a', // bronze
}

function metricLabel(metric) {
  if (metric === 'points') return 'UN1T Points'
  if (metric === 'classes') return 'Classes'
  if (metric === 'z4plus_minutes') return 'Zone 4+ minutes'
  return metric
}

function formatValue(value, metric) {
  if (metric === 'z4plus_minutes') return `${Math.round(value)} min`
  if (metric === 'classes') return `${Math.round(value)}`
  return `${Math.round(value)}`
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

  // Collective challenge → big progress bar.
  if (firstActive?.mode === 'collective') {
    const { total, target, pct } = firstActive.collective || {}
    const pctDisplay = Math.round((pct || 0) * 100)
    return (
      <main className="min-h-screen bg-black text-white flex flex-col">
        <Header locationName={locationName} challengeName={firstActive.name} now={now} />

        <div className="flex flex-1 flex-col items-center justify-center px-8 py-12 gap-10">
          <div className="text-center">
            <p className="text-sm uppercase tracking-[0.3em] font-bold" style={{ color: EMBER }}>
              {metricLabel(firstActive.metric)}
            </p>
            <p className="mt-2 text-7xl font-bold tabular-nums leading-none">
              {pctDisplay}<span className="text-4xl">%</span>
            </p>
            <p className="mt-2 text-2xl text-neutral-300">
              {total ?? 0} / {target ?? '?'}
            </p>
          </div>

          <div className="w-full max-w-3xl">
            <div className="h-8 w-full overflow-hidden rounded-full bg-neutral-800">
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${pctDisplay}%`, backgroundColor: EMBER }}
              />
            </div>
            <p className="mt-3 text-center text-sm text-neutral-400">gym-wide goal</p>
          </div>
        </div>

        <Footer endsOn={firstActive.endsOn} />
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

  return (
    <main className="min-h-screen bg-black text-white flex flex-col">
      <Header locationName={locationName} challengeName={boardLabel} now={now} />

      {error && (
        <p className="mx-4 mt-2 rounded-lg border border-red-700 bg-red-950 px-3 py-2 text-sm">
          Connection issue: {error}. Retrying…
        </p>
      )}

      {isEmpty ? (
        <EmptyBoard />
      ) : (
        <>
          <div className="flex-1 px-6 py-4">
            <div className={`grid gap-3 ${portrait ? 'grid-cols-1' : 'grid-cols-2'}`}>
              {visible.map((row) => (
                <Row key={row.rank + ':' + row.name} row={row} metric={boardMetric} />
              ))}
            </div>
          </div>

          {pages > 1 && (
            <div className="pb-4 text-center text-xs text-neutral-500 tabular-nums">
              {page + 1} / {pages}
            </div>
          )}
        </>
      )}

      {firstActive?.mode === 'individual' && (
        <Footer endsOn={firstActive.endsOn} />
      )}
    </main>
  )
}

// ── sub-components ────────────────────────────────────────────────────────────

function Header({ locationName, challengeName, now }) {
  return (
    <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
      <div>
        <p className="text-xs uppercase tracking-[0.3em] font-bold" style={{ color: EMBER }}>
          ● Challenge
        </p>
        <h1 className="mt-1 text-2xl font-bold leading-tight">{locationName}</h1>
        <p className="text-base text-neutral-300 leading-tight">{challengeName}</p>
      </div>
      <div className="text-right">
        <p className="text-xl font-mono tabular-nums">
          {now.toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>
    </header>
  )
}

function Row({ row, metric }) {
  const metalColor = METALS[row.rank] || null
  const rankStyle = metalColor
    ? { color: metalColor, fontWeight: 'bold' }
    : { color: '#9ca3af' }

  return (
    <div
      className="flex items-center gap-4 rounded-xl px-5 py-4"
      style={{
        background: metalColor
          ? `linear-gradient(135deg, ${metalColor}18 0%, #000 80%)`
          : '#111',
        borderLeft: metalColor ? `5px solid ${metalColor}` : '5px solid #222',
      }}
    >
      {/* Rank */}
      <span
        className="w-10 shrink-0 text-right text-3xl tabular-nums leading-none"
        style={rankStyle}
      >
        {row.rank}
      </span>

      {/* Name */}
      <span className="flex-1 truncate text-2xl font-semibold leading-tight">
        {row.name}
      </span>

      {/* Value */}
      <span
        className="shrink-0 text-3xl font-bold tabular-nums leading-none"
        style={{ color: metalColor || EMBER }}
      >
        {formatValue(row.value, metric)}
      </span>
    </div>
  )
}

function Footer({ endsOn }) {
  if (!endsOn) return null
  return (
    <div className="border-t border-neutral-800 px-6 py-3 text-right text-xs text-neutral-500">
      ends {endsOn}
    </div>
  )
}

function EmptyBoard() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center px-8">
      <p className="text-2xl font-semibold text-neutral-300">No active challenge</p>
      <p className="mt-3 text-sm text-neutral-500">
        The leaderboard appears automatically when a challenge is running.
      </p>
    </div>
  )
}
