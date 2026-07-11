'use client'
// PRESENT — fullscreen public viewer. Preloads every slide image once, then
// only toggles which is visible on current_index change (no reload, no flash).
// Polls /api/public/presentations/[token]/state ~1s; swaps on version change.
import { useEffect, useRef, useState } from 'react'
import { hasAdvanced } from '@/lib/presentations'

// Slide-sync poll; a few seconds of advance latency is imperceptible and 1s
// was a standing Vercel Fluid-compute cost on always-open screens.
const POLL_MS = 4000

export default function PresentViewer({ token, initial }) {
  const [slides, setSlides] = useState(initial?.slides || [])
  const [index, setIndex] = useState(initial?.current_index || 0)
  const [invalid, setInvalid] = useState(false)
  const versionRef = useRef(initial?.version ?? null)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const res = await fetch(`/api/public/presentations/${token}/state?_=${Date.now()}`, { cache: 'no-store' })
        if (res.status === 404) { if (!cancelled) setInvalid(true); return }
        if (!res.ok) return
        const j = await res.json()
        if (cancelled || !j.success) return
        if (hasAdvanced(versionRef.current, j.version)) {
          versionRef.current = j.version
          setSlides(j.slides || [])
          setIndex(j.current_index || 0)
        }
      } catch { /* network blip — retry next tick */ }
    }
    const h = setInterval(tick, POLL_MS)
    return () => { cancelled = true; clearInterval(h) }
  }, [token])

  if (invalid) {
    return <Stage><div style={{ color: '#444', fontSize: 14 }}>Invalid presentation link.</div></Stage>
  }
  const current = slides[index]
  return (
    <Stage>
      {/* Preload every slide; show only the current one. Swapping is instant. */}
      {slides.map((url, i) => (
        <img
          key={url}
          src={url}
          alt=""
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%',
            objectFit: 'contain', opacity: i === index ? 1 : 0,
            transition: 'opacity 300ms ease-in-out', pointerEvents: 'none',
          }}
        />
      ))}
      {!current && <div style={{ color: '#444', fontSize: 14 }}>Waiting for the presenter…</div>}
    </Stage>
  )
}

function Stage({ children }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#000', overflow: 'hidden',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
    }}>
      {children}
    </div>
  )
}
