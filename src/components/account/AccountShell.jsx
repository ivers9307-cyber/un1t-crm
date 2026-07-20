'use client'

// REPSET-ACCOUNT.2 — the ACCOUNT-tier left shell.
//
// At the account tier the studio operational sidebar (Communications,
// Bookings, Approvals, Accounting, Pipeline, Contacts, …) is the wrong
// altitude — it belongs to one studio's CRM. AppShell renders THIS in
// its place on account-tier paths (isAccountTierPath); the studio shell
// is left completely untouched for every other path. Visually it mirrors
// Sidebar.jsx (same <aside>, tokens, user/logout block) so the app reads
// as one system.
//
// Nav model + live/deferred item decisions live in src/lib/account-nav.js
// (tested). This component only renders it + owns the two side-effects
// (open a studio, sign out).

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LogOut, X, Store, ArrowRight, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import { createBrowserClient } from '@/lib/supabase'
import { setActiveLocation } from '@/lib/active-location'
import { resolveAccountNav } from '@/lib/account-nav'

const roleLabels = {
  master: 'Master',
  owner: 'Owner',
  manager: 'Manager',
  head_coach: 'Head Coach',
  staff: 'Staff',
}

// Same leaf styling as the studio sidebar (Sidebar.jsx#leafClassName) so
// the two shells are visually consistent.
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

export default function AccountShell({ user, mobileOpen = false, onMobileClose }) {
  const router = useRouter()
  const pathname = usePathname()
  const [signingOut, setSigningOut] = useState(false)
  const nav = resolveAccountNav(user)

  // Drill into a studio the SAME way the location switcher does: set the
  // shared active-location cookie, then land on /dashboard with a
  // refresh so getCurrentUser() re-reads it (a bare push can be served
  // from the client Router Cache under the old cookie — see AccountHome).
  function openStudio(locationId) {
    if (!locationId) return
    setActiveLocation(locationId)
    router.push('/dashboard')
    router.refresh()
  }

  async function handleLogout() {
    if (signingOut) return
    setSigningOut(true)
    // Close any active impersonation session first (best-effort) so its
    // audit row gets a precise ended_at — mirrors Sidebar.handleLogout.
    if (user?.impersonatingFrom) {
      try {
        await fetch('/api/impersonate/stop', { method: 'POST' })
      } catch {
        // ignore — the close-stale-impersonations cron is the backstop
      }
    }
    const supabase = createBrowserClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const OverviewIcon = nav.overview.icon
  const overviewActive = pathname === nav.overview.href

  return (
    <aside
      className={clsx(
        'w-64 md:w-56 bg-un1t-surface border-r border-un1t-border flex flex-col shrink-0',
        'fixed inset-y-0 left-0 z-50 transform transition-transform duration-200',
        mobileOpen ? 'translate-x-0' : '-translate-x-full',
        'md:relative md:translate-x-0 md:transition-none md:z-auto'
      )}
    >
      {/* Header — org context + mobile close. The full org header
          (name + "N studios · portfolio overview") stays on the page
          body (AccountHome), per #1004; this is the shell label. */}
      <div className="p-5 border-b border-un1t-border">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-wider text-un1t-text truncate">
              {user?.activeOrganization?.name || 'Account'}
            </h1>
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-un1t-muted">
              Account
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
        {/* Overview */}
        <Link href={nav.overview.href} className={rowClass(overviewActive)}>
          <OverviewIcon size={18} />
          {nav.overview.label}
        </Link>

        {/* Studios — each row opens that studio (set-active-location +
            /dashboard). Only the caller's accessible studios in the
            active org are listed (account-nav.js), which is exactly what
            the shared cookie path can validly activate. */}
        <SectionHeader label="Studios" />
        {nav.studios.length === 0 ? (
          <p className="px-5 py-2 text-xs text-un1t-subtle">No studios in this account.</p>
        ) : (
          nav.studios.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => openStudio(s.id)}
              className={rowClass(false)}
              title={`Open ${s.name}`}
            >
              <Store size={18} />
              <span className="truncate">{s.name}</span>
              {s.isActive && (
                <span className="ml-auto text-[10px] font-medium text-un1t-muted uppercase tracking-wider">
                  Active
                </span>
              )}
            </button>
          ))
        )}

        {/* Manage — org-level admin surfaces. Live items link out to the
            existing (org-scoped) pages; deferred items render a disabled
            "Soon" row so the tier's shape stays legible. */}
        <SectionHeader label="Manage" />
        {nav.manage.map((item) => {
          const Icon = item.icon
          if (!item.live || !item.href) {
            return (
              <div
                key={item.key}
                className="flex items-center gap-3 text-sm px-5 py-2.5 border-l-2 border-transparent text-un1t-muted cursor-default"
                title="Coming soon"
              >
                <Icon size={18} />
                {item.label}
                <span className="ml-auto inline-flex items-center rounded-full bg-un1t-border/40 px-2 py-0.5 text-[10px] font-medium text-un1t-subtle">
                  Soon
                </span>
              </div>
            )
          }
          const active = pathname === item.href || pathname.startsWith(item.href + '/')
          return (
            <Link key={item.key} href={item.href} className={rowClass(active)}>
              <Icon size={18} />
              {item.label}
            </Link>
          )
        })}
      </nav>

      {/* Enter studio — the explicit affordance to leave the account tier
          and go back into the studio CRM. Opens the active studio (or the
          first one). Disabled when there is no studio to open. */}
      <button
        type="button"
        onClick={() => openStudio(nav.enterStudioId)}
        disabled={!nav.enterStudioId}
        className={clsx(
          'flex items-center gap-3 px-5 py-3 text-sm font-medium transition-colors border-t border-un1t-border',
          nav.enterStudioId
            ? 'text-un1t-text hover:bg-un1t-border/30'
            : 'text-un1t-muted cursor-not-allowed'
        )}
        title="Enter the studio CRM"
      >
        <ArrowRight size={18} />
        Enter studio
        <ChevronRight size={14} className="ml-auto opacity-60" />
      </button>

      {/* User + logout — same block as the studio sidebar. */}
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
