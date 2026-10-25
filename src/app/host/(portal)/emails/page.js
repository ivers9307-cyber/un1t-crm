// Host emails (HOST-EMAIL.3) — compose + send marketing email to the host's
// own contact list. The page is just the auth gate + shell; HostEmails
// (client) talks to /api/host/emails, where every send gate lives
// (verified sender, daily cap, consent/suppression, CAS double-send guard).

import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { getLocationZone, DEFAULT_TZ } from '@/lib/location-time'
import { logWarn } from '@/lib/log'
import { resolveHostOrgBrand } from '@/lib/host-org-brand'
import HostEmails from '@/components/host/HostEmails'

export const dynamic = 'force-dynamic'

// TZ.9 — the composer schedules on the host's own clock: its anchor location's
// zone (a host's events live there). The schedule panel names the zone it
// uses, so the display fallback on an unreadable read is visible, not silent.
async function hostScheduleZone(hostId) {
  try {
    const db = createServerClient()
    const { data, error } = await db.from('event_hosts').select('anchor_location_id').eq('id', hostId).maybeSingle()
    if (error) throw error
    return await getLocationZone(db, data?.anchor_location_id || null)
  } catch (err) {
    logWarn('host-emails', 'host zone unreadable; composer on the default zone', { err, hostId })
    return DEFAULT_TZ
  }
}

export default async function HostEmailsPage() {
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')
  const zone = await hostScheduleZone(session.host.id)
  // W1.S1c — a paused campaign tells the host to ask its organisation.
  const brand = await resolveHostOrgBrand(createServerClient(), session.host)

  return (
    <div>
      <a href="/host" className="text-xs text-white/45 hover:text-white">← Back</a>

      <div className="mt-3">
        <h1 className="text-2xl font-bold">Emails</h1>
        <p className="text-white/55 text-sm mt-1">
          Email your contacts — everyone who attended your events or joined your mailing list and has opted in.
        </p>
      </div>

      <Suspense fallback={null}>
        <HostEmails zone={zone} brandName={brand.name} />
      </Suspense>
    </div>
  )
}
