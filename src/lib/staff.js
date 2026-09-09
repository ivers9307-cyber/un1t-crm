// Staff read service (Plan C1). The single source of read logic for the
// staff directory — backs GET /api/staff, GET /api/staff/[id], and the
// web staff list, consumed on mobile via the SDK. Scopes to profiles
// sharing a location with the caller; admins (master/owner/manager) see
// the full profile incl. HR fields, others see the slim public roster.
// The create/update logic (the PUT monolith) is NOT here — that's C2.
import { getUserLocationIds } from '@/lib/auth'
import { ADMIN_ROLES } from '@/lib/schemas'
import { mergeTemplates } from '@shared/permissions'

export const STAFF_PUBLIC_FIELDS =
  'id, full_name, email, role, avatar_url, active, employment_type, contracted_hours_per_week'

// ROSTER-FIX.2 — the roster coach picker only ever renders a name, an
// avatar and the active flag, but it fetched the same list an HR screen
// does, so an admin caller's browser received `*` — hourly_rate,
// annual_salary and the rest — to populate a dropdown. `?fields=picker`
// pins this shape for EVERY role, master included.
//
// ROSTER-FIX.6c — `employment_type` and `contracted_hours_per_week` joined the
// list when the calendar itself moved onto this shape. The FTE utilisation bars
// under the roster read both (allocated vs contract), and neither is pay data:
// they are already in STAFF_PUBLIC_FIELDS, so every role has always received
// them. The rates — hourly_rate, annual_salary, overtime_rate — stay out.
export const STAFF_PICKER_FIELDS =
  'id, full_name, active, role, avatar_url, employment_type, contracted_hours_per_week'

function selectClause(isAdmin, fields) {
  if (fields === 'picker') {
    return `${STAFF_PICKER_FIELDS}, profile_locations(location_id, role, locations(id, name, slug))`
  }
  return isAdmin
    ? '*, profile_locations(*, locations(*))'
    : `${STAFF_PUBLIC_FIELDS}, profile_locations(location_id, role, locations(id, name, slug))`
}

// ROSTER-FIX.6c — `locationId` narrows the read to ONE of the caller's
// locations. Absent (the default) the behaviour is exactly what it always was:
// every location the caller holds. It is applied by INTERSECTING with the
// caller's own set rather than replacing it, so this can only ever return less
// than the unscoped call — a route that forgets `assertLocationAccess` gets an
// empty list, never another tenant's staff.
export async function listStaffForUser({ db, user, fields, locationId = null }) {
  const callerLocationIds = getUserLocationIds(user)
  const userLocationIds = locationId
    ? callerLocationIds.filter(id => id === locationId)
    : callerLocationIds
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
    .select(selectClause(isAdmin, fields))
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
    .select(selectClause(isAdmin, null))
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
          .select('location_id, role, employment_type, permissions')
          .in('location_id', locIds)
        // RECEPTION.2 (mig 367) — merge the TARGET's employment-type
        // variant over the role's 'all' row, so consumers (the mobile
        // permissions editor) keep seeing one template per (loc, role)
        // that matches what the resolver uses for this user.
        const emp = data?.employment_type || null
        const rowFor = (locId, role, e) => (tplRows || []).find(r =>
          r.location_id === locId && r.role === role && r.employment_type === e
        )?.permissions || null
        for (const row of (tplRows || [])) {
          roleTemplates[row.location_id] = roleTemplates[row.location_id] || {}
          if (roleTemplates[row.location_id][row.role]) continue
          roleTemplates[row.location_id][row.role] = mergeTemplates(
            rowFor(row.location_id, row.role, 'all'),
            emp ? rowFor(row.location_id, row.role, emp) : null
          ) || {}
        }
      } catch {
        // degrade to code defaults
      }
    }
    return { ok: true, data: { ...data, role_templates: roleTemplates } }
  }
  return { ok: true, data }
}
