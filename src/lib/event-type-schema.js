// EVENTTYPERLS.1 — the body the booking-type (event_types) write routes accept.
//
// POST /api/bookings/event-types and PUT /api/bookings/event-types/[id] are
// the ONLY writers of event_types (tests/event-types-writers.test.js; mig 650
// takes every write privilege off the browser roles). The booking-type form
// (src/components/EventForm.jsx) saves through them, so they must accept
// everything it sends — the mig 077 confirmation columns included: zod strips
// unknown keys, so a field missing here is dropped SILENTLY on save.
//
// Server-only (zod). The form imports nothing from here.
import { z } from 'zod'
import { uuidLike, hexColor, url } from './schemas'

const fields = {
  name: z.string().min(1).max(200),
  slug: z.string().max(100),
  description: z.string().max(5000).nullable(),
  duration_minutes: z.number().int().min(1).max(1440),
  color: hexColor,
  availability: z.unknown(), // opaque JSON shape, schema lives client-side
  buffer_minutes: z.number().int().min(0).max(1440),
  max_advance_days: z.number().int().min(0).max(3650),
  custom_fields: z.array(z.unknown()),
  webhook_url: url.nullable(),
  active: z.boolean(),
  // Mig 125: how many staff are needed to keep this booking type bookable.
  // Commitment-based: if availability exists for a day, this many staff must
  // be rostered to cover (0 = covered by another role). Drives the studio
  // overview classifier on /schedule.
  staff_required: z.number().int().min(0).max(50),
  // Mig 144 (GLOFOX3.2): when true, public bookings on this type push the
  // customer to Glofox (search-and-link OR create + attach trial). Default
  // false; the operator opts in per booking type (/api/public/book).
  create_in_glofox: z.boolean(),
  // Mig 077: the one-shot booking confirmation. The DB CHECK
  // (event_types_confirmation_channels_check) still admits {email, sms}, but
  // SMS was retired with Twilio (TWILIO-RETIRE.1), so only 'email' is
  // accepted; text limits match event_type_reminders'.
  confirmation_enabled: z.boolean(),
  confirmation_channels: z.array(z.enum(['email'])).min(1).nullable(),
  confirmation_email_template_id: uuidLike.nullable(),
  confirmation_email_subject: z.string().max(500).nullable(),
}

const optional = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()]))

/** PUT /api/bookings/event-types/[id]: every field optional; location_id is never movable. */
export const EventTypeUpdateSchema = z.object(optional)

/** POST /api/bookings/event-types: name required; location_id says where. */
export const EventTypeCreateSchema = z.object({
  ...optional,
  name: fields.name,
  location_id: uuidLike.optional(),
})

/** The mig 077 columns POST writes only when the caller sent them (API-key creates keep the column defaults). */
export const CONFIRMATION_FIELDS = Object.freeze([
  'confirmation_enabled',
  'confirmation_channels',
  'confirmation_email_template_id',
  'confirmation_email_subject',
])

/** The slug both routes derive from a name (the form used to compute the same thing client-side). */
export function eventTypeSlug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}
