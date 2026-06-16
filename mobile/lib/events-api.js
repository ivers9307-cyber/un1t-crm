// Mobile events browse client (EVENT-CHECKIN.E). The list goes through
// api() so Bearer + x-active-location + x-impersonate-target are built
// once and can't drift (see the impersonation-header lesson). The event
// DETAIL + roster reuse getCheckinRoster from event-checkin-api.js — the
// check-in GET already returns the event metadata + live counts.

import { api } from './api'
import { eventKindTone } from '../../shared/events'

/** GET /api/events?location_id= → { success, data: events[] } */
export function listEvents({ locationId } = {}) {
  const qs = locationId ? `?location_id=${encodeURIComponent(locationId)}` : ''
  return api(`/api/events${qs}`, { locationId })
}

// NativeWind bg + text classes for an event-kind badge pill, keyed off the
// shared semantic tone. Mirrors the web TONE_CLS map in src/app/events/page.js.
// Returned as separate bg/text so a <View> gets the bg and its <Text> the text
// class (RN <View> can't render a text colour) — no fragile string-splitting.
const KIND_BADGE_CLS = {
  emerald: { bg: 'bg-emerald-500/15', text: 'text-emerald-700' },
  sky:     { bg: 'bg-sky-500/15',     text: 'text-sky-700' },
  indigo:  { bg: 'bg-indigo-500/15',  text: 'text-indigo-700' },
  amber:   { bg: 'bg-amber-500/15',   text: 'text-amber-700' },
  pink:    { bg: 'bg-pink-500/15',    text: 'text-pink-700' },
  teal:    { bg: 'bg-teal-500/15',    text: 'text-teal-700' },
}

/** { bg, text } NativeWind classes for an event kind's badge pill. */
export function eventKindBadgeClasses(kind) {
  return KIND_BADGE_CLS[eventKindTone(kind)] || KIND_BADGE_CLS.emerald
}

/** Short date label for a YYYY-MM-DD event date, e.g. "Tue, 16 Jun 2026". */
export function eventDateLabel(iso) {
  if (!iso) return ''
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    })
  } catch {
    return iso
  }
}
