'use client'

import { useState, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { Menu } from 'lucide-react'
import Sidebar from './Sidebar'
import AssistantBubble from './AssistantBubble'
import ImpersonationBanner from './ImpersonationBanner'
import PendingContractsAlert from './PendingContractsAlert'
import { hasPermission } from '@/lib/permissions'
// PERF.3 — Vercel scripts moved here from the root layout. Mounted
// only inside the authenticated branch so /login + public booking
// pages don't pay for two extra JS bundles before the user is in.
import { SpeedInsights } from '@vercel/speed-insights/next'
import { Analytics } from '@vercel/analytics/next'

// Routes that should NOT show the CRM sidebar (i.e. anything a
// non-CRM user might land on — public booking, unsubscribe, deposit
// payment, etc.). Mirrors the auth allowlist in middleware.js.
const publicPaths = ['/login', '/book/', '/event/', '/unsubscribe/', '/preferences/', '/deposit/', '/welcome']

export default function AppShell({ children, user }) {
  const pathname = usePathname()
  // The exact "/" path also counts as public — when un1tdublin.com or
  // www.un1tdublin.com hit "/", middleware rewrites to /welcome
  // server-side, but usePathname() returns the BROWSER URL which is
  // still "/" (the rewrite is invisible to the client). Without this,
  // visitors to un1tdublin.com saw the CRM sidebar wrapped around the
  // welcome page (and the absolute-positioned hero header scrolled
  // with the inner container instead of the page). On crm.un1tdublin
  // .com, hitting "/" never renders this layout because src/app/page
  // .js does a server-side redirect to /dashboard before AppShell
  // mounts — so this is safe.
  const isPublic = pathname === '/' || publicPaths.some(p => pathname.startsWith(p))

  // Mobile sidebar drawer state. Desktop (>= md breakpoint, 768px)
  // ignores this entirely and always shows the sidebar; mobile hides
  // it offscreen and reveals via the hamburger top-left.
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Auto-close the drawer when the user navigates. expo-router on
  // mobile uses native push, but here Link clicks update pathname
  // without unmounting the shell — so we listen for pathname changes
  // and shut the drawer if it was open.
  useEffect(() => {
    setSidebarOpen(false)
  }, [pathname])

  if (isPublic) {
    return children
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {user?.impersonatingFrom && <ImpersonationBanner user={user} />}

      {/* Mobile-only top bar with hamburger. Only renders below the
          md breakpoint; desktop has the sidebar inline so this is
          unnecessary. The branding text mirrors what the sidebar
          shows so the user always knows what app + location they're
          in even when the drawer is closed. */}
      <header className="md:hidden sticky top-0 z-30 bg-un1t-dark border-b border-un1t-gray flex items-center justify-between px-4 py-2.5">
        <button
          onClick={() => setSidebarOpen(true)}
          aria-label="Open menu"
          className="p-2 -ml-2 text-un1t-light hover:text-un1t-white active:bg-un1t-gray/40 rounded-md transition-colors"
        >
          <Menu size={22} />
        </button>
        <span className="text-sm font-semibold tracking-wider text-un1t-white">
          UN1T
        </span>
        {/* Right-side spacer to keep the title centred (matches the
            48px button width on the left). */}
        <span className="w-10" aria-hidden />
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Backdrop — only renders on mobile when open. Tapping it
            closes the drawer. md:hidden so it never appears on
            desktop even if state somehow gets set there (e.g. a
            window resize). */}
        {sidebarOpen && (
          <button
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
            className="md:hidden fixed inset-0 z-40 bg-black/50 transition-opacity"
          />
        )}

        <Sidebar
          user={user}
          mobileOpen={sidebarOpen}
          onMobileClose={() => setSidebarOpen(false)}
        />

        {/* Wrap main + the pending-contracts alert in their own
            flex column so the banner sits above the scrollable
            main content area without scrolling away with the page. */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <PendingContractsAlert />
          <main className="flex-1 overflow-auto">
            {children}
          </main>
        </div>
        {hasPermission(user, 'assistant') && <AssistantBubble user={user} />}
      </div>
      {/* PERF.3 — Speed Insights + Analytics only on authenticated
          pages. Public surfaces never render this branch. */}
      <SpeedInsights />
      <Analytics />
    </div>
  )
}
