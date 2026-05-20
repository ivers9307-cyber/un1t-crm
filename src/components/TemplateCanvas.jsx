'use client'

// TV-TEMPLATE — shared renderer for a base-image template.
//
// A fixed base image with text zones laid over it. Zone geometry
// is stored as a % of the base image, so the overlay only lines up
// when it's positioned relative to the *rendered image rectangle*
// — not the surrounding box, which letterboxes the image whenever
// the aspect ratios differ. We measure the box + the image's
// natural size, compute that contained rectangle, and position
// every zone inside it.
//
// Used both by the live cast page (TVDisplay) and by the push
// modal's preview, so what an operator previews is pixel-identical
// to what the TV shows.
//
// TV-TEMPLATE.4 — text renders at the operator's exact size (no
// auto-fit); it's clipped if it overflows. With `editable`, zones
// can be dragged + corner-resized straight on the preview and the
// new geometry is reported through `onZoneChange`.

import { useEffect, useState, useRef } from 'react'
import { resolveZone, textSegments, FLEX_V, FLEX_H } from '@/lib/tv-template'

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

export default function TemplateCanvas({ content, editable = false, onZoneChange }) {
  const boxRef = useRef(null)
  const imgRef = useRef(null)
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

  // The base image may finish loading before this component
  // hydrates (it's server-rendered on the cast page) — a load that
  // completed before React attached its handler never fires
  // onLoad. Read the natural size straight off the element once
  // it's complete; without it `frame` stays null and no text
  // renders.
  useEffect(() => {
    const img = imgRef.current
    if (img && img.complete && img.naturalWidth > 0) {
      setNat({ w: img.naturalWidth, h: img.naturalHeight })
    }
  }, [content.resolved_url])

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
        ref={imgRef}
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
      {frame && zones.map(z => (
        <Zone
          key={z.id}
          // resolveZone merges the zone's template default with the
          // operator's per-zone push override (text, style, geometry).
          s={resolveZone(z, values[z.id])}
          frame={frame}
          editable={editable}
          onChange={editable && onZoneChange ? patch => onZoneChange(z.id, patch) : undefined}
        />
      ))}
    </div>
  )
}

// ── One text zone ───────────────────────────────────────────────

function Zone({ s, frame, editable, onChange }) {
  const boxRef = useRef(null)
  const dragRef = useRef(null)

  // Geometry + font size resolved against the contained-image rect.
  const left = frame.left + (s.x / 100) * frame.w
  const top = frame.top + (s.y / 100) * frame.h
  const w = (s.width / 100) * frame.w
  const h = (s.height / 100) * frame.h
  const fontPx = (s.fontSize / 100) * frame.h

  function begin(e, mode) {
    if (!onChange) return
    e.stopPropagation()
    dragRef.current = {
      mode,
      sx: e.clientX,
      sy: e.clientY,
      fw: frame.w || 1,
      fh: frame.h || 1,
      orig: { x: s.x, y: s.y, width: s.width, height: s.height },
    }
    boxRef.current?.setPointerCapture(e.pointerId)
  }
  function move(e) {
    const d = dragRef.current
    if (!d) return
    const dx = ((e.clientX - d.sx) / d.fw) * 100
    const dy = ((e.clientY - d.sy) / d.fh) * 100
    if (d.mode === 'move') {
      onChange({
        x: clamp(d.orig.x + dx, 0, 100 - d.orig.width),
        y: clamp(d.orig.y + dy, 0, 100 - d.orig.height),
      })
    } else {
      onChange({
        width: clamp(d.orig.width + dx, 5, 100 - d.orig.x),
        height: clamp(d.orig.height + dy, 4, 100 - d.orig.y),
      })
    }
  }
  function end(e) {
    dragRef.current = null
    boxRef.current?.releasePointerCapture?.(e.pointerId)
  }

  return (
    <div
      ref={boxRef}
      onPointerDown={editable ? e => begin(e, 'move') : undefined}
      onPointerMove={editable ? move : undefined}
      onPointerUp={editable ? end : undefined}
      style={{
        position: 'absolute',
        left, top, width: w, height: h,
        display: 'flex',
        alignItems: FLEX_V[s.vAlign],
        justifyContent: FLEX_H[s.align],
        overflow: 'hidden',
        ...(editable
          ? {
              border: '1px dashed rgba(255,255,255,0.65)',
              boxSizing: 'border-box',
              cursor: 'move',
              touchAction: 'none',
            }
          : {}),
      }}
    >
      <div
        style={{
          width: '100%',
          fontSize: `${fontPx}px`,
          color: s.color,
          fontWeight: s.fontWeight,
          textAlign: s.align,
          textTransform: s.uppercase ? 'uppercase' : 'none',
          lineHeight: s.lineHeight,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          pointerEvents: 'none',
        }}
      >
        {/* Per-selection colour (TV-TEMPLATE.5): the text is split
            into runs; each renders in its own colour, the base
            colour fills the gaps. */}
        {textSegments(s.text, s.colorRuns, s.color).map((seg, i) => (
          <span key={i} style={{ color: seg.color }}>{seg.text}</span>
        ))}
      </div>
      {editable && (
        <div
          onPointerDown={e => begin(e, 'resize')}
          title="Drag to resize"
          style={{
            position: 'absolute',
            right: -1,
            bottom: -1,
            width: 16,
            height: 16,
            background: '#4ade80',
            cursor: 'nwse-resize',
            touchAction: 'none',
          }}
        />
      )}
    </div>
  )
}
