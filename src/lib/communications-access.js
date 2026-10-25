// C116 GATES-2 — who may use the /communications area, judged at a named
// studio (a record's), at the ACTIVE studio (the pages about it), or at SOME
// studio (the layout's coarse gate, the ROLESWEEP pattern).
//
// The layout used to decide at the active studio. A layout runs before its
// pages, so it bounced pages that judge a RECORD's studio (a sent broadcast,
// another studio's template, Mail across every studio) before they ran. It is
// now the coarse gate, and each page carries its own decision; the pages
// about the active studio use canUseCommunicationsHere, which is exactly
// what the layout used to decide.
import { hasPermission, hasPermissionAtAnyLocation, hasPermissionForLocation } from './permissions'

// `email_inbox` is the Mail surface's key (EMAIL-TICKET.4), distinct from the
// marketing `email` one.
export const COMMUNICATIONS_AREA_PERMISSIONS = Object.freeze(['email', 'whatsapp', 'email_inbox'])

/** The area at `locationId` (its role, overrides, template and features). */
export function canUseCommunicationsAt(user, locationId) {
  if (!user || !locationId) return false
  return COMMUNICATIONS_AREA_PERMISSIONS.some((key) => hasPermissionForLocation(user, locationId, key))
}

/** The area at the ACTIVE studio: the old layout rule, word for word. */
export function canUseCommunicationsHere(user) {
  if (!user) return false
  return COMMUNICATIONS_AREA_PERMISSIONS.some((key) => hasPermission(user, key))
}

/** The coarse gate: the area at some studio the caller belongs to. */
export function canUseCommunicationsSomewhere(user) {
  if (!user) return false
  return COMMUNICATIONS_AREA_PERMISSIONS.some((key) => hasPermissionAtAnyLocation(user, key))
}

/**
 * /api/templates/[id]'s rule for an email template: `email` at its studio; a
 * location-less template has no studio to judge at, so `email` somewhere.
 */
export function canEditEmailTemplate(user, locationId) {
  if (!user) return false
  return locationId
    ? hasPermissionForLocation(user, locationId, 'email')
    : hasPermissionAtAnyLocation(user, 'email')
}

/**
 * The area for a RECORD's page (the WhatsApp template editor): at its studio;
 * a location-less record has no studio to judge at, so at SOME studio.
 */
export function canUseCommunicationsForRecord(user, locationId) {
  return locationId ? canUseCommunicationsAt(user, locationId) : canUseCommunicationsSomewhere(user)
}
