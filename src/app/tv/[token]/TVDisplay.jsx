'use client'

// TV.1 — fullscreen display client.
//
// Polls /api/tv/[token]/content every 3s. Re-renders only when
// content.pushed_at changes (so a steady-state poll is cheap).
// Renders one of:
//   - <img>      for source_type 'storage' or 'url'
//   - Idle view (UN1T mark + live clock) if no content row
//
// On the wire we use plain fetch — no Supabase client needed
// because the API route is public (token-gated server-side).
//
// Image rendering: object-fit: contain on a 100vw × 100vh
// container so the image fills the screen preserving aspect
// ratio. Background is solid black so letter/pillar-boxing
// looks intentional, not broken.

import { useEffect, useState, useRef } from 'react'

const POLL_MS = 3000

export default function TVDisplay({ token, initial }) {
  const [data, setData] = useState(initial)
  const [now, setNow] = useState(new Date())
  const lastPushedAtRef = useRef(initial?.content?.pushed_at || null)

  // Poll for content changes.
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const res = await fetch(`/api/public/tv/${token}/content`, { cache: 'no-store' })
        if (!res.ok) return
        const j = await res.json()
        const newPushedAt = j?.content?.pushed_at || null
        // Only re-render when content actually changed. This
        // keeps the DOM stable for hours of idle steady-state
        // (avoids flicker / GC pressure on the cast).
        if (newPushedAt !== lastPushedAtRef.current) {
          lastPushedAtRef.current = newPushedAt
          if (!cancelled) setData(j)
        }
      } catch {
        // Network blips happen — try again next tick.
      }
    }
    const handle = setInterval(tick, POLL_MS)
    return () => { cancelled = true; clearInterval(handle) }
  }, [token])

  // Tick the clock for the idle view. Once per second is plenty
  // for a wall display and stays out of the GPU's way.
  useEffect(() => {
    const handle = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(handle)
  }, [])

  const content = data?.content

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#000',
        overflow: 'hidden',
        color: '#fff',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
      }}
    >
      {content?.resolved_url ? (
        <img
          // Cache-buster only when pushed_at changes — keeps the
          // image cached across the 3s polls but forces a reload
          // when the operator pushes new content (even if the
          // URL itself is unchanged because they re-uploaded to
          // the same path).
          src={`${content.resolved_url}${content.resolved_url.includes('?') ? '&' : '?'}t=${encodeURIComponent(content.pushed_at)}`}
          alt={content.label || ''}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
          }}
        />
      ) : (
        <IdleView now={now} />
      )}
    </div>
  )
}

// Default idle content — UN1T mark + live clock. Operator
// confirmed this in TV.1 setup.
function IdleView({ now }) {
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const day = now.toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' })
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '5vh',
      }}
    >
      <div style={{ fontSize: '12vh', fontWeight: 900, letterSpacing: '0.2em' }}>UN1T</div>
      <div style={{ fontSize: '18vh', fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
        {hh}:{mm}
      </div>
      <div style={{ fontSize: '3.5vh', color: '#888', letterSpacing: '0.1em' }}>
        {day}
      </div>
    </div>
  )
}
