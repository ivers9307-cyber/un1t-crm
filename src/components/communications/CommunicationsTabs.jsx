'use client'

// Sub-tab navigation for /communications — the Messages landing's own
// strip. Pure UI — the parent layout already redirected away if neither
// underlying permission is held, and computes the two props below.
//
// DEEP.4 Task 2 (4B) — slimmed from six tabs to two. Send / Sent /
// Templates / Segments moved to communications/(marketing-era) (their
// own route group + their own HubTabs-based strip — see that layout's
// header comment), because they're campaign-lifecycle content with zero
// inbox coupling. What's left here is genuinely Messages territory: the
// unified WhatsApp/Instagram inbox and the email support-ticket queue.
// The scroller/fade/badge machinery below is kept as-is (harmless at two
// tabs, and this component still needs to survive the same 375px
// viewport COMMSLAYOUT.2 fixed for six).
//
// INBOX-SURFACE.C adds a THIRD tab, conditionally: Mail, the other half of the
// ticketing A/B. `canMail` is DATA-gated, not permission-gated — the layout
// resolves it by asking whether this studio has an active account on that
// surface — because a tab that opens onto a surface with nothing routed to it
// reads as broken mail, not as a feature that is off. The strip is back to
// being wider than a 375px viewport with three tabs, which is exactly what the
// scroller and fades below already handle.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import clsx from 'clsx'
import { usePolledCount } from '../use-polled-count'

export default function CommunicationsTabs({ canWhatsapp, canMail = false }) {
  const pathname = usePathname()
  const activeRef = useRef(null)
  const scrollerRef = useRef(null)
  // COMMS-DETAIL-FIX.2 — which edge (if either) has tabs beyond it.
  const [edges, setEdges] = useState({ start: false, end: false })

  // Conversations needing action (awaiting a reply or handed off) at the
  // active location — same endpoint + poller as the sidebar Communications
  // badge, so the two counts can never disagree.
  const inboxActionCount = usePolledCount({
    enabled: !!canWhatsapp,
    url: '/api/whatsapp/unread-count',
  })

  // INBOX-SURFACE.E — the Mail tab's needs-reply count (the only email badge
  // since RETIRE-TICKETS.1 deleted the ticket queue and its tab).
  // `enabled: !!canMail` matters: a studio with no mailboxes has nothing to
  // poll for, and polling anyway would be a request with no possible answer.
  const mailNeedsReplyCount = usePolledCount({
    enabled: !!canMail,
    url: '/api/email/mail/count',
  })

  const tabs = [
    // UIX-P1b: one unified WhatsApp + Instagram queue — the separate
    // Instagram tab retired (/communications/instagram redirects here).
    canWhatsapp && { id: 'inbox',      label: 'WhatsApp & Instagram inbox', href: '/communications/inbox', badge: inboxActionCount },
    // RETIRE-TICKETS.1 — the "Email inbox" ticket-queue tab that sat here is
    // gone; Mail is the email surface. Labelled "Mail", NOT "Inbox": the
    // first tab is already an inbox, and two tabs called Inbox is an operator
    // guessing which queue they are opening. The route is /communications/mail
    // for the same reason — /communications/inbox has been the unified
    // WhatsApp + Instagram queue since UIX-P1b. "Ticket" stays the name of
    // the DATA MODEL only — the API and the `email_tickets` table are
    // deliberately unchanged.
    canMail && { id: 'mail', label: 'Mail', href: '/communications/mail', badge: mailNeedsReplyCount },
  ].filter(Boolean)

  // COMMS-DETAIL-FIX.2 — measured rather than assumed, because "does this
  // overflow" depends on the viewport AND on how many tabs the viewer's
  // permissions produced. A media query would guess at both.
  const measure = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    // 1px slack: sub-pixel layout leaves a permanent 0.4px of "overflow" on
    // a row that visibly fits, which would park a fade on the desktop strip.
    const next = {
      start: max > 1 && el.scrollLeft > 1,
      end: max > 1 && el.scrollLeft < max - 1,
    }
    // FU-COMMSTABS-BAILOUT — backported from HubTabs.jsx's identical
    // measure(). Bail out on a no-op update (same reference back) rather
    // than always handing setEdges a fresh object literal. jsdom reports
    // scrollWidth === clientWidth === 0, so the mount-time layout effect
    // and the pathname effect both compute the same {false,false} — a
    // fresh object each time still re-renders (React only skips identical
    // *references*), which forced every per-tab badge poller to re-run on
    // mount and re-resolve its count, discarding whatever the first
    // render saw.
    setEdges(prev => (prev.start === next.start && prev.end === next.end) ? prev : next)
  }, [])

  useLayoutEffect(() => {
    measure()
    const el = scrollerRef.current
    if (!el) return undefined
    // The row's width changes with the permission set and with a badge count
    // going 9 → 10, neither of which fires a window resize.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  // COMMSLAYOUT.2 — with six tabs the row is wider than a 375px viewport, so
  // the active tab can start off-screen. `inline: 'nearest'` only scrolls when
  // it actually is; `block: 'nearest'` keeps it from yanking the page down.
  // Optional-called because jsdom does not implement scrollIntoView.
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    measure()
  }, [pathname, measure])

  return (
    // COMMSLAYOUT.2 — the strip was a no-wrap `flex` row of `flex-1` children
    // with no scroll: at 375px six tabs squashed to ~55px each and the labels
    // became unreadable. Scrolling (rather than wrapping or truncating) is the
    // conventional fix for a tab strip and the only one that keeps this
    // component's shape: wrapping would turn a one-line control into a
    // two-line block that shifts the page below it as permissions change, and
    // truncating would leave "Temp…"/"Segm…" — labels a scan cannot tell
    // apart. `w-max` lets the row size to its content on narrow screens, while
    // `min-w-full` + `flex-1` reproduce the existing even-width desktop row
    // exactly once the viewport is wider than the content.
    // COMMS-DETAIL-FIX.2 — the strip scrolled but said nothing about it. At
    // 375px it is 507px of content in a 327px viewport with the scrollbar
    // hidden, so there was ZERO signal that more tabs existed; and with the
    // last tab active, scrollIntoView parked the row so the left edge cut
    // straight through the Inbox badge, leaving a red half-circle against a
    // hard vertical edge with no label — which reads as a rendering bug, not
    // as "scroll for more".
    //
    // Two changes, one for each half. `scroll-px-7` keeps the resting scroll
    // position 28px clear of the viewport edge (honoured by scrollIntoView),
    // so a tab is never parked flush and sliced; and a gradient fade sits on
    // whichever edge still has tabs beyond it, which both softens whatever the
    // cut lands on and IS the affordance. A fade is the conventional answer
    // here because it costs no layout: arrow buttons would need 2×28px of the
    // 327px viewport — a whole tab's worth — and an always-visible scrollbar
    // would add a row of chrome under a control that is one row tall by
    // design. Both fades are measured, so the even-width desktop row (where
    // nothing overflows) renders exactly as before.
    <div className="relative mb-6 max-w-3xl">
      <div
        ref={scrollerRef}
        data-testid="tabs-scroller"
        onScroll={measure}
        className="overflow-x-auto overscroll-x-contain scroll-px-7 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div className="flex w-max min-w-full p-1 bg-un1t-surface border border-un1t-border rounded-xl">
          {tabs.map(t => {
            const active = pathname === t.href || pathname.startsWith(`${t.href}/`)
            return (
              <Link
                key={t.id}
                href={t.href}
                ref={active ? activeRef : undefined}
                className={clsx(
                  'flex-1 whitespace-nowrap text-center px-3 py-2 rounded-lg text-sm transition-colors',
                  active
                    ? 'bg-un1t-text text-un1t-bg font-semibold'
                    : 'text-un1t-subtle hover:text-un1t-text'
                )}
              >
                {t.label}
                {/* Driven off the tab's own `badge` rather than an id check, so a
                    third badged tab is one property, not another special case. */}
                {t.badge > 0 && (
                  <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold align-middle">
                    {t.badge > 99 ? '99+' : t.badge}
                  </span>
                )}
              </Link>
            )
          })}
        </div>
      </div>

      {/* Coloured from the strip's own surface, so the tabs dissolve into it
          rather than into an unrelated page background. Flush to the edge
          (not inset by the border) because a fade only renders when there IS
          content beyond that edge — which means the strip's border on that
          side is already scrolled out of view, and a 1px gap there let the
          severed badge's last red pixel through. `from-15%` keeps the first
          6px fully opaque so whatever the cut lands on is covered outright. */}
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
