// Host-portal shell + auth gate (HOST-PORTAL.1). Every page under this (portal)
// route group requires a host session; getCurrentHost() returning null →
// redirect to /host/login. The login page sits OUTSIDE this group so it isn't
// gated. This is the host analog of the staff AppShell gate.

import { redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import HostSignOut from '@/components/host/HostSignOut'

export const dynamic = 'force-dynamic'

export default async function HostPortalLayout({ children }) {
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  return (
    <div className="min-h-screen bg-black text-white">
      <header className="border-b border-white/10">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-baseline gap-3">
            <span className="font-bold tracking-[0.2em]">UN1T</span>
            <span className="text-xs uppercase tracking-[0.15em] text-white/45">Hosts</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-white/70">{session.host.name}</span>
            <HostSignOut />
          </div>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-4 py-8">{children}</main>
    </div>
  )
}
