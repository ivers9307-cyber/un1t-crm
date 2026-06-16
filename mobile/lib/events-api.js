// Mobile events browse client (EVENT-CHECKIN.E). The list goes through
// api() so Bearer + x-active-location + x-impersonate-target are built
// once and can't drift (see the impersonation-header lesson). The event
// DETAIL + roster reuse getCheckinRoster from event-checkin-api.js — the
// check-in GET already returns the event metadata + live counts.

import { api } from './api'

/** GET /api/events?location_id= → { success, data: events[] } */
export function listEvents({ locationId } = {}) {
  const qs = locationId ? `?location_id=${encodeURIComponent(locationId)}` : ''
  return api(`/api/events${qs}`, { locationId })
}

/** Short date label for a YYYY-MM-DD event date, e.g. "Tue, 16 Jun". */
export function eventDateLabel(iso) {
  if (!iso) return ''
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short',
    })
  } catch {
    return iso
  }
}
