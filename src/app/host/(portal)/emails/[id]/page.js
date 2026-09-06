// Host email report (HOST-METRICS.1) — the auth gate + shell for ONE of the
// host's sent emails. HostEmailReport (client) talks to
// /api/host/emails/[id]/recipients, which owns the ownership check (a
// foreign id 404s) — this page only gates the session, same shape as the
// emails list page it links from.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import HostEmailReport from '@/components/host/HostEmailReport'

export const dynamic = 'force-dynamic'

export default async function HostEmailReportPage(props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  return (
    <div>
      {/* next/link rather than <a>: @next/next/no-html-link-for-pages scans
          src/app in this plugin version and matches /host/emails against
          this [id] route's regex (empty capture), so a raw
          <a href="/host/emails"> errors. See CLAUDE.md. */}
      <Link href="/host/emails" className="text-xs text-white/45 hover:text-white">← Back to emails</Link>

      <HostEmailReport campaignId={params.id} />
    </div>
  )
}
