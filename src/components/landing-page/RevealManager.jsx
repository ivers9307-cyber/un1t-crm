'use client'

// RevealManager — scroll-reveal driver for the public landing pages.
//
// Pairs with <RevealArmScript /> (reveal-arm.js) which the PUBLIC
// pages render as their first child: it adds `lp-armed` to <html>
// synchronously during HTML parse — before first paint — so
// `.lp-reveal` elements start hidden with zero flash. This island
// then marks the observer as live (`lp-io-live`, which cancels the
// CSS dead-island failsafe) and reveals each element as it enters
// the viewport.
//
// Degradation table lives next to the CSS in globals.css. Edit-mode
// (?edit=1) never renders the arm script nor this island, so the
// operator edits fully-visible static blocks.

import { useEffect } from 'react'

export default function RevealManager() {
  useEffect(() => {
    const root = document.getElementById('lp-shell')
    if (!root || !root.classList.contains('lp-armed')) return undefined
    root.classList.add('lp-io-live')

    const els = Array.from(document.querySelectorAll('.lp-reveal'))
    if (els.length === 0) return undefined

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('lp-in')
            io.unobserve(entry.target)
          }
        }
      },
      // Trigger slightly before the element fully enters so the motion
      // reads as the user arrives, not after.
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])

  return null
}
