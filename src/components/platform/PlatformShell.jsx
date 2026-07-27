'use client'

// REPSET-PLATFORM.1 — the PLATFORM-tier (master console) left shell.
//
// At the platform tier both the studio operational sidebar
// (Communications, Bookings, Approvals, Accounting, …) and the account
// org menu are the wrong altitude — this is the platform operator's
// cross-tenant cockpit. AppShell renders THIS in their place on the four
// console paths (isPlatformTierPath) FOR A MASTER only; every other path
// (and every non-master) is left completely untouched. Visually it
// mirrors Sidebar.jsx / AccountShell.jsx (same <aside>, tokens, user/
// logout block) so the app reads as one system.
//
// Nav model + live/omitted item decisions live in src/lib/platform-nav.js
// (tested). This component only renders it + owns sign-out.

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LogOut, X, ArrowUpRight, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import { createBrowserClient } from '@/lib/supabase'
import { resolvePlatformNav } from '@/lib/platform-nav'

const roleLabels = {
  master: 'Master',
  owner: 'Owner',
  manager: 'Manager',
  head_coach: 'Head Coach',
  staff: 'Staff',
}

// Same leaf styling as the studio sidebar (Sidebar.jsx#leafClassName)
// and the account shell so the three shells are visually consistent.
function rowClass(active) {
  return clsx(
    'flex items-center gap-3 text-sm transition-colors px-5 py-2.5 w-full text-left',
    active
      ? 'text-un1t-text bg-un1t-border/50 border-l-2 border-un1t-text'
      : 'text-un1t-subtle hover:text-un1t-text hover:bg-un1t-border/30 border-l-2 border-transparent'
  )
}

function SectionHeader({ label }) {
  return (
    <p className="px-5 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-un1t-muted">
      {label}
    </p>
  )
}

export default function PlatformShell({ user, mobileOpen = false, onMobileClose }) {
  const router = useRouter()
  const pathname = usePathname()
  const [signingOut, setSigningOut] = useState(false)
  const nav = resolvePlatformNav(user)

  async function handleLogout() {
    if (signingOut) return
    setSigningOut(true)
    // Close any active impersonation session first (best-effort) so its
    // audit row gets a precise ended_at — mirrors Sidebar/AccountShell.
    if (user?.impersonatingFrom) {
      try {
        await fetch('/api/impersonate/stop', { method: 'POST' })
      } catch {
        // ignore — the close-stale-impersonations cron is the backstop
      }
    }
    const supabase = createBrowserClient()
    // scope:'local' — this device only (global default revokes every session).
    await supabase.auth.signOut({ scope: 'local' })
    router.push('/login')
    router.refresh()
  }

  return (
    <aside
      className={clsx(
        'w-64 md:w-56 bg-un1t-surface border-r border-un1t-border flex flex-col shrink-0',
        'fixed inset-y-0 left-0 z-50 transform transition-transform duration-200',
        mobileOpen ? 'translate-x-0' : '-translate-x-full',
        'md:relative md:translate-x-0 md:transition-none md:z-auto'
      )}
    >
      {/* Header — platform brand + mobile close. Mirrors AccountShell's
          title/eyebrow split ("Repset" over "Platform"). */}
      <div className="p-5 border-b border-un1t-border">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-wider text-un1t-text truncate">
              {nav.brand.title}
            </h1>
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-un1t-muted">
              {nav.brand.eyebrow}
            </p>
          </div>
          <button
            type="button"
            onClick={onMobileClose}
            aria-label="Close menu"
            className="md:hidden p-1.5 -m-1 text-un1t-subtle hover:text-un1t-text rounded transition-colors"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto py-4">
        {/* Console — the four platform pages. Tenants is the home. */}
        <SectionHeader label="Console" />
        {nav.primary.map((item) => {
          const Icon = item.icon
          const active = pathname === item.href || pathname.startsWith(item.href + '/')
          return (
            <Link key={item.key} href={item.href} className={rowClass(active)}>
              <Icon size={18} />
              {item.label}
            </Link>
          )
        })}

        {/* Actions — cross-links. `insideShell` items (Provision tenant)
            stay in the console; others (Audit log) link OUT to their
            current studio-shelled page (Phase-2 rule: nothing else in
            /admin moved), flagged with an out-link glyph. */}
        {nav.actions.length > 0 && (
          <>
            <SectionHeader label="Actions" />
            {nav.actions.map((item) => {
              const Icon = item.icon
              const active = item.insideShell &&
                (pathname === item.href || pathname.startsWith(item.href + '/'))
              return (
                <Link key={item.key} href={item.href} className={rowClass(active)}>
                  <Icon size={18} />
                  {item.label}
                  {!item.insideShell && (
                    <ArrowUpRight size={14} className="ml-auto opacity-50" />
                  )}
                </Link>
              )
            })}
          </>
        )}
      </nav>

      {/* Exit to app — the explicit affordance to leave the platform
          console and go back into the normal studio/account experience.
          Lands on /dashboard (loop-safe: not a console path, not `/`). */}
      <Link
        href={nav.exitHref}
        className="flex items-center gap-3 px-5 py-3 text-sm font-medium transition-colors border-t border-un1t-border text-un1t-text hover:bg-un1t-border/30"
        title="Exit the console and return to the app"
      >
        <ArrowUpRight size={18} />
        Exit to app
        <ChevronRight size={14} className="ml-auto opacity-60" />
      </Link>

      {/* User + logout — same block as the studio sidebar / account shell. */}
      <div className="border-t border-un1t-border p-4">
        <div className="flex items-center justify-between gap-2">
          <Link
            href="/account"
            className="min-w-0 flex-1 -m-1 p-1 rounded hover:bg-un1t-border/40 transition-colors"
            title="Account preferences"
          >
            <p className="text-sm font-medium truncate text-un1t-text">{user?.full_name || 'User'}</p>
            <p className="text-xs text-un1t-subtle truncate">{roleLabels[user?.role] || user?.role || ''}</p>
          </Link>
          <button
            type="button"
            onClick={handleLogout}
            className="p-1.5 text-un1t-subtle hover:text-un1t-text transition-colors rounded hover:bg-un1t-border/50 shrink-0"
            title="Sign out"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </aside>
  )
}
