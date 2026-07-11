// Host emails (HOST-EMAIL.3) — compose + send marketing email to the host's
// own contact list. The page is just the auth gate + shell; HostEmails
// (client) talks to /api/host/emails, where every send gate lives
// (verified sender, daily cap, consent/suppression, CAS double-send guard).

import { redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import HostEmails from '@/components/host/HostEmails'

export const dynamic = 'force-dynamic'

export default async function HostEmailsPage() {
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  return (
    <div>
      <a href="/host" className="text-xs text-white/45 hover:text-white">← Back</a>

      <div className="mt-3">
        <h1 className="text-2xl font-bold">Emails</h1>
        <p className="text-white/55 text-sm mt-1">
          Email your contacts — everyone who attended your events or joined your mailing list and has opted in.
        </p>
      </div>

      <HostEmails />
    </div>
  )
}
