'use client'

// StickyOfferBar — MOBILEFUNNEL.1: on an offer page (the one_class layout:
// /newstart, /corp, /50plus, /trial) a phone visitor who has scrolled away
// from the offer card gets one full-width button pinned to the bottom of the
// screen that takes them back to it. Below `lg` only; on a wide screen the
// card sits beside the hero and the header carries the page.
//
//   href   the card's anchor ('#corp', '#book', '#trial'), the page's CTA href
//   label  the page's CTA label (e.g. "Claim my 3 free classes")
//
// Shown only while the card is out of view (an IntersectionObserver on the
// element the anchor names); hidden while any of it is on screen, and never
// shown when the anchor names nothing (a promo with no live offer renders a
// card without one) or the browser has no IntersectionObserver. The tap
// scrolls the card to just under the header (smoothly unless the visitor
// asks for reduced motion); without JS the link is a plain anchor. The bar
// clears the iPhone home indicator (env(safe-area-inset-bottom)), and a
// spacer of the same height after the footer keeps the footer's last line
// from sitting under it.
//
// The editor's preview never renders it: EditOfferLayout draws its own
// layout, and only the public OneClassLayout mounts this bar.

import { useEffect, useState } from 'react'

const HEADER_CLEARANCE_PX = 72
const BAR_PAD_STYLE = { paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)' }
const SPACER_STYLE = { height: 'calc(env(safe-area-inset-bottom, 0px) + 5rem)' }

export const anchorIdOf = (href) => (typeof href === 'string' && href.startsWith('#') && href.length > 1 ? href.slice(1) : null)

export default function StickyOfferBar({ href, label }) {
  const id = anchorIdOf(href)
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (!id || typeof IntersectionObserver === 'undefined') return undefined
    const card = document.getElementById(id)
    if (!card) return undefined
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) setShow(!entry.isIntersecting)
    }, { threshold: 0 })
    observer.observe(card)
    return () => observer.disconnect()
  }, [id])

  if (!id || !label) return null

  function goToCard(e) {
    const card = document.getElementById(id)
    if (!card) return
    e.preventDefault()
    let reduce = false
    try { reduce = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) } catch { /* no matchMedia */ }
    const top = card.getBoundingClientRect().top + (window.scrollY || 0) - HEADER_CLEARANCE_PX
    window.scrollTo({ top: Math.max(0, top), behavior: reduce ? 'auto' : 'smooth' })
  }

  return (
    <>
      <div aria-hidden="true" className="lg:hidden bg-black" style={SPACER_STYLE} />
      {show && (
        <div data-sticky-offer="" className="fixed inset-x-0 bottom-0 z-30 lg:hidden bg-white/95 backdrop-blur border-t border-black/10 px-4 pt-3" style={BAR_PAD_STYLE}>
          <a href={href} onClick={goToCard} className="block w-full rounded-full bg-black text-white text-center py-3.5 px-6 font-bold text-base">
            {label}
          </a>
        </div>
      )}
    </>
  )
}
