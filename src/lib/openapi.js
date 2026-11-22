// OpenAPI 3.1 spec generator for the Repset CRM integration API.
//
// We use @asteasolutions/zod-to-openapi to derive request/response schemas
// from Zod. The spec is served at /api/openapi.json (session or Bearer key,
// gated by the proxy) and rendered by /api-docs.
//
// RETIRE.2 (Nov 2026) — this registry documents ONLY the routes that accept a
// per-organisation `unitk_` API key (authenticateApiKey / requireApiKeyOrManager
// in src/lib/api-auth.js). Session-only, public, webhook, bridge and mobile
// routes are not documented here. When a route gains or loses the API-key
// path, add or remove its entry below (src/lib/openapi.test.js pins the list).
// The request bodies mirror the handlers' own Zod schemas (a route file may
// not export them); where a schema lives in src/lib it is imported.

import { z } from 'zod'
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi'
import { unstable_cache } from 'next/cache'
import {
  uuidLike, isoDate, timeOfDay, email, phone,
  leadSourceSchema, audienceFilterSchema,
} from './schemas.js'
import {
  EventTypeCreateSchema as EventTypeCreateRaw,
  EventTypeUpdateSchema as EventTypeUpdateRaw,
} from './event-type-schema.js'

// Wire .openapi() onto Zod so we can decorate inline-defined schemas.
extendZodWithOpenApi(z)

const registry = new OpenAPIRegistry()

// ============================================================================
// Common envelopes
// ============================================================================
const ErrorResponse = z.object({
  success: z.literal(false),
  error: z.string(),
  issues: z.array(z.object({
    path: z.string(),
    message: z.string(),
  })).optional(),
}).openapi('ErrorResponse', { description: 'Standard error envelope' })

const SuccessResponse = (dataSchema) =>
  z.object({
    success: z.literal(true),
    data: dataSchema,
  })

const json = (schema) => ({ content: { 'application/json': { schema } } })
const err = (description) => ({ description, ...json(ErrorResponse) })
const UNAUTHORIZED = err('Unauthorized: no valid API key (or, where a session is also accepted, no Manager+ session)')
const NOT_FOUND = err('Not found, or not in your organisation (a cross-organisation id is indistinguishable from a missing one)')

const idParams = z.object({ id: uuidLike })

// Every route below takes BearerAuth; those that also serve the web app list
// CookieAuth as the alternative.
const KEY_ONLY = [{ BearerAuth: [] }]
const KEY_OR_SESSION = [{ BearerAuth: [] }, { CookieAuth: [] }]

registry.registerComponent('securitySchemes', 'BearerAuth', {
  type: 'http',
  scheme: 'bearer',
  description:
    'API key for external integrations, sent as `Authorization: Bearer <token>`: a ' +
    'per-organization key (`unitk_…`, issued at /settings/api-keys) whose queries are ' +
    'scoped to the key\'s organization.',
})
registry.registerComponent('securitySchemes', 'CookieAuth', {
  type: 'apiKey',
  in: 'cookie',
  name: 'sb-access-token',
  description: 'Supabase session cookie set after browser login (Manager+ at the target studio).',
})

// ============================================================================
// Contacts
// ============================================================================
const ContactCreate = z.object({
  name: z.string().min(1).max(200),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  email: email.optional().nullable().describe('Email or phone is required (PHONEONLY.1).'),
  phone: phone.optional().nullable(),
  label: z.string().max(100).nullable().optional(),
  glofox_member_id: z.string().max(100).nullable().optional(),
  trial_credits_remaining: z.number().int().min(0).max(100).optional()
    .describe('Omitted = no credit count (null) until Glofox links the contact and sets it (C145). No default.'),
  lead_source: leadSourceSchema.optional(),
  lead_created_at: z.string().datetime().optional(),
  location_id: uuidLike.optional(),
}).openapi('ContactCreate')

const ContactUpdate = z.object({
  name: z.string().min(1).max(200).optional(),
  first_name: z.string().max(100).nullable().optional(),
  last_name: z.string().max(100).nullable().optional(),
  email: email.optional(),
  phone: phone.nullable().optional(),
  label: z.string().max(100).nullable().optional(),
  glofox_member_id: z.string().max(100).nullable().optional(),
  trial_credits_remaining: z.number().int().min(0).max(100).optional(),
  lead_source: leadSourceSchema.optional(),
  hr_leaderboard_opt_out: z.boolean().optional(),
  tags: z.array(z.string().min(1).max(64)).max(50).optional()
    .describe('The full new tag array. Sequence tag_added triggers fire on the tags added.'),
}).openapi('ContactUpdate')

const Contact = z.object({
  id: uuidLike,
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  lead_source: z.string().nullable(),
  pipeline_stage_slug: z.string().nullable(),
  location_id: uuidLike.nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).openapi('Contact')

registry.registerPath({
  method: 'post',
  path: '/api/contacts',
  tags: ['Contacts'],
  security: KEY_OR_SESSION,
  summary: 'Create a contact',
  description: 'An email or a phone number is required (PHONEONLY.1). Without an email the contact is not provisioned in Glofox.',
  request: { body: json(ContactCreate) },
  responses: {
    200: { description: 'Contact created', ...json(SuccessResponse(Contact)) },
    400: err('Validation failed, location_id missing (cookie callers and per-organisation keys), or the insert failed (generic message; the database error is logged, never echoed)'),
    401: err('Unauthorized, or (cookie caller) not Manager+ at location_id'),
    403: err('Per-organisation API key: location_id is not in your organisation. Cookie caller: not a member of location_id.'),
    409: err('A contact with this email (or, with no email, this WhatsApp number) already exists in your organisation'),
    500: err('No email given and the phone duplicate check could not be read (nothing created)'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/contacts/{id}',
  tags: ['Contacts'],
  security: KEY_ONLY,
  summary: 'Get a contact',
  request: { params: idParams },
  responses: {
    200: { description: 'The contact row', ...json(SuccessResponse(Contact)) },
    401: UNAUTHORIZED,
    404: NOT_FOUND,
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/contacts/{id}',
  tags: ['Contacts'],
  security: KEY_OR_SESSION,
  summary: 'Update a contact',
  request: { params: idParams, body: json(ContactUpdate) },
  responses: {
    200: { description: 'Contact updated', ...json(SuccessResponse(Contact)) },
    400: err('Validation failed, or the update failed (generic message; the database error is logged, never echoed)'),
    401: UNAUTHORIZED,
    404: err('No such contact (or a malformed id), or (cookie caller) not Manager+ at its location; per-organisation keys: not in your organisation'),
    409: err('A contact with this email already exists in your organisation'),
    503: err('The contact could not be read just now; nothing was changed. Retry.'),
  },
})

// ============================================================================
// Pipeline stages
// ============================================================================
registry.registerPath({
  method: 'get',
  path: '/api/stages',
  tags: ['Pipeline'],
  security: KEY_OR_SESSION,
  summary: 'List pipeline stages',
  description: 'Ordered by display_order. A key sees its organisation\'s studios only; a session sees the studios where it is Manager+.',
  request: { query: z.object({ location_id: uuidLike.optional() }) },
  responses: {
    200: { description: 'The pipeline_stages rows' },
    401: UNAUTHORIZED,
    403: err('Cookie caller: not a member of location_id'),
  },
})

// ============================================================================
// Tasks
// ============================================================================
const TaskPriority = z.enum(['low', 'medium', 'high', 'urgent']).nullable().optional()
const TaskStatus = z.enum(['todo', 'in_progress', 'done', 'cancelled']).optional()
const dueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()
const dueTime = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional()

const TaskCreate = z.object({
  location_id: uuidLike,
  subject: z.string().min(1).max(500),
  note: z.string().max(5000).nullable().optional(),
  due_date: dueDate,
  due_time: dueTime,
  assignee_id: uuidLike.nullable().optional(),
  priority: TaskPriority,
  project: z.string().max(100).nullable().optional(),
  contact_id: uuidLike.nullable().optional(),
  status: TaskStatus,
}).openapi('TaskCreate')

const TaskUpdate = z.object({
  subject: z.string().min(1).max(500).optional(),
  note: z.string().max(5000).nullable().optional(),
  status: TaskStatus,
  priority: TaskPriority,
  project: z.string().max(100).nullable().optional(),
  due_date: dueDate,
  due_time: dueTime,
  assignee_id: uuidLike.nullable().optional(),
  contact_id: uuidLike.nullable().optional(),
}).openapi('TaskUpdate')

registry.registerPath({
  method: 'get',
  path: '/api/tasks',
  tags: ['Tasks'],
  security: KEY_ONLY,
  summary: 'List tasks',
  description: 'Newest first.',
  request: {
    query: z.object({
      location_id: uuidLike.optional(),
      status: z.enum(['todo', 'in_progress', 'done', 'cancelled']).optional(),
      assignee_id: uuidLike.optional(),
      project: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    }),
  },
  responses: { 200: { description: 'Task rows' }, 401: UNAUTHORIZED },
})

registry.registerPath({
  method: 'post',
  path: '/api/tasks',
  tags: ['Tasks'],
  security: KEY_ONLY,
  summary: 'Create a task',
  description: 'location_id must be in your organisation, and so must contact_id and assignee_id when given.',
  request: { body: json(TaskCreate) },
  responses: {
    200: { description: 'Task created' },
    400: err('Validation failed'),
    401: UNAUTHORIZED,
    403: err('location_id is not in your organisation'),
    404: err('contact_id or assignee_id is not in your organisation'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/tasks/{id}',
  tags: ['Tasks'],
  security: KEY_ONLY,
  summary: 'Get a task',
  request: { params: idParams },
  responses: { 200: { description: 'The task' }, 401: UNAUTHORIZED, 404: NOT_FOUND },
})

registry.registerPath({
  method: 'patch',
  path: '/api/tasks/{id}',
  tags: ['Tasks'],
  security: KEY_ONLY,
  summary: 'Update a task',
  request: { params: idParams, body: json(TaskUpdate) },
  responses: {
    200: { description: 'Task updated' },
    400: err('Validation failed'),
    401: UNAUTHORIZED,
    404: NOT_FOUND,
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/tasks/{id}',
  tags: ['Tasks'],
  security: KEY_ONLY,
  summary: 'Delete a task',
  request: { params: idParams },
  responses: { 200: { description: 'Task deleted' }, 401: UNAUTHORIZED, 404: NOT_FOUND },
})

// ============================================================================
// Bookings and booking types
// ============================================================================
const BookingUpdate = z.object({
  status: z.enum(['pending', 'confirmed', 'completed', 'cancelled', 'no_show']).optional(),
  notes: z.string().max(5000).nullable().optional(),
  booking_date: isoDate.optional(),
  start_time: timeOfDay.optional(),
  end_time: timeOfDay.optional(),
}).openapi('BookingUpdate')

// .extend({}) gives a fresh object that carries .openapi() (the imported
// schemas were built before extendZodWithOpenApi ran).
const EventTypeCreate = EventTypeCreateRaw.extend({}).openapi('EventTypeCreate')
const EventTypeUpdate = EventTypeUpdateRaw.extend({}).openapi('EventTypeUpdate')

registry.registerPath({
  method: 'get',
  path: '/api/bookings',
  tags: ['Bookings'],
  security: KEY_ONLY,
  summary: 'List bookings',
  description: 'Ordered by date and start time; each row embeds its booking type (name, color, slug) and contact (name, email).',
  request: {
    query: z.object({
      location_id: uuidLike.optional(),
      event_type_id: uuidLike.optional(),
      status: z.string().optional(),
      date_from: isoDate.optional(),
      date_to: isoDate.optional(),
      contact_id: uuidLike.optional(),
      limit: z.coerce.number().int().min(1).optional().default(50),
    }),
  },
  responses: { 200: { description: 'Booking rows' }, 401: UNAUTHORIZED },
})

registry.registerPath({
  method: 'put',
  path: '/api/bookings/{id}',
  tags: ['Bookings'],
  security: KEY_ONLY,
  summary: 'Update a booking (status, notes, time)',
  request: { params: idParams, body: json(BookingUpdate) },
  responses: {
    200: { description: 'Booking updated' },
    400: err('Validation failed'),
    401: UNAUTHORIZED,
    404: NOT_FOUND,
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/bookings/event-types',
  tags: ['Bookings'],
  security: KEY_ONLY,
  summary: 'List booking types',
  request: {
    query: z.object({
      location_id: uuidLike.optional(),
      active: z.enum(['true', 'false']).optional().describe('true = active booking types only'),
    }),
  },
  responses: { 200: { description: 'Booking type rows' }, 401: UNAUTHORIZED },
})

registry.registerPath({
  method: 'post',
  path: '/api/bookings/event-types',
  tags: ['Bookings'],
  security: KEY_OR_SESSION,
  summary: 'Create a booking type',
  description: 'The slug is derived from the name when not given.',
  request: { body: json(EventTypeCreate) },
  responses: {
    200: { description: 'Booking type created' },
    400: err('Validation failed, or location_id missing'),
    401: UNAUTHORIZED,
    403: err('location_id is not in your organisation (key) or not one of your studios (session)'),
    409: err('The slug is already in use'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/bookings/event-types/{id}',
  tags: ['Bookings'],
  security: KEY_OR_SESSION,
  summary: 'Get a booking type with its bookings count',
  request: { params: idParams },
  responses: { 200: { description: 'The booking type' }, 401: UNAUTHORIZED, 404: NOT_FOUND },
})

registry.registerPath({
  method: 'put',
  path: '/api/bookings/event-types/{id}',
  tags: ['Bookings'],
  security: KEY_OR_SESSION,
  summary: 'Update a booking type',
  description: 'location_id cannot be changed.',
  request: { params: idParams, body: json(EventTypeUpdate) },
  responses: {
    200: { description: 'Booking type updated' },
    400: err('Validation failed'),
    401: UNAUTHORIZED,
    404: NOT_FOUND,
    409: err('The slug is already in use'),
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/bookings/event-types/{id}',
  tags: ['Bookings'],
  security: KEY_OR_SESSION,
  summary: 'Deactivate a booking type (soft delete)',
  request: { params: idParams },
  responses: { 200: { description: 'Booking type deactivated' }, 401: UNAUTHORIZED, 404: NOT_FOUND },
})

// ============================================================================
// Email campaigns
// ============================================================================
const abFields = {
  ab_subject_b: z.string().min(1).max(500).nullable().optional()
    .openapi({ description: 'Variant-B subject line; setting this enables the A/B test (subject is variant A)' }),
  ab_test_pct: z.number().int().min(5).max(50).nullable().optional()
    .openapi({ description: 'Percent of the audience in the test slice (default 10)' }),
  ab_wait_hours: z.number().int().min(1).max(24).nullable().optional()
    .openapi({ description: 'Hours to wait before auto-picking the winner by open rate (default 4)' }),
}

const CampaignCreate = z.object({
  location_id: uuidLike,
  name: z.string().min(1).max(200),
  subject: z.string().max(500).optional(),
  preview_text: z.string().max(500).nullable().optional(),
  from_name: z.string().max(100).nullable().optional(),
  from_email: email.nullable().optional(),
  reply_to: email.nullable().optional(),
  design_json: z.unknown().nullable().optional(),
  html_content: z.string().max(1_000_000).nullable().optional(),
  audience_filter: audienceFilterSchema,
  template_id: uuidLike.nullable().optional(),
  ...abFields,
}).openapi('CampaignCreate')

const CampaignUpdate = z.object({
  name: z.string().min(1).max(200).optional(),
  subject: z.string().max(500).optional(),
  preview_text: z.string().max(500).nullable().optional(),
  from_name: z.string().max(100).nullable().optional(),
  from_email: email.nullable().optional(),
  reply_to: email.nullable().optional(),
  design_json: z.unknown().nullable().optional(),
  html_content: z.string().max(1_000_000).nullable().optional(),
  audience_filter: audienceFilterSchema,
  scheduled_at: z.string().datetime().nullable().optional(),
  template_id: uuidLike.nullable().optional(),
  status: z.enum(['draft', 'scheduled']).optional()
    .describe('Only the editable states; sending, sent and cancelled belong to the send path.'),
  email_type: z.enum(['marketing', 'utility']).optional(),
  ...abFields,
}).openapi('CampaignUpdate')

const FROM_ADDRESS_NOTE = 'Any valid from_email is stored as given, but it is SENT only when its domain equals the organisation\'s verified sending domain (exact, case-insensitive; a subdomain does not match); otherwise the email goes out from the resolved sender. When the body carries a from_email the response adds from_address: { requested, sends_as, on_verified_domain, verified_domain }.'

registry.registerPath({
  method: 'get',
  path: '/api/campaigns',
  tags: ['Marketing'],
  security: KEY_ONLY,
  summary: 'List email campaigns',
  request: {
    query: z.object({
      location_id: uuidLike.optional(),
      status: z.string().optional(),
    }),
  },
  responses: { 200: { description: 'Campaign rows' }, 401: UNAUTHORIZED },
})

registry.registerPath({
  method: 'post',
  path: '/api/campaigns',
  tags: ['Marketing'],
  security: KEY_ONLY,
  summary: 'Create an email campaign (draft)',
  description: `Sending is a signed-in action and is not part of this API. ${FROM_ADDRESS_NOTE}`,
  request: { body: json(CampaignCreate) },
  responses: {
    200: { description: 'Campaign created' },
    400: err('Validation failed, or an invalid audience filter'),
    401: UNAUTHORIZED,
    403: err('location_id is not in your organisation'),
    404: err('template_id is not in your organisation'),
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/campaigns/{id}',
  tags: ['Marketing'],
  security: KEY_ONLY,
  summary: 'Get a campaign with its metrics',
  request: { params: idParams },
  responses: { 200: { description: 'The campaign' }, 401: UNAUTHORIZED, 404: NOT_FOUND },
})

registry.registerPath({
  method: 'put',
  path: '/api/campaigns/{id}',
  tags: ['Marketing'],
  security: KEY_ONLY,
  summary: 'Update a campaign (drafts and scheduled campaigns only)',
  description: FROM_ADDRESS_NOTE,
  request: { params: idParams, body: json(CampaignUpdate) },
  responses: {
    200: { description: 'Campaign updated' },
    400: err('Validation failed, or an invalid audience filter'),
    401: UNAUTHORIZED,
    404: NOT_FOUND,
    409: err('The campaign is no longer editable'),
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/campaigns/{id}',
  tags: ['Marketing'],
  security: KEY_ONLY,
  summary: 'Delete a campaign while it is still a plan',
  request: { params: idParams },
  responses: {
    200: { description: 'Campaign deleted' },
    401: UNAUTHORIZED,
    404: NOT_FOUND,
    409: err('The campaign has started sending (or has sent) and cannot be deleted'),
  },
})

// ============================================================================
// Locations
// ============================================================================
const IntegrationsUpdate = z.object({
  glofox: z.unknown().nullable().optional(),
  webhooks: z.unknown().nullable().optional(),
}).openapi('IntegrationsUpdate', {
  description: 'A secret-named key sent back masked (or blank) keeps the stored value.',
})

registry.registerPath({
  method: 'get',
  path: '/api/locations',
  tags: ['Locations'],
  security: KEY_ONLY,
  summary: 'List your organisation\'s active studios',
  responses: {
    200: { description: 'id, name, slug, address, active, timezone, country per studio' },
    401: UNAUTHORIZED,
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/locations/{id}/integrations',
  tags: ['Locations'],
  security: KEY_ONLY,
  summary: 'Get a studio\'s integration settings (Glofox, webhooks)',
  request: { params: idParams },
  responses: {
    200: { description: '{ location_id, location_name, location_slug, glofox, webhooks }' },
    401: UNAUTHORIZED,
    404: NOT_FOUND,
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/locations/{id}/integrations',
  tags: ['Locations'],
  security: KEY_ONLY,
  summary: 'Update a studio\'s integration settings',
  request: { params: idParams, body: json(IntegrationsUpdate) },
  responses: {
    200: { description: '{ id, name, slug, settings: { glofox, webhooks } }, secret-named keys masked' },
    400: err('Validation failed'),
    401: UNAUTHORIZED,
    404: NOT_FOUND,
  },
})

// ============================================================================
// Spec generator — build once and cache
// ============================================================================
function buildSpec() {
  const generator = new OpenApiGeneratorV31(registry.definitions)
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      // CHROME.1 — platform chrome. This spec documents the PLATFORM's HTTP
      // API to integrators; it names no gym and must not carry a tenant's
      // brand.
      title: 'Repset CRM API',
      version: '2.0.0',
      description:
        'The integration API of the Repset gym CRM: the routes that accept a ' +
        'per-organization `unitk_…` API key (Bearer), scoped to the key\'s organization. ' +
        'Some also accept a signed-in session cookie. Mutating endpoints validate request ' +
        'bodies with Zod; invalid input returns 400 with a structured `issues` array.',
    },
    servers: [
      // REPSET-P6.S2 — canonical host leads; legacy host stays listed so
      // existing integrations pointed at it keep a documented base URL.
      { url: 'https://crm.repset.ie', description: 'Production' },
      { url: 'https://crm.un1tdublin.com', description: 'Production (legacy host)' },
      { url: 'http://localhost:3000', description: 'Local dev' },
    ],
  })
}

// Two layers of caching:
//   1. `cachedSpec` (module-level) — fastest path, hits within the same
//      lambda instance. Never expires.
//   2. `unstable_cache` — Next.js's data cache, shared across lambda
//      instances and surviving cold starts. 24h TTL since the spec only
//      changes on deploy (deploys clear the data cache anyway).
// unstable_cache only works inside Next.js's request runtime; from Vitest it
// throws, and getOpenApiSpec falls back to a direct build.
let cachedSpec = null

const buildSpecCached = unstable_cache(
  async () => buildSpec(),
  ['openapi-spec'],
  { revalidate: 60 * 60 * 24, tags: ['openapi-spec'] }
)

/**
 * Build (and cache) the OpenAPI 3.1 spec object for the CRM API.
 * Returns a plain JSON-serialisable object. Safe to stringify.
 */
export async function getOpenApiSpec() {
  if (cachedSpec) return cachedSpec
  try {
    cachedSpec = await buildSpecCached()
  } catch {
    // No Next.js runtime (e.g. Vitest) — build directly. Module-level
    // cache still keeps subsequent calls fast.
    cachedSpec = buildSpec()
  }
  return cachedSpec
}
