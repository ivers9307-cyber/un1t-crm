'use client'

// CountUp — animates a stat number from 0 to its value the first time
// it scrolls into view. Server-renders the FINAL string so no-JS
// visitors, crawlers and reduced-motion users always see the real
// number; the animation is pure progressive enhancement.
//
// The operator types free-form values ("200+", "4.9", "7500+ ",
// "4.9 ⭐") — we animate the first numeric token and re-attach
// whatever surrounds it. Anything unparseable renders verbatim.

import { useEffect, useRef } from 'react'

const NUM_RE = /(-?\d[\d,]*(?:\.\d+)?)/

export default function CountUp({ value, className }) {
  const ref = useRef(null)
  const text = value == null ? '' : String(value)

  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    if (typeof window === 'undefined') return undefined
    if (!window.matchMedia('(prefers-reduced-motion: no-preference)').matches) return undefined
    if (!('IntersectionObserver' in window)) return undefined

    const match = text.match(NUM_RE)
    if (!match) return undefined
    const raw = match[1]
    const target = parseFloat(raw.replace(/,/g, ''))
    if (!Number.isFinite(target)) return undefined

    const prefix = text.slice(0, match.index)
    const suffix = text.slice(match.index + raw.length)
    const decimals = raw.includes('.') ? raw.split('.')[1].length : 0
    const useGrouping = raw.includes(',')
    const fmt = (n) =>
      n.toLocaleString('en-IE', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
        useGrouping,
      })

    let rafId = null
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        io.disconnect()
        const t0 = performance.now()
        const duration = 1400
        const tick = (now) => {
          const p = Math.min(1, (now - t0) / duration)
          const eased = 1 - Math.pow(1 - p, 4) // ease-out-quart
          el.textContent = `${prefix}${fmt(target * eased)}${suffix}`
          if (p < 1) rafId = requestAnimationFrame(tick)
          else el.textContent = text // land exactly on the source string
        }
        rafId = requestAnimationFrame(tick)
      },
      { threshold: 0.4 }
    )
    io.observe(el)
    return () => {
      io.disconnect()
      if (rafId) cancelAnimationFrame(rafId)
    }
    // text captures everything the effect reads.
  }, [text])

  return (
    <span ref={ref} className={className}>
      {text}
    </span>
  )
}
