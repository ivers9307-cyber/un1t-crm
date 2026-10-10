// W1.M2 — one audit row per membership-source change, whoever made it.
//
// Two writers exist: PUT /api/locations/[id]/membership-source (the setting,
// the only DIRECT writer) and PUT/DELETE /api/locations/[id]/integrations/
// glofox (the connect/disconnect flip, owner/master only — a manager's
// credential save never moves the column). Both call this. The mig 191
// audit_mutation trigger on `locations` also records the row change, but as
// a service-role diff with no actor; this row names WHO and WHY.
//
// Fire-and-forget (CLAUDE.md): logAuditEvent never throws — it resolves
// { logged: false, error } and warns on its own — so this only adds the
// membership-source context to that warning and never blocks the switch.
import { logAuditEvent } from '@/lib/audit'
import { logWarn } from '@/lib/log'

export const MEMBERSHIP_SOURCE_AUDIT_ACTION = 'location.membership_source_changed'

/**
 * @param {object} args
 * @param {{ id?: string, full_name?: string, email?: string } | null} args.user
 * @param {{ id: string, name?: string | null }} args.location
 * @param {string | null} args.from
 * @param {string} args.to
 * @param {string} args.via   'membership-source' | 'integrations/glofox'
 * @param {Request | null} [args.request]
 */
export async function logMembershipSourceChange({ user, location, from, to, via, request = null }) {
  const r = await logAuditEvent({
    category: 'business',
    action: MEMBERSHIP_SOURCE_AUDIT_ACTION,
    actor: user ? { id: user.id, full_name: user.full_name, email: user.email } : null,
    // Not a profile: carry the identity in `resource` (logAuditEvent's contract).
    target: { resource: `location/${location.id}`, label: location.name || null },
    locationId: location.id,
    details: { from: from ?? null, to, via },
    request,
  })
  if (!r?.logged) {
    logWarn('membership-source', 'audit row not written', { locationId: location.id, from: from ?? null, to, via, err: r?.error || 'unknown' })
  }
  return r
}
