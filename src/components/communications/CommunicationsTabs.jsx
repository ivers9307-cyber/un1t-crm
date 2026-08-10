'use client'

// Sub-tab navigation for /communications. Each tab gates itself by
// the underlying email / whatsapp permission. Pure UI — the parent
// layout already redirected away if neither perm is held, and it
// computes the props (including `canSegments`, which mirrors the
// segments page's own manager gate — see COMMSLAYOUT.3 below).

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import clsx from 'clsx'
import { usePolledCount } from '../use-polled-count'

export default function CommunicationsTabs({ canSms, canEmail, canWhatsapp, canEmailInbox, canSegments }) {
  const pathname = usePathname()
  const activeRef = useRef(null)

  // Conversations needing action (awaiting a reply or handed off) at the
  // active location — same endpoint + poller as the sidebar Communications
  // badge, so the two counts can never disagree.
  const inboxActionCount = usePolledCount({
    enabled: !!canWhatsapp,
    url: '/api/whatsapp/unread-count',
  })

  // EMAIL-TICKET-CLEANUP.3 — same endpoint + poller as the sidebar Email badge,
  // for the same reason: two numbers for one queue that could disagree is worse
  // than one number.
  const emailNeedsReplyCount = usePolledCount({
    enabled: !!canEmailInbox,
    url: '/api/email/tickets/count',
  })

  const canSend = canSms || canEmail || canWhatsapp
  const tabs = [
    // PILLAR2: the unified audience-first send + its history replace the old
    // per-channel Campaigns / Broadcasts tabs.
    canSend     && { id: 'send',       label: 'Send',       href: '/communications/send' },
    canSend     && { id: 'sent',       label: 'Sends',      href: '/communications/sent' },
    // UIX-P1b: one unified WhatsApp + Instagram queue — the separate
    // Instagram tab retired (/communications/instagram redirects here).
    canWhatsapp && { id: 'inbox',      label: 'Inbox',      href: '/communications/inbox', badge: inboxActionCount },
    // EMAIL-TICKET.4 — the studio email queue. Its own key (`email_inbox`),
    // not the marketing `email` one, so it appears for the people who
    // actually answer accounts@/sales@ and for nobody else.
    //
    // INBOX-SPLIT.1 — labelled "Email", not "Tickets": operators think in
    // channels, and this is now the ONLY place email is worked (the unified
    // Inbox is WhatsApp + Instagram only). "Ticket" stays the name of the
    // DATA MODEL — the route, the API and the `email_tickets` table are all
    // deliberately unchanged.
    canEmailInbox && { id: 'tickets',  label: 'Email',      href: '/communications/tickets', badge: emailNeedsReplyCount },
    (canEmail || canWhatsapp) && { id: 'templates', label: 'Templates', href: '/communications/templates' },
    // Segments tab (mig 085, moved from top-level /segments).
    //
    // COMMSLAYOUT.3 — gated on `canSegments`, which the layout computes as the
    // SAME manager-role check /communications/segments applies to itself (and
    // that GET /api/segments applies to its data). It used to render on
    // `canEmail || canWhatsapp`, so a `staff` user with the email permission
    // saw the tab, clicked it, and was redirected to `/` — off Communications
    // entirely. Hiding a tab you cannot use beats ejecting you from one.
    canSegments && { id: 'segments',  label: 'Segments',  href: '/communications/segments' },
  ].filter(Boolean)

  // COMMSLAYOUT.2 — with six tabs the row is wider than a 375px viewport, so
  // the active tab can start off-screen. `inline: 'nearest'` only scrolls when
  // it actually is; `block: 'nearest'` keeps it from yanking the page down.
  // Optional-called because jsdom does not implement scrollIntoView.
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [pathname])

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
    <div className="overflow-x-auto overscroll-x-contain mb-6 max-w-3xl [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
  )
}
