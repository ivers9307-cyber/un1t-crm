// Host-portal shell + auth gate (HOST-PORTAL.1). Every page under this (portal)
// route group requires a host session; getCurrentHost() returning null →
// redirect to /host/login. The login page sits OUTSIDE this group so it isn't
// gated. This is the host analog of the staff AppShell gate.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import HostSignOut from '@/components/host/HostSignOut'
import HostImpersonationBanner from '@/components/host/HostImpersonationBanner'
import HostNav from '@/components/host/HostNav'

export const dynamic = 'force-dynamic'

export default async function HostPortalLayout({ children }) {
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Admin "view-as-host" strip (HOST-PORTAL.4) — full-width, above the
          header. Present only when an admin is impersonating; it carries the
          only exit affordance in that mode (see the header safeguard below). */}
      {session.impersonatedBy && <HostImpersonationBanner hostName={session.host.name} />}
      <header className="border-b border-white/10">
        <div className="max-w-4xl mx-auto px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-baseline gap-3 shrink-0">
            <span className="font-bold tracking-[0.2em]">UN1T</span>
            <span className="text-xs uppercase tracking-[0.15em] text-white/45">Hosts</span>
          </div>
          <HostNav />
          <div className="ml-auto flex items-center gap-3 text-sm">
            <Link
              href="/host/events/new"
              className="rounded-lg bg-white text-black text-sm font-semibold px-4 py-2 hover:bg-white/90 whitespace-nowrap"
            >
              + Create event
            </Link>
            <span className="text-white/70 hidden sm:inline">{session.host.name}</span>
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
