// Mobile-side class-timer API — wraps the same /api/timer/* routes the web
// Studio Management timer page uses (CLASS-TIMER PR3).
//
// The timer routes read `location_id` from the query string / body (NOT the
// x-active-location header), so it's passed explicitly each call. We also hand
// it to api() so the active-location header is set, matching the other mobile
// wrappers (studio-mgmt-api.js etc.). Auth (Bearer JWT + impersonation header)
// comes from api() / authHeaders() — never hand-roll headers here.

import { api } from './api'

export function listTimerTemplates(locationId) {
  return api(`/api/timer/templates?location_id=${locationId}`, { locationId })
}

export function createTimerTemplate(locationId, name, structure) {
  return api('/api/timer/templates', {
    method: 'POST',
    locationId,
    body: { location_id: locationId, name, structure },
  })
}

export function getActiveTimer(locationId) {
  return api(`/api/timer/active?location_id=${locationId}`, { locationId })
}

export function startTimer(locationId, templateId) {
  return api('/api/timer/runs', {
    method: 'POST',
    locationId,
    body: { location_id: locationId, template_id: templateId },
  })
}

export function controlTimer(runId, action, direction, locationId) {
  return api(`/api/timer/runs/${runId}/control`, {
    method: 'POST',
    locationId,
    body: { action, direction },
  })
}
