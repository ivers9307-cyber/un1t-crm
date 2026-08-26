// Common Zod building blocks shared across API routes.
//
// Reusing these keeps validation behaviour consistent — e.g. every endpoint
// that accepts a contact phone number applies the same constraints, every
// date field expects YYYY-MM-DD. When a constraint changes, it changes here.

import { z } from 'zod'
import { sanitizePermissionsBlob } from '@shared/permissions'

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

// Bare hostname like pay.example.com — no scheme, no port, no path.
// Requires at least one dot (a public tenant domain, not a bare
// label) and normalises to lowercase, matching the tenant_domains
// CHECK constraint (mig 415). Case-insensitive validation THEN the
// lowercase transform so "Pay.Example.COM" is accepted and stored
// canonically.
export const tenantHostname = z.string().trim().min(1).max(253)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
    'Must be a bare hostname like pay.example.com (no scheme, port, or path)'
  )
  .transform((s) => s.toLowerCase())

// tenant_domains.brand config (SAAS-8, mig 415) — mirrors the BRANDS
// entry shape in src/lib/brands.js. All keys optional: missing ones
// default to the marketing shape (rewrite "/" + strays to /welcome;
// see DB_BRAND_DEFAULTS in tenant-domains-edge.js). .strict() so a
// typo'd key is a 400 at write time, not a silently-ignored config.
export const tenantDomainBrandConfigSchema = z.object({
  description: z.string().trim().max(200).optional(),
  allowedPaths: z.array(
    z.string().max(200).regex(/^\//, 'Paths must start with /')
  ).max(100).optional(),
  rootHandler: z.enum(['reject', 'rewrite']).optional(),
  rootRewriteTo: z.string().max(200).regex(/^\//, 'Must start with /').optional(),
  fallbackHandler: z.enum(['reject', 'rewrite']).optional(),
  fallbackRewriteTo: z.string().max(200).regex(/^\//, 'Must start with /').optional(),
}).strict()

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
//   staff        Trainer.
//   reception    Front-of-house desk (2026-07) — staff-tier authz;
//                defaults add the WhatsApp inbox + booking desk.
export const roleSchema = z.enum(['master', 'owner', 'manager', 'head_coach', 'staff', 'reception'])
export const employmentTypeSchema = z.enum(['fte', 'contractor', 'casual'])

// Per-location role schema (mig 051). master never appears at the
// per-location level — it's a platform-wide flag on profiles.role.
// The CHECK constraint on profile_locations.role enforces this.
export const locationRoleSchema = z.enum(['owner', 'manager', 'head_coach', 'staff', 'reception'])

// Per-location assignment shape used by the staff API. One row per
// location the user belongs to, each carrying its own role, flags,
// and (mig 058) its own permission overrides.
export const assignmentSchema = z.object({
  location_id: uuidLike,
  role: locationRoleSchema,
  is_default: z.boolean().optional(),
  unifi_door_access: z.boolean().optional(),
  // Optional manual link to an existing UniFi Access user AT THIS
  // LOCATION (mig 120 attendance picker). Normally findOrCreateUnifiUser
  // populates this when the door-access toggle is flipped on; the
  // picker lets the operator override that and link to a specific
  // pre-existing UniFi user instead. `null` clears the link,
  // `undefined` leaves it unchanged, a string sets it. Treated as a
  // hint by the staff PUT — when present and door access is ON, the
  // route uses this id rather than calling findOrCreateUnifiUser.
  unifi_user_id: z.string().nullable().optional(),
  // UNIFI-DOORS-SCOPE (mig 182) — per-location allowlist of UniFi
  // Access door IDs this user can remote-unlock from the iOS Studio
  // Management screen. NULL = legacy fallback (route shows all doors
  // for manager+ roles only). Empty array = no doors visible.
  // Populated = exactly those doors. Strings are UniFi-controller-
  // assigned door IDs; the staff edit UI fetches the door list from
  // /api/locations/[id]/unifi-doors and the operator ticks the ones
  // the member is allowed to see.
  unifi_door_ids: z.array(z.string().min(1).max(200)).nullable().optional(),
  // STUDIO-AC-DEVICES.1 (mig 210) — per-location allowlist of
  // ac_devices.id values this user can control from the Studio
  // Management screen. Same NULL / empty / populated semantics
  // as unifi_door_ids. UUIDs, not arbitrary strings.
  ac_device_ids: z.array(z.string().uuid()).nullable().optional(),
  // GEO-ATT (mig 463) — exclude this staff member from mobile
  // geofence attendance at this location: never permission-gated in
  // the app, never auto-stamped by source=geofence. Omit to leave the
  // stored value unchanged (buildAssignmentRow mirrors the
  // hasOwnProperty optional-key semantics).
  geofence_exempt: z.boolean().optional(),
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
export const MASTER_ASSIGNABLE_ROLES = Object.freeze(['owner', 'manager', 'head_coach', 'staff', 'reception'])
// Per-location roles an owner-at-X can grant at X. Mig 051 expanded
// this to include 'owner' — owner-at-Hatch can now mint another
// owner-at-Hatch (no longer a platform-level promotion since per-
// location roles are independent).
export const OWNER_ASSIGNABLE_ROLES = Object.freeze(['owner', 'manager', 'head_coach', 'staff', 'reception'])

// Default colour used when a user-created entity (event, shift template)
// doesn't specify one. Branding-aware components should reference this
// instead of hardcoding hex values.
export const DEFAULT_COLOR = '#3B82F6'

// Lead source — mirror the values surfaced in AudienceBuilder.jsx.
// 'classpass' added in GLOFOX2.1.8 — preserves the 3rd-party origin signal
// for ClassPass-sourced contacts (Glofox surfaces this on member.origin,
// distinct from member.source which is 'UNKNOWN' for ClassPass).
//
// NOTE: leadStatusSchema removed in CLASSIFY.2 (mig 155 follow-up) — the
// contacts.lead_status column is being dropped. Audience classification
// now lives on contacts.pipeline_stage_slug (denormalised from deals).
export const leadSourceSchema = z.enum([
  'booking', 'meta', 'tiktok', 'walkin', 'referral', 'website', 'whatsapp', 'classpass', 'other',
])

// Deal status — open/won/lost from migration 001.
export const dealStatusSchema = z.enum(['open', 'won', 'lost'])

// Activity / note types are open-ended in the DB; bound length only.
export const activityTypeSchema = z.string().min(1).max(50)

// Time-off types. Full coherent set matching the DB CHECK (mig 283) + the
// shared catalogue in shared/time-off.js. The coach-facing menu is gated by
// employment type in the UI; this enum just bounds what the API will accept.
export const timeOffTypeSchema = z.enum(['holiday', 'sick', 'unpaid', 'other', 'unavailable'])

// Time-off status (used on PUT /api/schedule/time-off/[id])
export const timeOffStatusSchema = z.enum(['pending', 'approved', 'rejected', 'cancelled'])

// Swap request status. 'awaiting_approval' = a coach has claimed/accepted the
// swap and it's waiting for a manager to finalise (CT-P3). Free TEXT in the
// DB (no CHECK constraint) — this enum is the only gate.
export const swapStatusSchema = z.enum(['pending', 'awaiting_approval', 'approved', 'rejected', 'cancelled'])

// Report frequency / type — match scheduled_reports.frequency and the
// report-generator's switch statement.
export const reportFrequencySchema = z.enum(['once', 'daily', 'weekly', 'monthly'])
export const reportTypeSchema = z.enum([
  'staff_hours', 'staff_cost', 'time_off_summary', 'roster_coverage', 'utilisation',
])

// Permissions — whitelisted to the known keys from shared/permissions.js
// (PERM-AUDIT.1). Unknown keys and non-boolean values are silently
// stripped rather than rejected, so a stored blob carrying a stale
// pre-rename key still round-trips through the editors (and gets
// cleaned in the process).
export const permissionsSchema = z.record(z.string(), z.unknown())
  .transform(sanitizePermissionsBlob)

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
  // CONTRACTS-VARS.2 — optional per-variable default, pre-filled into
  // the issue wizard's input (prefill from a re-issue and issuer
  // typing both still win over this). Stored as a string regardless
  // of `type` (matches how the wizard's number/date inputs read their
  // value); omitted entirely when the template author leaves it blank
  // — see ContractTemplateForm's payload builder.
  default: z.string().max(500).optional(),
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
  // CONTRACTS-EDIT.1 — issuer's hand-edited rendered body from the
  // wizard's step-3 preview. When present it REPLACES the rendered
  // template output entirely (see /api/contracts POST); omitted when
  // the issuer never touched the "Edit text" affordance.
  body_override: z.string().min(1).optional(),
  // CONTRACTS-DRAFT.1 — save without notifying the recipient. When
  // true the route inserts with status='draft' and skips the email
  // + push entirely; the issuer sends it later via
  // /api/contracts/[id]/send or discards it via
  // /api/contracts/[id]/discard.
  save_as_draft: z.boolean().optional(),
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

// GIVERS-WEB.1 — public enquiry from the giversautos.com coming-soon page.
// email/message accept '' so the form can send its fields verbatim;
// the route normalises '' → null before insert.
export const giversEnquirySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  phone: z.string().trim().min(5, 'Phone is required').max(40),
  email: email.or(z.literal('')).optional(),
  message: z.string().trim().max(2000).optional(),
})
