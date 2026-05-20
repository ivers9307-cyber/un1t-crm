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
// to what the TV shows. Fills its nearest positioned ancestor.

import { useEffect, useState, useRef } from 'react'
import { resolveZone, FLEX_V, FLEX_H } from '@/lib/tv-template'
import FittedText from './FittedText'

export default function TemplateCanvas({ content }) {
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
      {frame && zones.map(z => {
        // resolveZone merges the zone's template default with the
        // operator's per-zone push override (TV-TEMPLATE.2).
        const s = resolveZone(z, values[z.id])
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
              alignItems: FLEX_V[s.vAlign],
              justifyContent: FLEX_H[s.align],
              overflow: 'hidden',
            }}
          >
            {/* fontSize is a % of the base-image height; FittedText
                treats it as the cap and shrinks to fit if needed. */}
            <FittedText
              text={s.text}
              maxFontSize={(s.fontSize / 100) * frame.h}
              color={s.color}
              fontWeight={s.fontWeight}
              align={s.align}
              uppercase={s.uppercase}
            />
          </div>
        )
      })}
    </div>
  )
}
