// Staff read service (Plan C1). The single source of read logic for the
// staff directory — backs GET /api/staff, GET /api/staff/[id], and the
// web staff list, consumed on mobile via the SDK. Scopes to profiles
// sharing a location with the caller.
//
// CONTRACTVIS.1 — WHAT of each row leaves is decided PER ROW, by whether the
// caller MANAGES that person: master, or ADMIN_ROLES (owner / manager) at a
// location the person is linked to, among the locations in scope. A managed
// row gets the full profile (HR fields); any other row gets the slim public
// shape. The caller's own row always keeps its contract. This replaced
// `ADMIN_ROLES.includes(user.role)` — the ACTIVE studio's role — which handed a
// manager at A who is a head coach at B the HR fields of people only at B.
// The create/update logic (the PUT monolith) is NOT here — that's C2.
import { getUserLocationIds } from '@/lib/auth'
import { ADMIN_ROLES } from '@/lib/schemas'
import { hasRoleAtLocation } from '@/lib/role-at-location'
import { logError } from '@/lib/log'
import { mergeTemplates } from '@shared/permissions'

// CONTRACTVIS.1 (Richard, 27 Sep 2026) — neither shape below carries
// contracted_hours_per_week. A colleague's contract goes to a master, or to an
// owner or manager at a studio that colleague works at, and nobody else: the
// rule CANDIDATES.1 and GRID.1 already applied. ROSTER-FIX.6c had put the
// column in both lists on the grounds that hours are not pay and "every role
// has always received them"; Richard's decision replaces that reasoning.
// The column is added back per row, only for people the caller manages (and
// their own row), by listStaffForUser / getStaffForUser below.
export const STAFF_PUBLIC_FIELDS =
  'id, full_name, email, role, avatar_url, active, employment_type'

// ROSTER-FIX.2 — the roster coach picker only ever renders a name, an avatar,
// the role, the active flag and the employment type. `?fields=picker` pins this
// shape for EVERY role, master included: never `*`, never a rate.
export const STAFF_PICKER_FIELDS =
  'id, full_name, active, role, avatar_url, employment_type'

// The one contract column, named once. Added to a read only by the per-row
// rule below; never part of either shape above.
export const STAFF_CONTRACT_FIELD = 'contracted_hours_per_week'

const PUBLIC_LINKS = 'profile_locations(location_id, role, locations(id, name, slug))'
const FULL_SELECT = '*, profile_locations(*, locations(*))'
const keysOf = (fields) => fields.split(',').map((k) => k.trim())
const PUBLIC_KEYS = keysOf(STAFF_PUBLIC_FIELDS)
const PICKER_KEYS = keysOf(STAFF_PICKER_FIELDS)
const has = (row, key) => Object.prototype.hasOwnProperty.call(row, key)

/** Does the caller manage people at `locationId`? Master, or owner / manager there. */
export function managesAt(user, locationId) {
  return hasRoleAtLocation(user, locationId, ADMIN_ROLES)
}

function publicLinks(links) {
  return (links || []).map((l) => ({
    location_id: l.location_id,
    role: l.role,
    locations: l.locations ? { id: l.locations.id, name: l.locations.name, slug: l.locations.slug } : null,
  }))
}

// An ALLOWLIST projection: only `keys` (+ the contract when allowed) and the
// trimmed links leave, whatever the read returned. The second lock behind the
// select: a future select change cannot widen what an unmanaged row carries.
function slimRow(row, keys, withContract) {
  const out = {}
  for (const k of keys) if (has(row, k)) out[k] = row[k]
  if (withContract && has(row, STAFF_CONTRACT_FIELD)) out[STAFF_CONTRACT_FIELD] = row[STAFF_CONTRACT_FIELD]
  out.profile_locations = publicLinks(row.profile_locations)
  return out
}

// ROSTER-FIX.6c — `locationId` narrows the read to ONE of the caller's
// locations. Absent (the default) the behaviour is exactly what it always was:
// every location the caller holds. It is applied by INTERSECTING with the
// caller's own set rather than replacing it, so this can only ever return less
// than the unscoped call — a route that forgets `assertLocationAccess` gets an
// empty list, never another tenant's staff. It also narrows WHO the caller
// manages: with location_id=B, only an admin role AT B counts.
//
// CONTRACTVIS.1 — `includeContract` (picker only): add contracted hours to the
// rows the caller manages and to their own row. Everyone else's are stripped.
export async function listStaffForUser({ db, user, fields, locationId = null, includeContract = false }) {
  const callerLocationIds = getUserLocationIds(user)
  const userLocationIds = locationId
    ? callerLocationIds.filter(id => id === locationId)
    : callerLocationIds
  if (userLocationIds.length === 0) return { ok: true, data: [] }

  const { data: links, error: linksError } = await db
    .from('profile_locations')
    .select('profile_id, location_id')
    .in('location_id', userLocationIds)
  if (linksError) return { ok: false, error: linksError.message }

  const profileIds = [...new Set((links || []).map(l => l.profile_id))]
  if (profileIds.length === 0) return { ok: true, data: [] }

  const managedLocations = new Set(userLocationIds.filter((id) => managesAt(user, id)))
  const managed = new Set(
    (links || []).filter((l) => managedLocations.has(l.location_id)).map((l) => l.profile_id),
  )
  const selfId = user?.id ?? null
  const mayContract = (id) => managed.has(id) || (selfId !== null && id === selfId)

  const picker = fields === 'picker'
  let select
  if (picker) {
    // Read the column only when some row in the list may carry it.
    const readContract = includeContract && profileIds.some(mayContract)
    select = `${STAFF_PICKER_FIELDS}${readContract ? `, ${STAFF_CONTRACT_FIELD}` : ''}, ${PUBLIC_LINKS}`
  } else if (managed.size > 0) {
    select = FULL_SELECT
  } else {
    const readContract = selfId !== null && profileIds.includes(selfId)
    select = `${STAFF_PUBLIC_FIELDS}${readContract ? `, ${STAFF_CONTRACT_FIELD}` : ''}, ${PUBLIC_LINKS}`
  }

  const { data, error } = await db
    .from('profiles')
    .select(select)
    .in('id', profileIds)
    .order('full_name', { ascending: true })
  if (error) return { ok: false, error: error.message }

  const rows = (data || []).map((row) => {
    if (!picker && managed.has(row.id)) return row
    return slimRow(row, picker ? PICKER_KEYS : PUBLIC_KEYS, (picker ? includeContract : true) && mayContract(row.id))
  })
  return { ok: true, data: rows }
}

export async function getStaffForUser({ db, user, id }) {
  const userLocationIds = getUserLocationIds(user)
  if (userLocationIds.length === 0) return { ok: false, status: 404, error: 'Not found' }

  // CONTRACTVIS.1 — every SHARED link, not `.limit(1)`: whether the caller
  // manages this person depends on WHICH shared studio they are an admin at.
  const { data: links, error: linksError } = await db
    .from('profile_locations')
    .select('location_id')
    .eq('profile_id', id)
    .in('location_id', userLocationIds)
  // A failed read is not "this person is not yours": 404 would tell the
  // caller a colleague who exists does not. Same reasoning as the profile
  // read below — a DB error is a 500. Zero links is the real 404.
  if (linksError) {
    logError('staff', 'could not read the staff member\'s location links', { profile_id: id, err: linksError.message })
    return { ok: false, status: 500, error: linksError.message }
  }
  if (!links || links.length === 0) return { ok: false, status: 404, error: 'Not found' }

  const managed = links.some((l) => managesAt(user, l.location_id))
  const self = (user?.id ?? null) === id
  const select = managed
    ? FULL_SELECT
    : `${STAFF_PUBLIC_FIELDS}${self ? `, ${STAFF_CONTRACT_FIELD}` : ''}, ${PUBLIC_LINKS}`
  const { data, error } = await db
    .from('profiles')
    .select(select)
    .eq('id', id)
    .single()
  // The cross-tenant guard above already 404s a missing / out-of-scope
  // target, so an error here means the row exists but the fetch failed
  // (a real DB error) — surface 500 rather than masking it as 404 and
  // sending the caller into a silent retry loop.
  if (error) return { ok: false, status: 500, error: error.message }
  if (!managed) return { ok: true, data: slimRow(data, PUBLIC_KEYS, self) }

  // PERM-AUDIT.3 — role templates (mig 364) for the target's
  // locations, keyed { [location_id]: { [role]: sparse blob } }.
  // The permission editors (web StaffForm + mobile staff/permissions)
  // hydrate stored SPARSE per-user blobs against the role's effective
  // defaults, which include the template. Admin payloads only — the
  // slim roster shape doesn't carry permissions at all.
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
