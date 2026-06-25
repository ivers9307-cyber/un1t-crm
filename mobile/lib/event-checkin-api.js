// Event check-in roster + actions (EVENT-CHECKIN.C). Goes through api() so
// the Bearer token + x-impersonate-target header are attached correctly —
// never hand-roll headers here (see the impersonation-header lesson).

import { api } from './api'

export function getCheckinRoster(eventId, { locationId } = {}) {
  return api(`/api/events/${eventId}/checkin`, { locationId })
}

export function checkInMember(eventId, { teamMemberId, registrationId, locationId } = {}) {
  return api(`/api/events/${eventId}/checkin`, {
    method: 'POST',
    body: { team_member_id: teamMemberId, race_registration_id: registrationId },
    locationId,
  })
}

export function undoCheckInMember(eventId, { teamMemberId, registrationId, locationId } = {}) {
  const qs = `team_member_id=${encodeURIComponent(teamMemberId)}&race_registration_id=${encodeURIComponent(registrationId)}`
  return api(`/api/events/${eventId}/checkin?${qs}`, { method: 'DELETE', locationId })
}

export function checkInWholeTeam(eventId, { registrationId, locationId } = {}) {
  return api(`/api/events/${eventId}/checkin/all`, {
    method: 'POST',
    body: { race_registration_id: registrationId },
    locationId,
  })
}

// Check in by scanning a per-attendee QR. The eventId + token come from the
// scanned URL (parseCheckinQr); the server re-verifies the signed token.
export function scanCheckin(eventId, { token, locationId } = {}) {
  return api(`/api/events/${eventId}/checkin/scan`, {
    method: 'POST',
    body: { token },
    locationId,
  })
}
