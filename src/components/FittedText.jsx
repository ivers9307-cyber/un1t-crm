'use client'

// TV-TEMPLATE.2 — auto-fitting text.
//
// Renders `text` inside its parent box and shrinks the font size
// until the text fits — so a long workout list and a short
// "Welcome" both sit cleanly inside the same zone, no overflow.
//
// `maxFontSize` (px) is the cap: text renders at that size when it
// fits and smaller when it doesn't, never larger. That makes the
// operator's push-time size control behave as a "biggest allowed"
// setting while auto-fit guarantees it never spills.
//
// Must be rendered as the only child of a fixed-size, overflow-
// hidden box (the zone div) — it measures itself against that box.

import { useRef, useState, useEffect } from 'react'

const MIN_FONT_PX = 4

export default function FittedText({
  text,
  maxFontSize,
  color = '#FFFFFF',
  fontWeight = 700,
  align = 'center',
  uppercase = false,
}) {
  const ref = useRef(null)
  const [fontPx, setFontPx] = useState(maxFontSize || MIN_FONT_PX)

  useEffect(() => {
    const el = ref.current
    const box = el?.parentElement
    if (!el || !box) return

    const fit = () => {
      const cap = Math.max(MIN_FONT_PX, maxFontSize || 0)
      const fits = (px) => {
        el.style.fontSize = `${px}px`
        return el.scrollHeight <= box.clientHeight + 1 &&
               el.scrollWidth <= box.clientWidth + 1
      }
      // Fast path: the text already fits at the cap.
      if (fits(cap)) { el.style.fontSize = ''; setFontPx(cap); return }
      // Otherwise binary-search the largest size that fits.
      let lo = MIN_FONT_PX, hi = cap, best = MIN_FONT_PX
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2
        if (fits(mid)) { best = mid; lo = mid } else { hi = mid }
      }
      el.style.fontSize = ''
      setFontPx(best)
    }

    fit()
    // Re-fit when the box resizes (rotation change, viewport, the
    // template editor canvas being dragged, etc).
    const ro = new ResizeObserver(fit)
    ro.observe(box)
    return () => ro.disconnect()
  }, [text, maxFontSize])

  return (
    <div
      ref={ref}
      style={{
        width: '100%',
        fontSize: `${fontPx}px`,
        color,
        fontWeight,
        textAlign: align,
        textTransform: uppercase ? 'uppercase' : 'none',
        lineHeight: 1.12,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        pointerEvents: 'none',
      }}
    >
      {text}
    </div>
  )
}
