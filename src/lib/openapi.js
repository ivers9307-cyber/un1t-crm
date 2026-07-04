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
  passwordSchema,
} from './schemas.js'
import { LeadSchema } from './leads.js'

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
  description: 'CRM_API_KEY for n8n / external integrations. Sent as `Authorization: Bearer <token>`.',
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
  path: '/api/webhooks/unifi-access',
  tags: ['Webhooks (Inbound)'],
  security: [{ WebhookToken: [] }],
  summary: 'UniFi Access door events',
  description: 'UniFi Access → CRM. Carries door open/close and access events.',
  request: { body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('UnifiAccessEvent') } } } },
  responses: {
    200: { description: 'Accepted' },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/unifi-protect',
  tags: ['Webhooks (Inbound)'],
  security: [{ WebhookToken: [] }],
  summary: 'UniFi Protect events',
  description: 'UniFi Protect → CRM. Carries camera/NVR events.',
  request: { body: { content: { 'application/json': { schema: z.object({}).passthrough().openapi('UnifiProtectEvent') } } } },
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

// Google Business (operator-facing — cookie auth, owner/master gate)
registry.registerPath({
  method: 'get',
  path: '/api/google-business/status',
  tags: ['Google Business'],
  security: [{ CookieAuth: [] }],
  summary: 'Get Google Business Profile connection status for a location',
  request: {
    query: z.object({ location_id: uuidLike }),
  },
  responses: { 200: { description: 'Connection status' } },
})

registry.registerPath({
  method: 'post',
  path: '/api/google-business/select-location',
  tags: ['Google Business'],
  security: [{ CookieAuth: [] }],
  summary: 'Select a Google Business Profile listing for a location',
  responses: {
    200: { description: 'Listing selected' },
    400: { description: 'Validation failed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/google-business/disconnect',
  tags: ['Google Business'],
  security: [{ CookieAuth: [] }],
  summary: 'Disconnect Google Business Profile for a location',
  responses: { 200: { description: 'Disconnected' } },
})

registry.registerPath({
  method: 'post',
  path: '/api/google-business/sync-now',
  tags: ['Google Business'],
  security: [{ CookieAuth: [] }],
  summary: 'Trigger an immediate sync of Google reviews for a location',
  responses: { 200: { description: 'Sync triggered' } },
})

registry.registerPath({
  method: 'get',
  path: '/api/google-business/locations',
  tags: ['Google Business'],
  security: [{ CookieAuth: [] }],
  summary: 'List available Google Business Profile listings for a location',
  request: {
    query: z.object({ location_id: uuidLike }),
  },
  responses: { 200: { description: 'Listings' } },
})

registry.registerPath({
  method: 'get',
  path: '/api/google-reviews',
  tags: ['Google Business'],
  security: [{ CookieAuth: [] }],
  summary: 'List synced Google reviews for a location',
  request: {
    query: z.object({ location_id: uuidLike }),
  },
  responses: { 200: { description: 'Reviews' } },
})

registry.registerPath({
  method: 'patch',
  path: '/api/google-reviews/{id}',
  tags: ['Google Business'],
  security: [{ CookieAuth: [] }],
  summary: 'Update a Google review (e.g. toggle hidden)',
  request: {
    params: z.object({ id: uuidLike }),
  },
  responses: {
    200: { description: 'Review updated' },
    400: { description: 'Validation failed', content: { 'application/json': { schema: ErrorResponse } } },
  },
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
        'session cookie (browser) or a Bearer token (CRM_API_KEY for n8n / external ' +
        'integrations). Mutating endpoints validate request bodies via Zod schemas; ' +
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
