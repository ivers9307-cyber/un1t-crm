// SHELLY-UI.6 — smart plugs. Same gate as the Sonos surface next door:
// `device_control`, which the role templates and the nav union already carry.
//
// Everything below the header is client-side, because the page is a live
// control surface (a 30 s poll, toggles, discovery) rather than a rendered
// snapshot. The server contributes exactly three facts the client cannot work
// out for itself:
//
//   locationName          — whose plugs these are, in the header.
//   locationTz            — the zone an override's expiry is rendered in. The
//                           toggle route computes the default `until` as the
//                           LOCATION's next local midnight, so a card that
//                           formatted it in the browser's zone would print a
//                           time the engine will not act on.
//   glofoxConnected       — whether class-linked schedules are even offerable
//                           (the timetable is the trigger source).
//   canManageConnection   — whether to show the Connect form at all. This is
//                           an AFFORDANCE, not the enforcement: PUT/DELETE
//                           /api/shelly/connection run guardMasterOrOwner
//                           themselves, and the client replaces this with the
//                           server's own `can_manage` the moment GET
//                           /api/shelly/connection lands.
//
// No location = no page. Every Shelly query is scoped by the session's active
// location and no route takes one from the request, so a page with no active
// location has nothing it could possibly be about.

import { redirect } from 'next/navigation'
import { getCurrentUser, guardMasterOrOwner } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { glofoxConnected } from '@/lib/automations/registry'
import { DEFAULT_TZ } from '@/lib/tz-time'
import ShellyDevicesClient from '@/components/automations/ShellyDevicesClient'

export const dynamic = 'force-dynamic'

export default async function ShellyPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'device_control')) redirect('/automations')

  const location = user.activeLocation
  if (!location?.id) redirect('/automations')

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-un1t-text">Smart plugs · {location.name || 'your studio'}</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          Shelly plugs and relays — power schedules, live switching and energy use.
        </p>
      </div>
      <ShellyDevicesClient
        locationName={location.name || ''}
        locationTz={location.timezone || DEFAULT_TZ}
        glofoxConnected={glofoxConnected(location)}
        // guardMasterOrOwner returns a 403 response or null; null is "allowed".
        canManageConnection={guardMasterOrOwner(user, location.id) === null}
      />
    </div>
  )
}
