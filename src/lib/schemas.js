// Common Zod building blocks shared across API routes.
//
// Reusing these keeps validation behaviour consistent — e.g. every endpoint
// that accepts a contact phone number applies the same constraints, every
// date field expects YYYY-MM-DD. When a constraint changes, it changes here.

import { z } from 'zod'

// UUID-shaped string matching what Postgres's uuid type accepts. See
// src/lib/validate.js for the rationale (Zod 4's .uuid() is RFC-strict
// but the seeded location ID isn't RFC-compliant).
export const uuidLike = z.string().regex(
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  'Must be a 36-character UUID-shaped string'
)

// Date in ISO-8601 calendar format (no time portion).
export const isoDate = z.string().regex(
  /^\d{4}-\d{2}-\d{2}$/,
  'Use YYYY-MM-DD'
)

// Time of day, HH:MM or HH:MM:SS.
export const timeOfDay = z.string().regex(
  /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/,
  'Use HH:MM (24h)'
)

// Hex colour like #RRGGBB.
export const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use #RRGGBB hex')

// Email — same constraint Postmark and Supabase auth apply.
export const email = z.string().email().max(320)

// Permissive phone: free-form, length-bounded. Don't try to enforce E.164
// since trial leads sometimes type local numbers without country codes.
export const phone = z.string().min(3).max(50)

// HTTP(S) URL.
export const url = z.string().url().max(2000)

// Money / hours / leave-day bounds matching the DB schema.
//   annual_salary  NUMERIC(10,2)  → up to 99,999,999.99
//   hourly_rate    NUMERIC(8,2)   → up to 999,999.99
//   contracted_hours_per_week NUMERIC(5,1) → up to 9999.9 (we cap at 168)
//   annual_leave_entitlement  NUMERIC(5,1)
export const money = z.number().finite().min(0).max(10_000_000)
export const hours = z.number().finite().min(0).max(168)
export const days = z.number().finite().min(0).max(366)

// Roles + employment types — keep in sync with profiles.role and the
// employment_type CHECK constraint.
//
// Ordered from most-privileged → least:
//   master       Platform-level super-admin (mig 033). Only role that
//                can create new locations or new owner/master accounts.
//                RLS treats master as a member of every location.
//   owner        Studio-level admin. Full control of locations they
//                belong to, but cannot create new locations or new
//                owner/master accounts.
//   manager      Day-to-day ops admin (schedule, pipeline, settings).
//   head_coach   Senior trainer.
//   staff        Trainer / front-desk.
export const roleSchema = z.enum(['master', 'owner', 'manager', 'head_coach', 'staff'])
export const employmentTypeSchema = z.enum(['fte', 'contractor', 'casual'])

// Per-location role schema (mig 051). master never appears at the
// per-location level — it's a platform-wide flag on profiles.role.
// The CHECK constraint on profile_locations.role enforces this.
export const locationRoleSchema = z.enum(['owner', 'manager', 'head_coach', 'staff'])

// Per-location assignment shape used by the staff API. One row per
// location the user belongs to, each carrying its own role, flags,
// and (mig 058) its own permission overrides.
export const assignmentSchema = z.object({
  location_id: uuidLike,
  role: locationRoleSchema,
  is_default: z.boolean().optional(),
  unifi_door_access: z.boolean().optional(),
  // Per-location user permission overrides (mig 058). Empty `{}` =
  // "use the role default at this assignment's role". Top-level
  // keys mirror WEB_PERMISSIONS; nested `mobile` sub-object mirrors
  // MOBILE_PERMISSIONS. Validation is intentionally loose so adding
  // a new permission key isn't a schema change here — same shape as
  // permissionsSchema below.
  permissions: z.record(z.string(), z.unknown()).optional(),
})

// Role groups for authz checks. Reference these instead of inlining
// `['owner', 'manager', 'head_coach']` so a future role addition is a
// one-line change. Master is implicitly in every group via the
// hasPermission() short-circuit + RLS — no explicit listing needed.
export const ADMIN_ROLES = Object.freeze(['master', 'owner', 'manager'])
export const MANAGER_ROLES = Object.freeze(['master', 'owner', 'manager', 'head_coach'])

// Per-location roles a master can grant at any location. Master itself
// is set via the separate `is_master` flag, not as a per-location role.
export const MASTER_ASSIGNABLE_ROLES = Object.freeze(['owner', 'manager', 'head_coach', 'staff'])
// Per-location roles an owner-at-X can grant at X. Mig 051 expanded
// this to include 'owner' — owner-at-Hatch can now mint another
// owner-at-Hatch (no longer a platform-level promotion since per-
// location roles are independent).
export const OWNER_ASSIGNABLE_ROLES = Object.freeze(['owner', 'manager', 'head_coach', 'staff'])

// Default colour used when a user-created entity (event, shift template)
// doesn't specify one. Branding-aware components should reference this
// instead of hardcoding hex values.
export const DEFAULT_COLOR = '#3B82F6'

// Lead source / status — mirror the values surfaced in AudienceBuilder.jsx.
export const leadSourceSchema = z.enum([
  'booking', 'meta', 'tiktok', 'walkin', 'referral', 'website', 'whatsapp', 'other',
])
export const leadStatusSchema = z.enum([
  'active_trial', 'cold', 'lost_member', 'member', 'returning',
  // Mig 086 — race-contact-linking. A non-member who registered for
  // a race gets stamped with this status so they can be filtered /
  // sequenced separately from gym leads. Schema was missing it,
  // which made the contacts PUT route reject this value even though
  // race-contact-linking writes it directly.
  'competition_competitor',
])

// Deal status — open/won/lost from migration 001.
export const dealStatusSchema = z.enum(['open', 'won', 'lost'])

// Activity / note types are open-ended in the DB; bound length only.
export const activityTypeSchema = z.string().min(1).max(50)

// Time-off types from migration 011.
export const timeOffTypeSchema = z.enum(['holiday', 'sick', 'unpaid', 'other'])

// Time-off status (used on PUT /api/schedule/time-off/[id])
export const timeOffStatusSchema = z.enum(['pending', 'approved', 'rejected', 'cancelled'])

// Swap request status
export const swapStatusSchema = z.enum(['pending', 'approved', 'rejected', 'cancelled'])

// Report frequency / type — match scheduled_reports.frequency and the
// report-generator's switch statement.
export const reportFrequencySchema = z.enum(['once', 'daily', 'weekly', 'monthly'])
export const reportTypeSchema = z.enum([
  'staff_hours', 'staff_cost', 'time_off_summary', 'roster_coverage', 'utilisation',
])

// Permissions — JSONB, opaque values. Don't gate on shape.
export const permissionsSchema = z.record(z.string(), z.unknown())

// ---------------------------------------------------------------------------
// PASSWORDS
// Mirrors the Supabase project's auth-side requirements (set in the
// Dashboard: Auth > Sign In > Password Strength). If we accept a password
// that Supabase will reject, the user gets a confusing error from
// auth.admin.createUser / auth.updateUser. So we validate the same rules
// up-front, before sending to Supabase.
//
// Current org policy:
//   - 8+ characters
//   - at least one lowercase letter
//   - at least one uppercase letter
//   - at least one digit
//   - at least one symbol  (anything not a-zA-Z0-9)
//
// passwordRequirements is exported so client components can render the same
// requirement list / live-validate without duplicating regex.
// ---------------------------------------------------------------------------

export const passwordRequirements = Object.freeze([
  { id: 'length',    label: 'At least 8 characters',  test: v => v.length >= 8 },
  { id: 'lowercase', label: 'A lowercase letter',     test: v => /[a-z]/.test(v) },
  { id: 'uppercase', label: 'An uppercase letter',    test: v => /[A-Z]/.test(v) },
  { id: 'digit',     label: 'A digit',                test: v => /\d/.test(v) },
  { id: 'symbol',    label: 'A symbol',               test: v => /[^a-zA-Z0-9]/.test(v) },
])

/**
 * Returns null when the password meets every requirement, or a short
 * human-readable message naming the first failing rule. Used both by
 * the Zod schema and by client-side form pre-flight.
 */
export function validatePasswordComplexity(password) {
  if (typeof password !== 'string') return 'Password must be a string'
  for (const r of passwordRequirements) {
    if (!r.test(password)) return `Password requires: ${r.label.toLowerCase()}`
  }
  return null
}

export const passwordSchema = z.string()
  .min(8, 'Password must be at least 8 characters')
  .max(200, 'Password is too long')
  .refine(v => /[a-z]/.test(v), 'Password must contain a lowercase letter')
  .refine(v => /[A-Z]/.test(v), 'Password must contain an uppercase letter')
  .refine(v => /\d/.test(v),    'Password must contain a digit')
  .refine(v => /[^a-zA-Z0-9]/.test(v), 'Password must contain a symbol')

// Audience filter: { logic: 'and'|'or', filters: [...] }. The actual
// per-filter validation lives in src/lib/audience-filter.js (because it
// depends on the field/op whitelist), so here we just shape-check.
export const audienceFilterSchema = z.object({
  logic: z.enum(['and', 'or']).optional(),
  filters: z.array(z.object({
    field: z.string().max(100),
    op: z.string().max(50),
    value: z.unknown().optional(),
  })).optional(),
}).optional()

// =============================================================
// Contracts (mig 106) — templates + issued instances
// =============================================================

// Single custom-variable definition inside a template's
// variables_schema array. Type is informational (the wizard uses
// it to render the right input control); validation at issue time
// is just "is the field non-empty when required is true".
export const contractVariableDefSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9_]+$/, 'Use only letters, digits, underscore').max(60),
  label: z.string().min(1).max(120),
  type: z.enum(['text', 'number', 'date']).default('text'),
  required: z.boolean().default(false),
})

export const contractTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).nullable().optional(),
  body_markdown: z.string().min(1).max(50_000),
  variables_schema: z.array(contractVariableDefSchema).max(50).default([]),
  employment_type: z.enum(['fte', 'contractor', 'both']).default('both'),
  active: z.boolean().default(true),
})

// Issue-a-contract payload. variables is an open record because
// the keys depend on the template's variables_schema, which is
// dynamic. The route looks up the template and runs
// validateCustomVariables() against the schema.
export const contractIssueSchema = z.object({
  template_id: uuidLike,
  profile_id: uuidLike,
  location_id: uuidLike.nullable().optional(),
  variables: z.record(z.union([z.string(), z.number(), z.null()])).default({}),
  // Issuer's typed name for the countersign block. Recipient sees
  // a fully-employer-signed document on first view.
  issuer_signature: z.string().min(1).max(200),
})

// Sign payload — typed-name only in the MVP. The route adds IP
// + user agent + timestamp from the request itself (those
// shouldn't come from the client).
export const contractSignSchema = z.object({
  signature_value: z.string().min(1).max(200),
  signature_method: z.enum(['typed', 'drawn']).default('typed'),
})

export const contractDeclineSchema = z.object({
  declined_reason: z.string().min(1).max(500),
})

export const contractRevokeSchema = z.object({
  revoked_reason: z.string().min(1).max(500),
})
