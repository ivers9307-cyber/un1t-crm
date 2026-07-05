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
// TV-TEMPLATE.4 — with `editable`, zones can be dragged +
// corner-resized straight on the preview and the new geometry is
// reported through `onZoneChange`.
//
// TV-TEMPLATE.6 — the operator's fontSize is a MAXIMUM, not an
// exact size. Staff pasting a paragraph into a zone sized for a
// short heading used to render at the full % size and get clipped
// by the zone's overflow:hidden. useFitText (below) shrinks the
// rendered size until the text block fits, so overflow:hidden stays
// only as the final safety net for pathological cases.

import { useEffect, useState, useRef, useLayoutEffect } from 'react'
import { resolveZone, textSegments, FLEX_V, FLEX_H } from '@/lib/tv-template'
import { tvFontFamily } from '@/components/tv-font'

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

// Floor so a giant paste still reads as "small text" rather than
// disappearing entirely.
const MIN_FIT_PX = 9
// Re-measuring changes wrapping, which changes scrollHeight/Width,
// which can call for another shrink — iterate rather than trusting
// one shot, but cap it so a pathological layout can't spin forever.
const MAX_FIT_ITERATIONS = 6

// Pure step of the fit loop: given the current font size and how
// much the text block overflows its box on each axis, return the
// next (smaller-or-equal) font size to try. Kept pure + exported so
// the convergence logic itself is unit-testable without a DOM.
export function nextFitPx(currentPx, scaleH, scaleW, minPx = MIN_FIT_PX) {
  const scale = Math.min(1, scaleH, scaleW)
  if (!Number.isFinite(scale) || scale <= 0) return minPx
  return Math.max(minPx, currentPx * scale)
}

// Shrink `el`'s font size (starting at maxPx) until its content
// fits within `w`×`h` px, or the min/iteration cap is hit. Returns
// the fitted px — caller stores it in state and applies it as the
// rendered fontSize.
function measureFit(el, maxPx, w, h, minPx = MIN_FIT_PX) {
  if (!el || !(w > 0) || !(h > 0)) return maxPx
  // In a tiny container (the now-showing thumbnail) the operator's
  // max can already sit below the legibility floor — the floor must
  // never push text ABOVE its max.
  minPx = Math.min(minPx, maxPx)
  let px = maxPx
  for (let i = 0; i < MAX_FIT_ITERATIONS; i++) {
    el.style.fontSize = `${px}px`
    const overflowH = el.scrollHeight > h
    // scrollWidth matters for unbreakable words/URLs that don't wrap.
    const overflowW = el.scrollWidth > w
    if (!overflowH && !overflowW) break
    const scaleH = h / el.scrollHeight
    const scaleW = w / el.scrollWidth
    const next = nextFitPx(px, overflowH ? scaleH : 1, overflowW ? scaleW : 1, minPx)
    if (Math.abs(next - px) < 0.5) { px = next; break }
    px = next
    if (px <= minPx) break
  }
  return px
}

// Shared by TemplateCanvas's Zone and TemplateEditor's ZoneBox so
// the TV, the push preview and the template editor all agree on
// the fitted size for the same text/box/maxPx.
//
// `deps` should include everything that can change wrapping or
// measured size: text, maxPx, box w/h, lineHeight, fontWeight,
// uppercase. Re-runs on those plus a one-time recheck once web
// fonts finish loading (metrics shift slightly between the
// fallback and the loaded face).
export function useFitText(elRef, maxPx, w, h, deps) {
  const [fitPx, setFitPx] = useState(maxPx)

  useLayoutEffect(() => {
    const el = elRef.current
    if (!el) return
    const fitted = measureFit(el, maxPx, w, h)
    setFitPx(prev => (Math.abs(prev - fitted) > 0.5 ? fitted : prev))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    let cancelled = false
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (cancelled) return
        const el = elRef.current
        if (!el) return
        const fitted = measureFit(el, maxPx, w, h)
        setFitPx(prev => (Math.abs(prev - fitted) > 0.5 ? fitted : prev))
      })
    }
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return fitPx
}

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
  const textRef = useRef(null)

  // Geometry + font size resolved against the contained-image rect.
  const left = frame.left + (s.x / 100) * frame.w
  const top = frame.top + (s.y / 100) * frame.h
  const w = (s.width / 100) * frame.w
  const h = (s.height / 100) * frame.h
  // s.fontSize is a MAXIMUM (TV-TEMPLATE.6) — useFitText shrinks the
  // rendered size to whatever actually fits the zone box.
  const maxFontPx = (s.fontSize / 100) * frame.h
  const fontPx = useFitText(textRef, maxFontPx, w, h, [
    s.text, maxFontPx, w, h, s.lineHeight, s.fontWeight, s.uppercase,
  ])

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
        ref={textRef}
        style={{
          width: '100%',
          fontSize: `${fontPx}px`,
          fontFamily: tvFontFamily,
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
