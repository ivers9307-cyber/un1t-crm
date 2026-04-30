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
export const roleSchema = z.enum(['owner', 'manager', 'head_coach', 'staff'])
export const employmentTypeSchema = z.enum(['fte', 'contractor', 'casual'])

// Lead source / status — mirror the values surfaced in AudienceBuilder.jsx.
export const leadSourceSchema = z.enum([
  'booking', 'meta', 'tiktok', 'walkin', 'referral', 'website', 'whatsapp', 'other',
])
export const leadStatusSchema = z.enum([
  'active_trial', 'cold', 'lost_member', 'member', 'returning',
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
