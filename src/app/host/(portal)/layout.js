// Host-portal shell + auth gate (HOST-PORTAL.1). Every page under this (portal)
// route group requires a host session; getCurrentHost() returning null →
// redirect to /host/login. The login page sits OUTSIDE this group so it isn't
// gated. This is the host analog of the staff AppShell gate.

import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { resolveHostOrgBrand } from '@/lib/host-org-brand'
import HostSignOut from '@/components/host/HostSignOut'
import HostImpersonationBanner from '@/components/host/HostImpersonationBanner'
import HostNav from '@/components/host/HostNav'
import GuardedLink from '@/components/host/GuardedLink'
import HostThemeToggle from '@/components/host/HostThemeToggle'
import { HOST_THEME_COOKIE, hostThemeFromCookie } from '@/lib/host-theme'
import { HOST_BTN_PRIMARY, HOST_EYEBROW } from '@/components/host/host-ui'

export const dynamic = 'force-dynamic'

export default async function HostPortalLayout({ children }) {
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')
  // W1.S1c: the wordmark is the host's ORGANISATION (short name: UN1T keeps
  // its bare "UN1T"), never a literal gym and never the host's own name.
  const brand = await resolveHostOrgBrand(createServerClient(), session.host)
  // HOSTTHEME.1: a string only — a Server Component never hands a function to a client one.
  const theme = hostThemeFromCookie((await cookies()).get(HOST_THEME_COOKIE)?.value)

  return (
    <div>
      {/* Admin "view-as-host" strip (HOST-PORTAL.4) — full-width, above the
          header. Present only when an admin is impersonating; it carries the
          only exit affordance in that mode (see the header safeguard below). */}
      {session.impersonatedBy && <HostImpersonationBanner hostName={session.host.name} />}
      <header className="border-b border-host-border">
        <div className="max-w-4xl mx-auto px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-baseline gap-3 shrink-0">
            <span className="font-bold tracking-[0.2em]">{brand.shortName}</span>
            <span className={HOST_EYEBROW}>Hosts</span>
          </div>
          <HostNav />
          <div className="ml-auto flex items-center gap-3 text-sm">
            <GuardedLink
              href="/host/events/new"
              className={`${HOST_BTN_PRIMARY} whitespace-nowrap`}
            >
              + Create event
            </GuardedLink>
            <span className="text-host-label hidden sm:inline truncate max-w-[16rem]">{session.host.name}</span>
            <HostThemeToggle initial={theme} />
            {/* SAFEGUARD: HostSignOut calls supabase.auth.signOut(), which would
                destroy the admin's real staff session. An admin viewing-as must
                exit via the banner's "Exit to CRM", never sign out here. */}
            {session.impersonatedBy ? null : <HostSignOut />}
          </div>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-4 py-8">{children}</main>
    </div>
  )
}
