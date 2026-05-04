'use client'

import { usePathname } from 'next/navigation'
import Sidebar from './Sidebar'
import AssistantBubble from './AssistantBubble'
import ImpersonationBanner from './ImpersonationBanner'
import { hasPermission } from '@/lib/permissions'

// Routes that should NOT show the CRM sidebar (i.e. anything a
// non-CRM user might land on — public booking, unsubscribe, deposit
// payment, etc.). Mirrors the auth allowlist in middleware.js.
const publicPaths = ['/login', '/book/', '/race/', '/unsubscribe/', '/preferences/', '/deposit/']

export default function AppShell({ children, user }) {
  const pathname = usePathname()
  const isPublic = publicPaths.some(p => pathname.startsWith(p))

  if (isPublic) {
    return children
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {user?.impersonatingFrom && <ImpersonationBanner user={user} />}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar user={user} />
        <main className="flex-1 overflow-auto">
          {children}
        </main>
        {hasPermission(user, 'assistant') && <AssistantBubble user={user} />}
      </div>
    </div>
  )
}
