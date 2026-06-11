'use client'

// Sub-tab navigation for /communications. Each tab gates itself by
// the underlying email / whatsapp permission. Pure UI — the parent
// layout already redirected away if neither perm is held.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import clsx from 'clsx'
import { usePolledCount } from '../use-polled-count'

export default function CommunicationsTabs({ canSms, canEmail, canWhatsapp }) {
  const pathname = usePathname()

  // Unread WhatsApp messages awaiting a reply at the active location —
  // same endpoint + poller as the sidebar Communications badge, so the
  // two counts can never disagree.
  const inboxUnread = usePolledCount({
    enabled: !!canWhatsapp,
    url: '/api/whatsapp/unread-count',
  })

  const canSend = canSms || canEmail || canWhatsapp
  const tabs = [
    // PILLAR2: the unified audience-first send + its history replace the old
    // per-channel Campaigns / Broadcasts tabs.
    canSend     && { id: 'send',       label: 'Send',       href: '/communications/send' },
    canSend     && { id: 'sent',       label: 'Sends',      href: '/communications/sent' },
    // UIX-P1b: one unified WhatsApp + Instagram queue — the separate
    // Instagram tab retired (/communications/instagram redirects here).
    canWhatsapp && { id: 'inbox',      label: 'Inbox',      href: '/communications/inbox' },
    canEmail    && { id: 'sequences',  label: 'Sequences',  href: '/communications/sequences' },
    (canEmail || canWhatsapp) && { id: 'templates', label: 'Templates', href: '/communications/templates' },
    // Segments tab (mig 085, moved from top-level /segments).
    (canEmail || canWhatsapp) && { id: 'segments',  label: 'Segments',  href: '/communications/segments' },
  ].filter(Boolean)

  return (
    <div className="flex p-1 bg-un1t-surface border border-un1t-border rounded-xl mb-6 max-w-3xl">
      {tabs.map(t => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`)
        return (
          <Link
            key={t.id}
            href={t.href}
            className={clsx(
              'flex-1 text-center py-2 rounded-lg text-sm transition-colors',
              active
                ? 'bg-un1t-text text-un1t-bg font-semibold'
                : 'text-un1t-subtle hover:text-un1t-text'
            )}
          >
            {t.label}
            {t.id === 'inbox' && inboxUnread > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold align-middle">
                {inboxUnread > 99 ? '99+' : inboxUnread}
              </span>
            )}
          </Link>
        )
      })}
    </div>
  )
}
