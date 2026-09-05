'use client'

// HubTabs — the shared hub tab strip (phase-2 consolidation). Server hub
// layouts compute permission-filtered `tabs` ([{ id, label, href, badgeUrl? }])
// and this client strip owns pathname, badge polling and overflow.
//
// Generalised from CommunicationsTabs (scroller + measured edge fades —
// see COMMSLAYOUT.2 / COMMS-DETAIL-FIX.2 there for the full rationale)
// with two deliberate differences:
// - Active state is LONGEST match (CalendlyTabs' fix), because hub tabs
//   routinely nest and a bare startsWith lights every prefix.
// - Renders nothing below 2 tabs (dashboard/layout.js precedent): a
//   one-tab strip is chrome with no choice.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ExternalLink } from 'lucide-react'
import clsx from 'clsx'
import { usePolledCount } from './use-polled-count'

// Hooks can't sit in the tabs.map loop, so each badge is its own component.
// Since MAIL-PERF.1 a badge is a subscriber on poll-store.js, not a poller:
// badges sharing a URL (here, in the sidebar, in CommunicationsTabs) share ONE
// visibility-gated request per cadence, and the badge unmounting is what
// releases it. Still keep badge tabs per hub to the few queues that need a
// live count — every distinct badgeUrl is still its own clock and request.
function TabBadge({ url }) {
  const count = usePolledCount({ enabled: true, url })
  if (!(count > 0)) return null
  return (
    <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold align-middle">
      {count > 99 ? '99+' : count}
    </span>
  )
}

export default function HubTabs({ tabs }) {
  const pathname = usePathname()
  const activeRef = useRef(null)
  const scrollerRef = useRef(null)
  const [edges, setEdges] = useState({ start: false, end: false })

  const measure = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    const next = {
      start: max > 1 && el.scrollLeft > 1,
      end: max > 1 && el.scrollLeft < max - 1,
    }
    // Bail out on a no-op update (same reference back) rather than always
    // handing setEdges a fresh object literal. jsdom reports scrollWidth ===
    // clientWidth === 0, so the mount-time layout effect and the pathname
    // effect both compute the same {false,false} — a fresh object each time
    // still re-renders (React only skips identical *references*), which
    // forced every per-tab badge poller to re-run on mount and re-resolve
    // its count, discarding whatever the first render saw.
    setEdges(prev => (prev.start === next.start && prev.end === next.end) ? prev : next)
  }, [])

  useLayoutEffect(() => {
    measure()
    const el = scrollerRef.current
    if (!el) return undefined
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    measure()
  }, [pathname, measure])

  if (!tabs || tabs.length < 2) return null

  // HUBS.2f — a newTab tab (e.g. Marketing's Landing page → /welcome,
  // the public site) is excluded outright, not just left to never
  // match: it has no in-app pathname, so usePathname can never
  // legitimately equal its href, but excluding it here means active
  // state can't be fooled by a contrived match either.
  const bestMatch = tabs
    .filter(t => !t.newTab)
    .filter(t => pathname === t.href || (t.href !== '/' && pathname.startsWith(`${t.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0]

  return (
    // print:hidden — nav chrome never prints (found via the (team) group
    // wrapping the contract print surface, HUBS.2d review).
    <div className="relative mb-6 max-w-3xl print:hidden">
      <div
        ref={scrollerRef}
        data-testid="tabs-scroller"
        onScroll={measure}
        className="overflow-x-auto overscroll-x-contain scroll-px-7 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div className="flex w-max min-w-full p-1 bg-un1t-surface border border-un1t-border rounded-xl">
          {tabs.map(t => {
            // newTab tabs are never the active one (see the bestMatch
            // filter above) — this `&& !t.newTab` is belt-and-braces,
            // not load-bearing, since bestMatch can never equal them.
            const active = bestMatch?.href === t.href && !t.newTab
            const className = clsx(
              'flex-1 whitespace-nowrap text-center px-3 py-2 rounded-lg text-sm transition-colors',
              active
                ? 'bg-un1t-text text-un1t-bg font-semibold'
                : 'text-un1t-subtle hover:text-un1t-text'
            )
            if (t.newTab) {
              // Same idiom as Sidebar.jsx's openInNewTab rendering: a
              // plain anchor (no client-side <Link> prefetch/navigation
              // for a page outside this app) with an ExternalLink glyph
              // after the label.
              return (
                <a
                  key={t.id}
                  href={t.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={className}
                >
                  {t.label}
                  {t.badgeUrl ? <TabBadge url={t.badgeUrl} /> : null}
                  <ExternalLink size={12} className="inline-block opacity-60 ml-1" />
                </a>
              )
            }
            return (
              <Link
                key={t.id}
                href={t.href}
                ref={active ? activeRef : undefined}
                className={className}
              >
                {t.label}
                {t.badgeUrl ? <TabBadge url={t.badgeUrl} /> : null}
              </Link>
            )
          })}
        </div>
      </div>
      {edges.start && (
        <div
          data-testid="tabs-fade-start"
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-10 rounded-l-xl bg-gradient-to-r from-un1t-surface from-15% via-un1t-surface/80 to-transparent"
        />
      )}
      {edges.end && (
        <div
          data-testid="tabs-fade-end"
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-10 rounded-r-xl bg-gradient-to-l from-un1t-surface from-15% via-un1t-surface/80 to-transparent"
        />
      )}
    </div>
  )
}
