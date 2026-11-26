import { getUserLocationIds } from '@/lib/auth'
import { hasPermissionForLocation, hasMobilePermissionForLocation } from '@/lib/permissions'

// INBOXPERM.1 — the studios where the caller holds the inbox key (the
// `whatsapp` key serves WhatsApp and Instagram; web or phone), of those they
// belong to. A conversation list with no ?location_id covers these and only
// these, never every studio the caller merely belongs to.
export const inboxLocationIds = (user) => getUserLocationIds(user).filter((id) => (
  hasPermissionForLocation(user, id, 'whatsapp') || hasMobilePermissionForLocation(user, id, 'whatsapp')
))
