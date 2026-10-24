// OPENAPI-EVENTS.1 — the request bodies of POST /api/events (create an event)
// and PUT /api/events/[id] (update one), in src/lib so that the OpenAPI spec
// (src/lib/openapi.js, which derives its schemas from src/lib only, never
// from src/app/api) documents the SAME Zod object the handlers validate with.
// The two handlers import these and re-export them under their old names
// (CreateSchema, UpdateSchema); what they accept did not change in the move.
//
// Each body comes in two layers: the `*Fields` object (every key, the thing
// the spec names as a component) and the schema the handler validates with,
// which adds the cross-field rules in a superRefine. A new field goes in the
// Fields object, so the spec sees it without anyone touching openapi.js.
//
// No IO, no React/Next/Supabase.

import { z } from 'zod'
import { uuidLike } from './schemas.js'
import { CharitySettingsSchema } from './charity-donations'
import { FindTeamSettingsSchema } from './find-team'

// ----------------------------------------------------------------------------
// Waves (mig 083). capacity null = unlimited.
// ----------------------------------------------------------------------------

// Create: no id (every wave is new).
export const WaveCreateInputSchema = z.object({
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM'),
  capacity: z.number().int().positive().max(10000).nullable().optional(),
  label: z.string().max(60).nullable().optional(),
  display_order: z.number().int().nonnegative().optional(),
})

// Update: id present = update that wave; absent = create. The diff-and-apply
// path in PUT matches by id where present, by start_time for unidentified
// rows that happen to align with existing waves.
export const WaveUpdateInputSchema = WaveCreateInputSchema.extend({
  id: z.string().uuid().optional(),
})

// ----------------------------------------------------------------------------
// POST /api/events
// ----------------------------------------------------------------------------

export const EventCreateFields = z.object({
  location_id: uuidLike,
  // Mig 122: discriminator. Defaults to 'race' so existing operator
  // muscle memory (where every event is a race) keeps working without
  // the form having to send the field.
  kind: z.enum(['race', 'workshop', 'seminar', 'open_day', 'masterclass', 'lead_gen']).optional(),
  // EVENTS-CAPACITY-MODE.1 (mig 280): does per-wave capacity count teams
  // (registrations, legacy default) or people (sum of team sizes)?
  capacity_mode: z.enum(['teams', 'people']).optional(),
  // Mig 125: staffing requirement for the studio overview demand
  // classifier. 0-50 (matches DB CHECK). Default 1 (matches DB DEFAULT).
  // Form pre-fills per kind (race=4, workshop=1, etc.) but operator
  // can override.
  staff_required: z.number().int().min(0).max(50).optional(),
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(120).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase kebab-case').optional(),
  description: z.string().max(4000).nullable().optional(),
  // race_date is required for every kind EXCEPT lead_gen (a no-date
  // data-capture form). Enforced per-kind in the superRefine below.
  race_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').nullable().optional(),
  registration_opens_at: z.string().datetime().nullable().optional(),
  registration_closes_at: z.string().datetime().nullable().optional(),
  allowed_team_sizes: z.array(z.number().int().positive().max(50)).min(1).max(20).optional(),
  active: z.boolean().optional(),
  // Member pricing (mig 084).
  member_pricing_enabled: z.boolean().optional(),
  members_only: z.boolean().optional(),
  // EVENTS-LOC.2: when true, this event shows in every location's list.
  shared: z.boolean().optional(),
  // EVENTS-HOST.4: nullable FK -> event_hosts. NULL = internal UN1T event
  // (settled via Revolut, the default); set = that host is paid directly
  // via Stripe Connect with UN1T's per-ticket booking fee. Org-validated
  // against the event's location in POST before it's persisted.
  host_id: uuidLike.nullable().optional(),
  member_fee_cents: z.number().int().nonnegative().nullable().optional(),
  non_member_fee_cents: z.number().int().nonnegative().nullable().optional(),
  payment_currency: z.string().length(3).optional(),
  // Mig 092: up to 3 sponsor/branding logo URLs for the TV display.
  // Schema CHECK caps the array at 6 to leave headroom; UI caps at 3.
  // Each entry must be an http(s) URL (no data: blobs).
  tv_logos: z.array(z.string().url().max(2000)).max(6).optional(),
  // Public-page hero image + accent colour. Hero is normally uploaded
  // after the event is saved (needs an id to namespace the storage
  // path), so these are typically set on the follow-up PUT — but the
  // create schema accepts them too. accent_hex is a 6-digit hex.
  hero_image_url: z.string().url().max(2000).nullable().optional(),
  accent_hex: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  // EVENTS-EMAILCFG.1 (mig 385) — per-event styling of the signup
  // confirmation + pre-event reminder emails. subject/intro drop into the
  // shared branded shell (merge-tagged); *_template_id overrides the shell
  // with a full email_templates row. All nullable → NULL = default copy/look
  // (behaviour-preserving). template_ids are org/location-validated in POST.
  confirmation_email_subject: z.string().max(4000).nullable().optional(),
  confirmation_email_intro: z.string().max(4000).nullable().optional(),
  reminder_email_subject: z.string().max(4000).nullable().optional(),
  reminder_email_intro: z.string().max(4000).nullable().optional(),
  // EVENT-MOVE.1 (mig 708) — copy for the "your entry has moved" email.
  moved_email_subject: z.string().max(4000).nullable().optional(),
  moved_email_intro: z.string().max(4000).nullable().optional(),
  // EVENT-MOVE.5 (mig 710) — copy for the two price-difference emails (the
  // payment link and the receipt share it).
  gap_email_subject: z.string().max(4000).nullable().optional(),
  gap_email_intro: z.string().max(4000).nullable().optional(),
  // EVENT-WAITLIST.1 (mig 713) — copy for the waitlist "a spot opened up"
  // offer email ({{claim_url}} available).
  waitlist_email_subject: z.string().max(4000).nullable().optional(),
  waitlist_email_intro: z.string().max(4000).nullable().optional(),
  confirmation_email_template_id: uuidLike.nullable().optional(),
  reminder_email_template_id: uuidLike.nullable().optional(),
  // EVENT-COMMS-LOC (mig 553) — the real UN1T location this event's SMS + email
  // send from. In-org non-anchor validated in POST.
  sending_location_id: uuidLike.nullable().optional(),
  // CHARITY.9 (mig 765) — "Charity day" card donations on the public page.
  charity_enabled: z.boolean().optional(),
  charity: CharitySettingsSchema.nullable().optional(),
  // FINDTEAM.6 — "Find me a team" switch + copy (race_events.find_team, mig 766).
  find_team: FindTeamSettingsSchema.nullable().optional(),
  // Waves (mig 083) — at least one required for a usable race.
  // Server normalises by start_time ascending; UNIQUE on
  // (race_event_id, start_time) catches duplicates from the DB side.
  waves: z.array(WaveCreateInputSchema).max(50).optional(),
})

export const EventCreateSchema = EventCreateFields.superRefine((val, ctx) => {
  // Every kind except lead_gen needs a date AND at least one wave.
  // lead_gen is a pure data-capture form: no date, no waves.
  const kind = val.kind ?? 'race'
  if (kind === 'lead_gen') return
  if (!val.race_date) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['race_date'], message: 'Date is required.' })
  }
  if (!val.waves || val.waves.length < 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['waves'], message: 'Add at least one wave.' })
  }
})

// ----------------------------------------------------------------------------
// PUT /api/events/[id]
// ----------------------------------------------------------------------------

export const EventUpdateFields = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
  race_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  registration_opens_at: z.string().datetime().nullable().optional(),
  registration_closes_at: z.string().datetime().nullable().optional(),
  allowed_team_sizes: z.array(z.number().int().positive().max(50)).min(1).max(20).optional(),
  // Mig 125: staffing requirement edit. Same range as create. The update
  // accepts kind-NULL keep semantics — only patches when explicitly set.
  staff_required: z.number().int().min(0).max(50).optional(),
  active: z.boolean().optional(),
  // EVENTS-CAPACITY-MODE.1 (mig 280): cap by teams or people. Scalar —
  // flows through the generic `updates` patch in PUT.
  capacity_mode: z.enum(['teams', 'people']).optional(),
  // Member pricing (mig 084).
  member_pricing_enabled: z.boolean().optional(),
  members_only: z.boolean().optional(),
  // EVENTS-LOC.2: shared = show this event in every location's list.
  shared: z.boolean().optional(),
  // EVENTS-HOST.4: reassign the payee. NULL = internal UN1T (Revolut);
  // set = pay that host directly via Stripe. Org-validated in PUT.
  host_id: uuidLike.nullable().optional(),
  member_fee_cents: z.number().int().nonnegative().nullable().optional(),
  non_member_fee_cents: z.number().int().nonnegative().nullable().optional(),
  payment_currency: z.string().length(3).optional(),
  // Mig 092: TV-display logos (max 3 in UI, schema allows 6).
  tv_logos: z.array(z.string().url().max(2000)).max(6).optional(),
  // Public-page hero image + accent colour. hero_image_url is set by
  // the caller after POST /api/events/[id]/hero returns the bytes URL;
  // accent_hex is a 6-digit hex (#RRGGBB). Both nullable to clear.
  hero_image_url: z.string().url().max(2000).nullable().optional(),
  accent_hex: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  // EVENTS-EMAILCFG.1 (mig 385) — per-event confirmation/reminder email
  // styling. Scalars flow through the generic `updates` patch; NULL
  // clears back to the default copy/look, omit = leave untouched. The
  // *_template_id fields are location-validated in PUT before persisting.
  confirmation_email_subject: z.string().max(4000).nullable().optional(),
  confirmation_email_intro: z.string().max(4000).nullable().optional(),
  reminder_email_subject: z.string().max(4000).nullable().optional(),
  reminder_email_intro: z.string().max(4000).nullable().optional(),
  // EVENT-MOVE.1 (mig 708) — copy for the "your entry has moved" email.
  moved_email_subject: z.string().max(4000).nullable().optional(),
  moved_email_intro: z.string().max(4000).nullable().optional(),
  // EVENT-MOVE.5 (mig 710) — copy for the two price-difference emails (the
  // payment link and the receipt share it).
  gap_email_subject: z.string().max(4000).nullable().optional(),
  gap_email_intro: z.string().max(4000).nullable().optional(),
  // EVENT-WAITLIST.1 (mig 713) — copy for the waitlist "a spot opened up"
  // offer email ({{claim_url}} available).
  waitlist_email_subject: z.string().max(4000).nullable().optional(),
  waitlist_email_intro: z.string().max(4000).nullable().optional(),
  confirmation_email_template_id: uuidLike.nullable().optional(),
  reminder_email_template_id: uuidLike.nullable().optional(),
  // EVENT-COMMS-LOC (mig 553) — flows through the generic scalar patch; in-org
  // non-anchor validated in PUT.
  sending_location_id: uuidLike.nullable().optional(),
  // CHARITY.9 (mig 765) — "Charity day" card donations on the public page.
  // Flows through the generic `updates` spread in PUT.
  charity_enabled: z.boolean().optional(),
  charity: CharitySettingsSchema.nullable().optional(),
  // FINDTEAM.6 — "Find me a team" switch + copy (race_events.find_team, mig 766).
  find_team: FindTeamSettingsSchema.nullable().optional(),
  // EVENT-OWNER.1 — the owning studio. Admin at both ends, same org, not a
  // host anchor, not a host event: judged by judgeEventOwnerChange in PUT.
  location_id: uuidLike.optional(),
  // When provided, replaces the wave set entirely (diff-and-apply).
  // Omitting leaves waves untouched. At least one wave required if set.
  waves: z.array(WaveUpdateInputSchema).min(1).max(50).optional(),
})

export const EventUpdateSchema = EventUpdateFields.superRefine((b, ctx) => {
  // CHARITY.12 — switching donations on with settings that have no charity
  // name would render "Every euro goes to ." publicly. Judged when the
  // settings come with the switch (the form always sends both).
  if (b.charity_enabled === true && b.charity !== undefined && !String(b.charity?.name || '').trim()) {
    ctx.addIssue({ code: 'custom', path: ['charity', 'name'], message: 'Enter the charity name to take donations.' })
  }
})
