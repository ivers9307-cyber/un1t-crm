'use client'

// Sub-tab navigation for /communications. Each tab gates itself by
// the underlying email / whatsapp permission. Pure UI — the parent
// layout already redirected away if neither perm is held.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import clsx from 'clsx'

export default function CommunicationsTabs({ canEmail, canWhatsapp }) {
  const pathname = usePathname()

  const tabs = [
    canWhatsapp && { id: 'inbox',      label: 'Inbox',      href: '/communications/inbox' },
    canEmail    && { id: 'sequences',  label: 'Sequences',  href: '/communications/sequences' },
    canEmail    && { id: 'campaigns',  label: 'Campaigns',  href: '/communications/campaigns' },
    canWhatsapp && { id: 'broadcasts', label: 'Broadcasts', href: '/communications/broadcasts' },
    (canEmail || canWhatsapp) && { id: 'templates', label: 'Templates', href: '/communications/templates' },
    // Segments tab (mig 085, moved from top-level /segments). Same
    // permission gate as the broadcast tabs since segments only
    // matter when you can actually send to them.
    (canEmail || canWhatsapp) && { id: 'segments',  label: 'Segments',  href: '/communications/segments' },
  ].filter(Boolean)

  return (
    <div className="flex p-1 bg-un1t-dark border border-un1t-gray rounded-xl mb-6 max-w-3xl">
      {tabs.map(t => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`)
        return (
          <Link
            key={t.id}
            href={t.href}
            className={clsx(
              'flex-1 text-center py-2 rounded-lg text-sm transition-colors',
              active
                ? 'bg-un1t-white text-un1t-black font-semibold'
                : 'text-un1t-light hover:text-un1t-white'
            )}
          >
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}
