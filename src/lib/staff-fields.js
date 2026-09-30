// STAFFPROFILEPICK.1 — which columns of a COLLEAGUE's profile may cross to a
// browser or a phone, named once.
//
// The staff API (GET /api/staff, GET /api/staff/[id], the POST/PUT echoes;
// the phone's staff directory reads the same routes) and the staff editor
// page used to hand over profiles.*: pin_hash (a short numeric PIN's hash,
// so offline-guessable), pin_* bookkeeping, unifi_user_id, both email
// signatures, two_factor_enabled, tombstone and auth bookkeeping. The API's
// embed also carried each studio's whole locations row (settings, including
// the customer agent's test phone numbers). This is the PROFILESPREAD.1
// class (src/lib/user-profile.js) one hop over: other people's rows.
//
// WHAT a managed row carries is decided here. WHO gets a managed row (master,
// or owner/manager at a studio the person works at; CONTRACTVIS.1) is
// decided in src/lib/staff.js and does not change.
//
// Pure, relative imports only: tests/staff-profile-to-client.test.js imports
// it, and the route tests mock '@/lib/staff' wholesale.

import { CLIENT_LOCATION_COLUMNS, toUserLocation } from './location-secrets.js'

export const STAFF_HR_FIELDS = Object.freeze([
  'annual_salary', 'hourly_rate', 'contracted_hours_per_week', 'annual_leave_entitlement', 'overtime_rate',
])

// A managed row: the public identity (STAFF_PUBLIC_FIELDS' seven) + HR.
// Readers: the phone's staff list/detail/edit/permissions/roles/new-task
// screens and the web ContractIssueWizard (plan C63 §2).
export const STAFF_MANAGED_FIELDS = Object.freeze([
  'id', 'full_name', 'email', 'role', 'avatar_url', 'active', 'employment_type', ...STAFF_HR_FIELDS,
])

// The assignment fields the phone's editors read and echo back
// (mobile/lib/staff-edit.js buildStaffAssignmentsPatch). The server leaves
// every key a PUT omits unchanged, so the rest never needs to travel.
export const STAFF_MANAGED_LINK_FIELDS = Object.freeze([
  'location_id', 'role', 'is_default', 'permissions', 'unifi_door_access',
])

export const STAFF_MANAGED_SELECT =
  `${STAFF_MANAGED_FIELDS.join(', ')}, ` +
  `profile_locations(${STAFF_MANAGED_LINK_FIELDS.join(', ')}, locations(${CLIENT_LOCATION_COLUMNS.join(', ')}))`

// The staff editor (StaffForm's `staff` prop): EXACTLY the fields StaffForm
// reads (tests/staff-profile-to-client.test.js holds it to that, both ways).
// A field missing here would render as a default and be SAVED BACK over the
// real value, so a new form field must be added here in the same change.
export const STAFF_EDITOR_FIELDS = Object.freeze([
  'id', 'email', 'full_name', 'active', 'employment_type', ...STAFF_HR_FIELDS,
])

// The editor page's read: the fields + role (the edit gate, is_master) +
// deleted_at (isTombstone), neither passed on. profile_locations(*) stays
// WHOLE on purpose: mapProfileLocationToAssignment is the single source of
// the assignment shape, and a narrowed link list twice dropped a column the
// form then saved back as defaults (see the page's CRITICAL comment).
export const STAFF_EDITOR_SELECT =
  `${[...STAFF_EDITOR_FIELDS, 'role', 'deleted_at'].join(', ')}, profile_locations(*)`

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
function pick(row, keys) {
  const out = {}
  for (const k of keys) if (hasOwn(row, k)) out[k] = row[k]
  return out
}

/**
 * A managed staff row as it may leave the server: STAFF_MANAGED_FIELDS, the
 * links' STAFF_MANAGED_LINK_FIELDS, and each link's studio as
 * CLIENT_LOCATION_COLUMNS. The second lock behind the select: a widened
 * select or a raw row can never put a dropped key on the wire. Never adds a
 * key the row lacks.
 */
export function pickManagedStaffRow(row) {
  if (!isPlainObject(row)) return row
  const out = pick(row, STAFF_MANAGED_FIELDS)
  if (Array.isArray(row.profile_locations)) {
    out.profile_locations = row.profile_locations.map((l) => {
      if (!isPlainObject(l)) return l
      const link = pick(l, STAFF_MANAGED_LINK_FIELDS)
      if (hasOwn(l, 'locations')) link.locations = isPlainObject(l.locations) ? toUserLocation(l.locations) : l.locations
      return link
    })
  }
  return out
}

/** The staff editor's profile fields (STAFF_EDITOR_FIELDS) of a profiles row. */
export function pickStaffEditorProfile(row) {
  if (!isPlainObject(row)) return row
  return pick(row, STAFF_EDITOR_FIELDS)
}
