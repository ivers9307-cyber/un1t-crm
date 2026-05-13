// SECURITY.1 — helpers for the profile_compensation table (mig 152).
//
// The 5 sensitive comp fields used to live on profiles directly, but
// profiles RLS allows every authenticated user to read their own row,
// which leaked salary / hourly rate to any staff member who knew how
// to write a Supabase JS query. Mig 152 moved them to a separate
// table with master/owner-only RLS.
//
// All readers + writers go through these helpers so we have one place
// to enforce the new shape. Pass a server-client (createServerClient)
// — those bypass RLS via the service-role key, so server routes work
// regardless of the caller's session role. Direct client-side reads
// are blocked by the table's RLS policy.
//
// The shape returned is intentionally identical to the columns'
// previous on-profiles names so call sites can swap with minimal
// churn:
//   { annual_salary, hourly_rate, contracted_hours_per_week,
//     annual_leave_entitlement, overtime_rate }
//
// employment_type stays on profiles — see mig 152 header for the
// reasoning.

const COMP_COLS = [
  'annual_salary',
  'hourly_rate',
  'contracted_hours_per_week',
  'annual_leave_entitlement',
  'overtime_rate',
]

/**
 * Read one profile's comp row. Returns the same shape the old
 * inline columns had, with all-null defaults if no row exists yet.
 *
 * @param {SupabaseClient} db    server-client (service-role)
 * @param {string} profileId
 * @returns {Promise<{
 *   annual_salary: number|null,
 *   hourly_rate: number|null,
 *   contracted_hours_per_week: number|null,
 *   annual_leave_entitlement: number|null,
 *   overtime_rate: number|null,
 * }>}
 */
export async function getCompensationForProfile(db, profileId) {
  if (!db || !profileId) return emptyComp()
  const { data, error } = await db
    .from('profile_compensation')
    .select(COMP_COLS.join(', '))
    .eq('profile_id', profileId)
    .maybeSingle()
  if (error || !data) return emptyComp()
  return {
    annual_salary:             toNum(data.annual_salary),
    hourly_rate:               toNum(data.hourly_rate),
    contracted_hours_per_week: toNum(data.contracted_hours_per_week),
    annual_leave_entitlement:  toNum(data.annual_leave_entitlement),
    overtime_rate:             toNum(data.overtime_rate),
  }
}

/**
 * Bulk-read many profiles' comp rows in one round-trip. Returns a
 * Map keyed by profile_id. Missing profiles have no key — the caller
 * should default to emptyComp() / null fields.
 *
 * Uses .range() pagination (PostgREST 1k-row cap — the recurring trap
 * documented in CLAUDE.md). UN1T has ~12 profiles today; the cap
 * doesn't bite until many hundreds, but page anyway for safety.
 *
 * @param {SupabaseClient} db
 * @param {string[]} profileIds
 * @returns {Promise<Map<string, object>>}
 */
export async function getCompensationForProfiles(db, profileIds) {
  const out = new Map()
  if (!db || !Array.isArray(profileIds) || profileIds.length === 0) return out
  // For small N (<=200) one query is faster than paging.
  // Larger sets hit PostgREST URL length on .in(), so chunk.
  const CHUNK = 200
  for (let i = 0; i < profileIds.length; i += CHUNK) {
    const slice = profileIds.slice(i, i + CHUNK)
    const { data } = await db
      .from('profile_compensation')
      .select(`profile_id, ${COMP_COLS.join(', ')}`)
      .in('profile_id', slice)
    for (const row of (data || [])) {
      out.set(row.profile_id, {
        annual_salary:             toNum(row.annual_salary),
        hourly_rate:               toNum(row.hourly_rate),
        contracted_hours_per_week: toNum(row.contracted_hours_per_week),
        annual_leave_entitlement:  toNum(row.annual_leave_entitlement),
        overtime_rate:             toNum(row.overtime_rate),
      })
    }
  }
  return out
}

/**
 * Write (insert or update) one profile's comp row. Only writes the
 * fields actually present in `patch` — undefined keys are left
 * unchanged. null explicitly clears a field.
 *
 * @param {SupabaseClient} db
 * @param {string} profileId
 * @param {object} patch        subset of COMP_COLS
 * @param {object} [opts]
 * @param {string} [opts.actorId]  who's making the change (audit)
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function upsertCompensationForProfile(db, profileId, patch, opts = {}) {
  if (!db || !profileId || !patch || typeof patch !== 'object') {
    return { ok: false, error: 'invalid args' }
  }
  const row = { profile_id: profileId, updated_at: new Date().toISOString() }
  for (const col of COMP_COLS) {
    if (Object.prototype.hasOwnProperty.call(patch, col)) {
      row[col] = patch[col] === '' ? null : patch[col]
    }
  }
  if (opts.actorId) row.updated_by = opts.actorId

  const { error } = await db
    .from('profile_compensation')
    .upsert(row, { onConflict: 'profile_id' })
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/**
 * Strip the deprecated comp fields from a profile-update payload.
 * Used by API routes that accept a flat profile patch from the
 * StaffForm — they should still accept the keys (back-compat with
 * an older client) but route them through upsertCompensationForProfile
 * instead of writing them to profiles directly.
 *
 * Returns { profileFields, compFields } where compFields is a
 * subset of COMP_COLS suitable for upsertCompensationForProfile,
 * and profileFields is the original input minus those keys.
 */
export function splitCompFromProfilePatch(patch) {
  const compFields = {}
  const profileFields = {}
  for (const [k, v] of Object.entries(patch || {})) {
    if (COMP_COLS.includes(k)) compFields[k] = v
    else profileFields[k] = v
  }
  return { profileFields, compFields }
}

function emptyComp() {
  return {
    annual_salary: null,
    hourly_rate: null,
    contracted_hours_per_week: null,
    annual_leave_entitlement: null,
    overtime_rate: null,
  }
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export const COMPENSATION_FIELDS = [...COMP_COLS]
