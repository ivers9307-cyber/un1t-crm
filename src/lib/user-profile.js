// PROFILESPREAD.1 — the profile columns the signed-in user object carries.
//
// getCurrentUser() used to `select('*')` from profiles and spread the row
// into the user object, which the layout hands to <AppShell user={user}>, a
// client component. So every page's HTML carried the person's own pin_hash,
// pin_* bookkeeping, pay columns (annual_salary, hourly_rate,
// contracted_hours_per_week, annual_leave_entitlement, overtime_rate),
// unifi_user_id and tombstone bookkeeping, and a master's "View as" carried
// the TARGET's. These ten are every profile field a reader takes off the
// user object (census: plan C41 §1; tests/user-profile-consumers.test.js
// keeps it true). A new reader of another column adds it here on purpose.
//
// The account page reads PIN state and home_screen_path FRESH by id; pay is
// read from profile_compensation; door access is per location
// (assignmentsByLocation). None of them come off the user object.

export const USER_PROFILE_COLUMNS = Object.freeze([
  'id', 'email', 'full_name', 'avatar_url', 'role', 'active',
  'permissions', 'employment_type', 'email_signature', 'email_signature_rich',
])

// What getCurrentUser selects: the list plus deleted_at, which the tombstone
// check reads BEFORE the spread (isTombstone) and which is never spread.
// Every name must exist on profiles: an unknown one 400s the read, and the
// read resolving null signs everyone out (src/lib/user-profile.test.js).
export const PROFILE_AUTH_SELECT = [...USER_PROFILE_COLUMNS, 'deleted_at'].join(', ')

/** The listed keys the row actually has (never adds an undefined key). */
export function pickUserProfile(row) {
  if (row === null || typeof row !== 'object') return row
  const out = {}
  for (const k of USER_PROFILE_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(row, k)) out[k] = row[k]
  }
  return out
}

// AUTHUSERPICK.1 — the Supabase auth user as the user object carries it.
//
// getCurrentUser() used to put the whole auth user on `user.user`: identities
// (each with the provider's identity_data), app_metadata, user_metadata,
// phone, factors, confirmation and sign-in timestamps. The object is
// serialised into every page (AppShell, and ~30 page → client-component
// hand-offs). Nothing reads any of it (census: plan C58 §2;
// tests/user-profile-consumers.test.js keeps it true). id + email is the shape
// the studio-PIN path has always produced (getUserFromStudioSession), so every
// auth source now yields the same two fields. Under "View as" this is still
// the MASTER's auth user (the profile fields are the target's).
export const AUTH_USER_FIELDS = Object.freeze(['id', 'email'])

/** `{ id, email }` of an auth user (null for a missing field); null for a non-object. */
export function pickAuthUser(authUser) {
  if (authUser === null || typeof authUser !== 'object') return null
  return { id: authUser.id ?? null, email: authUser.email ?? null }
}
