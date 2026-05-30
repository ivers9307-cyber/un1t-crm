'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useState, useEffect } from 'react'
import Sidebar from './Sidebar'
import ImpersonationBanner from './ImpersonationBanner'

// Client-side public-route list. MUST stay in sync with the server
// proxy's publicPaths (src/proxy.js) — if a route is public there but
// missing here, the page server-renders fine for an anonymous visitor
// but AppShell then client-redirects them to /login after hydration.
// That's exactly how the public payment page (/event-pay) regressed:
// it was added to the proxy but not here. Note '/event' also covers
// '/event-pay' is FALSE (startsWith('/event/') wouldn't, and we match
// p + '/'), so /event-pay needs its own entry.
const PUBLIC_PATHS = ['/login', '/reset-password', '/welcome', '/deposit', '/book', '/event', '/event-pay', '/race', '/race-pay', '/tv', '/unsubscribe', '/preferences', '/studio-login']

export default function AppShell({ user, children }) {
  const pathname = usePathname()
  const router = useRouter()
  // Hooks must run before any early return — keep them at the top so the
  // hook order is stable across the public/protected branches below.
  const [mobileOpen, setMobileOpen] = useState(false)

  const isPublic = PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))

  // Protected route but no resolved user (expired/unresolved session, or
  // a transient profile-fetch miss in getCurrentUser). Previously the
  // chrome rendered anyway with user=null, producing a dead shell —
  // default "UN1T" logo, "Lead Management" subtitle, "User" footer and
  // an EMPTY nav (every permission check fails on a null user). Send them
  // to login instead, preserving where they were headed.
  useEffect(() => {
    if (!isPublic && !user) {
      router.replace(`/login?redirect=${encodeURIComponent(pathname || '/')}`)
    }
  }, [isPublic, user, pathname, router])

  // Public pages: render bare, no sidebar/chrome.
  if (isPublic) {
    return <>{children}</>
  }

  // Protected route without a user: render nothing while the redirect
  // above runs, rather than flashing the empty authenticated shell.
  if (!user) {
    return null
  }

  return (
    <div className="flex h-screen overflow-hidden bg-un1t-bg">
      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 inset-x-0 z-40 flex items-center gap-3 px-4 h-14 bg-un1t-surface border-b border-un1t-border">
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          className="p-1.5 -ml-1.5 text-un1t-text"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
        <span className="font-bold tracking-wider text-un1t-text">{user?.activeLocation?.name || 'UN1T'}</span>
      </div>

      {/* Sidebar */}
      <Sidebar user={user} mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <ImpersonationBanner user={user} />
        <main className="flex-1 overflow-y-auto pt-14 md:pt-0">
          {children}
        </main>
      </div>
    </div>
  )
}
