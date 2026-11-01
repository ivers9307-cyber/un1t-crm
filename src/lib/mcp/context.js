// MCP.1 — pure helpers a tool call uses to decide WHERE and AS WHOM it acts.
// No db: everything is read off the `getCurrentUser()` object that
// `verifyMcpToken` carried in `extra.user`.

import { hasPermissionForLocation } from '@/lib/permissions'
import { MANAGER_ROLES, ADMIN_ROLES } from '@/lib/schemas'

/**
 * Pick the studio a tool acts at.
 *
 * `studioId` null: the active studio if the person holds `assistant` there,
 * else the first of their studios where they do. An id outside
 * `user.locations` answers `studio_not_found`, the same code as a uuid that
 * does not exist, so a studio id cannot be probed. An id the person belongs
 * to but lacks `assistant` at answers `assistant_permission`.
 *
 * @param {object} user getCurrentUser() result
 * @param {string | null} studioId
 * @returns {{ ok: true, studio: object } | { ok: false, code: 'studio_not_found' | 'assistant_permission' }}
 */
export function resolveStudio(user, studioId) {
  const locations = user?.locations || []
  const holdsAssistant = (l) => hasPermissionForLocation(user, l.id, 'assistant')

  if (studioId) {
    const studio = locations.find((l) => l.id === studioId)
    if (!studio) return { ok: false, code: 'studio_not_found' }
    return holdsAssistant(studio)
      ? { ok: true, studio }
      : { ok: false, code: 'assistant_permission' }
  }

  const active = user?.activeLocation
    ? locations.find((l) => l.id === user.activeLocation.id)
    : null
  if (active && holdsAssistant(active)) return { ok: true, studio: active }
  const first = locations.find(holdsAssistant)
  return first ? { ok: true, studio: first } : { ok: false, code: 'assistant_permission' }
}

/** The role the person holds at a studio; master everywhere. */
export function roleAt(user, studioId) {
  if (user?.isMaster) return 'master'
  return user?.rolesByLocation?.[studioId] ?? null
}

export function isManagerAt(user, studioId) {
  return MANAGER_ROLES.includes(roleAt(user, studioId))
}

export function isAdminAt(user, studioId) {
  return ADMIN_ROLES.includes(roleAt(user, studioId))
}
