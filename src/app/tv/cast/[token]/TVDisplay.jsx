'use client'

// TV.1 — fullscreen display client for UC Cast Pro.
//
// Polls /api/public/tv/[token]/content every 3s. Re-renders only
// when content.pushed_at changes (so a steady-state poll is cheap).
// Renders one of:
//   - <img>        for source_type 'storage' or 'url'
//   - TemplateView for source_type 'template' (TV-TEMPLATE.1) —
//                  a fixed base image with text zones overlaid
//   - Idle view    (UN1T mark + live clock) if no content row
//
// TV-ROTATION.1 — the whole stage is counter-rotated by
// display.rotation degrees so content designed landscape fills a
// panel that's been hung portrait (or upside-down). 0 = normal.

import { useEffect, useState, useRef } from 'react'

const POLL_MS = 3000

export default function TVDisplay({ token, initial }) {
  const [data, setData] = useState(initial)
  const [now, setNow] = useState(new Date())
  const lastPushedAtRef = useRef(initial?.content?.pushed_at || null)
  const lastRotationRef = useRef(initial?.display?.rotation ?? 0)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const res = await fetch(`/api/public/tv/${token}/content`, { cache: 'no-store' })
        if (!res.ok) return
        const j = await res.json()
        const newPushedAt = j?.content?.pushed_at || null
        const newRotation = j?.display?.rotation ?? 0
        // Re-render on a new push OR an orientation change so the
        // operator can re-aim the panel without rebooting the cast.
        if (newPushedAt !== lastPushedAtRef.current || newRotation !== lastRotationRef.current) {
          lastPushedAtRef.current = newPushedAt
          lastRotationRef.current = newRotation
          if (!cancelled) setData(j)
        }
      } catch {
        // network blip — retry next tick
      }
    }
    const handle = setInterval(tick, POLL_MS)
    return () => { cancelled = true; clearInterval(handle) }
  }, [token])

  useEffect(() => {
    const handle = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(handle)
  }, [])

  const content = data?.content
  const rotation = data?.display?.rotation ?? 0

  // The stage carries the rotation. For 90/270 the rotated element's
  // own axes are swapped relative to the viewport, so it has to be
  // sized height-for-width (100vh wide, 100vw tall) and pinned to
  // the centre — otherwise the rotated box hangs off the screen.
  const quarterTurn = rotation === 90 || rotation === 270
  const stageStyle = quarterTurn
    ? {
        position: 'absolute',
        top: '50%',
        left: '50%',
        width: '100vh',
        height: '100vw',
        transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
        transformOrigin: 'center center',
        // container-type makes the stage box the reference for the
        // cqh/cqw units the idle view uses, so the clock stays
        // correctly proportioned to the panel after rotation.
        containerType: 'size',
      }
    : {
        position: 'absolute',
        inset: 0,
        transform: rotation === 180 ? 'rotate(180deg)' : 'none',
        transformOrigin: 'center center',
        containerType: 'size',
      }

  let body
  if (content?.source_type === 'template' && content?.resolved_url) {
    body = <TemplateView content={content} />
  } else if (content?.resolved_url) {
    body = (
      <img
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
    )
  } else {
    body = <IdleView now={now} />
  }

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
      <div style={stageStyle}>{body}</div>
    </div>
  )
}

// ── Template view ───────────────────────────────────────────────
//
// TV-TEMPLATE.1 — a fixed base image with text zones laid over it.
// Zone geometry is stored as % of the base image, so the overlay
// only lines up if it's positioned relative to the *rendered image
// rectangle* — not the stage, which letterboxes the image when the
// panel aspect ratio differs. We measure the stage box + the
// image's natural size and compute that contained rectangle, then
// position every zone inside it.

function TemplateView({ content }) {
  const boxRef = useRef(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [nat, setNat] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const zones = content.template?.zones || []
  const values = content.template?.values || {}

  // object-fit: contain rectangle for the base image inside the box.
  let frame = null
  if (box.w > 0 && box.h > 0 && nat.w > 0 && nat.h > 0) {
    const scale = Math.min(box.w / nat.w, box.h / nat.h)
    const w = nat.w * scale
    const h = nat.h * scale
    frame = { w, h, left: (box.w - w) / 2, top: (box.h - h) / 2 }
  }

  return (
    <div ref={boxRef} style={{ position: 'absolute', inset: 0 }}>
      <img
        src={content.resolved_url}
        alt={content.label || ''}
        onLoad={e => setNat({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'contain',
        }}
      />
      {frame && zones.map(z => {
        const text = (values[z.id] ?? z.defaultText ?? '').toString()
        return (
          <div
            key={z.id}
            style={{
              position: 'absolute',
              left: frame.left + (z.x / 100) * frame.w,
              top: frame.top + (z.y / 100) * frame.h,
              width: (z.width / 100) * frame.w,
              height: (z.height / 100) * frame.h,
              display: 'flex',
              alignItems: V_ALIGN[z.vAlign] || 'center',
              justifyContent: H_ALIGN[z.align] || 'center',
              textAlign: z.align || 'center',
              color: z.color || '#FFFFFF',
              fontWeight: z.fontWeight || 700,
              // fontSize is stored as % of the base image height.
              fontSize: ((z.fontSize || 6) / 100) * frame.h,
              lineHeight: 1.12,
              textTransform: z.uppercase ? 'uppercase' : 'none',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflow: 'hidden',
            }}
          >
            <span style={{ width: '100%' }}>{text}</span>
          </div>
        )
      })}
    </div>
  )
}

const V_ALIGN = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }
const H_ALIGN = { left: 'flex-start', center: 'center', right: 'flex-end' }

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
        gap: '5cqh',
      }}
    >
      {/* cqh = 1% of the stage box height. The stage is already
          oriented to the panel, so these track the panel whichever
          way the TV is rotated (matches the old vh values 1:1 in
          the landscape case). */}
      <div style={{ fontSize: '12cqh', fontWeight: 900, letterSpacing: '0.2em' }}>UN1T</div>
      <div style={{ fontSize: '18cqh', fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
        {hh}:{mm}
      </div>
      <div style={{ fontSize: '3.5cqh', color: '#888', letterSpacing: '0.1em' }}>
        {day}
      </div>
    </div>
  )
}
