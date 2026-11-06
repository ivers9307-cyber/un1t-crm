'use client'

// HeaderAutoHide — MOBILEFUNNEL.1: the public sticky header's scroll
// behaviour on a phone. SiteHeader is pure (a server component on the public
// page), so this island renders an empty marker inside the <header> and sets
// `data-hidden` on it: "true" while the visitor scrolls DOWN past the bar's
// own height, "false" as soon as they scroll up or are back near the top.
// The header's own classes do the moving, and only below `lg`
// (`max-lg:data-[hidden=true]:-translate-y-full`), so a stray attribute on a
// wide screen moves nothing.
//
// Never hides: at the very top of the page (within the bar's height), from
// `lg` up, or when the visitor asks for reduced motion (the bar then simply
// stays, which is the no-motion choice). A keyboard user tabbing into the
// hidden bar brings it back (the header's focus-within class).

import { useEffect, useRef } from 'react'

/** Scroll distance (px) that counts as a direction, so jitter never flips the bar. */
export const SCROLL_DEADBAND_PX = 6
export const PHONE_QUERY = '(max-width: 1023.98px)'
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * Whether the bar should be hidden after a scroll from `lastY` to `y`, or
 * `null` for "leave it as it is" (a move inside the deadband). Pure.
 */
export function nextHidden({ y, lastY, barHeight, allowed }) {
  if (!allowed || y <= barHeight) return false
  const delta = y - lastY
  if (delta > SCROLL_DEADBAND_PX) return true
  if (delta < -SCROLL_DEADBAND_PX) return false
  return null
}

const matches = (query) => {
  try { return Boolean(window.matchMedia && window.matchMedia(query).matches) } catch { return false }
}

export default function HeaderAutoHide() {
  const markerRef = useRef(null)

  useEffect(() => {
    const header = markerRef.current?.closest('header')
    if (!header) return undefined
    let lastY = window.scrollY || 0
    let hidden = false
    let pending = false
    let frame = 0
    const set = (next) => {
      if (next === null || next === hidden) return
      hidden = next
      header.setAttribute('data-hidden', next ? 'true' : 'false')
    }
    const update = () => {
      pending = false
      const y = window.scrollY || 0
      const allowed = matches(PHONE_QUERY) && !matches(REDUCED_MOTION_QUERY)
      const next = nextHidden({ y, lastY, barHeight: header.offsetHeight || 0, allowed })
      set(next)
      // Inside the deadband the reference point stays, so a slow scroll still adds up.
      if (next !== null) lastY = y
    }
    const onScroll = () => {
      // One read per frame; `pending` is set first so a frame that runs at once still clears it.
      if (pending) return
      pending = true
      if (typeof window.requestAnimationFrame !== 'function') { update(); return }
      frame = window.requestAnimationFrame(update)
    }
    header.setAttribute('data-hidden', 'false')
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (pending && frame && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame)
      header.removeAttribute('data-hidden')
    }
  }, [])

  return <span ref={markerRef} hidden aria-hidden="true" />
}
