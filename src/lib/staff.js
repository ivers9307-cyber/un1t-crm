// Staff read service (Plan C1). The single source of read logic for the
// staff directory — backs GET /api/staff, GET /api/staff/[id], and the
// web staff list, consumed on mobile via the SDK. Scopes to profiles
// sharing a location with the caller; admins (master/owner/manager) see
// the full profile incl. HR fields, others see the slim public roster.
// The create/update logic (the PUT monolith) is NOT here — that's C2.
import { getUserLocationIds } from '@/lib/auth'
import { ADMIN_ROLES } from '@/lib/schemas'

export const STAFF_PUBLIC_FIELDS =
  'id, full_name, email, role, avatar_url, active, employment_type, contracted_hours_per_week'

function selectClause(isAdmin) {
  return isAdmin
    ? '*, profile_locations(*, locations(*))'
    : `${STAFF_PUBLIC_FIELDS}, profile_locations(location_id, role, locations(id, name, slug))`
}

export async function listStaffForUser({ db, user }) {
  const userLocationIds = getUserLocationIds(user)
  if (userLocationIds.length === 0) return { ok: true, data: [] }

  const { data: links, error: linksError } = await db
    .from('profile_locations')
    .select('profile_id')
    .in('location_id', userLocationIds)
  if (linksError) return { ok: false, error: linksError.message }

  const profileIds = [...new Set((links || []).map(l => l.profile_id))]
  if (profileIds.length === 0) return { ok: true, data: [] }

  const isAdmin = ADMIN_ROLES.includes(user.role)
  const { data, error } = await db
    .from('profiles')
    .select(selectClause(isAdmin))
    .in('id', profileIds)
    .order('full_name', { ascending: true })
  if (error) return { ok: false, error: error.message }
  return { ok: true, data }
}

export async function getStaffForUser({ db, user, id }) {
  const userLocationIds = getUserLocationIds(user)
  if (userLocationIds.length === 0) return { ok: false, status: 404, error: 'Not found' }

  const { data: links } = await db
    .from('profile_locations')
    .select('profile_id')
    .eq('profile_id', id)
    .in('location_id', userLocationIds)
    .limit(1)
  if (!links || links.length === 0) return { ok: false, status: 404, error: 'Not found' }

  const isAdmin = ADMIN_ROLES.includes(user.role)
  const { data, error } = await db
    .from('profiles')
    .select(selectClause(isAdmin))
    .eq('id', id)
    .single()
  // The cross-tenant guard above already 404s a missing / out-of-scope
  // target, so an error here means the row exists but the fetch failed
  // (a real DB error) — surface 500 rather than masking it as 404 and
  // sending the caller into a silent retry loop.
  if (error) return { ok: false, status: 500, error: error.message }

  // PERM-AUDIT.3 — role templates (mig 364) for the target's
  // locations, keyed { [location_id]: { [role]: sparse blob } }.
  // The permission editors (web StaffForm + mobile staff/permissions)
  // hydrate stored SPARSE per-user blobs against the role's effective
  // defaults, which include the template. Admin payloads only — the
  // slim roster shape doesn't carry permissions at all.
  if (isAdmin) {
    const locIds = (data?.profile_locations || []).map(l => l.location_id).filter(Boolean)
    const roleTemplates = {}
    if (locIds.length > 0) {
      try {
        const { data: tplRows } = await db
          .from('location_role_permissions')
          .select('location_id, role, permissions')
          .in('location_id', locIds)
        for (const row of (tplRows || [])) {
          roleTemplates[row.location_id] = roleTemplates[row.location_id] || {}
          roleTemplates[row.location_id][row.role] = row.permissions || {}
        }
      } catch {
        // degrade to code defaults
      }
    }
    return { ok: true, data: { ...data, role_templates: roleTemplates } }
  }
  return { ok: true, data }
}
