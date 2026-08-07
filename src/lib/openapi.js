// OpenAPI 3.1 spec generator for the UN1T CRM HTTP API.
//
// We use @asteasolutions/zod-to-openapi to derive request/response schemas
// directly from the Zod schemas in src/lib/schemas.js. The single source of
// truth is the schema — no hand-written JSON to drift out of sync.
//
// The spec is exposed at /api/openapi.json (Bearer-token gated). Point any
// Swagger UI / Redoc / Stoplight Studio at it.

import { z } from 'zod'
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi'
import {
  uuidLike, isoDate, timeOfDay, email, phone,
  money, hours, days,
  roleSchema, employmentTypeSchema,
  leadSourceSchema, dealStatusSchema,
  timeOffTypeSchema, timeOffStatusSchema, swapStatusSchema,
  reportFrequencySchema, reportTypeSchema,
  permissionsSchema, audienceFilterSchema,
  passwordSchema, tenantDomainBrandConfigSchema,
  ccfEnquirySchema,
} from './schemas.js'
import { LeadSchema } from './leads.js'
import { MAX_STORED_EXAMPLE_CHARS, MAX_STORED_EXAMPLES } from '@/lib/hyrox/constants'

// Wire .openapi() onto Zod so we can decorate inline-defined schemas.
extendZodWithOpenApi(z)

const registry = new OpenAPIRegistry()

// ============================================================================
// Common error response shape — every route returns this on failure.
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

// ============================================================================
// Resource schemas (request bodies + DB row shapes)
// ============================================================================

const ContactCreate = z.object({
  name: z.string().min(1).max(200),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  email,
  phone: phone.optional().nullable(),
  label: z.string().max(100).nullable().optional(),
  glofox_member_id: z.string().max(100).nullable().optional(),
  trial_credits_remaining: z.number().int().min(0).max(100).optional(),
  lead_source: leadSourceSchema.optional(),
  lead_created_at: z.string().datetime().optional(),
  location_id: uuidLike.optional(),
}).openapi('ContactCreate')

const ContactUpdate = ContactCreate.partial().openapi('ContactUpdate')

const Contact = z.object({
  id: uuidLike,
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  lead_source: leadSourceSchema.nullable(),
  pipeline_stage_slug: z.string().nullable(),
  location_id: uuidLike.nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).openapi('Contact')

const DealCreate = z.object({
  title: z.string().min(1).max(200),
  contact_id: uuidLike,
  stage_id: uuidLike.optional(),
  stage_slug: z.string().max(100).optional(),
  status: dealStatusSchema.optional(),
  value: z.number().finite().min(0).max(10_000_000).optional(),
  location_id: uuidLike.optional(),
}).openapi('DealCreate')

const DealUpdate = z.object({
  title: z.string().min(1).max(200).optional(),
  status: dealStatusSchema.optional(),
  value: z.number().finite().min(0).max(10_000_000).optional(),
  stage_id: uuidLike.optional(),
  stage_slug: z.string().max(100).optional(),
}).openapi('DealUpdate')

const BookingCreate = z.object({
  event_type_id: uuidLike,
  booking_date: isoDate,
  start_time: timeOfDay,
  customer_name: z.string().min(1).max(200),
  customer_email: email,
  customer_phone: z.string().max(50).nullable().optional(),
  custom_responses: z.record(z.string(), z.unknown()).optional(),
  source: z.string().max(50).optional(),
}).openapi('BookingCreate')

const StaffCreate = z.object({
  email,
  full_name: z.string().min(1).max(200),
  // Password rules mirror Supabase Auth's project settings: 8+ chars,
  // at least one each of lower, upper, digit, symbol. See passwordSchema
  // in src/lib/schemas.js for the canonical definition.
  password: passwordSchema,
  role: roleSchema.optional(),
  permissions: permissionsSchema.optional(),
  location_ids: z.array(uuidLike).optional(),
  employment_type: employmentTypeSchema.optional(),
  annual_salary: money.nullable().optional(),
  hourly_rate: money.nullable().optional(),
  contracted_hours_per_week: hours.nullable().optional(),
  annual_leave_entitlement: days.nullable().optional(),
  overtime_rate: money.nullable().optional(),
}).openapi('StaffCreate')

const StaffUpdate = StaffCreate.partial().omit({ email: true, password: true })
  .extend({ active: z.boolean().optional() })
  .openapi('StaffUpdate')

const TimeOffRequest = z.object({
  type: timeOffTypeSchema,
  start_date: isoDate,
  end_date: isoDate,
  reason: z.string().max(2000).nullable().optional(),
  location_id: uuidLike.optional(),
}).openapi('TimeOffRequest')

const TimeOffReview = z.object({
  status: timeOffStatusSchema,
  review_note: z.string().max(2000).nullable().optional(),
}).openapi('TimeOffReview')

const SwapCreate = z.object({
  requester_shift_id: uuidLike,
  target_shift_id: uuidLike.nullable().optional(),
  target_id: uuidLike.nullable().optional(),
  reason: z.string().max(2000).nullable().optional(),
}).openapi('SwapCreate')

const SwapReview = z.object({
  status: swapStatusSchema,
  review_note: z.string().max(2000).nullable().optional(),
}).openapi('SwapReview')

const CampaignCreate = z.object({
  location_id: uuidLike,
  name: z.string().min(1).max(200),
  subject: z.string().max(500).optional(),
  preview_text: z.string().max(500).nullable().optional(),
  from_name: z.string().max(100).nullable().optional(),
  from_email: email.nullable().optional(),
  reply_to: email.nullable().optional(),
  html_content: z.string().max(1_000_000).nullable().optional(),
  audience_filter: audienceFilterSchema,
  template_id: uuidLike.nullable().optional(),
  // CAMPAIGN-AB (mig 398) — optional subject-line A/B test.
  ab_subject_b: z.string().min(1).max(500).nullable().optional()
    .openapi({ description: 'Variant-B subject line; setting this enables the A/B test (subject is variant A)' }),
  ab_test_pct: z.number().int().min(5).max(50).nullable().optional()
    .openapi({ description: 'Percent of the audience in the test slice (default 10)' }),
  ab_wait_hours: z.number().int().min(1).max(24).nullable().optional()
    .openapi({ description: 'Hours to wait before auto-picking the winner by open rate (default 4)' }),
}).openapi('CampaignCreate')

const ScheduledReport = z.object({
  location_id: uuidLike.optional(),
  report_type: reportTypeSchema,
  report_name: z.string().min(1).max(200),
  frequency: reportFrequencySchema,
  day_of_week: z.number().int().min(0).max(6).nullable().optional(),
  day_of_month: z.number().int().min(1).max(31).nullable().optional(),
  deliver_email: z.boolean().optional(),
  email_recipients: z.array(email).optional(),
  deliver_notification: z.boolean().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
}).openapi('ScheduledReport')

// ============================================================================
// Auth schemes
// ============================================================================
registry.registerComponent('securitySchemes', 'BearerAuth', {
  type: 'http',
  scheme: 'bearer',
  description:
    'API key for n8n / external integrations, sent as `Authorization: Bearer <token>`. ' +
    'Two kinds are accepted (SAAS-3): a per-organization key (`unitk_…`, issued at ' +
    '/settings/api-keys) whose queries are scoped to the key\'s organization, or the ' +
    'legacy shared CRM_API_KEY (unscoped, system-admin behaviour).',
})
registry.registerComponent('securitySchemes', 'CookieAuth', {
  type: 'apiKey',
  in: 'cookie',
  name: 'sb-access-token',
  description: 'Supabase session cookie set after browser login.',
})
registry.registerComponent('securitySchemes', 'GlofoxHmac', {
  type: 'apiKey', in: 'header', name: 'X-Glofox-Signature',
  description: 'HMAC-SHA256 of the raw body, keyed by the per-location webhook secret. Verified in src/lib/glofox.js verifyGlofoxSignature.',
})
registry.registerComponent('securitySchemes', 'MetaSignature', {
  type: 'apiKey', in: 'header', name: 'X-Hub-Signature-256',
  description: 'Meta webhook signature. GET handshake echoes hub.challenge; POST carries X-Hub-Signature-256 over the raw body.',
})
registry.registerComponent('securitySchemes', 'WebhookToken', {
  type: 'apiKey', in: 'header', name: 'X-Webhook-Token',
  description: 'Shared-secret / signature header. Postmark, UniFi and InBody use `X-Webhook-Token`; Twilio uses `X-Twilio-Signature`; Revolut uses `Revolut-Signature`; Xero uses `X-Xero-Signature`. Tokenised receivers (`invoices-inbound`, `sequence`) instead authenticate via the path token.',
})
registry.registerComponent('securitySchemes', 'BridgeAuth', {
  type: 'http', scheme: 'bearer',
  description: 'Per-bridge device token. Verified in src/lib/bridge-auth.js verifyBridgeToken.',
})

// ============================================================================
// Path registrations — high-traffic / external-facing routes
// ============================================================================

// Public booking
registry.registerPath({
  method: 'post',
  path: '/api/public/book',
  tags: ['Public'],
  summary: 'Create a booking from the public booking widget',
  description: 'No auth required. Rate-limited to 5 requests per IP per 15 minutes.',
  request: { body: { content: { 'application/json': { schema: BookingCreate } } } },
  responses: {
    200: { description: 'Booking confirmed' },
    400: { description: 'Validation failed', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Slot no longer available', content: { 'application/json': { schema: ErrorResponse } } },
    429: { description: 'Rate limited', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// ============================================================================
// Public surface — anonymous, no security
// ============================================================================

registry.registerPath({
  method: 'post',
  path: '/api/public/leads',
  tags: ['Public'],
  summary: 'Public waitlist / lead capture',
  description: 'Anonymous. Rate-limited to 8 requests per IP per 15 min. Studio resolved server-side from publicPath — caller cannot target an arbitrary location.',
  // Re-derive via .extend({}) so the .openapi() decorator is present: LeadSchema
  // is constructed in leads.js BEFORE extendZodWithOpenApi(z) runs here, so the
  // raw export lacks .openapi (zod v4 adds it per-instance at construction time).
  // .extend({}) yields an identical schema built under the extended z. leads.js untouched.
  request: { body: { content: { 'application/json': { schema: LeadSchema.extend({}).openapi('LeadCapture') } } } },
  responses: {
    200: { description: 'Lead captured' },
    400: { description: 'Validation failed or studio not accepting sign-ups', content: { 'application/json': { schema: ErrorResponse } } },
    429: { description: 'Rate limited', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/public/ccf-enquiry',
  tags: ['Public'],
  summary: 'CCF Autos coming-soon page enquiry capture',
  description: 'Anonymous. Rate-limited to 5 requests per IP per 15 min. Inserts into car_enquiries (CCF-WEB.1).',
  // Same .extend({}) trick as LeadSchema above: ccfEnquirySchema is built in
  // schemas.js before extendZodWithOpenApi(z) runs here.
  request: { body: { content: { 'application/json': { schema: ccfEnquirySchema.extend({}).openapi('CcfEnquiry') } } } },
  responses: {
    200: { description: 'Enquiry captured' },
    400: { description: 'Validation failed', content: { 'application/json': { schema: ErrorResponse } } },
    429: { description: 'Rate limited', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/public/branding',
  tags: ['Public'],
  summary: 'Branding config for a location by publicPath',
  description: 'Anonymous. Returns company_settings branding for the location resolved from the publicPath query param.',
  request: { query: z.object({ publicPath: z.string().optional() }) },
  responses: {
    200: { description: 'Branding config', content: { 'application/json': { schema: z.object({}).passthrough().openapi('BrandingResponse') } } },
    404: { description: 'Location not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/public/bookings/{slug}',
  tags: ['Public'],
  summary: 'Booking page config for a slug',
  request: { params: z.object({ slug: z.string() }) },
  responses: {
    200: { description: 'Booking page config', content: { 'application/json': { schema: z.object({}).passthrough().openapi('BookingPageConfig') } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/public/bookings/{slug}/slots',
  tags: ['Public'],
  summary: 'Available slots for a booking page',
  request: {
    params: z.object({ slug: z.string() }),
    query: z.object({ date: isoDate.optional() }),
  },
  responses: {
    200: { description: 'Available slots', content: { 'application/json': { schema: z.object({}).passthrough().openapi('BookingSlotsResponse') } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/public/challenges/{locationId}',
  tags: ['Public'],
  summary: 'Public challenge board for a location',
  request: { params: z.object({ locationId: uuidLike }) },
  responses: {
    200: { description: 'Challenge board', content: { 'application/json': { schema: z.object({}).passthrough().openapi('PublicChallengesResponse') } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/public/events/{slug}',
  tags: ['Public'],
  summary: 'Event detail for a public event slug',
  request: { params: z.object({ slug: z.string() }) },
  responses: {
    200: { description: 'Event detail', content: { 'application/json': { schema: z.object({}).passthrough().openapi('PublicEventDetail') } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/public/events/{slug}/register',
  tags: ['Public'],
  summary: 'Event signup — name, email, phone (+ team fields)',
  request: {
    params: z.object({ slug: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).max(200),
            email: email,
            phone: z.string().max(50).optional(),
            team_name: z.string().max(200).optional(),
          }).openapi('EventRegisterBody'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Registration confirmed' },
    400: { description: 'Validation failed or registration closed', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Event not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/public/events/{slug}/check-member',
  tags: ['Public'],
  summary: 'Membership check before registering for an event',
  request: {
    params: z.object({ slug: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({ email: email }).openapi('EventCheckMemberBody'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Membership status', content: { 'application/json': { schema: z.object({}).passthrough().openapi('EventCheckMemberResponse') } } },
    404: { description: 'Event not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/public/events/{slug}/display',
  tags: ['Public'],
  summary: 'Public display feed for an event (TV / kiosk)',
  request: { params: z.object({ slug: z.string() }) },
  responses: {
    200: { description: 'Display feed', content: { 'application/json': { schema: z.object({}).passthrough().openapi('EventDisplayFeed') } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/public/events/checkin-qr',
  tags: ['Public'],
  summary: 'QR payload/image for event check-in; query = signed token',
  request: { query: z.object({ token: z.string() }) },
  responses: {
    200: { description: 'QR payload or image' },
    400: { description: 'Invalid or expired token', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/public/event-payments/{id}',
  tags: ['Public'],
  summary: 'Payment status for an event payment',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Payment status', content: { 'application/json': { schema: z.object({}).passthrough().openapi('EventPaymentStatus') } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/public/event-registrations/{id}',
  tags: ['Public'],
  summary: 'Registration status for an event registration',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Registration status', content: { 'application/json': { schema: z.object({}).passthrough().openapi('EventRegistrationStatus') } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/public/races/{slug}/register',
  tags: ['Public'],
  summary: 'Race signup',
  request: {
    params: z.object({ slug: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({}).passthrough().openapi('RaceRegisterBody'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Registration confirmed' },
    400: { description: 'Validation failed or registration closed', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Race not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/public/deposit/{token}',
  tags: ['Public'],
  summary: 'Deposit request detail by token',
  request: { params: z.object({ token: z.string() }) },
  responses: {
    200: { description: 'Deposit request detail', content: { 'application/json': { schema: z.object({}).passthrough().openapi('DepositRequestDetail') } } },
    404: { description: 'Not found or expired', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/public/deposit/{token}/accept-and-pay',
  tags: ['Public'],
  summary: 'Accept and pay a deposit request',
  request: {
    params: z.object({ token: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({}).passthrough().openapi('DepositAcceptBody'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Payment initiated or confirmed' },
    400: { description: 'Validation failed or deposit already paid', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found or expired', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/public/live/{locationId}',
  tags: ['Public'],
  summary: 'Public live / TV state feed for a location',
  request: { params: z.object({ locationId: uuidLike }) },
  responses: {
    200: { description: 'Live state', content: { 'application/json': { schema: z.object({}).passthrough().openapi('PublicLiveState') } } },
    404: { description: 'Location not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/public/tv/{token}/content',
  tags: ['Public'],
  summary: 'TV content for a paired display',
  request: { params: z.object({ token: z.string() }) },
  responses: {
    200: { description: 'TV content', content: { 'application/json': { schema: z.object({}).passthrough().openapi('TvContent') } } },
    404: { description: 'Token not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/public/presentations/{token}/state',
  tags: ['Public'],
  summary: 'Slideshow state for a presenter token',
  request: { params: z.object({ token: z.string() }) },
  responses: {
    200: { description: 'Presentation state', content: { 'application/json': { schema: z.object({}).passthrough().openapi('PresentationState') } } },
    404: { description: 'Token not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/public/bca/{token}/merged',
  tags: ['Public'],
  summary: 'Merged BCA document by token',
  request: { params: z.object({ token: z.string() }) },
  responses: {
    200: { description: 'Merged BCA doc' },
    404: { description: 'Token not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/public/bca/{token}/file/{slug}',
  tags: ['Public'],
  summary: 'BCA file by token and slug',
  request: { params: z.object({ token: z.string(), slug: z.string() }) },
  responses: {
    200: { description: 'BCA file' },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// ============================================================================
// Webhooks (Inbound) — provider-auth, externally-owned payloads
// ============================================================================

const GlofoxEvent = z.object({}).passthrough().openapi('GlofoxWebhookEvent', {
  description: 'Glofox booking/membership/member/access event. branchId resolves the location; event_id dedupes retried deliveries.',
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/glofox',
  tags: ['Webhooks (Inbound)'],
  security: [{ GlofoxHmac: [] }],
  summary: 'Inbound Glofox events',
  description: 'Glofox → CRM. HMAC-SHA256 verified against the per-location webhook secret (resolved by branchId). Idempotent via glofox_webhook_events.event_id.',
  request: { body: { content: { 'application/json': { schema: GlofoxEvent } } } },
  responses: {
    200: { description: 'Accepted (and processed unless dark-launched)' },
    401: { description: 'Bad / missing signature', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/postmark',
  tags: ['Webhooks (Inbound)'],
  security: [{ WebhookToken: [] }],
  summary: 'Postmark delivery/bounce/open events',
  description: 'Postmark → CRM. Payload is a Postmark delivery/bounce/open/spam event.',
  request: { body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('PostmarkWebhookEvent') } } } },
  responses: {
    200: { description: 'Accepted' },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/qstash/postmark',
  tags: ['Webhooks (Inbound)'],
  security: [{ WebhookToken: [] }],
  summary: 'QStash push-delivery worker for the Postmark webhook queue',
  description:
    'QStash → CRM. Delivers `{ id }` of a postmark_webhook_queue row published by /api/webhooks/postmark; ' +
    'verified via the Upstash-Signature HS256 JWT (current + next signing keys). Processes through the same ' +
    'claim CAS as the drain cron — 200 processed/skipped, 500 asks QStash to retry.',
  request: { body: { content: { 'application/json': { schema: z.object({ id: z.number().int() }).openapi('QstashPostmarkQueueMessage') } } } },
  responses: {
    200: { description: 'Processed, or skipped (row already handled)' },
    401: { description: 'Bad / missing Upstash signature', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Processing failed — QStash should retry', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/qstash/webhook-replay',
  tags: ['Webhooks (Inbound)'],
  security: [{ WebhookToken: [] }],
  summary: 'QStash push-delivery worker for webhook dead-letter replays',
  description:
    'QStash → CRM. Delivers `{ id }` of a webhook_dead_letter row published by deadLetterWebhook() (60s delay); ' +
    'verified via the Upstash-Signature HS256 JWT (current + next signing keys). Replays through the same ' +
    'claim CAS as the /api/cron/webhook-replay sweeper — 200 processed/skipped, 500 asks QStash to retry.',
  request: { body: { content: { 'application/json': { schema: z.object({ id: z.number().int() }).openapi('QstashWebhookReplayMessage') } } } },
  responses: {
    200: { description: 'Replayed, or skipped (row already handled / not eligible)' },
    401: { description: 'Bad / missing Upstash signature', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Replay failed — QStash should retry', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/qstash/contact-imports',
  tags: ['Webhooks (Inbound)'],
  security: [{ WebhookToken: [] }],
  summary: 'QStash push-delivery worker for the contact-imports queue',
  description:
    'QStash → CRM. Delivers `{ id }` of a contact_imports row published by the async path of /api/contacts/import/commit; ' +
    'verified via the Upstash-Signature HS256 JWT (current + next signing keys). Runs the import through the same ' +
    'claim CAS as the /api/cron/process-contact-imports sweeper — 200 processed/skipped, 500 = the import failed ' +
    '(row stamped failed for the operator; retries re-fetch and skip).',
  request: { body: { content: { 'application/json': { schema: z.object({ id: uuidLike }).openapi('QstashContactImportsMessage') } } } },
  responses: {
    200: { description: 'Import processed, or skipped (row already claimed / handled)' },
    401: { description: 'Bad / missing Upstash signature', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Import failed — row stamped failed with its error_message', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/qstash/invoice-analysis',
  tags: ['Webhooks (Inbound)'],
  security: [{ WebhookToken: [] }],
  summary: 'QStash push-delivery worker for the bulk invoice-analysis queue',
  description:
    'QStash → CRM. Delivers `{ id }` of an invoices_queue row published by /api/invoices-inbox/bulk-queue-analysis ' +
    'onto the `invoice-analysis` QStash queue (parallelism 2 — bounded Claude Vision OCR concurrency); verified via ' +
    'the Upstash-Signature HS256 JWT (current + next signing keys). Claims by id with the same semantics as the ' +
    '/api/cron/process-invoice-analysis sweeper — 200 processed/skipped INCLUDING deterministic extraction failures ' +
    '(row stamped with its extraction_error and de-queued; the operator retries from the UI), 500 only for ' +
    'infrastructure errors where a QStash retry helps.',
  request: { body: { content: { 'application/json': { schema: z.object({ id: uuidLike }).openapi('QstashInvoiceAnalysisMessage') } } } },
  responses: {
    200: { description: 'Extraction ran (success or recorded failure), or skipped (row already claimed / handled)' },
    401: { description: 'Bad / missing Upstash signature', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Infrastructure error — QStash should retry', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/qstash/class-bookings',
  tags: ['Webhooks (Inbound)'],
  security: [{ WebhookToken: [] }],
  summary: 'QStash push-delivery worker for the class-booking queue',
  description:
    'QStash → CRM. Delivers `{ id }` of a class_booking_requests row published by /api/public/class-booking or the ' +
    'WhatsApp Flow completion handler; verified via the Upstash-Signature HS256 JWT (current + next signing keys). ' +
    'Runs the row through the same claim CAS as the /api/cron/process-class-bookings sweeper — 200 for every ' +
    'decision-tree outcome (booked / routed to review / terminally failed: the processor stamps the row itself, a ' +
    'retry cannot improve it) and for skips; 500 only when the processor throws (row re-queued under the attempt ' +
    'cap, so the QStash retry re-runs it).',
  request: { body: { content: { 'application/json': { schema: z.object({ id: uuidLike }).openapi('QstashClassBookingsMessage') } } } },
  responses: {
    200: { description: 'Booking request processed (row stamped by the decision tree), or skipped (row already claimed / handled)' },
    401: { description: 'Bad / missing Upstash signature', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Processor threw — row re-queued under the attempt cap; QStash should retry', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/qstash/host-campaigns',
  tags: ['Webhooks (Inbound)'],
  security: [{ WebhookToken: [] }],
  summary: 'QStash push-delivery worker for host campaign sends (campaign-level kick + chunk chaining)',
  description:
    'QStash → CRM. The first BULK job on the push pattern: delivers a campaign-level `{ campaignId, link }` — NOT a ' +
    'per-recipient `{ id }` — published once by POST /api/host/emails/[id]/send after the fan-out rows are enqueued; ' +
    'verified via the Upstash-Signature HS256 JWT (current + next signing keys). Each delivery processes ONE ≤50-row ' +
    'chunk through the same claim-before-send CAS as the /api/cron/send-host-campaigns sweeper, then self-chains the ' +
    'next kick (2s delay, no dedup id, ≤40 links per lineage) while pending rows remain. 200 for chunk_sent / drained / ' +
    'halted (kill switch — the campaign stays sending and resumes via the cron when re-verified) / skipped; 500 only ' +
    'for infrastructure errors (retry-safe: rows claimed by a crashed attempt are swept terminal by the cron, never re-sent).',
  request: { body: { content: { 'application/json': { schema: z.object({ campaignId: uuidLike, link: z.number().int().min(1).optional() }).openapi('QstashHostCampaignsMessage') } } } },
  responses: {
    200: { description: 'Chunk sent (chained or handed to the cron), campaign drained/halted, or skipped (campaign already terminal)' },
    401: { description: 'Bad / missing Upstash signature', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Infrastructure error — QStash should retry', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/qstash/strava-exports',
  tags: ['Webhooks (Inbound)'],
  security: [{ WebhookToken: [] }],
  summary: 'QStash push-delivery worker for external export jobs (Strava uploads)',
  description:
    'QStash → CRM. Delivers `{ id }` of an external_export_jobs row published per freshly-inserted job by ' +
    'enqueueExportsForSession (live-class endSession) onto the `strava-exports` QUEUE (parallelism 2 — each export ' +
    'burns 2–4 Strava API calls against the 100-req/15-min budget); verified via the Upstash-Signature HS256 JWT ' +
    '(current + next signing keys). Runs the row through the same per-job unit as the /api/cron/run-strava-exports ' +
    'sweeper. 200 for EVERY processed outcome INCLUDING failures — the bookkeeping already re-queued the job on the ' +
    "queue's own backoff (or went terminal at the attempt cap), and the claim is not a CAS, so retries belong to the " +
    'cron; 500 only for infrastructure errors (row fetch).',
  request: { body: { content: { 'application/json': { schema: z.object({ id: uuidLike }).openapi('QstashStravaExportsMessage') } } } },
  responses: {
    200: { description: 'Export uploaded, job terminally skipped, delivery skipped (row not queued/due), or failed with bookkeeping done (cron owns the retry)' },
    401: { description: 'Bad / missing Upstash signature', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Infrastructure error — QStash should retry', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/qstash/zoom-contacts',
  tags: ['Webhooks (Inbound)'],
  security: [{ WebhookToken: [] }],
  summary: 'QStash push-delivery worker applying one Zoom Phone external-contact write',
  description:
    'QStash → CRM. Delivers a single `{ op, e164, … }` job published by the /api/cron/zoom-contact-sync reconcile ' +
    'onto the `zoom-contacts` QUEUE (parallelism 2 — deliberate pacing; Zoom allows 30/sec on Pro), verified via the ' +
    'Upstash-Signature HS256 JWT (current + next signing keys). Applies exactly ONE create / update / delete against ' +
    "Zoom's /phone/external_contacts, because Zoom has no batch endpoint. Every write is idempotent: a 409 duplicate " +
    'on create and a 404 on delete both count as success, so an overlapping run or a redelivery is harmless. ' +
    '400 for a malformed or unknown-op job (retrying can never help); 500 on a Zoom-side failure so QStash retries.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            op: z.enum(['create', 'update', 'delete']),
            e164: z.string().optional(),
            name: z.string().optional(),
            contactId: z.string().optional(),
            zoomId: z.string().optional(),
          }).openapi('QstashZoomContactsMessage'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Write applied (including the idempotent 409-duplicate and 404-already-gone cases)' },
    400: { description: 'Malformed JSON or unknown op — not retryable', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Bad / missing Upstash signature', content: { 'application/json': { schema: ErrorResponse } } },
    503: { description: 'Our own QStash signing keys are unset', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Zoom-side failure — QStash should retry', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/qstash/receipt-hunts',
  tags: ['Webhooks (Inbound)'],
  security: [{ WebhookToken: [] }],
  summary: 'QStash push-delivery worker for the receipt-hunt queue',
  description:
    'QStash → CRM. Delivers `{ id }` of a recon_bank_lines row published per seeded row by seedHunts (the Friday ' +
    'receipt-coverage-weekly cron, capped per seed) onto the `receipt-hunts` QUEUE (**parallelism 1** — a hunt opens ' +
    'IMAP sessions + burns a Claude Vision call per candidate, and hunting is deliberately strictly sequential); ' +
    'verified via the Upstash-Signature HS256 JWT (current + next signing keys). Claims via a by-id CAS mirroring the ' +
    'claim_recon_hunt_batch RPC predicate, then runs the same huntLine unit as the /api/cron/process-receipt-hunts ' +
    'sweeper. 200 for EVERY hunt outcome INCLUDING errors — huntLine never throws and its errorFinish already recorded ' +
    'a terminal audit row and de-queued the line (the cron never retries these either); 500 only for infrastructure ' +
    'errors (row fetch). The weekly finalizer (report email + weekly heartbeat) stays CRON-ONLY — this worker never ' +
    'calls it and stamps no heartbeat.',
  request: { body: { content: { 'application/json': { schema: z.object({ id: uuidLike }).openapi('QstashReceiptHuntsMessage') } } } },
  responses: {
    200: { description: 'Line hunted (found / not_found / terminal error, all with bookkeeping done) or delivery skipped (row not queued, or another consumer owns the claim)' },
    401: { description: 'Bad / missing Upstash signature', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Infrastructure error — QStash should retry', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/inbody',
  tags: ['Webhooks (Inbound)'],
  security: [{ WebhookToken: [] }],
  summary: 'InBody body-scan results',
  description: 'InBody → CRM. Carries a body composition scan result. Auth verified via shared token.',
  request: { body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('InBodyWebhookEvent') } } } },
  responses: {
    200: { description: 'Accepted' },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/webhooks/instagram',
  tags: ['Webhooks (Inbound)'],
  security: [],
  summary: 'Instagram webhook verification handshake',
  description: 'Meta verification handshake: echoes `hub.challenge` when `hub.verify_token` matches. POST carries the signed payload.',
  responses: {
    200: { description: 'Challenge echoed' },
    403: { description: 'Verify token mismatch' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/instagram',
  tags: ['Webhooks (Inbound)'],
  security: [{ MetaSignature: [] }],
  summary: 'Instagram DM/comment events',
  description: 'Meta → CRM. X-Hub-Signature-256 verified. Carries Instagram DM or comment events.',
  request: { body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('InstagramWebhookEvent') } } } },
  responses: {
    200: { description: 'Accepted' },
    401: { description: 'Bad signature', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/webhooks/whatsapp',
  tags: ['Webhooks (Inbound)'],
  security: [],
  summary: 'WhatsApp webhook verification handshake',
  description: 'Meta verification handshake: echoes `hub.challenge` when `hub.verify_token` matches. POST carries the signed payload.',
  responses: {
    200: { description: 'Challenge echoed' },
    403: { description: 'Verify token mismatch' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/whatsapp',
  tags: ['Webhooks (Inbound)'],
  security: [{ MetaSignature: [] }],
  summary: 'WhatsApp message/status events',
  description: 'Meta → CRM. X-Hub-Signature-256 verified. Carries incoming WA messages and delivery status updates.',
  request: { body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('WhatsAppWebhookEvent') } } } },
  responses: {
    200: { description: 'Accepted' },
    401: { description: 'Bad signature', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/webhooks/strava',
  tags: ['Webhooks (Inbound)'],
  security: [],
  summary: 'Strava subscription validation',
  description: 'Strava subscription validation (echoes `hub.challenge`).',
  responses: {
    200: { description: 'Challenge echoed' },
    403: { description: 'Verify token mismatch' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/strava',
  tags: ['Webhooks (Inbound)'],
  security: [{ WebhookToken: [] }],
  summary: 'Strava activity events',
  description: 'Strava → CRM. Carries activity create/update/delete events.',
  request: { body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('StravaWebhookEvent') } } } },
  responses: {
    200: { description: 'Accepted' },
    401: { description: 'Verify-token mismatch', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/webhooks/xero',
  tags: ['Webhooks (Inbound)'],
  security: [],
  summary: 'Xero intent-to-receive verification',
  description: 'Xero intent-to-receive validation (200).',
  responses: {
    200: { description: 'OK' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/xero',
  tags: ['Webhooks (Inbound)'],
  security: [{ WebhookToken: [] }],
  summary: 'Xero accounting events',
  description: 'Xero → CRM. Carries accounting events (invoices, contacts, payments).',
  request: { body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('XeroWebhookEvent') } } } },
  responses: {
    200: { description: 'Accepted' },
    401: { description: 'Bad signature', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/webhooks/revolut',
  tags: ['Webhooks (Inbound)'],
  security: [],
  summary: 'Revolut webhook verification',
  description: 'Configuration ping (200).',
  responses: {
    200: { description: 'OK' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/revolut',
  tags: ['Webhooks (Inbound)'],
  security: [{ WebhookToken: [] }],
  summary: 'Revolut payment events',
  description: 'Revolut Merchant → CRM. Carries payment success/failure events.',
  request: { body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('RevolutWebhookEvent') } } } },
  responses: {
    200: { description: 'Accepted' },
    401: { description: 'Bad signature', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/webhooks/revolut/race-payments',
  tags: ['Webhooks (Inbound)'],
  security: [],
  summary: 'Revolut race-payments webhook verification',
  description: 'Configuration ping (200).',
  responses: {
    200: { description: 'OK' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/revolut/race-payments',
  tags: ['Webhooks (Inbound)'],
  security: [{ WebhookToken: [] }],
  summary: 'Revolut race deposit payment events',
  description: 'Revolut Merchant → CRM. Separate webhook endpoint for race deposit payment events.',
  request: { body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('RevolutRacePaymentEvent') } } } },
  responses: {
    200: { description: 'Accepted' },
    401: { description: 'Bad signature', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/twilio/status',
  tags: ['Webhooks (Inbound)'],
  security: [{ WebhookToken: [] }],
  summary: 'Twilio SMS delivery status',
  description: 'Twilio → CRM. Carries SMS delivery status callbacks (delivered/failed/undelivered).',
  request: { body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('TwilioStatusEvent') } } } },
  responses: {
    200: { description: 'Accepted' },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/invoices-inbound/{token}',
  tags: ['Webhooks (Inbound)'],
  security: [],
  summary: 'Tokenised inbound invoice email/forward',
  description: 'Inbound invoice receiver. Accepts email-forwarded invoices. Authenticated by the unguessable `{token}` path segment, not a header.',
  request: {
    params: z.object({ token: z.string() }),
    body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('InboundInvoiceEvent') } } },
  },
  responses: {
    200: { description: 'Accepted' },
    401: { description: 'Invalid token', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// EMAIL-INBOX.1 — inbound email → unified inbox (mig 394)
registry.registerPath({
  method: 'post',
  path: '/api/webhooks/postmark-inbound/{token}',
  tags: ['Webhooks (Inbound)'],
  security: [],
  summary: 'Tokenised Postmark inbound email (unified inbox)',
  description: 'Postmark inbound stream → CRM. Threads customer email replies into email_tickets (mig 482) — as of EMAIL-CONV-STOP.1 it no longer writes the deprecated email_conversations table. Authenticated by the unguessable `{token}` path segment (POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN), not a header.',
  request: {
    params: z.object({ token: z.string() }),
    body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('PostmarkInboundEmailEvent') } } },
  },
  responses: {
    200: { description: 'Accepted' },
    404: { description: 'Invalid token (404 by design — no URL-pattern oracle)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Email inbox conversations (cookie auth) — EMAIL-INBOX.1, now RETIRED.
//
// EMAIL-CONV-STOP.1 (2026-08-07): all four operations answer **410 Gone** and
// touch no data. Superseded by /api/email/tickets* (mig 482). The routes still
// exist only so installed mobile builds on frozen OTA lanes get an actionable
// error rather than a 404 they cannot tell apart from a network failure.
//
// The `email_inbox` gate from INBOX-PERM.2 is still in front of the 410 (it
// used to resolve the `em` channel against `whatsapp`, which let a
// WhatsApp-only staffer read and send the studio's email), so 401 and 403 are
// still reachable and an unauthenticated caller cannot enumerate.
const GoneOnly = {
  401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  403: { description: 'Missing the email_inbox permission', content: { 'application/json': { schema: ErrorResponse } } },
  410: { description: 'Gone — retired, use /api/email/tickets*', content: { 'application/json': { schema: ErrorResponse } } },
}

registry.registerPath({
  method: 'get',
  path: '/api/email/conversations',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'RETIRED — list email inbox conversations (410 Gone)',
  description: 'Retired by EMAIL-CONV-STOP.1. Was the operator inbox list for the email channel; now returns 410 Gone and reads nothing. Use GET /api/email/tickets.',
  request: {
    query: z.object({ location_id: uuidLike.optional() }),
  },
  responses: { ...GoneOnly },
})

registry.registerPath({
  method: 'get',
  path: '/api/email/conversations/{id}',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'RETIRED — email conversation + message thread (410 Gone)',
  description: 'Retired by EMAIL-CONV-STOP.1. Was the conversation and its recent messages (and reset unread_count); now returns 410 Gone and reads nothing. Use GET /api/email/tickets/{id}.',
  request: {
    params: z.object({ id: uuidLike }),
  },
  responses: { ...GoneOnly },
})

registry.registerPath({
  method: 'patch',
  path: '/api/email/conversations/{id}',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'RETIRED — resolve / reopen an email conversation (410 Gone)',
  description: 'Retired by EMAIL-CONV-STOP.1. Was the resolved_at stamp (UIX-P1 queue semantics); now returns 410 Gone and writes nothing. Use PATCH /api/email/tickets/{id}/status.',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({ resolved: z.boolean() }).openapi('EmailConversationPatch') } } },
  },
  responses: { ...GoneOnly },
})

registry.registerPath({
  method: 'post',
  path: '/api/email/conversations/{id}/send',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'RETIRED — reply to an email conversation (410 Gone)',
  description: 'Retired by EMAIL-CONV-STOP.1. Was a plain-text operator reply on Postmark’s transactional stream; now returns 410 Gone and never reaches Postmark. Use POST /api/email/tickets/{id}/reply.',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({ text: z.string().min(1).max(10000), subject: z.string().max(500).optional() }).openapi('EmailInboxReply') } } },
  },
  responses: { ...GoneOnly },
})

// Email tickets (cookie auth) — EMAIL-TICKET.4.
// TWO GATES on every route below: the `email_inbox` permission gates the
// surface (NOT the older `email` key, which gates marketing mail), and a row
// in email_mailbox_access gates each individual account. A ticket on a mailbox
// the caller cannot see is a 404, never a 403.
registry.registerPath({
  method: 'get',
  path: '/api/email/tickets',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'List email tickets + the caller’s visible mailboxes',
  description: 'The studio ticket queue at one location, plus the mailboxes this caller may see (already in tab order). Filtered to those mailboxes and capped at 200, newest activity first. No visible mailboxes = an empty list, not an error.',
  request: {
    query: z.object({
      location_id: uuidLike,
      mailbox_id: uuidLike.optional(),
      view: z.enum(['unassigned', 'mine', 'needs_reply', 'closed']).optional(),
    }),
  },
  responses: {
    200: { description: '{ mailboxes, tickets }' },
    400: { description: 'Missing location_id / unknown view', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Missing email_inbox permission or foreign location', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Mailbox visibility lookup failed — NOT an empty inbox', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// EMAIL-TICKET-CLEANUP.3 — the Email nav badge. Deliberately parameterless
// (location comes off the session), like every other badge count endpoint.
registry.registerPath({
  method: 'get',
  path: '/api/email/tickets/count',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Count email tickets awaiting a reply (nav badge)',
  description:
    'Tickets at the caller’s ACTIVE location, on a mailbox they may see, that are `open` with an inbound last message — i.e. mail nobody has answered yet. The same predicate as the list route’s `needs_reply` view, so the badge and that tab always agree. Not the whole live queue: nothing in this feature auto-closes, so counting tickets already waiting on the member would never come down. Returns count 0 (not an error) for a session without the permission or without an active location.',
  responses: {
    200: { description: '{ count }', content: { 'application/json': { schema: SuccessResponse(z.object({ count: z.number() })) } } },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Mailbox visibility or count query failed — NOT a zero', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/email/tickets/{id}',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Ticket + its message thread',
  description: 'Returns the ticket (with its mailbox and linked contact) and the thread oldest-first, text bodies only. EMAIL-CC.1: each message also carries to_emails, cc_emails and bcc_emails, and the payload carries reply_recipients = { to, mode: reply | reply_all } — who a reply would reach, derived by the same code the reply route sends with, or null when that could not be worked out. bcc_emails is STAFF-ONLY: this route is behind the ticket gate (location + email_inbox at that location + a grant on the ticket mailbox), it must never be rendered on a member-visible surface, and it is never an input to a later reply or forward. 404 — never 403 — when the ticket is missing, at a foreign location, or on a mailbox the caller cannot see. Does NOT mark it read; that is POST /read. EMAIL-DELIVERY.1: each OUTBOUND message also carries delivery_status (null | delivered | bounced | complained), delivery_status_at, delivery_detail and delivery_bounce_type (hard | soft | transient). NULL means sent with no provider event yet — it is NOT a failure and must never render as one.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: '{ ticket, messages }' },
    404: { description: 'Not found / not accessible', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/email/tickets/{id}/reply',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Reply to a ticket, or add an internal note',
  description: "internal:true writes a staff-only note to the thread and sends NOTHING (no first_response_at, no status change) and MUST carry no recipients — a note with to/cc/bcc is a 400. Otherwise the reply goes out on Postmark's transactional stream ('outbound', no marketing-consent gate — the member wrote to us first), threaded off the last inbound message, Reply-To the ticket's own mailbox; the ticket then moves to pending and stamps first_response_at if unset. A failed send leaves the ticket untouched. EMAIL-CC.1 — THE RECIPIENT SET IS DERIVED, NOT CHOSEN: the server sends to everybody on the thread (the From + To + Cc of the latest non-note message, minus the studio's own addresses), so a one-person thread is a Reply and a wider one is a Reply All with no way to express the difference on the wire. `to`/`cc`/`bcc` in the body ADD people on top of that; there is deliberately no way to remove a participant. bcc_emails of earlier messages is NEVER read back as a recipient. All three lists are deduped case-insensitively across each other (To beats Cc beats Bcc) and capped at 25 addresses COMBINED. Bcc goes out in Postmark's own Bcc field, so no recipient sees it. Response carries { recipients: { to, cc, bcc }, mode }.",
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({
      text: z.string().min(1).max(10000),
      internal: z.boolean().optional(),
      to: z.array(z.string().email()).max(25).optional(),
      cc: z.array(z.string().email()).max(25).optional(),
      bcc: z.array(z.string().email()).max(25).optional(),
    }).openapi('EmailTicketReply') } } },
  },
  responses: {
    200: { description: 'Note written / reply sent' },
    400: { description: 'Invalid body, no recipient, or the send failed', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found / not accessible', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/email/tickets/{id}/status',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Move a ticket through its lifecycle',
  description: 'Sets solved_at / closed_at moving into those states and clears them moving out. Nothing auto-closes anywhere in this feature — this route is the only way a ticket leaves the queue.',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({ status: z.enum(['open', 'pending', 'solved', 'closed']) }).openapi('EmailTicketStatus') } } },
  },
  responses: {
    200: { description: 'Updated ticket' },
    400: { description: 'Invalid status', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found / not accessible', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/email/tickets/compose',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Start a new ticket by emailing someone',
  description: "A new email IS a ticket whose first message is outbound — one email_tickets row plus one outbound email_inbox_messages row, and thereafter an ordinary ticket (their reply threads back through the normal inbound path). The location comes off the MAILBOX, never the request, and `mailbox_id` must be in the caller's visible set: anything else is a 404, never a 403, so mailbox ids can't be enumerated. Sends on Postmark's transactional stream ('outbound') with Reply-To the chosen mailbox, links a contact when one matches the recipient, and stamps first_response_at. THE SEND HAPPENS FIRST: a failed send writes nothing at all, so there is never a ticket queued for an email that did not go. EMAIL-CC.1 — to[0] is the PRIMARY recipient: it is what requester_email records, what the contact link resolves against and what email_sends logs. Cc/Bcc are deduped case-insensitively against To and each other (To beats Cc beats Bcc), the studio's own mailbox addresses are stripped from all three (cc'ing one would file a phantom inbound ticket), and the combined total is capped at 25. Every address on a composed email was typed by a person, so the whole set is written to audit_events under the sender's name.",
  request: {
    body: { content: { 'application/json': { schema: z.object({
      mailbox_id: uuidLike,
      // EMAIL-CC.1 — several recipients; the SCALAR FORM IS STILL ACCEPTED and
      // normalised to a one-element array, so nothing that posted here before
      // has to change.
      to: z.union([z.string().email(), z.array(z.string().email()).max(25).min(1)]),
      cc: z.array(z.string().email()).max(25).optional(),
      bcc: z.array(z.string().email()).max(25).optional(),
      subject: z.string().min(1).max(200),
      text: z.string().min(1).max(10000),
    }).openapi('EmailTicketCompose') } } },
  },
  responses: {
    200: { description: '{ ticket_id, ticket, message, message_id }' },
    400: { description: 'Invalid body, or the send failed', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Missing email_inbox permission', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Mailbox missing, inactive, or not visible to the caller', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Sent, but the ticket/message could not be filed — do NOT resend', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/email/tickets/{id}/read',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Mark a ticket read',
  description: 'Zeroes unread_count and nothing else (updated_at deliberately does not move). Its own endpoint so the detail GET stays free of writes.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Marked read' },
    404: { description: 'Not found / not accessible', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// ── Attachments + storage quota — EMAIL-ATTACH.1 (mig 496) ──────────────────
registry.registerPath({
  method: 'get',
  path: '/api/email/tickets/{id}/attachments/{attachmentId}',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Short-lived signed URL for one stored attachment',
  description: "The email-attachments bucket is private, so this is the only way a client sees the bytes; the URL expires in 5 minutes. Access is the TICKET's access (location + the mailbox the ticket arrived at) PLUS a check that the attachment belongs to THIS ticket — without that pairing check, any ticket the caller can open would unlock any attachment id in the estate. 404 — never 403 — for a missing attachment, one on another ticket, and one whose bytes were never stored (the body then names the skipped_reason so staff can ask for a resend). storage_path is never returned.",
  request: { params: z.object({ id: uuidLike, attachmentId: uuidLike }) },
  responses: {
    200: { description: '{ url, filename, mime_type, size_bytes, expires_in }' },
    404: { description: 'Not found / not accessible / not stored', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Recorded as stored but Storage would not sign it', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/email/tickets/{id}/attachments/{attachmentId}/preview',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Short-lived signed INLINE URL for one stored attachment',
  description: "EMAIL-ATTACH-PREVIEW.1 — the same object as the route above, signed WITHOUT the download flag so the browser renders it instead of saving it. Two routes rather than one route with a ?disposition= parameter, deliberately: the disposition must never be something a request asserts, and neither route accepts a Storage option of any kind. Identical gate (the ticket's access plus the attachment-belongs-to-this-ticket pairing check) and identical 5-minute TTL. Mints a URL ONLY for an allow-list of types that are safe AND universally renderable — image/jpeg, image/png, image/gif, image/webp, application/pdf — enforced here and again in the signer. Everything else is 404 with preview_kind null, which the UI renders as 'download instead', never as an error: image/svg+xml is scriptable markup from an unauthenticated stranger and never gets an inline handle; image/heic and image/heif are what iPhones send and no mainstream browser can decode them; Word/Excel/PowerPoint have no native renderer and are NOT sent to any third-party viewer. storage_path is never returned.",
  request: { params: z.object({ id: uuidLike, attachmentId: uuidLike }) },
  responses: {
    200: { description: '{ url, preview_kind, filename, mime_type, size_bytes, expires_in }' },
    404: { description: 'Not found / not accessible / not stored / no preview for this type', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Recorded as stored but Storage would not sign it', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/locations/{id}/email/storage',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Attachment storage used per email account',
  description: "Per-mailbox fill against the 5 GB ceiling (mig 496), with a level of ok / warning (≥80%) / critical (≥95%) / full (≥100%), plus the location's `unfiled` bucket when a removed account has left bytes behind. Accounts with no counter row yet report 0 rather than being omitted. Inbound email is NEVER rejected on a full mailbox — the message lands in full and the attachment is recorded with skipped_reason 'quota'. Master or owner-at-location only.",
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: '{ quota_bytes, mailboxes, unfiled, prune_batch_limit }' },
    403: { description: 'Not master/owner at this location', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/locations/{id}/email/storage',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Reclaim attachment storage, or repair a drifted counter',
  description: "action='prune' deletes the stored bytes for attachments older than older_than_days (default 365) on SOLVED or CLOSED tickets only — a ticket someone is still working is never touched. The attachment ROW survives with storage_path NULL and skipped_reason 'pruned', so staff can still see a file existed and ask for a resend, and the mailbox counter is DECREMENTED by exactly what was removed (a prune that freed bytes without moving the counter would leave the mailbox permanently full). Bounded per call; `remaining` > 0 means run it again. mailbox_id null targets the location's unfiled bucket. action='recalculate' re-derives every counter at the location from the attachment rows. Master or owner-at-location only; another studio's mailbox id is 404.",
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({
      action: z.enum(['prune', 'recalculate']),
      mailbox_id: uuidLike.nullable().optional(),
      older_than_days: z.number().int().min(0).max(3650).optional(),
    }).openapi('EmailStorageAction') } } },
  },
  responses: {
    200: { description: '{ pruned, bytes_freed, remaining } or { recalculated }' },
    400: { description: 'Unknown action or invalid body', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Not master/owner at this location', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'No such mailbox at this location', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// ── Email accounts (mailboxes) + per-account access — EMAIL-MAILBOX-ADMIN.1 ──
// Master or owner-AT-LOCATION only, NOT the `email_inbox` permission: a
// manager holds that key and is not elevated, so gating here on it would let
// a manager grant themselves accounts@ — the exact hole the per-account model
// exists to close.
registry.registerPath({
  method: 'get',
  path: '/api/locations/{id}/email/mailboxes',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'The studio’s email accounts and who may read each',
  description: "Returns { mailboxes, staff }. Unlike the inbox this INCLUDES deactivated accounts — managing them is the point of the surface. Each mailbox carries an `access` array listing every active staff member at the location tagged implicit (owner-at-location or master — no grant row exists and none can be created), granted (a row in email_mailbox_access) or none. Master or owner-at-location only.",
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: '{ mailboxes, staff }' },
    403: { description: 'Not at this location, or not master/owner here', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/locations/{id}/email/mailboxes',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Add an email account to a studio',
  description: "Creates an email_mailboxes row (mig 485). The address is stored trimmed + lowercased and must be free ESTATE-WIDE — UNIQUE(lower(address)) is global, so a clash may be at a studio the caller cannot see; the 409 explains the rule rather than reporting a constraint, and names the other studio only for a master. is_default=true clears the location's incumbent default first (at most one per location). Master or owner-at-location only.",
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({
      address: z.string().email(),
      label: z.string().min(1).max(40),
      is_default: z.boolean().optional(),
    }).openapi('EmailMailboxCreate') } } },
  },
  responses: {
    201: { description: '{ mailbox }' },
    400: { description: 'Invalid address or label', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Not master/owner at this location', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Address already belongs to an account somewhere in the estate', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/api/locations/{id}/email/mailboxes/{mailboxId}',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Rename, re-default, deactivate or reactivate an account',
  description: "THERE IS NO DELETE: email_tickets.mailbox_id is ON DELETE SET NULL, so deleting would strip historic tickets of the address they arrived at. active=false is the removal path — it stops inbound routing and hides the tab from everyone including owners, keeping the row and its history — and it CLEARS is_default so a studio never defaults to an undeliverable address. The address itself is immutable (editing it would reattribute history). is_default=true clears the incumbent first and is refused for a deactivated account. Master or owner-at-location only; another studio's mailbox id is 404, never 403.",
  request: {
    params: z.object({ id: uuidLike, mailboxId: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({
      label: z.string().min(1).max(40).optional(),
      is_default: z.boolean().optional(),
      active: z.boolean().optional(),
    }).openapi('EmailMailboxPatch') } } },
  },
  responses: {
    200: { description: '{ mailbox }' },
    400: { description: 'Empty patch, bad label, or default-on-a-deactivated-account', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Not master/owner at this location', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'No such mailbox at this location', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/locations/{id}/email/mailboxes/{mailboxId}/access',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Grant or revoke one person’s access to one account',
  description: "Idempotent set-access: { profile_id, granted } → { granted, changed }. Grants stamp granted_by with the acting user; revokes DELETE the row, so both directions also write an audit_events row (the revoke would otherwise leave no record anywhere that access ever existed). The grantee must be an active staff member at this location — email_mailbox_access carries no location of its own, so without that check a grant could be minted for any profile in the estate. Owners-at-location and masters are refused in BOTH directions with an explanation: they read every account here implicitly, no row exists for them, and silently no-opping would have an operator toggling an owner and watching nothing happen. Master or owner-at-location only.",
  request: {
    params: z.object({ id: uuidLike, mailboxId: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({
      profile_id: uuidLike,
      granted: z.boolean(),
    }).openapi('EmailMailboxAccessSet') } } },
  },
  responses: {
    200: { description: '{ granted, changed }' },
    400: { description: 'Not staff here, or the person is implicitly elevated', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Not master/owner at this location', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'No such mailbox at this location', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/sequence/{token}',
  tags: ['Webhooks (Inbound)'],
  security: [],
  summary: 'Tokenised sequence callback',
  description: 'Sequence event callback; carries step completion or external event data. Authenticated by the unguessable `{token}` path segment, not a header.',
  request: {
    params: z.object({ token: z.string() }),
    body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('SequenceCallbackEvent') } } },
  },
  responses: {
    200: { description: 'Accepted' },
    401: { description: 'Invalid token', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// ============================================================================
// Bridge — Pi device API, BridgeAuth on all routes
// ============================================================================

const StrapScan = z.object({
  straps: z.array(z.object({
    device_key: z.string().openapi({ example: 'ble:AA:BB:CC:DD:EE:FF' }),
    name: z.string().nullable().optional(),
    rssi: z.number().nullable().optional(),
    last_bpm: z.number().nullable().optional(),
  })).max(100),
}).openapi('StrapScan')

registry.registerPath({
  method: 'post',
  path: '/api/bridge/scan',
  tags: ['Bridge'],
  security: [{ BridgeAuth: [] }],
  summary: 'Report currently-visible straps',
  description: 'Pi bridge → CRM. Overwrites ble_bridges.last_seen_straps. Polled ~every 5s during coach pairing. Max 100 straps.',
  request: { body: { content: { 'application/json': { schema: StrapScan } } } },
  responses: {
    200: { description: 'Stored' },
    401: { description: 'Invalid bridge token', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/bridge/samples',
  tags: ['Bridge'],
  security: [{ BridgeAuth: [] }],
  summary: 'Batch of HR samples for live sessions',
  description: 'Pi bridge → CRM. Posts a batch of heart-rate samples for active live sessions.',
  request: { body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('BridgeSamplesBatch') } } } },
  responses: {
    200: { description: 'Accepted' },
    401: { description: 'Invalid bridge token', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/bridge/heartbeat',
  tags: ['Bridge'],
  security: [{ BridgeAuth: [] }],
  summary: 'Bridge liveness ping',
  description: 'Pi bridge → CRM. Periodic heartbeat to indicate the bridge is online.',
  request: { body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('BridgeHeartbeat') } } } },
  responses: {
    200: { description: 'Acknowledged' },
    401: { description: 'Invalid bridge token', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/bridge/inbody/ingest',
  tags: ['Bridge'],
  security: [{ BridgeAuth: [] }],
  summary: 'Push a fresh InBody scan',
  description: 'Pi bridge → CRM. Ingests a new InBody body-composition scan result.',
  request: { body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('BridgeInBodyIngest') } } } },
  responses: {
    200: { description: 'Ingested' },
    401: { description: 'Invalid bridge token', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/bridge/inbody/backfill-ingest',
  tags: ['Bridge'],
  security: [{ BridgeAuth: [] }],
  summary: 'Push a historical InBody scan',
  description: 'Pi bridge → CRM. Ingests a historical InBody scan during backfill.',
  request: { body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('BridgeInBodyBackfillIngest') } } } },
  responses: {
    200: { description: 'Ingested' },
    401: { description: 'Invalid bridge token', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/bridge/inbody/backfill-pending',
  tags: ['Bridge'],
  security: [{ BridgeAuth: [] }],
  summary: 'List scans pending backfill',
  description: 'Pi bridge → CRM. Returns list of InBody scans that are pending backfill ingestion.',
  responses: {
    200: { description: 'Pending backfill scans', content: { 'application/json': { schema: z.object({}).passthrough().openapi('BridgeBackfillPendingResponse') } } },
    401: { description: 'Invalid bridge token', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/bridge/inbody/pending',
  tags: ['Bridge'],
  security: [{ BridgeAuth: [] }],
  summary: 'List scans pending ingest',
  description: 'Pi bridge → CRM. Returns list of InBody scans that are pending ingest.',
  responses: {
    200: { description: 'Pending scans', content: { 'application/json': { schema: z.object({}).passthrough().openapi('BridgeIngestPendingResponse') } } },
    401: { description: 'Invalid bridge token', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// ============================================================================
// Mobile — Staff App, CookieAuth on all routes
// ============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/mobile/today-feed',
  tags: ['Mobile'],
  security: [{ CookieAuth: [] }],
  summary: 'Coach "today" feed',
  responses: {
    200: { description: 'Today feed', content: { 'application/json': { schema: z.object({}).passthrough().openapi('TodayFeedResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/mobile/layout',
  tags: ['Mobile'],
  security: [{ CookieAuth: [] }],
  summary: 'Save the mobile home layout',
  request: { body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('MobileLayoutBody') } } } },
  responses: {
    200: { description: 'Layout saved' },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/mobile/me',
  tags: ['Mobile'],
  security: [{ CookieAuth: [] }],
  summary: 'Current staff profile + permissions',
  responses: {
    200: { description: 'Profile', content: { 'application/json': { schema: z.object({}).passthrough().openapi('MobileMeResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/mobile/radar',
  tags: ['Mobile'],
  security: [{ CookieAuth: [] }],
  summary: 'Lead/churn radar summary',
  responses: {
    200: { description: 'Radar summary', content: { 'application/json': { schema: z.object({}).passthrough().openapi('MobileRadarResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/mobile/device-tokens',
  tags: ['Mobile'],
  security: [{ CookieAuth: [] }],
  summary: 'Register a push token',
  request: { body: { content: { 'application/json': { schema: z.object({ token: z.string(), platform: z.string().optional() }).openapi('DeviceTokenRegisterBody') } } } },
  responses: {
    200: { description: 'Token registered' },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/mobile/device-tokens',
  tags: ['Mobile'],
  security: [{ CookieAuth: [] }],
  summary: 'Remove a push token',
  request: { body: { content: { 'application/json': { schema: z.object({ token: z.string() }).openapi('DeviceTokenRemoveBody') } } } },
  responses: {
    200: { description: 'Token removed' },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/mobile/impersonate',
  tags: ['Mobile'],
  security: [{ CookieAuth: [] }],
  summary: 'Start impersonation',
  request: { body: { content: { 'application/json': { schema: z.object({ userId: uuidLike }).openapi('ImpersonateStartBody') } } } },
  responses: {
    200: { description: 'Impersonation started' },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/mobile/impersonate/stop',
  tags: ['Mobile'],
  security: [{ CookieAuth: [] }],
  summary: 'Stop impersonation',
  responses: {
    200: { description: 'Impersonation stopped' },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/mobile/impersonate/users',
  tags: ['Mobile'],
  security: [{ CookieAuth: [] }],
  summary: 'List impersonatable users',
  responses: {
    200: { description: 'Users', content: { 'application/json': { schema: z.object({}).passthrough().openapi('ImpersonateUsersResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/mobile/checklists/today',
  tags: ['Mobile'],
  security: [{ CookieAuth: [] }],
  summary: "Today's checklists",
  responses: {
    200: { description: 'Checklists', content: { 'application/json': { schema: z.object({}).passthrough().openapi('ChecklistsTodayResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/mobile/checklists/{id}/items/{itemId}',
  tags: ['Mobile'],
  security: [{ CookieAuth: [] }],
  summary: 'Tick a checklist item',
  request: { params: z.object({ id: uuidLike, itemId: uuidLike }) },
  responses: {
    200: { description: 'Item ticked' },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/mobile/checklists/{id}/items/{itemId}',
  tags: ['Mobile'],
  security: [{ CookieAuth: [] }],
  summary: 'Untick a checklist item',
  request: { params: z.object({ id: uuidLike, itemId: uuidLike }) },
  responses: {
    200: { description: 'Item unticked' },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Contacts (Bearer auth — used by n8n)
registry.registerPath({
  method: 'get',
  path: '/api/contacts',
  tags: ['Contacts'],
  security: [{ BearerAuth: [] }],
  summary: 'List contacts',
  request: {
    query: z.object({
      location_id: uuidLike.optional(),
      pipeline_stage_slug: z.string().optional(),
      lead_source: leadSourceSchema.optional(),
      min_credits: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional().default(50),
      offset: z.coerce.number().int().min(0).optional().default(0),
    }),
  },
  responses: {
    200: { description: 'OK', content: { 'application/json': { schema: SuccessResponse(z.array(Contact)) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/contacts',
  tags: ['Contacts'],
  security: [{ BearerAuth: [] }],
  summary: 'Create a contact',
  request: { body: { content: { 'application/json': { schema: ContactCreate } } } },
  responses: {
    200: { description: 'Contact created', content: { 'application/json': { schema: SuccessResponse(Contact) } } },
    400: { description: 'Validation failed', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/contacts/{id}',
  tags: ['Contacts'],
  security: [{ BearerAuth: [] }],
  summary: 'Update a contact',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: ContactUpdate } } },
  },
  responses: {
    200: { description: 'Contact updated', content: { 'application/json': { schema: SuccessResponse(Contact) } } },
    400: { description: 'Validation failed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// PERSON-LINK.1 — identity-link routes
registry.registerPath({
  method: 'post',
  path: '/api/contacts/{id}/link',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Link two contacts or set-primary (contact_linking permission)',
  request: {
    params: z.object({ id: uuidLike }),
    query: z.object({ action: z.enum(['set-primary']).optional() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({ otherContactId: uuidLike }).openapi('ContactLinkBody'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Linked / primary set', content: { 'application/json': { schema: z.object({ success: z.literal(true), data: z.object({}).passthrough() }) } } },
    400: { description: 'Cross-location / not in group / validation error', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — contact_linking permission required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Contact not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/contacts/{id}/link',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Unlink a contact from its person group (contact_linking permission)',
  request: {
    params: z.object({ id: uuidLike }),
  },
  responses: {
    200: { description: 'Unlinked', content: { 'application/json': { schema: z.object({ success: z.literal(true), data: z.object({}).passthrough() }) } } },
    400: { description: 'Contact not linked', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — contact_linking permission required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Contact not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// PERSON-LINK.2 — detection runner
registry.registerPath({
  method: 'post',
  path: '/api/contacts/duplicates/detect',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Run duplicate-contact detection for a location (contact_linking permission)',
  description: 'Dry-run by default. Pass ?commit=true to upsert suggestion rows and auto-link high-confidence pairs.',
  request: {
    query: z.object({ commit: z.enum(['true', 'false']).optional() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({ location_id: uuidLike.optional() }).openapi('DuplicateDetectBody'),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Detection results (dryRun or commit)',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            data: z.object({
              dryRun: z.boolean(),
              counts: z.object({ high: z.number(), medium: z.number(), low: z.number() }),
              totalCandidates: z.number(),
            }).passthrough(),
          }),
        },
      },
    },
    400: { description: 'Missing location_id', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — contact_linking permission required', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// PERSON-LINK.2 — review queue PATCH
registry.registerPath({
  method: 'patch',
  path: '/api/contacts/duplicates/{id}',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Confirm or dismiss a duplicate-contact suggestion (contact_linking permission)',
  description: 'status="linked" creates/extends the person group; status="dismissed" marks the pair as reviewed.',
  request: {
    params: z.object({ id: uuidLike }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            status: z.enum(['linked', 'dismissed']),
          }).openapi('DuplicateSuggestionPatch'),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Suggestion updated',
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: z.object({}).passthrough() }),
        },
      },
    },
    400: { description: 'Contacts already in different groups', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — contact_linking permission required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Suggestion not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// CONSULTATIONS SP1 — goals routes
registry.registerPath({
  method: 'post',
  path: '/api/contacts/{id}/goals',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Create a goal for a contact (consultations permission)',
  request: {
    params: z.object({ id: uuidLike }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            title: z.string().min(1),
            detail: z.string().optional(),
            target_value: z.string().optional(),
            target_date: isoDate.optional(),
          }).openapi('ContactGoalCreateBody'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Goal created', content: { 'application/json': { schema: z.object({ success: z.literal(true), data: z.object({}).passthrough() }) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — consultations permission required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Contact not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/contacts/{id}/goals/{gid}',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Update a goal (consultations permission)',
  request: {
    params: z.object({ id: uuidLike, gid: uuidLike }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            title: z.string().min(1).optional(),
            detail: z.string().optional(),
            target_value: z.string().optional(),
            target_date: isoDate.optional(),
            status: z.enum(['open', 'achieved', 'dropped']).optional(),
          }).openapi('ContactGoalUpdateBody'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Goal updated', content: { 'application/json': { schema: z.object({ success: z.literal(true), data: z.object({}).passthrough() }) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — consultations permission required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Contact or goal not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/contacts/{id}/goals/{gid}',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Delete a goal (consultations permission)',
  request: {
    params: z.object({ id: uuidLike, gid: uuidLike }),
  },
  responses: {
    200: { description: 'Goal deleted', content: { 'application/json': { schema: z.object({ success: z.literal(true) }) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — consultations permission required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Contact not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// CONSULTATIONS SP1 — consultations routes
registry.registerPath({
  method: 'post',
  path: '/api/contacts/{id}/consultations',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Create a consultation for a contact (consultations permission)',
  request: {
    params: z.object({ id: uuidLike }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            consulted_at: z.string().optional(),
            coach_id: uuidLike.optional(),
            notes: z.string().optional(),
          }).openapi('ConsultationCreateBody'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Consultation created', content: { 'application/json': { schema: z.object({ success: z.literal(true), data: z.object({}).passthrough() }) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — consultations permission required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Contact not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// COACH KUDOS — staff sends a member a short congratulatory note
registry.registerPath({
  method: 'post',
  path: '/api/contacts/{id}/kudos',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Send a kudo to a member (consultations permission)',
  request: {
    params: z.object({ id: uuidLike }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            message: z.string().min(1).max(500),
            emoji: z.string().max(8).nullish(),
            session_id: uuidLike.nullish(),
          }).openapi('CoachKudosCreateBody'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Kudo sent', content: { 'application/json': { schema: z.object({ success: z.literal(true), data: z.object({}).passthrough() }) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — consultations permission required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Contact not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// GLOFOX-NOTES — staff-authored note on a contact (session-authed path; also
// pushes the note into Glofox as an interaction, best-effort)
registry.registerPath({
  method: 'post',
  path: '/api/contacts/{id}/notes',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Add a note to a contact (contacts permission)',
  request: {
    params: z.object({ id: uuidLike }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            content: z.string().min(1).max(20_000),
          }).openapi('ContactNoteCreateBody'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Note created', content: { 'application/json': { schema: z.object({ success: z.literal(true), data: z.object({}).passthrough() }) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — contacts permission required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Contact not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/contacts/{id}/command-centre',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Contact bundle: row + recent activities + event types; scope=drawer adds notes, sequences, WhatsApp window, composer templates',
  request: {
    params: z.object({ id: uuidLike }),
    query: z.object({
      scope: z.enum(['drawer']).optional().openapi({ description: 'drawer — extend the bundle for the pipeline contact drawer' }),
    }),
  },
  responses: {
    200: {
      description: 'Bundle',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            contact: z.object({}).passthrough(),
            activities: z.array(z.object({}).passthrough()),
            event_types: z.array(z.object({}).passthrough()),
            notes: z.array(z.object({}).passthrough()).optional(),
            sequences: z.array(z.object({}).passthrough()).optional(),
            wa: z.object({ window_open: z.boolean(), window_expires_at: z.string().nullable() }).optional(),
            composer_templates: z.array(z.object({
              name: z.string(), language: z.string(), bodyText: z.string(), sendable: z.boolean(),
            })).optional(),
            permissions: z.object({ whatsapp: z.boolean(), sms: z.boolean(), email: z.boolean() }).optional(),
          }).openapi('ContactCommandCentreBundle'),
        },
      },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Contact not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/contacts/{id}/consultations/{cid}',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Update a consultation (consultations permission)',
  request: {
    params: z.object({ id: uuidLike, cid: uuidLike }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            consulted_at: z.string().optional(),
            coach_id: uuidLike.optional(),
            notes: z.string().optional(),
          }).openapi('ConsultationUpdateBody'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Consultation updated', content: { 'application/json': { schema: z.object({ success: z.literal(true), data: z.object({}).passthrough() }) } } },
    400: { description: 'Validation error', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — consultations permission required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Contact or consultation not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/contacts/{id}/consultations/{cid}',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Delete a consultation (consultations permission)',
  request: {
    params: z.object({ id: uuidLike, cid: uuidLike }),
  },
  responses: {
    200: { description: 'Consultation deleted', content: { 'application/json': { schema: z.object({ success: z.literal(true) }) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — consultations permission required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Contact not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// CONSULTATIONS SP1 — consultation-photos routes
registry.registerPath({
  method: 'post',
  path: '/api/contacts/{id}/consultation-photos',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Upload a progress photo for a contact (consultations permission)',
  request: {
    params: z.object({ id: uuidLike }),
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({
            file:            z.any().openapi({ type: 'string', format: 'binary' }),
            label:           z.string().optional(),
            caption:         z.string().optional(),
            consultation_id: uuidLike.optional(),
            taken_at:        z.string().optional(),
          }).openapi('ConsultationPhotoUploadBody'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Photo uploaded', content: { 'application/json': { schema: z.object({ success: z.literal(true), data: z.object({}).passthrough() }) } } },
    400: { description: 'Validation or upload error', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — consultations permission required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Contact not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/contacts/{id}/consultation-photos/{pid}',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Delete a progress photo (consultations permission)',
  request: {
    params: z.object({ id: uuidLike, pid: uuidLike }),
  },
  responses: {
    200: { description: 'Photo deleted', content: { 'application/json': { schema: z.object({ success: z.literal(true) }) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — consultations permission required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Photo not found for this contact', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Deals
registry.registerPath({
  method: 'post',
  path: '/api/deals',
  tags: ['Deals'],
  security: [{ BearerAuth: [] }],
  summary: 'Create a deal',
  request: { body: { content: { 'application/json': { schema: DealCreate } } } },
  responses: {
    200: { description: 'Deal created' },
    400: { description: 'Validation failed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/deals/{id}',
  tags: ['Deals'],
  security: [{ BearerAuth: [] }],
  summary: 'Update a deal — fires deal_webhook_trigger if stage/status changes',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: DealUpdate } } },
  },
  responses: {
    200: { description: 'Deal updated' },
  },
})

// WhatsApp chat openers — Meta conversational components (cookie auth)
registry.registerPath({
  method: 'post',
  path: '/api/whatsapp/conversational-automation',
  tags: ['WhatsApp'],
  security: [{ CookieAuth: [] }],
  summary: 'Configure WhatsApp chat openers (welcome event + ice breakers)',
  description: "Sets Meta conversational components on the location's WhatsApp number: enable the welcome-message event (fires the request_welcome webhook so a fresh chat open gets an instant greeting) and up to 4 ice-breaker prompts (80 chars each). The applied config is mirrored into locations.settings.conversational_automation.",
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            location_id: uuidLike,
            enable_welcome: z.boolean().optional(),
            prompts: z.array(z.string().max(80)).max(4).optional(),
          }).openapi('WaConversationalAutomation'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Chat openers updated at Meta and mirrored locally' },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Location not found / not accessible', content: { 'application/json': { schema: ErrorResponse } } },
    502: { description: 'Meta conversational_automation call failed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// WhatsApp card sets — operator-curated media-carousel cards (cookie auth)
const WaCardSet = z.object({
  id: uuidLike,
  name: z.string().min(1).max(60),
  description: z.string().max(200).optional().openapi({ description: 'When the AI agent should send this set (shown to the model, not customers)' }),
  body_text: z.string().max(1024).optional(),
  cards: z.array(z.object({
    image_url: z.string().url(),
    title: z.string().min(1).max(80),
    body: z.string().max(160).optional(),
    link_url: z.string().url().optional(),
    link_text: z.string().max(20).optional(),
  })).min(2).max(10),
}).openapi('WaCardSet')

registry.registerPath({
  method: 'get',
  path: '/api/whatsapp/card-sets',
  tags: ['WhatsApp'],
  security: [{ CookieAuth: [] }],
  summary: "List a location's WhatsApp card sets",
  description: "Card sets are operator-curated 2-10 image-card collections stored on locations.settings.wa_card_sets, sent from the inbox composer as Meta's in-session interactive media carousel (24h window only, no template approval).",
  request: { query: z.object({ location_id: uuidLike }) },
  responses: {
    200: { description: 'Card sets for the location', content: { 'application/json': { schema: z.object({ success: z.literal(true), sets: z.array(WaCardSet) }) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Location not found / not accessible', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/whatsapp/card-sets',
  tags: ['WhatsApp'],
  security: [{ CookieAuth: [] }],
  summary: "Replace a location's WhatsApp card sets",
  description: 'Replaces the whole locations.settings.wa_card_sets array (ids minted client-side). Meta requires consistent button config across carousel cards, so each set must have links on all cards or none.',
  request: {
    body: { content: { 'application/json': { schema: z.object({ location_id: uuidLike, sets: z.array(WaCardSet).max(20) }).openapi('WaCardSetsPut') } } },
  },
  responses: {
    200: { description: 'Card sets saved' },
    400: { description: 'Validation failed', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Location not found / not accessible', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// WhatsApp inbox carousel send (cookie auth)
registry.registerPath({
  method: 'post',
  path: '/api/whatsapp/conversations/{id}/send-carousel',
  tags: ['WhatsApp'],
  security: [{ CookieAuth: [] }],
  summary: 'Send a curated card set as an in-session media carousel',
  description: "Sends one of the location's card sets to the conversation as Meta's interactive media carousel (2-10 swipeable image cards). Session message — only works while the 24h window is open; a Meta rejection surfaces as 502. Logs a thread row on success.",
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({ card_set_id: uuidLike }).openapi('WaSendCarousel') } } },
  },
  responses: {
    200: { description: 'Carousel sent' },
    404: { description: 'Conversation or card set not found', content: { 'application/json': { schema: ErrorResponse } } },
    502: { description: 'Meta carousel call failed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// WhatsApp inbox booking-Flow send (cookie auth)
registry.registerPath({
  method: 'post',
  path: '/api/whatsapp/conversations/{id}/send-flow',
  tags: ['WhatsApp'],
  security: [{ CookieAuth: [] }],
  summary: "Send the location's booking Flow into an open conversation",
  description: "Sends the configured 'Book your first visit' WhatsApp Flow (locations.settings.whatsapp_flow) as an in-session interactive flow message — no template needed inside the 24h window; a Meta rejection surfaces as 502. Requires the conversation to be linked to a contact (the flow_token books against it). Logs a thread row on success. Takes no body.",
  request: {
    params: z.object({ id: uuidLike }),
  },
  responses: {
    200: { description: 'Flow sent' },
    400: { description: 'No contact linked, or no Flow configured for the location', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Conversation not found', content: { 'application/json': { schema: ErrorResponse } } },
    502: { description: 'Meta flow send failed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// WhatsApp inbox block action (cookie auth)
registry.registerPath({
  method: 'post',
  path: '/api/whatsapp/conversations/{id}/block',
  tags: ['WhatsApp'],
  security: [{ CookieAuth: [] }],
  summary: 'Block or unblock a WhatsApp sender (Meta Block API)',
  description: 'Blocks/unblocks the sender at Meta and mirrors the state locally (conversation.is_blocked + contacts.wa_status). Meta only allows blocking users who messaged within the last 24h.',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({ action: z.enum(['block', 'unblock']) }).openapi('WaBlockAction') } } },
  },
  responses: {
    200: { description: 'Block state updated' },
    404: { description: 'Conversation not found', content: { 'application/json': { schema: ErrorResponse } } },
    502: { description: 'Meta block call failed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// WhatsApp inbox reaction action (cookie auth)
registry.registerPath({
  method: 'post',
  path: '/api/whatsapp/conversations/{id}/react',
  tags: ['WhatsApp'],
  security: [{ CookieAuth: [] }],
  summary: 'React to a WhatsApp message with an emoji',
  description: 'Sends an emoji reaction to a customer message via Meta (empty string removes the reaction) and logs a thread row. Reactions only receive a sent status webhook — no delivered/read.',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({ message_id: z.string().min(1), emoji: z.string().max(8) }).openapi('WaReaction') } } },
  },
  responses: {
    200: { description: 'Reaction sent' },
    404: { description: 'Conversation not found', content: { 'application/json': { schema: ErrorResponse } } },
    502: { description: 'Meta reaction call failed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// WhatsApp inbox pause/resume-Mia action (cookie auth)
registry.registerPath({
  method: 'patch',
  path: '/api/whatsapp/conversations/{id}/agent',
  tags: ['WhatsApp'],
  security: [{ CookieAuth: [] }],
  summary: 'Pause or resume the Mia auto-responder for this conversation',
  description: "Sticky pause, mirroring the Instagram agent-toggle sibling but on a dedicated column: active:false sets agent_paused_at (Mia stops auto-replying until explicitly resumed); active:true clears it back to null. Distinct from agent_active, which already auto-flips on every staff reply and auto-rearms after handoff_cooldown_hours — that machinery can't express a sticky pause, so this uses agent_paused_at instead (mig 435). Does not touch agent_handed_off_at.",
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({ active: z.boolean() }).openapi('WaAgentToggle') } } },
  },
  responses: {
    200: { description: 'Pause state updated', content: { 'application/json': { schema: z.object({ success: z.literal(true), agent_paused_at: z.string().datetime().nullable() }) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Conversation not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// WhatsApp spend telemetry (cookie auth)
registry.registerPath({
  method: 'get',
  path: '/api/whatsapp/spend',
  tags: ['WhatsApp'],
  security: [{ CookieAuth: [] }],
  summary: 'WhatsApp spend telemetry for a location',
  description: 'Local rollup of per-message PMP pricing fields (category/type/billable, mig 341) plus Meta pricing_analytics (actual cost) when the number is configured.',
  request: { query: z.object({ location_id: uuidLike.optional(), months: z.coerce.number().min(1).max(12).optional() }) },
  responses: {
    200: { description: 'Spend rollup + Meta pricing analytics' },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// WhatsApp Embedded Signup v4 — "Connect with WhatsApp" launcher (WA-TECHPROV.3, location-scoped)
const WaEmbeddedSignupConfig = z.object({
  configured: z.boolean(),
  app_id: z.string().nullable(),
  config_id: z.string().nullable(),
}).openapi('WaEmbeddedSignupConfig')

const WaNumberPublic = z.object({
  id: uuidLike,
  location_id: uuidLike,
  label: z.string(),
  phone_number_id: z.string(),
  business_account_id: z.string().nullable(),
  app_id: z.string().nullable(),
  display_phone: z.string().nullable(),
  source: z.string(),
  token_type: z.string().nullable(),
  connected_via: z.string().nullable(),
  is_default: z.boolean(),
  is_active: z.boolean(),
  access_token_redacted: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).openapi('WaNumberPublic')

registry.registerPath({
  method: 'get',
  path: '/api/locations/{id}/whatsapp/embedded-signup',
  tags: ['WhatsApp'],
  security: [{ CookieAuth: [] }],
  summary: 'Embedded Signup launch config (app_id, config_id, configured)',
  description: 'Launch config for the "Connect with WhatsApp" button. Reports configured:false instead of throwing when WHATSAPP_APP_ID / WHATSAPP_ES_CONFIG_ID are unset — the button renders a not-configured state.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Launch config for this location', content: { 'application/json': { schema: SuccessResponse(WaEmbeddedSignupConfig) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — location not in your assignments', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/locations/{id}/whatsapp/embedded-signup',
  tags: ['WhatsApp'],
  security: [{ CookieAuth: [] }],
  summary: 'Exchange an Embedded Signup code and connect the WABA/number to this location',
  description: "Orchestrates code→business-token exchange, an ownership check against whatsapp_numbers (a number already connected to a different location 409s BEFORE any Meta-side mutation), WABA webhook subscription, conditional number registration, then upsert into whatsapp_numbers. Nothing persists unless every Meta call succeeded — safe to re-run with a fresh code. mode='cloud_api' (default) supplies phone_number_id from the ES session and registers the number; mode='coexistence' omits phone_number_id (resolved server-side from the WABA) and skips registration — the number is already live on the WhatsApp Business app. Master-or-owner gated, matching the numbers CRUD route.",
  request: {
    params: z.object({ id: uuidLike }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            mode: z.enum(['cloud_api', 'coexistence']).default('cloud_api'),
            code: z.string().min(1),
            waba_id: z.string().regex(/^\d+$/, 'waba_id must be a numeric Meta id'),
            phone_number_id: z.string().regex(/^\d+$/, 'phone_number_id must be a numeric Meta id').optional(),
          }).openapi('WaEmbeddedSignupExchange'),
        },
      },
    },
  },
  responses: {
    200: { description: 'WABA/number connected to this location', content: { 'application/json': { schema: SuccessResponse(WaNumberPublic) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — location not in your assignments, or master/owner role required', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Number already connected to a different location, or a concurrent connect/label collision', content: { 'application/json': { schema: ErrorResponse } } },
    502: { description: 'A Meta call failed (code exchange, WABA subscription, or number registration)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Staff (cookie auth — owner-only)
registry.registerPath({
  method: 'post',
  path: '/api/staff',
  tags: ['Staff'],
  security: [{ CookieAuth: [] }],
  summary: 'Create a staff member (owner or master)',
  request: { body: { content: { 'application/json': { schema: StaffCreate } } } },
  responses: {
    201: { description: 'Staff created' },
    403: { description: 'Forbidden — owner or master', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/staff/{id}',
  tags: ['Staff'],
  security: [{ CookieAuth: [] }],
  summary: 'Update a staff member (owner or master)',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: StaffUpdate } } },
  },
  responses: {
    200: { description: 'Staff updated' },
    403: { description: 'Forbidden — owner or master', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Staff device visibility (STAFF-DEV, mig 466)
registry.registerPath({
  method: 'get',
  path: '/api/staff-devices',
  tags: ['Staff'],
  security: [{ CookieAuth: [] }],
  summary: 'Staff app versions, devices and geofence permission',
  description: 'Every active staff profile with their registered devices, the target app version derived from the non-stale fleet, and a per-person verdict (current | outdated | unknown_version | no_device). The verdict keys off each person\'s most recently seen device, never their best version. Requires the settings permission.',
  responses: {
    200: { description: 'Fleet payload — { target_version, staff[] }' },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — settings permission required', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/staff-devices/nudge',
  tags: ['Staff'],
  security: [{ CookieAuth: [] }],
  summary: 'Push an update reminder to staff on an outdated app build',
  description: 'Sends an "App update available" push. Who is outdated is recomputed SERVER-SIDE from device_tokens and intersected with `profile_ids` — the caller cannot nominate a staff member who is up to date, and profiles with no device are skipped (nothing to push to). Throttled to one nudge per device per 24h via device_tokens.last_update_nudge_at (mig 466). Requires the settings permission.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            profile_ids: z.array(uuidLike).min(1).max(200),
            message: z.string().min(1).max(200).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Counts — { sent, skipped_throttled, skipped_no_token }' },
    400: { description: 'Invalid body', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — settings permission required', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Org-admin grants (SAAS-4, mig 417)
registry.registerPath({
  method: 'get',
  path: '/api/staff/{id}/org-admin',
  tags: ['Staff'],
  security: [{ CookieAuth: [] }],
  summary: 'Org-admin grants for a staff member (master only)',
  description: 'Returns { organization_ids } — the organizations this profile holds an org_admin grant on (profile_organizations, mig 417). An org admin acts as owner at every active location of those orgs.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Current grants' },
    403: { description: 'Forbidden — master role required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Profile not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/staff/{id}/org-admin',
  tags: ['Staff'],
  security: [{ CookieAuth: [] }],
  summary: 'Set org-admin grants for a staff member (master only)',
  description: 'Body: { organization_ids } — the FULL desired set of orgs the profile should be org_admin of. The server diffs against existing grants (added orgs granted, missing orgs revoked); resubmitting the same list is a no-op. Grants/revokes are audit-logged (org_admin.granted / org_admin.revoked).',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({ organization_ids: z.array(uuidLike).max(100) }).openapi('OrgAdminGrantsSave') } } },
  },
  responses: {
    200: { description: 'Grants synced to the desired set' },
    400: { description: 'Invalid body or unknown organization id', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — master role required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Profile not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Tenant domains (SAAS-8, mig 415) — DB tier of the multi-brand
// hostname registry. Master-only platform surface.
// Re-derive via .extend({}) so the .openapi() decorator is present
// (same trick as LeadSchema above — the source schema is built before
// extendZodWithOpenApi runs).
const TenantDomainBrandConfig = tenantDomainBrandConfigSchema.extend({}).openapi('TenantDomainBrandConfig', {
  description: 'Brand config mirroring the in-code BRANDS entry shape (src/lib/brands.js). All keys optional; missing ones default to the marketing shape — root "/" and disallowed paths rewrite to /welcome, allowedPaths default to the public marketing set.',
})

registry.registerPath({
  method: 'get',
  path: '/api/admin/tenant-domains',
  tags: ['Admin'],
  security: [{ CookieAuth: [] }],
  summary: 'List tenant domain mappings (master only)',
  description: 'Rows from tenant_domains (mig 415): custom domains routed as tenant brands by the proxy, each linked to an organization and optionally a single location (mig 432). Includes the organization name/slug and the scoped location name for display.',
  responses: {
    200: { description: 'Mappings, ordered by hostname' },
    401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — master role required', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/admin/tenant-domains',
  tags: ['Admin'],
  security: [{ CookieAuth: [] }],
  summary: 'Create a tenant domain mapping (master only)',
  description: 'The hostname (stored lowercase, bare — no scheme/port/path) goes live within the proxy cache TTL (~5 min), no deploy. Optional location_id (mig 432) scopes the domain to a single studio inside the org — it must belong to organization_id (else 400); null/omitted = whole organisation. Hostnames handled by the in-code brand registry, and the CRM\'s own hostname, are refused (400). Duplicate hostnames return 409.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            hostname: z.string().max(253).openapi({ example: 'members.acmegym.ie' }),
            organization_id: uuidLike,
            location_id: uuidLike.nullish().openapi({ description: 'Optional per-location scoping (mig 432). Must belong to organization_id. Null/omitted = whole organisation.' }),
            brand: TenantDomainBrandConfig.optional(),
            active: z.boolean().optional(),
          }).openapi('TenantDomainCreate'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Created mapping' },
    400: { description: 'Invalid hostname/brand config, reserved hostname, unknown organization, or a location that is not in the organization', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — master role required', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Hostname already mapped', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/api/admin/tenant-domains/{id}',
  tags: ['Admin'],
  security: [{ CookieAuth: [] }],
  summary: 'Update a tenant domain mapping (master only)',
  description: 'Any of hostname / organization_id / location_id / brand / active. location_id (mig 432): a uuid scopes the domain to that studio (must belong to the effective org), null clears it back to whole-organisation. active=false is the soft kill switch — the hostname falls through to the CRM auth gate within the proxy cache TTL, config kept.',
  request: {
    params: z.object({ id: uuidLike }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            hostname: z.string().max(253).optional(),
            organization_id: uuidLike.optional(),
            location_id: uuidLike.nullish().openapi({ description: 'Optional per-location scoping (mig 432). uuid = scope to that studio (must belong to the effective org); null = whole organisation.' }),
            brand: TenantDomainBrandConfig.optional(),
            active: z.boolean().optional(),
          }).openapi('TenantDomainPatch'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Updated mapping' },
    400: { description: 'Invalid or empty patch, reserved hostname, or a location that is not in the organization', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — master role required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Mapping not found', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Hostname already mapped', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/admin/tenant-domains/{id}',
  tags: ['Admin'],
  security: [{ CookieAuth: [] }],
  summary: 'Delete a tenant domain mapping (master only)',
  description: 'The hostname falls back to the CRM auth gate within the proxy cache TTL.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Mapping removed' },
    403: { description: 'Forbidden — master role required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Mapping not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Role permission templates (PERM-AUDIT.2, mig 364)
registry.registerPath({
  method: 'get',
  path: '/api/locations/{id}/role-permissions',
  tags: ['Staff'],
  security: [{ CookieAuth: [] }],
  summary: 'Role permission templates for a location (owner or master)',
  description: 'Returns { role: { template, effective } } for owner/manager/head_coach/staff. `template` is the stored sparse diff vs code defaults; `effective` is the fully hydrated blob the editor renders.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Templates by role' },
    403: { description: 'Forbidden — owner at this location or master', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/locations/{id}/role-permissions',
  tags: ['Staff'],
  security: [{ CookieAuth: [] }],
  summary: 'Save a role permission template (owner or master)',
  description: "Body: { role, employment_type?, permissions } where permissions is the FULL desired effective blob. employment_type defaults to 'all' (the role base); 'fte'/'contractor'/'casual' edit the variant that layers on top of the base for users whose profiles.employment_type matches (RECEPTION.2, mig 367). The server whitelists keys, diffs against what the slice inherits and stores only the sparse difference; an all-inherited save deletes the row.",
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({ role: z.enum(['owner', 'manager', 'head_coach', 'staff', 'reception']), employment_type: z.enum(['all', 'fte', 'contractor', 'casual']).optional(), permissions: z.record(z.string(), z.unknown()) }).openapi('RoleTemplateSave') } } },
  },
  responses: {
    200: { description: 'Template saved (or cleared when it matches code defaults)' },
    403: { description: 'Forbidden — owner at this location or master', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Connections-registry legacy re-sync (INTEG-A2)
registry.registerPath({
  method: 'post',
  path: '/api/locations/{id}/connections/refresh',
  tags: ['Locations'],
  security: [{ CookieAuth: [] }],
  summary: 'Re-sync channel_connections registry rows from the location\'s legacy config (admin)',
  description: 'INTEG-A2 dual-write bridge: re-reads the location\'s legacy integration fields (settings.glofox, settings.unifi, sensibo/thinq columns, twilio_alpha_sender_id, bca_config) and upserts/deactivates the matching active channel_connections rows using the mig 419 mapping. Fired by the integration settings tabs after a legacy save. Idempotent. Returns { results: { platform: action } }.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Per-platform sync results' },
    403: { description: 'Forbidden — admin role at this location required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Location not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Glofox trainer-id reference list (STUDIO-KPI.4)
registry.registerPath({
  method: 'get',
  path: '/api/locations/{id}/glofox-trainers',
  tags: ['Locations'],
  security: [{ CookieAuth: [] }],
  summary: 'Trainer ids seen in the Glofox timetable + their resolved names',
  description: 'STUDIO-KPI.4 — distinct trainer ids from the last 28 days of class_occurrences with how each resolves (operator override from settings.glofox.trainer_names, the Glofox API, or unresolved). Powers the Trainer-names reference list in the Glofox settings tab. Master/owner/manager only.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: '{ trainers: [{ id, name, source, classes }], windowDays }' },
    400: { description: 'Glofox not configured on this location', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// DSAR contact export + tenant suspend (SAAS4-C3/P4)
registry.registerPath({
  method: 'get',
  path: '/api/contacts/{id}/export',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Subject-access (DSAR) export — full JSON bundle for one contact',
  description: 'Profile, preferences, consent log, email/booking/activity/note history, WhatsApp + Instagram messages. Sections paginate past the 1k cap and carry honest truncated flags; a broken section fails the export rather than shipping a silent hole. Every export is audit-logged. MANAGER_ROLES, location-scoped, 404 on cross-tenant ids.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'JSON download (Content-Disposition attachment)' },
    404: { description: 'Not found (incl. cross-tenant ids)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// CONTRACTS-EDIT.1 — resend the issue-notification email
registry.registerPath({
  method: 'post',
  path: '/api/contracts/{id}/resend',
  tags: ['Contracts'],
  security: [{ CookieAuth: [] }],
  summary: 'Resend the contract-issued notification email (master/owner only)',
  description: "Re-fires sendContractIssuedEmail plus the issue route's push block for a contract still at issued/viewed. Never mutates the contract row — a pure notification replay. Org-scoped like revoke (404 not 403 for a foreign-org id, non-enumerable); 409 once the contract has moved past issued/viewed (signed/declined/revoked).",
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Resent (warning present if the email itself failed)' },
    403: { description: 'Master or owner only', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found (incl. cross-tenant ids)', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Contract is not in issued/viewed status', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// CONTRACTS-DRAFT.1 — send a draft (its first-ever notification)
registry.registerPath({
  method: 'post',
  path: '/api/contracts/{id}/send',
  tags: ['Contracts'],
  security: [{ CookieAuth: [] }],
  summary: 'Send a draft contract to its recipient (master/owner only)',
  description: "Flips a draft to issued (issued_at reset to the send time — the draft's own issued_at is just its creation timestamp, since the column is NOT NULL) and fires notifyContractIssued (email + push) — the recipient's very first notification, since a draft never emailed or pushed anyone. Org-scoped like resend/revoke (404 not 403 for a foreign-org id, non-enumerable); 409 for any status other than draft.",
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Sent (warning present if the email itself failed)' },
    403: { description: 'Master or owner only', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found (incl. cross-tenant ids)', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Contract is not a draft', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// CONTRACTS-DRAFT.1 — discard a draft (silent — no recipient email)
registry.registerPath({
  method: 'post',
  path: '/api/contracts/{id}/discard',
  tags: ['Contracts'],
  security: [{ CookieAuth: [] }],
  summary: 'Discard a draft contract (master/owner only)',
  description: "Revokes a draft with NO recipient notification (they never knew it existed). Non-draft contracts must go through /revoke instead, which does email the recipient. Org-scoped (404 not 403 for a foreign-org id, non-enumerable); 409 for any status other than draft.",
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: "Discarded (status -> revoked, revoked_reason 'Draft discarded')" },
    403: { description: 'Master or owner only', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found (incl. cross-tenant ids)', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Contract is not a draft', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// CONTRACTS-PDF.1 — download the dual-signed PDF artifact
registry.registerPath({
  method: 'get',
  path: '/api/contracts/{id}/pdf',
  tags: ['Contracts'],
  security: [{ CookieAuth: [] }],
  summary: 'Download the dual-signed contract PDF (recipient, master, or org owner)',
  description: "302-redirects to a 60-second Supabase Storage signed URL for contracts/<id>/signed.pdf, written by the sign route. The bucket is private and no public URL is ever produced. Authorization mirrors GET /api/contracts/{id} exactly: recipient, master, or an owner of the contract's organization; everyone else gets 404 so ids stay non-enumerable. Also 404 when signed_pdf_path is null (unsigned, or sign-time generation degraded to a warning).",
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    302: { description: 'Redirect to the short-lived signed download URL' },
    404: { description: 'Not found (incl. cross-tenant ids and contracts with no stored PDF)', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Signed-URL mint failed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/admin/orgs/{id}/suspend',
  tags: ['Staff'],
  security: [{ CookieAuth: [] }],
  summary: 'Suspend a tenant org (master only; reversible)',
  description: 'Flips the org and ALL its locations inactive — every existing active=true filter (staff location lists, loop-over-locations crons, admin surfaces) enforces the suspension. DELETE on the same path unsuspends. Audit-logged both ways. Deletion stays manual: docs/runbooks/tenant-offboarding.md.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Org + locations toggled' },
    403: { description: 'Master only', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Org usage summary + hard caps (SAAS4-M3)
registry.registerPath({
  method: 'get',
  path: '/api/settings/org-usage',
  tags: ['Staff'],
  security: [{ CookieAuth: [] }],
  summary: 'Org month-to-date usage + hard caps (admin roles)',
  description: 'Live AI spend and email sends (cap-relevant, mig 421 RPCs) plus nightly per-meter and per-location rollup totals for the active organisation. ?organization_id targets another org (master only).',
  responses: {
    200: { description: 'Usage summary' },
    403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/settings/org-usage',
  tags: ['Staff'],
  security: [{ CookieAuth: [] }],
  summary: 'Set/clear the org hard caps (owner-of-org or master)',
  description: 'ai_hard_cap_cents (Mia pauses at cap) and email_hard_cap_sends (campaign starts refused at cap). null clears a cap; both default to no cap.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            organization_id: uuidLike.optional(),
            ai_hard_cap_cents: z.number().positive().nullable().optional(),
            email_hard_cap_sends: z.number().int().positive().nullable().optional(),
          }).openapi('OrgUsageCaps'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Caps saved' },
    403: { description: 'Forbidden — owner of the org or master', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Tenant Billing & usage page (INTEG-D1)
registry.registerPath({
  method: 'get',
  path: '/api/settings/billing',
  tags: ['Staff'],
  security: [{ CookieAuth: [] }],
  summary: 'Tenant billing & usage assembler (owner of the org or master)',
  description: 'Per pinned location: plan (tier/price/effective date/add-ons), month-to-date meters vs allowance (staff assistant separate — allowance-exempt), wallet (balance, Dublin month-end expiry, lapse warning, last-20 ledger, auto-top-up config). Plus the org\'s recent wallet top-up VAT invoices (INTEG-C2b: last 24 across all the org\'s locations, newest first). Orgs with zero active tier pinnings get pinned:false and empty locations/invoices lists. ?organization_id targets another org (master only; a foreign org answers 404, not 403).',
  responses: {
    200: { description: 'Billing page data' },
    403: { description: 'Forbidden — owners and master only', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Organization not found (or not yours)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/api/settings/billing/auto-topup',
  tags: ['Staff'],
  security: [{ CookieAuth: [] }],
  summary: 'Configure wallet auto-top-up (owner of the org or master)',
  description: 'Writes the three DORMANT wallets.auto_topup_* config columns only (never balance_cents — wallet_apply stays the only balance write path). Takes effect when the Stripe card top-up leg ships. A foreign/unknown location answers 404, not 403.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            location_id: uuidLike,
            enabled: z.boolean(),
            amount_cents: z.number().int().min(500).max(50000).nullable().optional(),
            threshold_cents: z.number().int().min(0).max(20000).nullable().optional(),
          }).openapi('WalletAutoTopupConfig'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Auto-top-up config saved' },
    403: { description: 'Forbidden — owners and master only', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Location not found (or not yours)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Wallet top-up (INTEG-C2b) — one-off Stripe Checkout, fixed
// denominations, VAT invoiced at the point of top-up.
registry.registerPath({
  method: 'post',
  path: '/api/settings/billing/topup',
  tags: ['Staff'],
  security: [{ CookieAuth: [] }],
  summary: 'Start a Stripe wallet top-up (owner of the org or master)',
  description: 'Creates a pending TU-serial VAT invoice row and a hosted Stripe Checkout Session (plain platform charge — no Connect params) for a FIXED denomination (2500/5000/10000/25000 cents ex-VAT; 23% Irish VAT added on top at checkout). Requires an ACTIVE tier pinning on the location — unpinned locations (every location today) answer 400. Fulfilment (invoice paid + wallet_apply credit + VAT-invoice email) happens on the dedicated /api/webhooks/stripe-wallet endpoint, never on the redirect. A foreign/unknown location answers 404, not 403.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            location_id: uuidLike,
            amount_cents: z.number().int()
              .describe('One of the fixed denominations in EUR cents (ex-VAT): 2500, 5000, 10000, 25000.'),
          }).openapi('WalletTopupStart'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Checkout created — { checkout_url, invoice_id, number }' },
    400: { description: 'Invalid denomination, or the location has no active platform plan', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — owners and master only', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Location not found (or not yours)', content: { 'application/json': { schema: ErrorResponse } } },
    502: { description: 'Stripe checkout could not be created', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Tenant email sending domain (INTEG-B3) — server-per-tenant. Owner-of-org
// or master; the server token is NEVER returned (redacted status payload).
registry.registerPath({
  method: 'get',
  path: '/api/settings/email-domain',
  tags: ['Staff'],
  security: [{ CookieAuth: [] }],
  summary: 'Tenant email sending-domain status (owner of the org or master)',
  description: 'Redacted status for the caller\'s org: sending domain, the DNS records to add (DKIM TXT + Return-Path CNAME), per-record verified booleans, lifecycle status, and addon_active/account_configured flags for the UI gate. The Postmark SERVER TOKEN is never included. ?organization_id targets another org (master only; a foreign org answers 404, not 403). 503 when POSTMARK_ACCOUNT_TOKEN is unset.',
  responses: {
    200: { description: 'Redacted email-domain status' },
    403: { description: 'Forbidden — owners and master only', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Organization not found (or not yours)', content: { 'application/json': { schema: ErrorResponse } } },
    503: { description: 'Provisioning not configured on this deployment', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/settings/email-domain',
  tags: ['Staff'],
  security: [{ CookieAuth: [] }],
  summary: 'Provision the org\'s Postmark server + sending domain (owner of the org or master)',
  description: 'Initiate: creates the org\'s dedicated Postmark server (via the Account API) and its sending domain, persists ids/token, and returns the DNS records to add — NEVER the server token. Gated by the custom_email_domain plan add-on (403 if the org\'s plan lacks it). Idempotent: a re-post for an already-provisioned org re-reads Postmark, never spawning a second server. A foreign org answers 404, not 403. 503 when POSTMARK_ACCOUNT_TOKEN is unset.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            organization_id: uuidLike.optional().describe('Master only — target another org (defaults to the active org).'),
            domain: z.string().describe('Bare sending domain, e.g. mail.yourgym.com (a subdomain is recommended).'),
            from_local: z.string().optional().describe('Local part of the From address (default "hello").'),
            from_name: z.string().optional().describe('Optional display name for the From.'),
          }).openapi('TenantEmailDomainInitiate'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Provisioned — redacted status + DNS records' },
    400: { description: 'Invalid sending domain', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — owners/master only, or the add-on is not on the plan', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Organization not found (or not yours)', content: { 'application/json': { schema: ErrorResponse } } },
    502: { description: 'Postmark could not provision the server/domain', content: { 'application/json': { schema: ErrorResponse } } },
    503: { description: 'Provisioning not configured on this deployment', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/settings/email-domain/verify',
  tags: ['Staff'],
  security: [{ CookieAuth: [] }],
  summary: 'Re-check the org\'s sending-domain DNS and go live (owner of the org or master)',
  description: 'Asks Postmark to re-verify DKIM + Return-Path; when both verify, flips the status to live. Idempotent. Operates on an already-provisioned row (409 if none). A foreign org answers 404, not 403. 503 when POSTMARK_ACCOUNT_TOKEN is unset.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            organization_id: uuidLike.optional().describe('Master only — target another org (defaults to the active org).'),
          }).openapi('TenantEmailDomainVerify'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Re-checked — redacted status + DNS records' },
    403: { description: 'Forbidden — owners and master only', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Organization not found (or not yours)', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'No sending domain provisioned yet', content: { 'application/json': { schema: ErrorResponse } } },
    502: { description: 'Postmark could not read the domain', content: { 'application/json': { schema: ErrorResponse } } },
    503: { description: 'Provisioning not configured on this deployment', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Location create (SAAS4-W0.1) — server-side so per-location defaults
// (FUNNEL.1 pipeline stages) are seeded atomically with the row.
registry.registerPath({
  method: 'post',
  path: '/api/locations',
  tags: ['Staff'],
  security: [{ CookieAuth: [] }],
  summary: 'Create a location and seed its defaults (master only)',
  description: 'Creates the locations row (slug derived from name) and seeds the FUNNEL.1 pipeline_stages set from the classifier taxonomy. Seeding is idempotent on (location_id, slug). Replaces the legacy browser-side insert in LocationForm.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).max(100),
            organization_id: uuidLike,
            address: z.string().max(300).nullish(),
            phone: z.string().max(50).nullish(),
            email: z.string().email().nullish(),
            timezone: z.string().max(64).optional(),
            country: z.string().length(2).optional(),
            active: z.boolean().optional(),
            monthly_contractor_budget_eur: z.number().min(0).nullish(),
            invoices_inbound_slug: z.string().nullish(),
            // DEPRECATED (mig 485) — superseded by email_mailboxes. Still
            // accepted so an existing integration does not break, but the CRM
            // no longer sends it: add the studio's addresses with
            // POST /api/locations/{id}/email/mailboxes instead.
            email_inbox_reply_to: z.string().email().nullish(),
          }).openapi('LocationCreate'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Location created and seeded' },
    403: { description: 'Forbidden — master only', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Slug already exists', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Location created but seeding failed (safe to re-run)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Marketing frequency cap (FREQ-CAP.1, mig 399)
registry.registerPath({
  method: 'get',
  path: '/api/locations/{id}/comms-frequency-cap',
  tags: ['Communications'],
  security: [{ CookieAuth: [] }],
  summary: 'Cross-channel marketing frequency cap for a location',
  description: 'Returns { enabled, min_hours_between, can_edit } (locations.settings.comms_frequency_cap; defaults enabled=false, 24h). When enabled, one contact receives at most one MARKETING touch (email campaign / WA blast / WA drip / sequence email+WA step) per window; capped sends are deferred, transactional sends are unaffected.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Current cap setting' },
    404: { description: 'Location not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/locations/{id}/comms-frequency-cap',
  tags: ['Communications'],
  security: [{ CookieAuth: [] }],
  summary: 'Save the marketing frequency cap (owner or master)',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({ enabled: z.boolean(), min_hours_between: z.number().int().min(1).max(168) }).openapi('CommsFrequencyCapSave') } } },
  },
  responses: {
    200: { description: 'Cap saved' },
    403: { description: 'Forbidden — owner or master', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Geofence attendance (GEO-ATT, mig 463)
registry.registerPath({
  method: 'get',
  path: '/api/attendance/geofence-config',
  tags: ['Attendance'],
  security: [{ CookieAuth: [] }],
  summary: 'Geofence regions + permission-gate flag for the current user',
  description: 'Returns { required, gate_copy, regions:[{location_id,latitude,longitude,radius_m}] } for the caller\'s non-exempt assignments at geofence-enabled locations (locations.settings.geofence, mig 463). Mobile registers OS geofences from this and gates the app on background-location permission when required=true.',
  responses: { 200: { description: 'Config for the current user' } },
})

registry.registerPath({
  method: 'post',
  path: '/api/attendance/geofence-checkin',
  tags: ['Attendance'],
  security: [{ CookieAuth: [] }],
  summary: 'Mobile geofence-entry check-in (stamps own shift)',
  description: 'Called by the mobile background geofence task on region ENTER. Stamps the caller\'s nearest unstamped shift at the location (±4h window, race-guarded) and writes a staff_attendance_events row with source=geofence (mig 463). Outcomes: matched | already_stamped | no_shift_in_window | duplicate | geofence_exempt | impersonation_ignored.',
  request: {
    body: { content: { 'application/json': { schema: z.object({
      location_id: uuidLike,
      entered_at: z.string().datetime({ offset: true }),
      device_name: z.string().max(80).optional(),
    }).openapi('GeofenceCheckin') } } },
  },
  responses: {
    200: { description: '{ match_outcome }' },
    404: { description: 'Location not found / geofencing not enabled', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/locations/{id}/geofence-attendance',
  tags: ['Attendance'],
  security: [{ CookieAuth: [] }],
  summary: 'Per-location geofence attendance settings',
  description: 'Returns { enabled, latitude, longitude, radius_m, gate_copy, can_edit } — the normalised locations.settings.geofence blob (mig 463; defaults enabled=false, radius 150 m, gate_copy = the default staff-facing permission copy). Any authenticated user at the location can read; owner + master can write.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Current geofence settings' },
    404: { description: 'Location not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/locations/{id}/geofence-attendance',
  tags: ['Attendance'],
  security: [{ CookieAuth: [] }],
  summary: 'Save geofence attendance settings (owner or master)',
  description: 'Merge-writes locations.settings.geofence without touching sibling settings keys. Latitude + longitude are required when enabled; radius is clamped to 50–1000 m; gate_copy null falls back to the default copy.',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({
      enabled: z.boolean(),
      latitude: z.number().min(-90).max(90).nullable(),
      longitude: z.number().min(-180).max(180).nullable(),
      radius_m: z.number().int().min(50).max(1000),
      gate_copy: z.string().max(2000).nullable(),
    }).openapi('GeofenceSettingsSave') } } },
  },
  responses: {
    200: { description: 'Settings saved' },
    403: { description: 'Forbidden — owner or master', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Schedule
registry.registerPath({
  method: 'get',
  path: '/api/schedule/shifts',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: 'List scheduled shifts',
  description: "Returns shifts for the caller's locations, optionally filtered by location_id, start_date, end_date, profile_id. (The legacy create / update / delete shift endpoints were retired — use the block-based assignment routes.)",
  responses: {
    200: { description: 'Shifts' },
    403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/schedule/time-off',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: 'Submit a time-off request',
  request: { body: { content: { 'application/json': { schema: TimeOffRequest } } } },
  responses: { 201: { description: 'Request submitted' } },
})

registry.registerPath({
  method: 'put',
  path: '/api/schedule/time-off/{id}',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: 'Approve, reject, or cancel a time-off request',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: TimeOffReview } } },
  },
  responses: { 200: { description: 'Request updated' } },
})

registry.registerPath({
  method: 'post',
  path: '/api/schedule/swaps',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: 'Create a shift swap request',
  request: { body: { content: { 'application/json': { schema: SwapCreate } } } },
  responses: { 201: { description: 'Swap requested' } },
})

registry.registerPath({
  method: 'put',
  path: '/api/schedule/swaps/{id}',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: 'Approve, reject, or cancel a swap request',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: SwapReview } } },
  },
  responses: { 200: { description: 'Swap updated' } },
})

// Marketing
registry.registerPath({
  method: 'post',
  path: '/api/campaigns',
  tags: ['Marketing'],
  security: [{ BearerAuth: [] }, { CookieAuth: [] }],
  summary: 'Create an email campaign (draft)',
  request: { body: { content: { 'application/json': { schema: CampaignCreate } } } },
  responses: { 200: { description: 'Campaign created' } },
})

registry.registerPath({
  method: 'post',
  path: '/api/campaigns/{id}/send',
  tags: ['Marketing'],
  security: [{ CookieAuth: [] }],
  summary: 'Send a campaign to its filtered audience',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Send complete' },
    400: { description: 'Send failed (e.g. invalid audience filter)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Schedule reports
registry.registerPath({
  method: 'post',
  path: '/api/schedule/reports/scheduled',
  tags: ['Schedule', 'Reports'],
  security: [{ CookieAuth: [] }],
  summary: 'Schedule a recurring report (manager+)',
  request: { body: { content: { 'application/json': { schema: ScheduledReport } } } },
  responses: { 201: { description: 'Schedule created' } },
})

// Automations
registry.registerPath({
  method: 'put',
  path: '/api/automations/{key}',
  tags: ['Automations'],
  security: [{ CookieAuth: [] }],
  summary: 'Toggle a per-location automation',
  request: {
    params: z.object({ key: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            location_id: uuidLike,
            enabled: z.boolean(),
            config: z.record(z.string(), z.unknown()).optional(),
          }).openapi('AutomationToggle'),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Automation updated',
      content: { 'application/json': { schema: SuccessResponse(z.object({ location_id: uuidLike, automation_key: z.string(), enabled: z.boolean() }).openapi('LocationAutomation')) } },
    },
    400: { description: 'Unknown automation key or DB error', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Unauthorized or location access denied', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/automations/{key}/backfill',
  tags: ['Automations'],
  security: [{ CookieAuth: [] }],
  summary: 'Count contacts eligible for the backfill (manager+)',
  request: {
    params: z.object({ key: z.string() }),
    query: z.object({ location_id: uuidLike }),
  },
  responses: {
    200: {
      description: 'Eligible count',
      content: { 'application/json': { schema: SuccessResponse(z.object({ eligible: z.number().int() }).openapi('BackfillEligibleCount')) } },
    },
    400: { description: 'Unknown automation key or missing location_id', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Unauthorized or location access denied', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/automations/{key}/backfill',
  tags: ['Automations'],
  security: [{ CookieAuth: [] }],
  summary: 'Run one backfill batch (manager+)',
  request: {
    params: z.object({ key: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({ location_id: uuidLike }).openapi('BackfillRunBody'),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Batch complete — returns processed/created/linked/needs_review/failed/skipped/remaining counts',
      content: {
        'application/json': {
          schema: SuccessResponse(z.object({
            processed: z.number().int(),
            created: z.number().int(),
            linked: z.number().int(),
            needs_review: z.number().int(),
            failed: z.number().int(),
            skipped: z.number().int(),
            remaining: z.number().int(),
          }).openapi('BackfillBatchSummary')),
        },
      },
    },
    400: { description: 'Unknown automation key or validation error', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Unauthorized or location access denied', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/sequences/{id}/graph',
  tags: ['Automations'],
  security: [{ CookieAuth: [] }],
  summary: 'Discard the unpublished flow-graph draft (clears draft_graph; the editor reopens the published graph)',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: {
      description: 'Draft discarded',
      content: { 'application/json': { schema: z.object({ success: z.literal(true), discarded: z.literal(true) }).openapi('SequenceDraftDiscarded') } },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Sequence not found (or no access)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Tapo devices (TAPO-T1) — staff registry/config/toggle, gated by the
// device_control permission. Lives under the Automations tag: the UI
// surface is /automations/devices. Note: these routes return
// { success, devices } / { success, device } (not the data envelope).
const TapoDevice = z.object({
  id: uuidLike,
  location_id: uuidLike,
  sidecar_device_id: z.string(),
  name: z.string().nullable(),
  kind: z.enum(['plug', 'switch']),
  zone: z.string().nullable(),
  enabled: z.boolean(),
  schedule_mode: z.enum(['none', 'fixed', 'class']),
  fixed_windows: z.array(z.object({
    days: z.array(z.number().int().min(1).max(7)),
    on: z.string(),
    off: z.string(),
  })),
  class_rule: z.object({
    lead_min: z.number().int().optional(),
    lag_min: z.number().int().optional(),
  }),
  override: z.object({
    state: z.enum(['on', 'off']),
    until: z.string(),
    set_by: uuidLike,
  }).nullable(),
  last_state: z.enum(['on', 'off']).nullable(),
  last_seen_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi('TapoDevice')

registry.registerPath({
  method: 'get',
  path: '/api/tapo/devices',
  tags: ['Automations'],
  security: [{ CookieAuth: [] }],
  summary: 'List Tapo devices at the active location (device_control)',
  description: 'Full registry including enabled=false rows — those are bridge-discovered devices awaiting adoption (staff name + enable them).',
  responses: {
    200: {
      description: 'Devices (enabled first, then by name)',
      content: { 'application/json': { schema: z.object({ success: z.literal(true), devices: z.array(TapoDevice) }).openapi('TapoDeviceListResponse') } },
    },
    401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Missing device_control permission', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/api/tapo/devices/{id}',
  tags: ['Automations'],
  security: [{ CookieAuth: [] }],
  summary: 'Update a Tapo device config (device_control)',
  description: 'Rename, set zone label, enable/adopt, and choose the schedule (none | fixed windows | class-linked). All body fields optional — send only what changed; an empty patch is a 400. Missing OR cross-location ids return 404 (no ID enumeration).',
  request: {
    params: z.object({ id: uuidLike }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).max(120).optional(),
            zone: z.string().max(60).nullable().optional(),
            enabled: z.boolean().optional(),
            schedule_mode: z.enum(['none', 'fixed', 'class']).optional(),
            fixed_windows: z.array(z.object({
              days: z.array(z.number().int().min(1).max(7)).min(1),
              on: z.string(),
              off: z.string(),
            })).max(8).optional(),
            class_rule: z.object({
              lead_min: z.number().int().min(0).max(120),
              lag_min: z.number().int().min(0).max(120),
            }).optional(),
          }).openapi('TapoDeviceConfigPatch'),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated device row',
      content: { 'application/json': { schema: z.object({ success: z.literal(true), device: TapoDevice }).openapi('TapoDeviceResponse') } },
    },
    400: { description: 'Validation failed or no editable fields supplied', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Missing device_control permission', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Device not found (or not at your active location)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/tapo/devices/{id}/toggle',
  tags: ['Automations'],
  security: [{ CookieAuth: [] }],
  summary: 'Set or clear a manual override on a Tapo device (device_control)',
  description: 'Exactly one of `state` / `clear`. `state` writes an override honoured ahead of any schedule until `until` (default: upcoming Dublin midnight); `clear: true` hands control back to the schedule. The bridge applies it on its next reconcile tick.',
  request: {
    params: z.object({ id: uuidLike }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            state: z.enum(['on', 'off']).optional(),
            clear: z.boolean().optional(),
            until: z.string().optional(),
          }).openapi('TapoDeviceToggle'),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated device row (override set or cleared)',
      content: { 'application/json': { schema: z.object({ success: z.literal(true), device: TapoDevice }).openapi('TapoDeviceToggleResponse') } },
    },
    400: { description: 'Validation failed (both/neither of state+clear, or until not a future ISO datetime)', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Missing device_control permission', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Device not found (or not at your active location)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Live HR
registry.registerPath({
  method: 'get',
  path: '/api/live/{locationId}',
  tags: ['Live HR'],
  security: [{ CookieAuth: [] }],
  summary: 'Current live HR sessions + available straps for a location (staff)',
  request: { params: z.object({ locationId: uuidLike }) },
  responses: {
    200: {
      description: 'Live state including sessions, available straps, roster, and test_mode_until',
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            server_time: z.string(),
            sessions: z.array(z.record(z.string(), z.unknown())),
            available_straps: z.array(z.record(z.string(), z.unknown())),
            roster: z.array(z.record(z.string(), z.unknown())),
            occurrence: z.record(z.string(), z.unknown()).nullable(),
            test_mode_until: z.string().nullable(),
          }).openapi('LiveState'),
        },
      },
    },
    403: { description: 'Location not in scope', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/live/{locationId}/pair',
  tags: ['Live HR'],
  security: [{ CookieAuth: [] }],
  summary: 'Override strap pairing for a walk-in or lent strap (coach+)',
  request: {
    params: z.object({ locationId: uuidLike }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            device_key: z.string().optional(),
            contact_id: uuidLike.optional(),
            bridge_id: uuidLike.optional(),
            booking_id: uuidLike.nullable().optional(),
          }).openapi('PairOverrideBody'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Paired — returns session_id' },
    400: { description: 'Missing required fields or pair failed', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Coach role or location scope required', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/live/{locationId}/test-mode',
  tags: ['Live HR'],
  security: [{ CookieAuth: [] }],
  summary: 'Enable staff HR test mode (manager+)',
  description: 'Sets test_mode_until on all ble_bridges for the location, allowing straps to route to sessions outside a live class. Time-boxed; default 120 min, max 240 min.',
  request: {
    params: z.object({ locationId: uuidLike }),
    body: {
      content: {
        'application/json': {
          schema: z.object({ minutes: z.number().int().positive().optional() }).openapi('TestModeBody'),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Test mode enabled — returns test_mode_until',
      content: {
        'application/json': {
          schema: z.object({ ok: z.literal(true), test_mode_until: z.string() }).openapi('TestModeEnabled'),
        },
      },
    },
    403: { description: 'Manager role or location scope required', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/live/{locationId}/test-mode',
  tags: ['Live HR'],
  security: [{ CookieAuth: [] }],
  summary: 'Disable staff HR test mode (manager+)',
  request: { params: z.object({ locationId: uuidLike }) },
  responses: {
    200: {
      description: 'Test mode cleared — test_mode_until is null',
      content: {
        'application/json': {
          schema: z.object({ ok: z.literal(true), test_mode_until: z.null() }).openapi('TestModeDisabled'),
        },
      },
    },
    403: { description: 'Manager role or location scope required', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// ============================================================================
// Pulse — first-90-days journey (PULSE-90)
// ============================================================================

const JourneyRow = z.object({
  contactId: uuidLike,
  name: z.string(),
  joinedAt: z.string(),
  inWindow: z.boolean(),
  dayIndex: z.number().int(),
  weekIndex: z.number().int(),
  windowDays: z.number().int(),
  attended: z.number().int(),
  target: z.number().int(),
  expectedByNow: z.number().int(),
  status: z.enum(['on_track', 'behind', 'at_risk', 'completed', 'expired']),
  lastAttendedAt: z.string().nullable(),
  daysSinceLastAttended: z.number().int().nullable(),
  completedAt: z.string().nullable(),
  completedDaysAgo: z.number().int().nullable(),
}).openapi('JourneyRow')

registry.registerPath({
  method: 'get',
  path: '/api/pulse/journey',
  tags: ['Pulse'],
  security: [{ CookieAuth: [] }],
  summary: 'First-90-days journey lane (staff)',
  description: 'Every new member at the location scored against the 9-classes-in-6-weeks pace, worst-first, each with their latest coach touch. Requires the pulse_admin permission.',
  request: { query: z.object({ location_id: uuidLike.optional() }) },
  responses: {
    200: {
      description: 'Journey lane + resolved per-location config',
      content: {
        'application/json': {
          schema: SuccessResponse(z.object({
            config: z.object({ windowDays: z.number().int(), targetClasses: z.number().int() }),
            lane: z.array(JourneyRow.extend({
              lastTouch: z.object({ action: z.string(), at: z.string() }).nullable(),
            })),
          })).openapi('JourneyLaneResponse'),
        },
      },
    },
    401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'pulse_admin permission or location scope required', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/pulse/journey/touch',
  tags: ['Pulse'],
  security: [{ CookieAuth: [] }],
  summary: 'Log a coach touch on a journey member',
  description: 'Writes a contacted action to the shared churn_radar_actions audit log; powers the lane\'s "last coach touch" column. Requires the pulse_admin permission.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            contact_id: uuidLike,
            note: z.string().max(500).optional(),
          }).openapi('JourneyTouchBody'),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Touch logged',
      content: {
        'application/json': {
          schema: SuccessResponse(z.object({
            action: z.literal('contacted'),
            at: z.string(),
          })).openapi('JourneyTouchResponse'),
        },
      },
    },
    401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'pulse_admin permission required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Contact not in the caller\'s active location', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// ============================================================================
// Accounting — receipt coverage board (RCOV.P0)
// ============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/accounting/coverage',
  tags: ['Accounting'],
  security: [{ CookieAuth: [] }],
  summary: 'Coverage board data for the active location',
  description: 'Filterable list of tracked Xero bank lines plus headline status counts and the most recent pull\'s audit row. Requires the accounting_hub permission.',
  request: {
    query: z.object({
      status: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }),
  },
  responses: {
    200: { description: 'Lines + counts + lastRun', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — accounting_hub permission required', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

for (const [action, summary, extra] of [
  ['ignore', 'Ignore a bank line (expected no-doc)', {
    body: { content: { 'application/json': { schema: z.object({ reason: z.string().min(2).max(200) }).openapi('CoverageIgnoreBody') } } },
  }],
  ['unignore', 'Reverse an ignore — the line returns to uncovered', {}],
  ['rehunt', 'Queue a single line for an immediate re-hunt', {}],
  ['upload', 'Attach a manually-obtained receipt (multipart file) — content-hash deduped, enters the invoices queue', {}],
]) {
  registry.registerPath({
    method: 'post',
    path: `/api/accounting/coverage/{id}/${action}`,
    tags: ['Accounting'],
    security: [{ CookieAuth: [] }],
    summary,
    request: { params: z.object({ id: uuidLike }), ...(extra.body ? { body: extra.body } : {}) },
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()) } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
      403: { description: 'Forbidden — accounting_hub permission required', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'Line not found for the active location', content: { 'application/json': { schema: ErrorResponse } } },
      409: { description: 'Line state does not allow this action', content: { 'application/json': { schema: ErrorResponse } } },
    },
  })
}

registry.registerPath({
  method: 'get',
  path: '/api/accounting/health',
  tags: ['Accounting'],
  security: [{ CookieAuth: [] }],
  summary: 'Runs & health for the receipt-coverage feature',
  description: 'Recent recon runs (pulls + weekly reports), hunt-inbox health, the two cron heartbeats with staleness, and 7-day LLM spend vs the hunt budget. Requires the accounting_hub permission.',
  responses: {
    200: { description: 'Runs, mailboxes, heartbeats, spend', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — accounting_hub permission required', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/accounting/exceptions',
  tags: ['Accounting'],
  security: [{ CookieAuth: [] }],
  summary: 'Exceptions for the active location (audit F2/F3/F4/F5 + stuck rows)',
  description: 'VAT mismatches (Xero-booked vs OCR), aging DRAFT bills, bills missing their attachment, receiptless-expected expenses, and queue rows stuck >7 days. Requires the accounting_hub permission.',
  responses: {
    200: { description: 'Five exception sections', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — accounting_hub permission required', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/accounting/coverage/refresh',
  tags: ['Accounting'],
  security: [{ CookieAuth: [] }],
  summary: 'Trigger a coverage pull for the active location',
  description: 'Operator-triggered pull; doubles as the live validation probe for the BankStatement report shape. `force: true` bypasses the covered-ratio circuit-breaker — the documented escape hatch after a legitimate bulk reconcile in Xero. Requires the accounting_hub permission.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ force: z.boolean().optional() }).openapi('CoverageRefreshBody'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Pull summary', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — accounting_hub permission required', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'A pull is already running, Xero reconnect required, or the cover-guard tripped (retry with force)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/accounting/payables',
  tags: ['Accounting'],
  security: [{ CookieAuth: [] }],
  summary: 'Aged payables (who we owe + how overdue) for the active location',
  description: 'Live pull of unpaid AUTHORISED ACCPAY bills from the active location\'s Xero connection, aggregated per supplier with a standard aging ladder (not due / 1-30 / 31-60 / 61-90 / 90+). Scope accounting.invoices. Requires the accounting_hub permission.',
  responses: {
    200: { description: 'Aged payables', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — accounting_hub permission required', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Xero not connected for this location', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/accounting/event-fees',
  tags: ['Accounting'],
  security: [{ CookieAuth: [] }],
  summary: 'Org-wide event booking fees (per-ticket fee UN1T earned on host events)',
  description: 'Rollup of race_payments.application_fee_cents across ALL of the session org\'s event hosts, settled (completed/refunded) payments only: grand total, per-host breakdown, per-month buckets. Requires the accounting_hub permission.',
  responses: {
    200: { description: 'Total + per-host + per-month fee rollup', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — accounting_hub permission required', content: { 'application/json': { schema: ErrorResponse } } },
    400: { description: 'No active organization', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/accounting/coverage/accounts',
  tags: ['Accounting'],
  security: [{ CookieAuth: [] }],
  summary: 'Active Xero bank accounts for the statement-import picker',
  responses: {
    200: { description: 'Bank accounts', content: { 'application/json': { schema: SuccessResponse(z.object({ accounts: z.array(z.object({ id: z.string(), name: z.string() })) })) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — accounting_hub permission required', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Xero not connected for this location', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// XERO-BILL-VAT.2 — active expense-applicable Xero tax rates for the
// /invoices VAT-rate picker (from the xero_tax_rates cache).
registry.registerPath({
  method: 'get',
  path: '/api/locations/{id}/xero/tax-rates',
  tags: ['Accounting'],
  security: [{ CookieAuth: [] }],
  summary: "A location's active, expense-applicable Xero tax rates for the VAT-rate picker",
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Tax rates', content: { 'application/json': { schema: SuccessResponse(z.object({ taxRates: z.array(z.object({ tax_type: z.string(), name: z.string(), effective_rate: z.number().nullable(), can_apply_to_expenses: z.boolean().nullable() })), lastSyncedAt: z.string().nullable(), stale: z.boolean() })) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — not a member of that location', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/accounting/coverage/clear',
  tags: ['Accounting'],
  security: [{ CookieAuth: [] }],
  summary: 'Clear all open (non-terminal) bank lines for the active location',
  description: 'Recovery hatch for a mistaken statement import — deletes every uncovered/submitted/not_found/needs_attention line (and its hunt rows) for the active location. Covered/ignored history and any receipts already pushed to Xero are kept. Recoverable via Refresh from Xero + re-upload. Requires the accounting_hub permission.',
  responses: {
    200: { description: 'Cleared count', content: { 'application/json': { schema: SuccessResponse(z.object({ cleared: z.number() })) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — accounting_hub permission required', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/accounting/coverage/import-statement',
  tags: ['Accounting'],
  security: [{ CookieAuth: [] }],
  summary: 'Import a bank-statement CSV export into the coverage board',
  description: 'CSV bridge for unactioned imported statement lines (invisible to the API pull — the Bank Statement report scope is retired and the Finance API is entitlement-gated). Money-out, unreconciled lines are tracked under the csv: key namespace; re-uploading with lines now Reconciled covers them. Requires the accounting_hub permission.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            bankAccountId: z.string().min(8).max(64),
            bankAccountName: z.string().min(1).max(120),
            csvText: z.string().min(1).max(2_000_000),
          }).openapi('CoverageImportStatementBody'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Import stats', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — accounting_hub permission required', content: { 'application/json': { schema: ErrorResponse } } },
    422: { description: 'CSV shape not recognised (error names the headers found)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// RCOV.P1 — hunt-inbox management. recon_mailboxes is scoped PER
// LOCATION (mig 374) — the hunt only searches a line against its own
// location's inboxes — so these routes gate on accounting_hub AND the
// active location.
const MailboxCreateBody = z.object({
  label: z.string().min(1).max(100),
  email: z.string().email().max(320),
  password: z.string().min(8).max(128),
}).openapi('MailboxCreateBody')

registry.registerPath({
  method: 'get',
  path: '/api/accounting/mailboxes',
  tags: ['Accounting'],
  security: [{ CookieAuth: [] }],
  summary: 'List hunt inboxes',
  description: 'Operator-facing metadata for every configured hunt inbox (the imap_password column is never selected). Global list — not scoped to the active location. Requires the accounting_hub permission.',
  responses: {
    200: { description: 'Mailbox rows', content: { 'application/json': { schema: SuccessResponse(z.array(z.object({}).passthrough())) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — accounting_hub permission required', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/accounting/mailboxes',
  tags: ['Accounting'],
  security: [{ CookieAuth: [] }],
  summary: 'Add a hunt inbox',
  description: 'Verifies the Gmail app password with a live IMAP login before persisting the credential. Requires the accounting_hub permission.',
  request: {
    body: {
      content: {
        'application/json': { schema: MailboxCreateBody },
      },
    },
  },
  responses: {
    200: { description: 'Created mailbox id', content: { 'application/json': { schema: SuccessResponse(z.object({ id: uuidLike })) } } },
    400: { description: 'Invalid request body, or the IMAP login check failed', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — accounting_hub permission required', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'This inbox (email) is already added', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/accounting/mailboxes/{id}',
  tags: ['Accounting'],
  security: [{ CookieAuth: [] }],
  summary: 'Remove a hunt inbox',
  description: 'Requires the accounting_hub permission.',
  request: {
    params: z.object({ id: uuidLike }),
  },
  responses: {
    200: { description: 'Removed', content: { 'application/json': { schema: SuccessResponse(z.object({})) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — accounting_hub permission required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'No mailbox with that id', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// ============================================================================
// Dashboard — command-centre block data (web + mobile Business segment)
// ============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/dashboard/business',
  tags: ['Dashboard'],
  security: [{ CookieAuth: [] }],
  summary: 'Business dashboard blocks as JSON',
  description: 'Every block of the /dashboard/business command centre in one payload — KPI briefing, acquisition funnel, ads-7d, membership live + 12-month trend, today-ops strip, and the "Needs you" rail. Per-block failure isolation: a failed block returns null under its key (rail: null = failed, [] = nothing waiting). Session cookie (web) or Supabase JWT Bearer + x-active-location (mobile app). Requires the dashboard_business permission.',
  responses: {
    200: { description: 'Dashboard blocks', content: { 'application/json': { schema: z.object({}).passthrough().openapi('BusinessDashboardResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Missing dashboard_business permission', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/dashboard/ads/refresh',
  tags: ['Dashboard'],
  security: [{ CookieAuth: [] }],
  summary: 'On-demand ads sync for one location',
  description: 'Runs the ad-insights sync for every active ad account at the location (yesterday + today, Dublin time) — the /dashboard/ads "Refresh" button. Per-account failure isolation: each entry in results is { id, ok } or { id, error }. Requires the dashboard_ads permission.',
  request: {
    body: { content: { 'application/json': { schema: z.object({ locationId: uuidLike }).openapi('AdsRefreshBody') } } },
  },
  responses: {
    200: { description: 'Sync results per ad account', content: { 'application/json': { schema: z.object({}).passthrough().openapi('AdsRefreshResponse') } } },
    400: { description: 'locationId required', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Missing dashboard_ads permission', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// ============================================================================
// Customer (champ-app member) self-service
// ============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/me/journey',
  tags: ['Me'],
  security: [{ BearerAuth: [] }],
  summary: 'Own first-90-days journey (champ-app member)',
  description: 'The caller\'s journey pace row, or journey: null when there is nothing to show (never joined / window expired / past the celebration tail) — the app renders no card on null.',
  responses: {
    200: {
      description: 'Journey row or null',
      content: {
        'application/json': {
          schema: SuccessResponse(z.object({
            journey: JourneyRow.nullable(),
          })).openapi('MyJourneyResponse'),
        },
      },
    },
    401: { description: 'Invalid or missing member JWT', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/me/body-metrics',
  tags: ['Me'],
  security: [{ BearerAuth: [] }],
  summary: 'Save own body metrics (champ-app member)',
  description: 'Member self-service: update gender, dob, and/or weight. Stamps profile_setup_completed_at when all three are present for the first time.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            gender: z.enum(['female', 'male', 'other']).optional(),
            weight_kg: z.number().min(20).max(300).optional(),
            dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          }).openapi('BodyMetricsBody'),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Metrics saved — returns current values and completion stamp',
      content: {
        'application/json': {
          schema: SuccessResponse(z.object({
            dob: z.string().nullable(),
            gender: z.string().nullable(),
            weight_kg: z.number().nullable(),
            profile_setup_completed_at: z.string().nullable(),
          })).openapi('BodyMetricsResponse'),
        },
      },
    },
    401: { description: 'Invalid or missing member JWT', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// ============================================================================
// Plans & pricing — master-only plan catalogue (INTEG-C1, mig 413)
// ============================================================================
// Numbers (prices, allowances, overage rates) are DB-backed and
// versioned: they change ONLY by creating a new plan version with an
// effective_from date — never edited in place. Allowance / rate /
// feature keys come from shared/plans.js.

const PlanRow = z.object({
  id: uuidLike,
  slug: z.string(),
  name: z.string(),
  kind: z.enum(['tier', 'addon']),
  active: z.boolean(),
  sort: z.number().int(),
  created_at: z.string(),
}).openapi('PlanRow')

const PlanVersionRow = z.object({
  id: uuidLike,
  plan_id: uuidLike,
  effective_from: z.string().openapi({ example: '2026-07-19' }),
  price_cents: z.number().int(),
  currency: z.literal('EUR'),
  allowances: z.object({}).passthrough()
    .openapi({ description: 'Monthly included quantities keyed by billing meter: wa_template_send, email_send, ai_message (shared/plans.js METERS — aligned with the mig 411 usage rollup meters).' }),
  unit_rates_cents: z.object({}).passthrough()
    .openapi({ description: 'Overage rates in EUR cents: wa_marketing (/msg), wa_utility (/msg), email_per_1k (/1,000 emails), ai_message (/msg).' }),
  features: z.object({}).passthrough()
    .openapi({ description: 'Boolean feature flags keyed by shared/plans.js FEATURE_KEYS (ai_agent, custom_email_domain).' }),
  notes: z.string().nullable(),
  created_at: z.string(),
  created_by: uuidLike.nullable(),
}).openapi('PlanVersionRow')

registry.registerPath({
  method: 'get',
  path: '/api/admin/plans',
  tags: ['Platform Admin'],
  security: [{ CookieAuth: [] }],
  summary: 'List SaaS plans with full version history (master only)',
  description: 'The plan catalogue — tier plans (Core/Growth/Scale) and add-ons, each with every pricing version newest-first. Feeds the /admin/plans editor.',
  responses: {
    200: {
      description: 'Plans with versions',
      content: { 'application/json': { schema: SuccessResponse(z.array(PlanRow.extend({ versions: z.array(PlanVersionRow) }))).openapi('PlansListResponse') } },
    },
    403: { description: 'Forbidden — master role required', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/admin/plans',
  tags: ['Platform Admin'],
  security: [{ CookieAuth: [] }],
  summary: 'Create a plan shell (master only)',
  description: 'Creates the plan row only — no numbers. Pricing is added as versions via POST /api/admin/plans/{id}/versions. Slug is permanent (snake_case; addon slugs should match shared/plans.js ADDON_KEYS so provisioning code can key off them).',
  request: {
    body: { content: { 'application/json': { schema: z.object({
      slug: z.string().regex(/^[a-z0-9]+(_[a-z0-9]+)*$/),
      name: z.string().min(1).max(100),
      kind: z.enum(['tier', 'addon']),
      sort: z.number().int().min(0).optional(),
    }).openapi('PlanCreateBody') } } },
  },
  responses: {
    200: { description: 'Plan created', content: { 'application/json': { schema: SuccessResponse(PlanRow) } } },
    403: { description: 'Forbidden — master role required', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Duplicate slug', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/api/admin/plans/{id}',
  tags: ['Platform Admin'],
  security: [{ CookieAuth: [] }],
  summary: 'Update plan metadata (master only)',
  description: 'Name / active / sort ONLY. Slug and kind are immutable; prices and allowances live on immutable versions — change them by creating a new version, never in place.',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({
      name: z.string().min(1).max(100).optional(),
      active: z.boolean().optional(),
      sort: z.number().int().min(0).optional(),
    }).openapi('PlanPatchBody') } } },
  },
  responses: {
    200: { description: 'Plan updated', content: { 'application/json': { schema: SuccessResponse(PlanRow) } } },
    403: { description: 'Forbidden — master role required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Plan not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/admin/plans/{id}/versions',
  tags: ['Platform Admin'],
  security: [{ CookieAuth: [] }],
  summary: 'Create a new pricing version for a plan (master only)',
  description: 'THE write path for plan numbers. Versions are immutable once created (no PATCH/DELETE), so locations pinned to a version keep their grandfathered pricing; the active version on a date is the latest effective_from <= date. 409 if a version with the same effective_from exists.',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({
      effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      price_cents: z.number().int().min(0),
      currency: z.literal('EUR').optional(),
      allowances: z.object({}).passthrough().optional(),
      unit_rates_cents: z.object({}).passthrough().optional(),
      features: z.object({}).passthrough().optional(),
      notes: z.string().max(2000).nullable().optional(),
    }).openapi('PlanVersionCreateBody') } } },
  },
  responses: {
    200: { description: 'Version created', content: { 'application/json': { schema: SuccessResponse(PlanVersionRow) } } },
    403: { description: 'Forbidden — master role required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Plan not found', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Duplicate effective_from for this plan', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// ============================================================================
// Integrations hub (INTEG-B2 / B4) — owner+/master card states
// ============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/integrations/hub',
  tags: ['Settings'],
  security: [{ CookieAuth: [] }],
  summary: 'Integrations hub card states (owner+/master)',
  description:
    'Assembled connection state for the caller\'s locations, powering /settings/integrations-hub: ' +
    'channel_connections registry rows (glofox/unifi/sensibo/thinq/twilio_sender/bca/instagram, ' +
    'with legacy location-field fallback), xero_connections, whatsapp_numbers (read-only), ' +
    'ad_accounts presence, the customer-agent live signal, and a derived "needs attention" list ' +
    '(errors first, then tokens expiring within 10 days, then incomplete setups). ' +
    'INTEG-B3 adds a per-ORG `email` array (one entry per distinct in-scope org, deduped) for the ' +
    'Email-delivery card: { organizationId, orgName, locationIds, status (platform | connected | ' +
    'action_needed | error, derived from the org\'s tenant_email_domains lifecycle status), ' +
    'sendingDomain, fromEmail, fromName, dkimVerified, returnPathVerified, lastError, href } — ' +
    'the Postmark server token is NEVER selected or returned. ' +
    'INTEG-C4 adds a read-only `billing` array (one entry per location) for the plan & wallet strip: ' +
    'with an ACTIVE tier pinning in location_plans it carries plan {name, effectiveFrom, priceCents, addons}, ' +
    'wallet {balanceCents, periodStart, expiresOn = last day of the current Dublin month, lapseWarning} and ' +
    'per-meter MTD usage vs allowance with overage cents drawn from the wallet ledger; ' +
    'unpinned locations (all of them today) return { locationId, plan: null }. ' +
    'Secrets are never returned — no token columns are selected. ' +
    'B4 access: master sees every location; owner/org-admin (SAAS-4) sees ONLY their own ' +
    'organisation(s)\' locations (payload hard-scoped via getOwnerOrganizationIds → ' +
    '.in(organization_id)); managers/head_coach/staff get 403.',
  responses: {
    200: {
      description: 'Hub payload — per-provider card states keyed by location, the billing strip, plus the attention strip',
      content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('IntegrationsHubResponse') } },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Not an owner/org-admin/master account', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// ZOOMOPS.1 — Zoom contact sync operator surface: /settings/integrations/zoom-contacts
registry.registerPath({
  method: 'post',
  path: '/api/integrations/zoom-contacts/run',
  tags: ['Settings'],
  security: [{ CookieAuth: [] }],
  summary: 'Trigger the Zoom Phone contact sync — preview, a real run, or a guard override',
  description:
    'Calls the same runZoomContactSync() the nightly cron does, recorded to zoom_sync_runs with trigger=manual. ' +
    'Three permission tiers on one route: a PREVIEW (`dry:true`, `force` absent/false) writes nothing to Zoom and ' +
    'is open to any member of the synced organisation (ZOOM_SYNC_ORGANIZATION_ID) — manager and up; a REAL run ' +
    '(`dry:false`) and the deletion-guard OVERRIDE (`force:true`, which can ride alongside either dry value) both ' +
    'require the integrations_zoom_manage permission (owner/master by default). Membership in the synced org is ' +
    "checked via assertOrganizationAccess (the caller's location/org-admin assignments) — deliberately NOT the " +
    "caller's currently-active location, so switching the location dropdown can't flip access. `limit` caps how " +
    'many pending writes get enqueued to QStash this run (creates first); omitted, a real run enqueues everything ' +
    '— the settings-page UI defaults this control to 200 rather than blank so the unlimited path is chosen, never ' +
    "defaulted into. The guard's suppressed-delete sample is redacted to a bare count in the response for a caller " +
    'without integrations_zoom_manage; the confirmation UI reads the real numbers from the stored zoom_sync_runs ' +
    'row instead. The cron route is unchanged and keeps its own CRON_SECRET guard — this is an addition, not a ' +
    'replacement, so an authenticated browser session can never become a way around cron auth.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            dry: z.boolean().optional().openapi({ description: 'Preview only — computes the diff, enqueues nothing. Open to any org member.' }),
            limit: z.number().positive().optional().openapi({ description: 'Cap on jobs enqueued this run (creates first). Omitted = unbounded.' }),
            force: z.boolean().optional().openapi({ description: 'Bypass the deletion guard for this run. Requires integrations_zoom_manage regardless of dry.' }),
          }).openapi('ZoomContactsRunRequest'),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Sync outcome — counts, enqueued, guard verdict (sample redacted without integrations_zoom_manage), and stats',
      content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('ZoomContactsRunResponse') } },
    },
    400: { description: 'Malformed JSON body, or limit not a positive number', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Outside the synced organisation, or a real run/guard override attempted without integrations_zoom_manage', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// INTEG hub inline #4 Phase 2 — in-hub Manage (write-only) for the
// credential-bearing `locations` providers.
registry.registerPath({
  method: 'put',
  path: '/api/locations/{id}/integrations/{provider}',
  tags: ['Settings'],
  security: [{ CookieAuth: [] }],
  summary: 'Save a location integration inline (write-only secrets)',
  description:
    'Service-role save behind the Integrations-hub Manage drawer for the providers stored on the ' +
    '`locations` row: glofox, twilio, unifi, ac (Sensibo + LG ThinQ creds only), bca. ' +
    'Secrets are WRITE-ONLY — a blank or masked-echo secret KEEPS the stored value, a fresh value ' +
    'overwrites, non-secret fields set normally (src/lib/integration-secret-merge.js). The whole ' +
    'slice is NEVER collapsed to null on a blank save (the Glofox null-collapse guard), so a no-op ' +
    'save can\'t wipe a live connection. JSONB slices are read-merge-write (sibling slices untouched); ' +
    'channel_connections is re-synced IN-HANDLER via syncConnectionFromLegacy. Role gate: glofox/twilio = ' +
    'ADMIN_ROLES; unifi/ac/bca = master-only. Plus assertLocationAccess. The response is a MASKED echo ' +
    '(has_* booleans + non-secret values) — a token is never returned.',
  request: {
    params: z.object({ id: uuidLike, provider: z.enum(['glofox', 'twilio', 'unifi', 'ac', 'bca']) }),
    body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('IntegrationSaveBody') } } },
  },
  responses: {
    200: { description: 'Saved — masked echo (has_* + non-secret values)', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()) } } },
    400: { description: 'Invalid body / provider not enabled', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — role/location gate', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Unknown provider or location not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
registry.registerPath({
  method: 'delete',
  path: '/api/locations/{id}/integrations/{provider}',
  tags: ['Settings'],
  security: [{ CookieAuth: [] }],
  summary: 'Disconnect a location integration (deactivate, not delete)',
  description:
    'Explicit disconnect for the same providers: clears the legacy `locations` slice and, via ' +
    'syncConnectionFromLegacy, DEACTIVATES the channel_connections registry row (is_active=false). ' +
    'Deactivate — never a hard delete, and no provider-side revoke. Same role/location gate as PUT.',
  request: { params: z.object({ id: uuidLike, provider: z.enum(['glofox', 'twilio', 'unifi', 'ac', 'bca']) }) },
  responses: {
    200: { description: 'Disconnected (deactivated)', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — role/location gate', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Unknown provider or location not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// ============================================================================
// Tenant console (INTEG-D2) — master roster / drill-in / wallet adjust
// ============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/admin/tenants',
  tags: ['Platform Admin'],
  security: [{ CookieAuth: [] }],
  summary: 'Tenant roster with platform stat tiles (master only)',
  description:
    'One row per organization — locations count, pinned-plan summary, combined wallet balance, ' +
    'MTD usage snapshot (wa_template_send / email_send / derived ai_message) and health ' +
    '(integrations attention + stale tenant heartbeats) — plus the platform stats: MRR ' +
    '(sum of active pinned tier prices), trials (stubbed 0 until trial machinery exists), ' +
    'past-due locations (negative wallets) and wallet top-ups this Dublin month. Read-only.',
  responses: {
    200: {
      description: 'Roster payload — stats + per-org rows',
      content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('AdminTenantsRosterResponse') } },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — master role required', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/admin/tenants/{orgId}',
  tags: ['Platform Admin'],
  security: [{ CookieAuth: [] }],
  summary: 'Tenant drill-in: per-location plan, wallet, usage, health (master only)',
  description:
    'Org header plus one block per location: pinned plan version + price (null when unpinned — ' +
    'every location today), wallet balance/period + last-50 ledger entries newest-first, MTD ' +
    'meters vs plan allowances with the allowance-EXEMPT staff-assistant count as a separate ' +
    'line, integrations summary derived from the hub assembler, and stale tenant heartbeats. ' +
    '404 (not 403) for unknown org ids so they cannot be enumerated.',
  request: { params: z.object({ orgId: uuidLike }) },
  responses: {
    200: {
      description: 'Drill-in payload — org + per-location blocks',
      content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('AdminTenantDetailResponse') } },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — master role required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Organization not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/admin/tenants/wallet-adjust',
  tags: ['Platform Admin'],
  security: [{ CookieAuth: [] }],
  summary: 'Post a goodwill wallet adjustment for a location (master only)',
  description:
    'The single write action on the /admin/tenants console. Posts a signed adjustment ' +
    '(positive = credit, negative = debit, EUR cents, non-zero, within ±1,000,000 cents = ±€10,000) ' +
    'via the wallet_apply RPC — the ONLY wallet write path (append-only ledger, row-locked, ' +
    '-1000-cent grace floor enforced in SQL). A note of at least 5 characters is required; ' +
    'the ledger row records created_by = the acting master and the action is audit-logged.',
  request: {
    body: { content: { 'application/json': { schema: z.object({
      locationId: uuidLike,
      amountCents: z.number().int()
        .openapi({ description: 'Signed EUR cents. Positive = credit, negative = debit. Non-zero, |amount| <= 1,000,000.' }),
      note: z.string().min(5).max(500),
    }).openapi('AdminTenantWalletAdjustBody') } } },
  },
  responses: {
    200: {
      description: 'Adjustment applied — returns the new balance',
      content: { 'application/json': { schema: SuccessResponse(z.object({
        locationId: uuidLike,
        balanceCents: z.number().int(),
      })).openapi('AdminTenantWalletAdjustResponse') } },
    },
    400: { description: 'Validation failed or the wallet_apply RPC refused (e.g. grace-floor breach)', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — master role required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Location not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/admin/tenants/{orgId}/plans',
  tags: ['Platform Admin'],
  security: [{ CookieAuth: [] }],
  summary: 'Pin a plan version to a tenant location — the billing on-switch (master only)',
  description:
    'Pins a plan VERSION to one of the org\'s locations via a location_plans row (mig 413). ' +
    'Assigning an ACTIVE TIER is the on-switch: getLocationPlan() starts returning non-null for ' +
    'that location, engaging wallet, usage enforcement, monthly reset, meters and MRR — other ' +
    'locations stay dormant. plan_version_id is optional; it defaults to the plan\'s CURRENT ' +
    'active version. THE ONE-ACTIVE-TIER INVARIANT: assigning a tier atomically deactivates any ' +
    'existing active tier pin for the location BEFORE activating the new one (deactivate-first), ' +
    'so a location can never hold two active tiers. Add-ons are additive (multiple allowed) and ' +
    'idempotent. Cross-org / unknown location → 404 (not 403). Validates the plan is active and ' +
    'its kind matches, and that an explicit version belongs to the plan.',
  request: {
    params: z.object({ orgId: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({
      location_id: uuidLike,
      plan_id: uuidLike.optional().openapi({ description: 'Plan id — provide this or plan_slug.' }),
      plan_slug: z.string().optional().openapi({ description: 'Plan slug — alternative to plan_id.' }),
      plan_version_id: uuidLike.optional().openapi({ description: 'Specific version to pin (grandfathering). Defaults to the plan\'s current active version.' }),
      kind: z.enum(['tier', 'addon']),
    }).openapi('AdminTenantPlanAssignBody') } } },
  },
  responses: {
    200: {
      description: 'Pin created/activated — returns the resulting pin, plan and version',
      content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('AdminTenantPlanAssignResponse') } },
    },
    400: { description: 'Validation failed — inactive plan, kind mismatch, version not on plan, or no active version', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — master role required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Org, location (incl. cross-org), or plan not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/admin/tenants/{orgId}/plans',
  tags: ['Platform Admin'],
  security: [{ CookieAuth: [] }],
  summary: 'Unpin a plan from a tenant location — set dormant (master only)',
  description:
    'Deactivates a specific pin (location_plans row) for a location. Unpinning the active TIER ' +
    'returns the location to DORMANT — getLocationPlan() goes null and billing/wallet/enforcement ' +
    'switch off for it; unpinning an add-on just drops that add-on. Cross-org / unknown location ' +
    'or a pin the location never had → 404.',
  request: {
    params: z.object({ orgId: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({
      location_id: uuidLike,
      plan_version_id: uuidLike,
    }).openapi('AdminTenantPlanUnassignBody') } } },
  },
  responses: {
    200: {
      description: 'Pin deactivated',
      content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('AdminTenantPlanUnassignResponse') } },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — master role required', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Org, location (incl. cross-org), or pin not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Account (Repset ACCOUNT tier) — org portfolio roll-up (REPSET-ACCOUNT.1)
registry.registerPath({
  method: 'get',
  path: '/api/account/overview',
  tags: ['Account'],
  security: [{ CookieAuth: [] }, { BearerAuth: [] }],
  summary: 'Org portfolio roll-up (owner-of-org + master)',
  description:
    'Read-only ACCOUNT-tier roll-up across an organization\'s studios: org-level KPIs ' +
    '(members, bookings last 7 days, high-risk members) plus a per-studio breakdown with an ' +
    'attention signal (open approvals + Glofox-connected). Org-scoped: master may pass ' +
    '?organization_id (defaults to their active org); an owner is constrained to the orgs they own ' +
    'and a foreign/unknown org answers 404 (not 403). Managers/staff → 403.',
  request: {
    query: z.object({ organization_id: uuidLike.optional() }),
  },
  responses: {
    200: { description: 'Org portfolio roll-up', content: { 'application/json': { schema: z.object({}).passthrough().openapi('AccountOverviewResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Not an account-tier operator (manager / staff)', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Organisation not found / not accessible', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Hyrox Training Club (HYROX-TC.2) — generate-a-block + coach review/approve.
const HyroxBlockCreate = z.object({
  location_id: uuidLike,
  starts_on: isoDate,
  title: z.string().max(120).optional(),
  weeks: z.number().int().min(1).max(24).optional(),
  sessions_per_week: z.number().int().min(1).max(7).optional(),
  session_weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  difficulty_dial: z.enum(['beginner_heavy', 'mixed', 'competitive']).optional(),
  auto_tune_enabled: z.boolean().optional(),
  charter: z.string().max(8000).optional(),
  expand_weeks: z.number().int().min(1).max(12).optional(),
}).openapi('HyroxBlockCreate')

registry.registerPath({
  method: 'post',
  path: '/api/hyrox/blocks',
  tags: ['Hyrox'],
  security: [{ CookieAuth: [] }],
  summary: 'Generate + persist a 12-week Hyrox Training Club block (manager+)',
  description:
    'Fast path only: generates the block arc (Claude, metered via anthropicMessages) and inserts the ' +
    'hyrox_blocks row, then returns (sessionsCreated:0). Session generation is a long fan-out and runs ' +
    'per-week via POST /api/hyrox/blocks/{id}/expand (client-driven) + the rolling-expansion cron — never ' +
    'inline here, which used to time the request out.',
  request: { body: { content: { 'application/json': { schema: HyroxBlockCreate } } } },
  responses: {
    201: { description: 'Block created (sessions expanded separately)', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('HyroxBlockCreateResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — manager+ only', content: { 'application/json': { schema: ErrorResponse } } },
    502: { description: 'Arc generation failed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

const HyroxExpandWeek = z.object({ week_no: z.number().int().min(1).max(52) }).openapi('HyroxExpandWeek')

registry.registerPath({
  method: 'post',
  path: '/api/hyrox/blocks/{id}/expand',
  tags: ['Hyrox'],
  security: [{ CookieAuth: [] }],
  summary: 'Generate one week of sessions for a Hyrox block',
  description:
    'Generates the given week\'s sessions in parallel (bounded, ~one Claude call) and inserts them as ' +
    'drafts. Idempotent per (block, week): a week that already has sessions returns skipped:true. ' +
    '404-not-403 detail-route posture on a missing block or missing location permission.',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: HyroxExpandWeek } } },
  },
  responses: {
    200: { description: 'Week expanded (or skipped if already present)', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('HyroxExpandWeekResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found (missing block, or no permission at this location)', content: { 'application/json': { schema: ErrorResponse } } },
    502: { description: 'Session generation failed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/hyrox/blocks/{id}/regenerate',
  tags: ['Hyrox'],
  security: [{ CookieAuth: [] }],
  summary: 'Start a Hyrox block over with a brand-new plan (manager+)',
  description:
    'Re-runs the arc generator for a fresh 12-week plan, deletes every non-published session, and writes the ' +
    'new arc onto the block. Published sessions (potentially live on a TV) are left untouched. The arc is ' +
    'generated first, so a failed generation leaves the block fully intact. Destructive: the client confirms ' +
    'before calling. 404-not-403 detail-route posture on a missing block or missing location permission.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Block regenerated (non-published sessions cleared)', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('HyroxBlockRegenerateResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found (missing block, or no permission at this location)', content: { 'application/json': { schema: ErrorResponse } } },
    502: { description: 'Arc generation failed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

const HyroxSessionUpdate = z.object({
  focus: z.string().max(200).nullish(),
  full_session: z.record(z.string(), z.any()).optional(),
  board: z.record(z.string(), z.any()).optional(),
  status: z.enum(['draft', 'approved']).optional(),
}).openapi('HyroxSessionUpdate')

registry.registerPath({
  method: 'put',
  path: '/api/hyrox/sessions/{id}',
  tags: ['Hyrox'],
  security: [{ CookieAuth: [] }],
  summary: 'Coach edit and/or approve a generated Hyrox session',
  description:
    'Detail route: a missing session or a session at a location the caller lacks approvals_hyrox_sessions ' +
    'for both answer 404 (IDOR posture). status:"approved" stamps approved_by/approved_at; status:"draft" clears them.',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: HyroxSessionUpdate } } },
  },
  responses: {
    200: { description: 'Session updated', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('HyroxSessionUpdateResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found (missing, or no permission at this location)', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Already published', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/hyrox/sessions/{id}/regenerate',
  tags: ['Hyrox'],
  security: [{ CookieAuth: [] }],
  summary: 'Regenerate a single Hyrox session',
  description:
    'Re-runs generation for the session\'s week_no/slot against its block\'s arc + difficulty dial, ' +
    'forcing the result back to status:"draft" (approved_by/approved_at cleared) so it re-enters coach review. ' +
    'Same 404-not-403 detail-route posture as the PUT route.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Session regenerated', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('HyroxSessionRegenerateResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found (missing, or no permission at this location)', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Already published, or no arc week for this session', content: { 'application/json': { schema: ErrorResponse } } },
    502: { description: 'Regeneration failed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/hyrox/sessions/{id}/push',
  tags: ['Hyrox'],
  security: [{ CookieAuth: [] }],
  summary: 'Manually push a session\'s board to the location\'s Hyrox TV(s)',
  description:
    'Upserts tv_content (source_type:"generated") onto the location\'s active Hyrox display(s) now, the same ' +
    'way the publish cron does at class time, but on demand. Only approved/published sessions may be pushed. ' +
    'Marked triggered_by:"manual:<user>" so the cron will not auto-revert it. 404-not-403 detail-route posture.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Pushed to the TV(s)', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('HyroxSessionPushResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found (missing, or no permission at this location)', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Not approved, or no active TV at this location', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

const HyroxExampleEntry = z.object({
  id: z.string().max(64).optional(),
  source: z.enum(['pasted', 'generated']).default('pasted'),
  label: z.string().max(120).optional(),
  text: z.string().min(1).max(MAX_STORED_EXAMPLE_CHARS),
  added_at: z.string().optional(),
}).openapi('HyroxExampleEntry')

const HyroxSettingsUpdate = z.object({
  location_id: uuidLike,
  charter: z.string().max(8000).nullish(),
  house_style: z.string().max(8000).nullish(),
  style_examples: z.array(HyroxExampleEntry).max(MAX_STORED_EXAMPLES).optional(),
}).openapi('HyroxSettingsUpdate')

registry.registerPath({
  method: 'put',
  path: '/api/hyrox/settings',
  tags: ['Hyrox'],
  security: [{ CookieAuth: [] }],
  summary: 'Operator editor for the Hyrox charter, house style, and style examples',
  description:
    'Read-modify-write onto locations.settings.hyrox — merges into the sibling settings keys, never ' +
    'clobbers them. Collection-style write (location_id in the body): missing the per-location ' +
    'approvals_hyrox_sessions grant answers 403 (not the detail-routes\' 404 IDOR posture).',
  request: { body: { content: { 'application/json': { schema: HyroxSettingsUpdate } } } },
  responses: {
    200: { description: 'Settings saved', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('HyroxSettingsUpdateResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — no approvals_hyrox_sessions grant at this location', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/hyrox/sessions/{id}/exemplar',
  tags: ['Hyrox'],
  security: [{ CookieAuth: [] }],
  summary: 'Save a generated Hyrox session as a house-style example ("star as style example")',
  description:
    'Renders the session server-side via sessionToExampleText and appends it to locations.settings.hyrox.style_examples ' +
    '(dedupe by session id, capped at MAX_STORED_EXAMPLES). Detail route: a missing session or missing ' +
    'per-location approvals_hyrox_sessions grant both answer 404 (IDOR posture).',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Example added (or already saved)', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('HyroxExemplarResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found (missing session, or no permission at this location)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// ============================================================================
// Host Portal — event host's own /h/[slug] signup-page copy (HOST-GROWTH.7)
// ============================================================================

const HostListPageCopy = z.object({
  slug: z.string().optional(),
  list_headline: z.string().max(120).nullable().optional(),
  list_blurb: z.string().max(500).nullable().optional(),
  list_button_label: z.string().max(40).nullable().optional(),
  list_success_message: z.string().max(500).nullable().optional(),
}).openapi('HostListPageCopy')

const HostListPageUpdate = z.object({
  list_headline: z.string().max(120).optional(),
  list_blurb: z.string().max(500).optional(),
  list_button_label: z.string().max(40).optional(),
  list_success_message: z.string().max(500).optional(),
}).openapi('HostListPageUpdate')

registry.registerPath({
  method: 'get',
  path: '/api/host/list-page',
  tags: ['Host Portal'],
  security: [{ CookieAuth: [] }],
  summary: "Get the host's /h/[slug] signup-page copy (mig 460)",
  description: 'Host session (getCurrentHost). Returns the four nullable list_* copy columns plus slug for the session host; a null field renders the built-in default copy on the public page.',
  responses: {
    200: { description: 'Copy fields for the session host', content: { 'application/json': { schema: SuccessResponse(HostListPageCopy) } } },
    401: { description: 'Unauthorized — no host session', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/api/host/list-page',
  tags: ['Host Portal'],
  security: [{ CookieAuth: [] }],
  summary: "Update the host's /h/[slug] signup-page copy",
  description: 'Host session. Strict schema (unknown keys rejected); partial — only supplied keys are written. Each field is trimmed; an empty string clears the override back to NULL (default copy).',
  request: { body: { content: { 'application/json': { schema: HostListPageUpdate } } } },
  responses: {
    200: { description: 'Updated fields', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()) } } },
    400: { description: 'Validation failed, unknown key, or empty patch', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized — no host session', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Database update failed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// ============================================================================
// Equipment Maintenance (EQUIP-MAINT.1) — register, types + checklists,
// per-location inspection weekday. PR 1: no inspection-run routes yet.
// ============================================================================

const EquipmentChecklistItem = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  order: z.number().int().optional(),
}).openapi('EquipmentChecklistItem')

const EquipmentSettingsUpdate = z.object({
  inspectionDayOfWeek: z.number().int().min(0).max(6),
  enabled: z.boolean(),
}).openapi('EquipmentSettingsUpdate')

registry.registerPath({
  method: 'get',
  path: '/api/equipment/settings',
  tags: ['Equipment Maintenance'],
  security: [{ CookieAuth: [] }],
  summary: "Get the location's equipment inspection settings",
  description: 'The inspection weekday + feature switch for the active location, or null data if never configured. Readable by anyone with equipment_inspect.',
  responses: {
    200: { description: 'Settings, or null if unconfigured', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough().nullable()).openapi('EquipmentSettingsResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/equipment/settings',
  tags: ['Equipment Maintenance'],
  security: [{ CookieAuth: [] }],
  summary: "Upsert the location's equipment inspection settings (equipment_admin)",
  description: 'Sets the studio inspection weekday (Postgres dow, 0=Sunday) and whether the feature is enabled at this location. equipment_admin only.',
  request: { body: { content: { 'application/json': { schema: EquipmentSettingsUpdate } } } },
  responses: {
    200: { description: 'Settings saved', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('EquipmentSettingsUpdateResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — equipment_admin only', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

const EquipmentTypeCreate = z.object({
  name: z.string().min(1).max(100),
  intervalWeeks: z.number().int().min(1).max(52),
  items: z.array(EquipmentChecklistItem),
}).openapi('EquipmentTypeCreate')

const EquipmentTypeUpdate = z.object({
  name: z.string().min(1).max(100).optional(),
  intervalWeeks: z.number().int().min(1).max(52).optional(),
  items: z.array(EquipmentChecklistItem).optional(),
  enabled: z.boolean().optional(),
}).openapi('EquipmentTypeUpdate')

registry.registerPath({
  method: 'get',
  path: '/api/equipment/types',
  tags: ['Equipment Maintenance'],
  security: [{ CookieAuth: [] }],
  summary: 'List equipment types for the active location',
  description: 'Enabled types only by default; pass ?includeDisabled=1 for the full list (needed to re-enable a soft-disabled type). Readable by anyone with equipment_inspect — the walk-round needs the checklist items.',
  request: { query: z.object({ includeDisabled: z.enum(['0', '1']).optional() }) },
  responses: {
    200: { description: 'Equipment types', content: { 'application/json': { schema: SuccessResponse(z.array(z.object({}).passthrough())).openapi('EquipmentTypeListResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/equipment/types',
  tags: ['Equipment Maintenance'],
  security: [{ CookieAuth: [] }],
  summary: 'Create an equipment type (equipment_admin)',
  description: 'Checklist items are validated + renumbered by order from array position (validateItems), so a stale client-sent order can never desync the list. equipment_admin only.',
  request: { body: { content: { 'application/json': { schema: EquipmentTypeCreate } } } },
  responses: {
    200: { description: 'Type created', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('EquipmentTypeCreateResponse') } } },
    400: { description: 'Invalid checklist items (empty, duplicate id, over-long label, …)', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — equipment_admin only', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'An equipment type with that name already exists at this location', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/api/equipment/types/{id}',
  tags: ['Equipment Maintenance'],
  security: [{ CookieAuth: [] }],
  summary: 'Edit an equipment type (equipment_admin)',
  description: 'Changing intervalWeeks deliberately does NOT touch existing equipment.next_due_on — it applies from the next roll-forward. 404-not-403 detail-route posture on a type at another location. equipment_admin only.',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: EquipmentTypeUpdate } } },
  },
  responses: {
    200: { description: 'Type updated', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('EquipmentTypeUpdateResponse') } } },
    400: { description: 'Invalid checklist items, or an empty patch', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found (missing, or at another location)', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'An equipment type with that name already exists at this location', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/equipment/types/{id}',
  tags: ['Equipment Maintenance'],
  security: [{ CookieAuth: [] }],
  summary: 'Soft-disable an equipment type (equipment_admin)',
  description: 'Sets enabled:false rather than deleting — equipment.type_id is `on delete restrict`, so a hard delete would 500 once assets exist. Refused with 409 while any non-retired asset still uses the type. 404-not-403 detail-route posture.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Type disabled', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('EquipmentTypeDisableResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found (missing, or at another location)', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Equipment still uses this type — retire or re-type it first', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

const EquipmentCreate = z.object({
  typeId: z.string().min(1),
  name: z.string().min(1).max(100),
  assetTag: z.string().max(50).nullish(),
  serialNumber: z.string().max(100).nullish(),
  manufacturer: z.string().max(100).nullish(),
  zone: z.string().max(100).nullish(),
  purchaseDate: isoDate.nullish(),
  notes: z.string().max(2000).nullish(),
  firstDueOn: isoDate.nullish(),
}).openapi('EquipmentCreate')

const EquipmentUpdate = z.object({
  typeId: z.string().min(1).optional(),
  name: z.string().min(1).max(100).optional(),
  assetTag: z.string().max(50).nullish(),
  serialNumber: z.string().max(100).nullish(),
  manufacturer: z.string().max(100).nullish(),
  zone: z.string().max(100).nullish(),
  purchaseDate: isoDate.nullish(),
  notes: z.string().max(2000).nullish(),
  nextDueOn: isoDate.optional(),
  status: z.enum(['in_service', 'out_of_service']).optional(),
}).openapi('EquipmentUpdate')

registry.registerPath({
  method: 'get',
  path: '/api/equipment',
  tags: ['Equipment Maintenance'],
  security: [{ CookieAuth: [] }],
  summary: 'List the equipment register for the active location',
  description: 'Non-retired assets by default; pass ?includeRetired=1 for the full history view. Each row embeds its equipment_types (id, name, interval_weeks). Readable by anyone with equipment_inspect.',
  request: { query: z.object({ includeRetired: z.enum(['0', '1']).optional() }) },
  responses: {
    200: { description: 'Equipment rows', content: { 'application/json': { schema: SuccessResponse(z.array(z.object({}).passthrough())).openapi('EquipmentListResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/equipment',
  tags: ['Equipment Maintenance'],
  security: [{ CookieAuth: [] }],
  summary: 'Register a new equipment asset (equipment_admin)',
  description: 'next_due_on is computed server-side (firstDueOn) from the location inspection weekday — never trusted from the client — unless an operator supplies an explicit firstDueOn. The type must exist, belong to this location, and be enabled. equipment_admin only.',
  request: { body: { content: { 'application/json': { schema: EquipmentCreate } } } },
  responses: {
    200: { description: 'Asset registered', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('EquipmentCreateResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — equipment_admin only', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Equipment type not found (missing, or at another location)', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Type is disabled, or the asset tag is already in use at this location', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/equipment/{id}',
  tags: ['Equipment Maintenance'],
  security: [{ CookieAuth: [] }],
  summary: 'Get a single equipment asset',
  description: 'Embeds its equipment_types (id, name, interval_weeks, items) for use as the checklist snapshot source. 404-not-403 detail-route posture on an asset at another location.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Equipment asset', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('EquipmentDetailResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found (missing, or at another location)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/api/equipment/{id}',
  tags: ['Equipment Maintenance'],
  security: [{ CookieAuth: [] }],
  summary: 'Edit an equipment asset, or manually change its status (equipment_admin)',
  description: 'Re-typing deliberately leaves next_due_on alone — the new checklist applies to the next inspection, its interval from the next roll-forward. A manual status change also clears out_of_service_issue_id, so a later resolve of an unrelated issue on this asset is a no-op rather than a surprise return-to-service. Refused with 409 on a retired asset. equipment_admin only.',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: EquipmentUpdate } } },
  },
  responses: {
    200: { description: 'Asset updated', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('EquipmentUpdateResponse') } } },
    400: { description: 'Empty patch', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — equipment_admin only', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found (missing asset or missing new type, at another location)', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Asset is retired, or the asset tag is already in use at this location', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/equipment/{id}',
  tags: ['Equipment Maintenance'],
  security: [{ CookieAuth: [] }],
  summary: 'Retire an equipment asset (equipment_admin)',
  description: 'Sets status:"retired" rather than hard-deleting — equipment_inspections references the asset with `on delete restrict`, so a hard delete would 500 once it has inspection history. Clears out_of_service_issue_id. 404-not-403 detail-route posture.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Asset retired', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('EquipmentRetireResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found (missing, or at another location)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// ============================================================================
// Equipment Maintenance (EQUIP-MAINT.2) — the inspection run: the due
// list, draft create-or-resume, tick, and submit. PR 1 (above)
// registered the register/types/settings routes; these four complete
// the walk-round.
// ============================================================================

const InspectionTick = z.object({
  itemId: z.string().min(1),
  state: z.enum(['pass', 'fail']),
  note: z.string().trim().max(500).optional().nullable(),
}).openapi('InspectionTick')

registry.registerPath({
  method: 'get',
  path: '/api/equipment/due',
  tags: ['Equipment Maintenance'],
  security: [{ CookieAuth: [] }],
  summary: "What's due for inspection at the active location",
  description: 'Computed, not pre-generated — one indexed comparison against equipment.next_due_on, plus the assets currently out of service. `enabled:false` (with empty due/outOfService lists) when inspections have never been configured, or have been switched off, for this location. Readable by anyone with equipment_inspect.',
  responses: {
    200: { description: 'Due list + out-of-service assets', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('EquipmentDueResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/equipment/{id}/inspection',
  tags: ['Equipment Maintenance'],
  security: [{ CookieAuth: [] }],
  summary: "Create-or-resume the inspection draft for an asset's current cycle (equipment_inspect)",
  description: 'Lazily created on first open, snapshotting the type\'s checklist so a mid-walk-round type edit can\'t shift state — so an abandoned walk-round leaves a draft with ticks, not nothing. Idempotent by construction: unique (equipment_id, due_on) means a double-tap returns the same draft rather than minting a second. 404-not-403 on a cross-location asset.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'The draft (newly created, or resumed)', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('EquipmentInspectionDraftResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found (missing asset or its type, or at another location)', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Asset is not in service, the inspection for this cycle has already been submitted, or the type has no checklist items', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/api/equipment/inspections/{id}',
  tags: ['Equipment Maintenance'],
  security: [{ CookieAuth: [] }],
  summary: 'Record one pass/fail mark on a draft inspection (equipment_inspect)',
  description: "One item per request, so a dropped connection loses one tick rather than the whole walk-round. A fail requires a non-empty note. itemId must belong to this run's snapshot — a stale client can't write keys that no longer exist. 404-not-403 on a cross-location inspection.",
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: InspectionTick } } },
  },
  responses: {
    200: { description: 'The updated inspection', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('EquipmentInspectionTickResponse') } } },
    400: { description: 'itemId not part of this snapshot, or a fail submitted with no note', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found (missing, or at another location)', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'This inspection has already been submitted', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/equipment/inspections/{id}/submit',
  tags: ['Equipment Maintenance'],
  security: [{ CookieAuth: [] }],
  summary: 'Submit a completed inspection (equipment_inspect)',
  description: 'Ordering is load-bearing server-side: the fault issue (with photos) is created FIRST, then the inspection is marked submitted and the asset rolled forward — a failed issue insert leaves the inspection in draft so the inspector can retry with ticks intact. An all-pass run raises no issue; a run with any fail raises exactly one issues row carrying equipment_id and — when takeOutOfService is set — takes the asset off the floor until that issue resolves. Photos upload only here, never on the draft, since the storage path is namespaced by the issue id.',
  request: {
    params: z.object({ id: uuidLike }),
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({
            results:          z.string().openapi({ description: 'JSON-encoded { [itemId]: { state, note?, at, by } } — the full local results map, submitted alongside the individual PATCH ticks' }),
            note:              z.string().optional().openapi({ description: 'Overall note, appended to the fault report if any check failed' }),
            takeOutOfService:  z.enum(['true', 'false']).optional().openapi({ description: 'Ignored server-side unless at least one item failed' }),
            photo_0:           z.any().optional().openapi({ type: 'string', format: 'binary' }),
            photo_1:           z.any().optional().openapi({ type: 'string', format: 'binary' }),
            photo_2:           z.any().optional().openapi({ type: 'string', format: 'binary' }),
          }).openapi('EquipmentInspectionSubmitBody'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Submitted — the inspection row, the raised issueId (if any), nextDueOn, and whether the asset was taken out of service', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('EquipmentInspectionSubmitResponse') } } },
    400: { description: 'Unmarked items (a `missing` array is included), malformed results JSON, a rejected photo, or an invalid inspection interval on the type', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found (missing, or at another location)', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'This inspection has already been submitted', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Photo upload failed, or the issue insert failed (the inspection stays draft, ticks intact)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/equipment/inspections',
  tags: ['Equipment Maintenance'],
  security: [{ CookieAuth: [] }],
  summary: 'The compliance log: every submitted inspection at the active location, newest first (equipment_admin)',
  description: 'The view you put in front of an insurer or an H&S auditor — gated on equipment_admin rather than equipment_inspect because it is an oversight surface, not an operational one. Paginated with `limit`/`offset` (`limit` capped at 100): unlike the register, this table grows without bound (roughly 1,500 rows/year for a 60-asset fortnightly-cycle studio) and every `.select()` caps at 1000 rows regardless of `.limit()`. Optional `equipmentId` narrows the log to one asset\'s history. No CSV export — on-screen only, per the operator.',
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional().openapi({ description: 'Default 50, capped at 100' }),
      offset: z.coerce.number().int().min(0).optional().openapi({ description: 'Default 0' }),
      equipmentId: uuidLike.optional(),
    }),
  },
  responses: {
    200: { description: 'A page of submitted inspections, newest first, with total for pagination', content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('EquipmentInspectionLogResponse') } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// ============================================================================
// Spec generator — build once and cache
// ============================================================================
//
// Two layers of caching:
//   1. `cachedSpec` (module-level) — fastest path, hits within the
//      same lambda instance. Never expires.
//   2. `unstable_cache` — Next.js's data cache, shared across lambda
//      instances and surviving cold starts. 24h TTL since the spec
//      only changes on deploy (deploys clear the data cache anyway).
//
// The unstable_cache is the small win over the previous setup, where
// every cold-started lambda did the full generator pass on its first
// hit before populating its local module variable.

import { unstable_cache } from 'next/cache'

let cachedSpec = null

function buildSpec() {
  const generator = new OpenApiGeneratorV31(registry.definitions)
  const doc = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'UN1T CRM API',
      version: '1.1.0',
      description:
        'HTTP API for the UN1T gym CRM. Most endpoints accept either a Supabase ' +
        'session cookie (browser) or a Bearer token for n8n / external integrations — ' +
        'a per-organization `unitk_…` API key (org-scoped) or the legacy shared ' +
        'CRM_API_KEY (unscoped). Mutating endpoints validate request bodies via Zod schemas; ' +
        'invalid input returns 400 with structured `issues` array.' +
        ' Covers the public, inbound-webhook, bridge and mobile integration surface; planned outbound events appear under webhooks.',
    },
    servers: [
      { url: 'https://crm.un1tdublin.com', description: 'Production' },
      { url: 'http://localhost:3000', description: 'Local dev' },
    ],
  })
  // Outbound events we PLAN to push to subscribers. 3.1 `webhooks` keyword:
  // the API is the source; the reader implements the receiver. Not yet built.
  doc.webhooks = {
    'lead.created': {
      post: {
        tags: ['Webhooks (Outbound)'],
        summary: 'Lead created (planned)',
        description: 'PLANNED — not yet implemented. Fired when a new lead is captured. ' +
          'Your endpoint receives this payload; respond 2xx to acknowledge.',
        requestBody: {
          content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              event: { type: 'string', example: 'lead.created' },
              contact_id: { type: 'string', format: 'uuid' },
              location_id: { type: 'string', format: 'uuid' },
              created_at: { type: 'string', format: 'date-time' },
            },
          } } },
        },
        responses: { '2xx': { description: 'Acknowledged by your endpoint' } },
      },
    },
  }
  return doc
}

// unstable_cache only works inside Next.js's request runtime — calling
// it from Vitest throws because there's no AsyncLocalStorage context.
// Build a Next-cached version when we have one, fall back to a direct
// async wrapper otherwise. The module-level `cachedSpec` below covers
// in-process repeats either way.
const buildSpecCached = unstable_cache(
  async () => buildSpec(),
  ['openapi-spec'],
  { revalidate: 60 * 60 * 24, tags: ['openapi-spec'] }
)

/**
 * Build (and cache) the OpenAPI 3.1 spec object for the CRM API.
 * Returns a plain JSON-serialisable object. Safe to stringify.
 *
 * Two layers of caching:
 *   1. `cachedSpec` (module-level) — fastest path, hits within the
 *      same lambda instance. Never expires.
 *   2. `unstable_cache` — Next.js's data cache, shared across lambda
 *      instances and surviving cold starts. 24h TTL since the spec
 *      only changes on deploy (deploys clear the data cache anyway).
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
