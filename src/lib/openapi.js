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
import { WindowBase } from '@/lib/schedule/windows'

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

// GAPS-P8 — copy assist input. Deliberately narrow: the operator's own brief
// and their own draft, nothing about the audience or its contacts.
const CopyAssistRequest = z.object({
  location_id: uuidLike,
  kind: z.enum(['subject', 'body']),
  brief: z.string().max(600).optional()
    .openapi({ description: 'One or two lines from the operator on what this email is about' }),
  subject: z.string().max(500).optional().openapi({ description: 'The draft subject line, if any' }),
  body: z.string().max(200_000).optional()
    .openapi({ description: 'The draft body (HTML accepted; flattened to plain text server-side before the prompt)' }),
  count: z.number().int().min(1).max(3).optional(),
}).openapi('CopyAssistRequest')

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

// UNSUB-RL.1 / WEBVIEW.1 — the consent + hosted-copy surface. All three are
// authorised by a capability token in the path and nothing else, so they carry
// no `security` entry. Registered here because they were missing from the spec
// entirely, which is how the /api/unsubscribe rate-limit defect stayed
// invisible to anyone reading the API surface.
registry.registerPath({
  method: 'post',
  path: '/api/unsubscribe/{token}',
  tags: ['Public'],
  summary: 'One-click unsubscribe (RFC 8058)',
  description: 'Anonymous. `token` is the per-contact contact_preferences.unsubscribe_token. POSTs arrive from the recipient\'s mail provider, so this is NOT rate-limited per IP: an invalid token spends a per-IP budget, a valid one spends a generous per-token budget. A repeat opt-out is a 200 no-op. Optional `?l=` scopes the opt-out to one location; `?c=` attributes it to a campaign.',
  request: {
    params: z.object({ token: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({ channels: z.array(z.string()).optional() }).openapi('UnsubscribeChannels') } } },
  },
  responses: {
    200: { description: 'Unsubscribed (or already unsubscribed)' },
    404: { description: 'Invalid token', content: { 'application/json': { schema: ErrorResponse } } },
    429: { description: 'Rate limited', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/preferences/{token}',
  tags: ['Public'],
  summary: 'Read a contact\'s marketing preferences',
  description: 'Anonymous, authorised by the per-contact preference token.',
  request: { params: z.object({ token: uuidLike }) },
  responses: {
    200: { description: 'Current preferences and per-location lists' },
    404: { description: 'Invalid token', content: { 'application/json': { schema: ErrorResponse } } },
    429: { description: 'Rate limited', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/preferences/{token}',
  tags: ['Public'],
  summary: 'Update a contact\'s marketing preferences',
  description: 'Anonymous, authorised by the per-contact preference token. `locationId` scopes the change to one location\'s list; omitting it writes the global row, which fans out to every location.',
  request: { params: z.object({ token: uuidLike }) },
  responses: {
    200: { description: 'Preferences updated' },
    404: { description: 'Invalid token', content: { 'application/json': { schema: ErrorResponse } } },
    429: { description: 'Rate limited', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/view-email/{token}',
  tags: ['Public'],
  summary: 'Hosted "view in browser" copy of a campaign',
  description: 'Anonymous. `token` is an HMAC-signed identifier naming ONE campaign and no contact, so the page renders no recipient data and is safe to forward. Returns text/html. 404 for a bad signature, an unknown campaign, or any campaign that has not been sent.',
  request: { params: z.object({ token: z.string() }) },
  responses: {
    200: { description: 'The campaign HTML' },
    404: { description: 'Not a valid link', content: { 'text/html': { schema: z.string() } } },
  },
})

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
  method: 'post',
  path: '/api/public/offers/{slug}/checkout',
  tags: ['Public'],
  summary: 'Start a Revolut checkout for one sale offer',
  description: 'Anonymous. Rate-limited to 8 requests per IP per 15 min. Amount is read from sale_offers server-side — the body carries buyer details only. 410 once the sale window has closed.',
  responses: {
    200: { description: 'Order created; returns { purchaseId, checkout: { provider, token } }' },
    400: { description: 'Validation failed', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Unknown offer', content: { 'application/json': { schema: ErrorResponse } } },
    410: { description: 'Sale ended', content: { 'application/json': { schema: ErrorResponse } } },
    429: { description: 'Rate limited', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/public/offer-purchases/{id}',
  tags: ['Public'],
  summary: 'Paid-status of one offer purchase (checkout polling)',
  description: 'Anonymous, display-safe: returns only { paid, state }. Re-checks Revolut while pending (capped at 20 rechecks per purchase per 5 min).',
  responses: {
    200: { description: 'Status returned' },
    404: { description: 'Unknown purchase', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/offer-purchases/{id}/fulfil',
  tags: ['Approvals'],
  summary: 'Mark a paid sale-offer purchase fulfilled',
  description: 'Session auth + the approvals_offer_purchases grant. Ids outside the caller\'s locations return 404. Idempotent — re-fulfilling returns { already: true }.',
  responses: {
    200: { description: 'Fulfilled (or already fulfilled)' },
    401: { description: 'No session', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Missing approvals_offer_purchases', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Unknown or inaccessible purchase', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Purchase is not paid', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/offer-purchases/{id}/send-confirmation',
  tags: ['Approvals'],
  summary: "Send (or re-send) the buyer's purchase confirmation email",
  description: "Session auth + the approvals_offer_purchases grant. Transactional: honours the email_administrative opt-out and refuses bounced/complained addresses, but is NOT blocked by a marketing unsubscribe. The fulfil route sends this automatically; this endpoint covers purchases fulfilled before it existed and 'I never got it' re-sends. Ids outside the caller's locations return 404.",
  responses: {
    200: { description: 'Sent; returns { sent: true, to }' },
    401: { description: 'No session', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Missing approvals_offer_purchases', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Unknown or inaccessible purchase', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Not paid, or the send was skipped (reason returned)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/public/countdown.gif',
  tags: ['Public'],
  summary: 'Live sale countdown as an animated GIF (for marketing email)',
  description: 'Anonymous image endpoint. Renders the time remaining to the active sale deadline (sale_offers.ends_at — the same source as the website countdown) as a 30-frame animated GIF, re-rendered per request with caches defeated. Falls back to a 1×1 transparent GIF when no sale is active or rendering fails, so a failure never shows a broken image. NOTE: Gmail proxies and caches images, so the timer is reliable on first open only — the deadline must also appear as text in the email.',
  responses: {
    200: { description: 'image/gif — the countdown, or a 1×1 transparent pixel on fallback' },
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
  description: 'Returns the ticket (with its mailbox and linked contact) and the thread oldest-first, text bodies only. EMAIL-CC.1: each message also carries to_emails, cc_emails and bcc_emails, and the payload carries reply_recipients = { to, mode: reply | reply_all, over_cap, empty } — who a reply would reach, derived by the same code the reply route sends with, or null when that could not be worked out. EMAIL-PARTICIPANTS.4: `to` is the union of the WHOLE thread (minus the studio’s own addresses and anyone removed via PATCH /participants), not the latest message; over_cap:true means that set exceeds the 25-recipient cap and the reply route will refuse to send; empty:true means every participant has been excluded and there is nobody left to reply to. Both are refusals the composer should surface BEFORE the operator types, not send-time surprises. bcc_emails is STAFF-ONLY: this route is behind the ticket gate (location + email_inbox at that location + a grant on the ticket mailbox), it must never be rendered on a member-visible surface, and it is never an input to a later reply or forward. 404 — never 403 — when the ticket is missing, at a foreign location, or on a mailbox the caller cannot see. Does NOT mark it read; that is POST /read. EMAIL-DELIVERY.1: each OUTBOUND message also carries delivery_status (null | delivered | bounced | complained), delivery_status_at, delivery_detail and delivery_bounce_type (hard | soft | transient). NULL means sent with no provider event yet — it is NOT a failure and must never render as one.',
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
  description: "internal:true writes a staff-only note to the thread and sends NOTHING (no first_response_at, no status change) and MUST carry no recipients and no files — a note with to/cc/bcc or attachments is a 400. Otherwise the reply goes out on Postmark's transactional stream ('outbound', no marketing-consent gate — the member wrote to us first), threaded off the last inbound message, Reply-To the ticket's own mailbox; the ticket then moves to pending and stamps first_response_at if unset. A failed send leaves the ticket untouched. EMAIL-PARTICIPANTS.5 — THE RECIPIENT SET IS DERIVED, NOT CHOSEN, AND IT IS THE WHOLE THREAD: the server sends to every participant the conversation accumulated — the From + To + Cc of EVERY non-note, non-forward message on the ticket, unioned — minus the studio's own addresses and minus anyone an operator removed via PATCH /api/email/tickets/{id}/participants. It is deliberately NOT the latest message: deriving from that let whoever wrote last silently redefine the audience, and on 2026-08-12 it dropped the shared mailbox that had opened a thread out of the answer to its own question. A one-person set is a Reply and a wider one is a Reply All, with no way to express the difference on the wire. That set can now be EMPTY (every participant removed) or OVER THE CAP (more than 25 derived participants) — each is a 400 with NOTHING SENT, never a silent truncation and never a send to a set the operator did not choose. GET /api/email/tickets/{id} answers the same two flags as reply_recipients.over_cap / .empty, so the composer can say so before the operator types. `to`/`cc`/`bcc` in the body ADD people on top of the derived set; there is deliberately no way to remove one HERE — removal is the participants route, where it is a visible act with an undo. bcc_emails of earlier messages is NEVER read back as a recipient. All three lists are deduped case-insensitively across each other (To beats Cc beats Bcc) and capped at 25 addresses COMBINED. Bcc goes out in Postmark's own Bcc field, so no recipient sees it. Response carries { recipients: { to, cc, bcc }, mode }. EMAIL-OUTBOUND-ATTACH.1: `attachments` carries REFERENCES to files already uploaded via /api/email/attachments/upload-sign, never bytes — the platform rejects a body over ~4.5 MB before this handler runs. They are read back out of Storage and size-checked BEFORE the send (7 MB of raw file bytes per email, from Postmark's 10 MB post-base64 ceiling), so an oversized or unreadable set is a 400 with nothing sent and nothing written — the thread never shows a reply claiming files that did not go.",
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({
      text: z.string().min(1).max(10000),
      internal: z.boolean().optional(),
      to: z.array(z.string().email()).max(25).optional(),
      cc: z.array(z.string().email()).max(25).optional(),
      bcc: z.array(z.string().email()).max(25).optional(),
      attachments: z.array(z.object({
        draft_id: uuidLike,
        index: z.number().int().min(0).max(9),
        filename: z.string().min(1).max(255),
        mime: z.string().min(1).max(255),
      })).max(10).optional(),
    }).openapi('EmailTicketReply') } } },
  },
  responses: {
    200: { description: 'Note written / reply sent' },
    400: { description: 'Invalid body, no recipient, or the send failed', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found / not accessible', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// EMAIL-FORWARD.1 (mig 501) — pass one message on the ticket to a third party.
registry.registerPath({
  method: 'post',
  path: '/api/email/tickets/{id}/forward',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Forward one message on a ticket to somebody else',
  description: "Sends `message_id` (a message on THIS ticket) to addresses the operator types, and files the result as an OUTBOUND message on the SAME ticket carrying forwarded_message_id — the record of 'we sent this to the accountant' belongs with the correspondence it is about, and the recipient's reply threads back onto this ticket through the ordinary inbound path. THE TICKET IS DELIBERATELY NOT MOVED: no status change, no last_message_at, no first_response_at, because `needs_reply` is (open AND inbound last message) and stamping an outbound one would drop a ticket the member is still waiting on out of the queue. AN INTERNAL NOTE CANNOT BE FORWARDED — 400, since a note was never sent to anyone and mailing staff-only commentary to a third party under the studio's address is the worst thing this surface could do. RECIPIENTS ARE TYPED, NEVER DERIVED (the opposite of a reply): nothing on this route reads bcc_emails off stored correspondence, and the quoted header block is a closed list of five — From, Date, Subject, To, Cc — so a forward reveals exactly what it would have had the original's Bcc never been typed. The shared model still applies: deduped case-insensitively across To/Cc/Bcc (To beats Cc beats Bcc), the studio's own addresses excluded from all three, 25 addresses combined, Bcc in Postmark's own Bcc field only. THE BODY IS PLAIN TEXT: text_body is quoted and HTML-escaped, and the original's html_body never reaches the wire — re-sending a stranger's markup under our own DKIM signature is how forwarding launders a phish, and our sanitiser's permissiveness is bought by the sandboxed iframe the thread renders into, which a recipient's mail client is not. `attachment_ids` chooses which of the ORIGINAL'S files ride along; they are read from the bytes already in the bucket (nothing is copied to a new key), the forwarded rows point at the same storage_path with forwarded_from_id set, and the mailbox quota is not charged twice. A file with no stored bytes, an id from another message, an unreadable object, or a set past the 7 MB outbound ceiling is a 400 with NOTHING SENT — files are never silently dropped. No email_sends row is written (a forward goes to a third party, not to the member). Every address is written to audit_events under the sender's name.",
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({
      message_id: uuidLike,
      to: z.array(z.string().email()).min(1).max(25),
      cc: z.array(z.string().email()).max(25).optional(),
      bcc: z.array(z.string().email()).max(25).optional(),
      note: z.string().max(10000).optional(),
      attachment_ids: z.array(uuidLike).max(10).optional(),
    }).openapi('EmailTicketForward') } } },
  },
  responses: {
    200: { description: '{ message, message_id, recipients, forwarded_message_id, attachment_count }' },
    400: { description: 'Invalid body, an internal note, no usable recipient, an unforwardable file, or the send failed', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Ticket not accessible, or the message is not on this ticket', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'A pre-send lookup failed (nothing sent), or the forward went out but could not be filed — do NOT resend', content: { 'application/json': { schema: ErrorResponse } } },
    503: { description: 'The ticketing Postmark server is unconfigured — nothing was sent', content: { 'application/json': { schema: ErrorResponse } } },
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
  path: '/api/email/tickets/{id}/assign',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Claim, release or reassign a ticket',
  description: "EMAIL-ASSIGN.1 — who owns this ticket. assignee 'me' CLAIMS an unassigned ticket (conditional on assigned_to IS NULL, so simultaneous claims race in Postgres and the loser gets 409 already_assigned; a ticket somebody else holds is a 409 outright — taking over is an explicit elevated reassign). assignee null RELEASES your own ticket, or anybody's when elevated at the ticket's location. Any other string is a profile id: elevated-only, and the TARGET must be able to SEE the ticket (a grant on its mailbox, owner at its location, or master) — 400 assignee_cannot_see otherwise. Gated through loadTicketForUser like every ticket write: 404, never 403, for tickets outside the caller's visible set.",
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({
      assignee: z.union([z.literal('me'), z.null(), z.string().min(1).max(64)]),
    }).openapi('EmailTicketAssign') } } },
  },
  responses: {
    200: { description: 'Updated ticket + resolved assignee_name' },
    400: { description: 'Invalid body, or the target cannot see the ticket', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Releasing another’s ticket, or reassigning, without elevation', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found / not accessible', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Somebody else already holds it', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/email/tickets/{id}/assignees',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Who a ticket can be assigned to',
  description: 'EMAIL-ASSIGN.1 — feeds the elevated reassign picker: holders of a grant on the ticket’s mailbox plus owners at its location, named. Elevated-only (403) because the list enumerates colleagues’ mailbox access; sits behind loadTicketForUser’s 404 so it reveals nothing about tickets the caller cannot already see.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: '{ assignees: [{ id, full_name }] }' },
    403: { description: 'Not elevated at the ticket’s location', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found / not accessible', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/api/email/tickets/{id}/participants',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Take an address off a ticket’s reply audience, or put it back',
  description: 'EMAIL-PARTICIPANTS.6 — the only writer of email_tickets.excluded_participants (mig 534). The audience itself is NOT stored: it is derived from the thread on every read, so it cannot drift from the mail that actually arrived; only the operator’s subtractions are kept, and the reply route applies them on its next send with no other moving part. Addresses are stored NORMALISED (lowercased, angle-brackets stripped) so a case variant cannot dodge an exclusion later — and `restore` matches the same way, so an exclusion can always be lifted by whoever is looking at it. Set semantics: re-removing an already-excluded address is a no-op, not a duplicate. An address named in BOTH lists ends up removed. An address the server cannot parse is a 400 with NOTHING written — a typo in this column would be a permanent exclusion matching nobody. Gated through loadTicketForUser like every ticket write: 404, never 403, for a ticket that is missing, at a foreign location, or on a mailbox the caller cannot see.',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({
      remove: z.array(z.string()).max(25).optional(),
      restore: z.array(z.string()).max(25).optional(),
    }).openapi('EmailTicketParticipants') } } },
  },
  responses: {
    200: { description: '{ excluded_participants } — the full list after the change', content: { 'application/json': { schema: SuccessResponse(z.object({ excluded_participants: z.array(z.string()) })) } } },
    400: { description: 'Neither list given, or an address the server cannot use', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found / not accessible', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'The update failed — nothing changed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/email/tickets/{id}/merge',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Fold this ticket into another one',
  description: 'EMAIL-MERGE.4 (mig 536) — two tickets that are really one conversation, joined so a correspondent cannot be answered twice. The ticket in the path is the SOURCE and becomes a tombstone: `closed` PLUS merged_into_id, deliberately not a fifth status value, hidden from every list and count by one shared scope. Its messages are REPARENTED onto the target — that is the mechanism, not the bookkeeping, because the inbound webhook threads replies on email_inbox_messages.ticket_id, so the survivor becomes the live thread and a later reply lands there. Every moved row is stamped merged_from_ticket_id so DELETE restores exactly those and nothing else. The target absorbs the summed unread_count, the EARLIER first_response_at and the newer message’s preview. BOTH tickets go through the same gate as every other ticket route, so a missing ticket, a foreign location, a missing email_inbox key at the ticket’s location and a mailbox the caller cannot see are all 404 — as are a self-merge, a cross-location merge, a ticket already merged, and a ticket on EITHER side that has itself ALREADY ABSORBED a merge (any message carrying merged_from_ticket_id) — chains are refused so the undo stays exact, since merging a survivor onward would re-stamp the rows it absorbed and strand the earlier merge; unmerge first, then merge onward. The tombstone RETAINS its unread_count: it is a counter rather than a property of the messages, so it cannot be re-derived, and it is the record of what the survivor absorbed — inert while merged, since tombstones are hidden from the list and the badge and nothing sums the column. There is no transaction: the messages move first, the target updates second, the tombstone is stamped LAST — conditionally, on the source not already being merged, so two operators merging one ticket into different targets cannot both stamp it (the loser gets 409). An interrupted merge leaves a visibly empty but LIVE source that re-running finishes, never a hidden ticket whose mail never moved; re-running does add the source’s unread to the survivor a second time, a badge that clears the moment the ticket is opened. Attachments key on message_id and ride along untouched; email_storage_usage is NOT adjusted, because merging moves no bytes. Writes an audit_events row (business / email_ticket.merged) naming both tickets and how many messages moved — the ticket rows alone cannot tell the story, since the undo nulls merged_by.',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({ into: uuidLike }).openapi('EmailTicketMerge') } } },
  },
  responses: {
    200: { description: '{ ticket_id, merged_into_id }' },
    400: { description: 'No target given, or one that is not UUID-shaped', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Either ticket missing or not accessible, or the pair cannot be merged', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Somebody else merged this ticket first — its pointer was not overwritten', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'A step failed — the response says which, and re-running finishes the job', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/email/tickets/{id}/merge',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Undo a merge',
  description: 'EMAIL-MERGE.4 — the exact reverse, on the TOMBSTONE’s id. Moves back only the messages stamped merged_from_ticket_id = this ticket, clearing the stamp, then clears merged_into_id / merged_at / merged_by; a ticket that was never merged is a 404. Keyed on the stamp rather than on the survivor’s ticket_id, so a survivor that had its own correspondence — or had absorbed an earlier merge — does not hand it to the wrong ticket. It is a real undo, not just a move: once the rows are back, BOTH tickets have their denormalised fields REBUILT from the messages that now sit on them (last-message trio and first_response_at, skipping internal notes and forwards, clocked on created_at because an inbound sent_at is the sender’s own Date header), and the survivor gives back exactly the unread_count the tombstone retained, clamped at zero. Left alone the survivor would keep advertising a last message that has left it — a preview and a queue sort key it does not own. Same ordering discipline as the merge: the messages move back first and the pointer clears LAST, so a failed undo leaves a tombstone that can simply be unmerged again (a retried undo subtracts the unread twice, a badge that clears when the ticket is opened). BOTH tickets go through the same gate as the merge did — this route takes messages OFF the survivor and rewrites its counters, so gating only the tombstone would let a caller reshape a ticket they cannot see. Writes an audit_events row (business / email_ticket.unmerged): once merged_into_id / merged_at / merged_by are cleared the rows carry no trace that the correspondence was ever moved, so that event is the only surviving record of it. The source stays `closed`; reopening it is the status route’s job, since merging is not a status decision.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: '{ ticket_id }' },
    404: { description: 'Not found / not accessible, or not a merged ticket', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'A step failed — the response says which, and re-running finishes the job', content: { 'application/json': { schema: ErrorResponse } } },
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
      // EMAIL-OUTBOUND-ATTACH.1 — references to already-uploaded drafts, never
      // bytes. Same field and same rules as the reply route.
      attachments: z.array(z.object({
        draft_id: uuidLike,
        index: z.number().int().min(0).max(9),
        filename: z.string().min(1).max(255),
        mime: z.string().min(1).max(255),
      })).max(10).optional(),
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

// ── Outbound attachments — EMAIL-OUTBOUND-ATTACH.1 ──────────────────────────
registry.registerPath({
  method: 'post',
  path: '/api/email/attachments/upload-sign',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Authorise a browser upload for a file staff want to attach',
  description: "Step 1 of attaching a file to a ticket reply or a new email. The bytes NEVER travel through this API: Vercel rejects a request body over ~4.5 MB before a handler runs, so the browser uploads straight to the private email-attachments bucket with the one-shot token this returns, and the send request carries only { draft_id, index, filename, mime }. THE CLIENT NEVER NAMES A PATH — the key is built here as outbound/<caller's profile id>/<draft_id>/<index>.<ext>, so a session can only ever address its own drafts and can never reach the canonical <location_id>/… or the shim's inbound/… half of the bucket. Pass EXACTLY ONE of ticket_id (gated exactly as the reply route is: the ticket's location, email_inbox there, and the mailbox it arrived at must be visible) or mailbox_id (gated exactly as compose is: the mailbox's location, email_inbox there, and it must be a mailbox the caller may send as). 404 — never 403 — for every refusal. Charges no quota and writes no row: a draft becomes an attachment only when a message carrying it actually goes out.",
  request: {
    body: { content: { 'application/json': { schema: z.object({
      ticket_id: uuidLike.optional(),
      mailbox_id: uuidLike.optional(),
      draft_id: uuidLike,
      index: z.number().int().min(0).max(9),
      filename: z.string().min(1).max(255),
      mime: z.string().min(1).max(255),
      size: z.number().int().positive(),
    }).openapi('EmailAttachmentUploadSign') } } },
  },
  responses: {
    200: { description: '{ path, token } for supabase.storage.uploadToSignedUrl' },
    400: { description: 'Invalid body, both/neither target, or the file is over the 7 MB per-email ceiling', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Ticket or mailbox missing, or not usable by the caller', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Storage would not mint an upload token', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/email/attachments/discard',
  tags: ['Email'],
  security: [{ CookieAuth: [] }],
  summary: 'Throw away an uploaded draft the operator removed before sending',
  description: "The × on a chip, and the cancelled composer. Needs no ticket or mailbox: the object key is rebuilt from the CALLER'S OWN profile id, so this can only ever remove one of their own drafts and there is nothing to enumerate — another person's draft uuid simply derives a key under the caller's prefix that does not exist. Always 200, deliberately: the client calls it while tidying its own state and a storage failure is not something an operator can act on (it is logged server-side). A draft that is never discarded is never metered — quota is charged only when a message row is filed — so an abandoned one costs storage, not a mailbox's ceiling.",
  request: {
    body: { content: { 'application/json': { schema: z.object({
      draft_id: uuidLike,
      index: z.number().int().min(0).max(9),
      filename: z.string().min(1).max(255),
      mime: z.string().min(1).max(255),
    }).openapi('EmailAttachmentDiscard') } } },
  },
  responses: {
    200: { description: '{ discarded: true }' },
    400: { description: 'Invalid body', content: { 'application/json': { schema: ErrorResponse } } },
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

// DELBLOCK.1 — DELETE /api/contacts/{id}. Cookie path only (destructive
// deletes stay off the n8n API-key surface), Manager+ at the contact's
// location. Registered here for the first time because of the 409 below.
const ContactDeleteBlocker = z.object({
  table: z.string(),
  column: z.string(),
  label: z.string(),
  count: z.number().int(),
}).openapi('ContactDeleteBlocker', {
  description: 'A (table, column) that references contacts(id) with ON DELETE RESTRICT / NO ACTION and holds rows for this contact — the delete would raise a foreign-key violation.',
})

registry.registerPath({
  method: 'delete',
  path: '/api/contacts/{id}',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Delete a contact (hard delete + GDPR scrub)',
  description:
    'DELBLOCK.1 — irreversible. Scrubs the WhatsApp PII (mig 094) and hard-deletes the InBody rows, then deletes the contact; CASCADE children go with it and SET NULL children survive unlinked. Because that scrub cannot be undone, the route asks public.contact_delete_impact (mig 538) what references the contact BEFORE touching anything: a RESTRICT / NO ACTION reference (person_groups.primary_contact_id, offer_purchases.contact_id) returns 409 with the blocking rows and performs no scrub and no delete. It also FAILS CLOSED — when that check could not run (partial), it returns 503 rather than guessing, since "we did not look" is not "nothing blocks it". The 500 remains as a backstop: the check and the delete are two statements, not one transaction, so a row inserted in between still reaches the database.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Contact deleted' },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Not Manager+, or the contact is at another location', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Contact not found', content: { 'application/json': { schema: ErrorResponse } } },
    409: {
      description: 'A foreign key blocks the delete — nothing was scrubbed or deleted. `data.block_delete` names the rows to reassign or remove first.',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(false),
            error: z.string(),
            data: z.object({ block_delete: z.array(ContactDeleteBlocker) }),
          }),
        },
      },
    },
    503: {
      description: 'The blocker check could not run, so the delete was refused — nothing was scrubbed or deleted. Retryable.',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(false),
            error: z.string(),
            data: z.object({ partial: z.literal(true) }),
          }),
        },
      },
    },
    500: { description: 'The delete itself failed (backstop — e.g. a blocking row inserted after the check)', content: { 'application/json': { schema: ErrorResponse } } },
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

// REPSET-P5 — admin app-account linking (contacts.user_id ↔ auth user).
// Master/owner only; staff never self-link their member contact.
registry.registerPath({
  method: 'get',
  path: '/api/contacts/{id}/link-account',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'App-account link state, with optional exact-email auth-user search (master/owner)',
  request: {
    params: z.object({ id: uuidLike }),
    query: z.object({ email: z.string().email().optional() }),
  },
  responses: {
    200: {
      description: 'Link state (masked email only) + optional search result',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            data: z.object({
              linked: z.boolean(),
              account: z.object({ userId: uuidLike, maskedEmail: z.string().nullable(), staff: z.object({ fullName: z.string().nullable(), role: z.string() }).nullable() }).nullable(),
              search: z.object({ found: z.boolean() }).passthrough().optional(),
            }),
          }),
        },
      },
    },
    400: { description: 'Malformed email search term', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — master/owner only', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Contact not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/contacts/{id}/link-account',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Link contacts.user_id to an EXISTING auth user (master/owner; never creates auth users)',
  request: {
    params: z.object({ id: uuidLike }),
    body: {
      content: {
        'application/json': {
          schema: z.object({ userId: uuidLike, confirm: z.literal(true) }).openapi('ContactLinkAccountBody'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Linked', content: { 'application/json': { schema: z.object({ success: z.literal(true), data: z.object({}).passthrough() }) } } },
    400: { description: 'Validation error (confirm is required)', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — master/owner only', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Contact or target auth user not found', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Contact already linked (unlink first) or auth user linked to another contact', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/contacts/{id}/link-account',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Unlink a contact from its app account (master/owner)',
  request: {
    params: z.object({ id: uuidLike }),
    body: {
      content: {
        'application/json': {
          schema: z.object({ confirm: z.literal(true) }).openapi('ContactUnlinkAccountBody'),
        },
      },
    },
  },
  responses: {
    200: { description: 'Unlinked', content: { 'application/json': { schema: z.object({ success: z.literal(true), data: z.object({}).passthrough() }) } } },
    400: { description: 'Not linked / confirm missing', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — master/owner only', content: { 'application/json': { schema: ErrorResponse } } },
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
  path: '/api/admin/webhook-dead-letter',
  tags: ['Admin'],
  security: [{ CookieAuth: [] }],
  summary: 'List captured webhook dead-letter rows (master/owner only)',
  description: 'Newest 200 webhook_dead_letter rows (mig 315): events that 200\'d their provider but failed to process — unroutable/unparseable inbound email, exhausted postmark_webhook_queue rows (bounces, complaints, RFC-8058 one-click unsubscribes), sent-but-unfiled ticket mail, and glofox/inbody capture failures. Each row is annotated `replayable` (does the provider have a registered idempotent re-driver — see src/lib/webhook-replay.js). Filter with ?provider= and ?status= (pending|resolved|failed|discarded). Consumed by /admin/webhook-dead-letter.',
  request: { query: z.object({ provider: z.string().optional(), status: z.enum(['pending', 'resolved', 'failed', 'discarded']).optional() }) },
  responses: {
    200: { description: 'Dead-letter rows, newest first' },
    401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — master or owner required', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/admin/webhook-dead-letter/{id}/replay',
  tags: ['Admin'],
  security: [{ CookieAuth: [] }],
  summary: 'Manually replay one dead-letter row (master/owner only)',
  description: 'Re-drives the captured payload through the provider\'s registered idempotent re-driver. Only registry providers (inbody, postmark ingest failures) are accepted — postmark_queue, postmark_inbound and email_ticket_* are deliberately NOT replayable (re-queueing an exhausted row resets its retry budget; replaying a sent email double-sends it) and answer 400. Pending/failed rows only.',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: '{ success, status } — resolved on success' },
    400: { description: 'Provider not auto-replayable, or row discarded', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'No such row', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Row already resolved', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/admin/webhook-dead-letter/{id}/resolve',
  tags: ['Admin'],
  security: [{ CookieAuth: [] }],
  summary: 'Acknowledge one dead-letter row as handled (master/owner only)',
  description: 'The human path for the deliberately non-replayable sources (DEADLETTER-UI.1): records that the event was dealt with outside this table (resolved) or needs no action (discarded). Stamps resolved_at either way — that is what removes the row from the integration-health backlog count. Pending/failed rows only; no payload processing of any kind.',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: z.object({ status: z.enum(['resolved', 'discarded']).optional().openapi({ description: 'Default resolved' }) }).openapi('DeadLetterResolve') } } },
  },
  responses: {
    200: { description: '{ success, data: { id, status } }' },
    400: { description: 'Invalid target status', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'No such row', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Row already resolved/discarded', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/admin/webhook-dead-letter/bulk-resolve',
  tags: ['Admin'],
  security: [{ CookieAuth: [] }],
  summary: 'Acknowledge every open dead-letter row of one provider (master/owner only)',
  description: 'Bulk form of {id}/resolve, for a provider that can park a whole population behind a single cause (ZOOMSYNC.4): zoom_contact_sync parks a row per phone number, so an account-level Zoom refusal — a dropped scope, a lapsed plan, a quota — would otherwise take one click per number to clear after the credential is fixed. Updates pending/failed rows only and stamps resolved_at, exactly like the single-row route. `provider` is REQUIRED and there is no all-providers mode: a blanket clear would let a Zoom cleanup silently acknowledge an unread inbound email.',
  request: {
    body: { content: { 'application/json': { schema: z.object({
      provider: z.string().openapi({ description: 'webhook_dead_letter.provider key, e.g. zoom_contact_sync' }),
      status: z.enum(['resolved', 'discarded']).optional().openapi({ description: 'Default resolved' }),
    }).openapi('DeadLetterBulkResolve') } } },
  },
  responses: {
    200: { description: '{ success, data: { provider, status, updated } }' },
    400: { description: 'Missing provider or invalid target status', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Not master or owner', content: { 'application/json': { schema: ErrorResponse } } },
  },
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

// CONSENT.3 + GAPS-P6 — consent history feed and its CSV export
registry.registerPath({
  method: 'get',
  path: '/api/contacts/{id}/consent-log',
  tags: ['Contacts'],
  security: [{ CookieAuth: [] }],
  summary: 'Consent history for one contact (JSON feed, or CSV via ?format=csv)',
  description: "Append-only consent_log rows joined to the acting profile and the location, newest first. `?format=csv` returns the subject-access-request download (UTF-8 BOM, RFC-4180, formula-injection neutralised); the JSON feed caps at 500 rows and flags `truncated`, the CSV paginates the full history past the 1k select cap. Legacy 'opted_out'/'opted_in' rows written before mig 516 are normalised to opt_out/opt_in on read, so a report can never lose a withdrawal to a spelling. Service-role route: location-gated in app code, 404 (not 403) on cross-tenant ids.",
  request: {
    params: z.object({ id: uuidLike }),
    query: z.object({ format: z.enum(['csv']).optional() }),
  },
  responses: {
    200: { description: 'JSON feed, or a text/csv attachment when format=csv' },
    404: { description: 'Not found (incl. cross-tenant ids)', content: { 'application/json': { schema: ErrorResponse } } },
    413: { description: 'History too large to export safely — refused rather than truncated', content: { 'application/json': { schema: ErrorResponse } } },
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

// Send-time quiet hours (GAPS-P4, mig 514)
registry.registerPath({
  method: 'get',
  path: '/api/locations/{id}/send-quiet-hours',
  tags: ['Communications'],
  security: [{ CookieAuth: [] }],
  summary: 'Send-time quiet window for a location',
  description: 'Returns { enabled, start_hour, end_hour, default_start_hour, default_end_hour, can_edit } (company_settings.send_quiet_hours_*, mig 514; defaults enabled=true, 21:00 to 08:00 Europe/Dublin). ADVISORY on every MANUAL path: the composers warn when a send would land inside the window and offer the next slot outside it, and nothing an operator sends by hand is clamped, deferred or blocked. One automated reader DEFERS (SEQ-QUIET.1): the sequence runner falls back to this window for a sequence that has no send_window of its own, since no operator is watching a cron tick to read a warning. A sequence-level send_window still wins outright and the two are never merged. A location with no company_settings row returns the defaults rather than 404.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Current quiet-hours setting' },
    403: { description: 'Forbidden — no access to this location', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/locations/{id}/send-quiet-hours',
  tags: ['Communications'],
  security: [{ CookieAuth: [] }],
  summary: 'Save the send-time quiet window (owner or master)',
  description: 'Hours are 0-23, Europe/Dublin wall clock. The window is half-open [start, end): start_hour > end_hour wraps past midnight (the default 21 to 8 does). start_hour must differ from end_hour — switch enabled off instead of setting a zero-length window.',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({ enabled: z.boolean(), start_hour: z.number().int().min(0).max(23), end_hour: z.number().int().min(0).max(23) }).openapi('SendQuietHoursSave') } } },
  },
  responses: {
    200: { description: 'Quiet hours saved' },
    400: { description: 'start_hour equals end_hour, or an hour is out of range', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — owner or master', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Recipient-facing email copy (K7, mig 530)
registry.registerPath({
  method: 'get',
  path: '/api/locations/{id}/email-copy',
  tags: ['Communications'],
  security: [{ CookieAuth: [] }],
  summary: 'Operator-editable broadcast copy for a location',
  description: 'Returns { view_in_browser_label, hosted_copy_note, default_view_in_browser_label, default_hosted_copy_note, can_edit } (company_settings, mig 530). Two strings a RECIPIENT reads: the "view in browser" link prepended to every broadcast (WEBVIEW.1) and the note at the foot of the hosted web copy. Both columns are nullable and NULL means "use the code-side default" in src/lib/campaign-web-view.js, so a location with no company_settings row returns the defaults rather than 404 and needs no backfill.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Current email copy' },
    403: { description: 'Forbidden — no access to this location', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/api/locations/{id}/email-copy',
  tags: ['Communications'],
  security: [{ CookieAuth: [] }],
  summary: 'Save the broadcast copy (owner or master)',
  description: 'An EMPTY string stores NULL, which restores the default — it never ships an empty link label. Values are trimmed, capped at 120 / 400 characters (matching the CHECK constraints in mig 530) and HTML-escaped at render.',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({ view_in_browser_label: z.string().max(120), hosted_copy_note: z.string().max(400) }).openapi('EmailCopySave') } } },
  },
  responses: {
    200: { description: 'Email copy saved' },
    400: { description: 'A value is over its length cap', content: { 'application/json': { schema: ErrorResponse } } },
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

// CAMPHIST.1 — duplicate a campaign into a fresh draft. The reuse path that
// `?edit=1` was being abused as: editing a sent campaign in place leaves its
// recipients, opens and clicks describing an email that was never sent.
registry.registerPath({
  method: 'post',
  path: '/api/campaigns/{id}/duplicate',
  tags: ['Marketing'],
  security: [{ CookieAuth: [] }],
  summary: 'Duplicate a campaign into a new draft',
  description: 'Copies subject, preview text, sender fields, design, HTML, audience filter and A/B setup into a new campaign with status=draft. Carries none of the source campaign\'s recipients, counters, send timestamps, A/B outcome or resend state.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Duplicate created' },
    400: { description: 'Invalid campaign id', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'No email permission at the campaign location', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Campaign not found or not accessible', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// GAPS-P8 — AI copy assist for the composer. Session-only (it costs money per
// call), rate-limited per user and per location, capped by the per-location
// prepaid wallet (COPYCAP.1), and it fails soft: no API key, an exhausted
// wallet or an upstream error all still answer 200 with available:false so the
// composer keeps working. Nothing is applied or sent.
registry.registerPath({
  method: 'post',
  path: '/api/campaigns/copy-assist',
  tags: ['Marketing'],
  security: [{ CookieAuth: [] }],
  summary: 'Suggest alternative subject lines or body copy in the house style',
  description:
    'Takes the operator brief plus whatever they are already writing and returns a few alternatives. The model is a '
    + 'REWRITER, not a source of studio facts: everything it returns is scrubbed deterministically (em dashes via '
    + 'stripEmDashes, emoji, exclamation pile-ups, ALL-CAPS shouting) and any suggestion that invents a price, date, '
    + 'time or offer, or that surfaces class capacity, is dropped before the operator sees it. Requires the `email` '
    + 'permission at the target location, and passes the same per-location prepaid wallet check as the send paths '
    + '(checkSpend, meter ai_message) BEFORE the model is called. Suggestions are never auto-applied and never sent.',
  request: { body: { content: { 'application/json': { schema: CopyAssistRequest } } } },
  responses: {
    200: {
      description: 'Suggestions, or available:false when the assist is unconfigured, the location wallet is empty, or upstream is down',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            data: z.object({
              available: z.boolean(),
              reason: z.string().optional(),
              kind: z.enum(['subject', 'body']).optional(),
              suggestions: z.array(z.string()),
              dropped: z.array(z.object({ reason: z.string() })),
              generated_by: z.literal('model'),
              reviewed: z.literal(false),
            }),
          }),
        },
      },
    },
    400: { description: 'Nothing supplied to rewrite', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'No email permission at this location', content: { 'application/json': { schema: ErrorResponse } } },
    429: { description: 'Rate limited (20 per 15 min per user, 120 per day per location)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// COMMSFIX.F.3 (mig 510) — per-link click report. Aggregated in Postgres by
// campaign_link_click_stats; unique_clickers is the honest headline (one
// person clicking five times is not five people), total clicks sits beside it.
registry.registerPath({
  method: 'get',
  path: '/api/campaigns/{id}/links',
  tags: ['Marketing'],
  security: [{ CookieAuth: [] }],
  summary: 'Per-link click report for a campaign',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: {
      description: 'Links ordered by unique clickers, descending',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            data: z.array(z.object({
              url: z.string(),
              clicks: z.number(),
              unique_clickers: z.number(),
            })),
          }),
        },
      },
    },
    404: {
      description: 'No such campaign, or it belongs to another location (404 not 403 — ids are not enumerable)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
})

// GAPS-P2 — the outcome report. Aggregates only: a per-contact outcome list is
// a different feature with different PII implications.
registry.registerPath({
  method: 'get',
  path: '/api/campaigns/{id}/outcomes',
  tags: ['Campaigns'],
  security: [{ CookieAuth: [] }],
  summary: 'What a campaign produced, attributed through clickers, against a control cohort',
  description:
    'Counts event registrations, class attendances and DISCRETE purchases for the contacts who CLICKED a link in '
    + 'this campaign, alongside the sent-but-never-opened cohort as a control — an attributed number without a '
    + 'control is a correlation, not a result. The window opens at each contact\'s first click (send time for the '
    + 'control) and defaults to 7 days; window_days is echoed back because the answer genuinely depends on it. '
    + 'Recurring membership revenue is deliberately EXCLUDED: it runs on monthly direct debit and does not follow a '
    + 'click, so a windowed figure would credit the campaign with unrelated income. Requires access to the '
    + 'campaign\'s location; answers 404 (never 403) so ids cannot be enumerated.',
  request: {
    params: z.object({ id: uuidLike }),
    query: z.object({ window_days: z.coerce.number().int().min(1).max(90).optional() }),
  },
  responses: {
    200: { description: 'Outcome comparison', content: { 'application/json': { schema: SuccessResponse(z.object({
      window_days: z.number().int(),
      clicked: z.object({ contacts: z.number(), event_registrations: z.number(), class_attendances: z.number(), purchases: z.number(), purchase_cents: z.number() }).passthrough(),
      not_opened: z.object({ contacts: z.number(), event_registrations: z.number(), class_attendances: z.number(), purchases: z.number(), purchase_cents: z.number() }).passthrough(),
    }).openapi('CampaignOutcomeStats')) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Campaign not found, or outside the caller\'s locations', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Outcome aggregation failed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// FILTER-C.4 — the two audience routes. Both are POSTs despite being reads:
// an audience filter is a nested JSON document, and putting it in a query
// string would both blow the URL length on a real filter and put targeting
// criteria into access logs. Neither was registered here — audience-count
// predates the spec, and audience-preview (FILTER-B.6) shipped without an
// entry — so /api-docs did not show that a preview exists at all.
registry.registerPath({
  method: 'post',
  path: '/api/communications/audience-count',
  tags: ['Marketing'],
  security: [{ CookieAuth: [] }],
  summary: 'How many contacts match an audience filter, and how many would actually receive a send',
  description:
    'Counts an audience_filter at one location. WITHOUT a channel this is the raw match set at the location — no '
    + 'deliverability gate — which is the only honest answer for a sequence, whose audience is a continuing '
    + 'condition rather than a recipient list (SEQEXIT.1). WITH a channel the will-receive number comes from that '
    + "channel's own SEND builder, so the count, the preview and the send resolve one query path by construction. "
    + 'Response shape differs per channel and this is deliberate: for email and SMS, `count` is the will-receive '
    + 'number and `matched` the filter-only total; for WhatsApp, `count` is the match set and `reachable` the '
    + 'will-receive number. `excluded` breaks down WHY contacts fell out — the reasons are INDEPENDENT counts that '
    + 'may overlap, so never sum them; the true excluded total is matched minus will-receive. An invalid filter '
    + '(unknown field, off-allowlist operator, OR logic combined with a tag/event filter) answers 400, not 500 — '
    + "it is the caller's filter being wrong, not the server failing.",
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            location_id: uuidLike,
            audience_filter: audienceFilterSchema.optional(),
            channel: z.enum(['sms', 'whatsapp', 'email']).optional()
              .describe('Omit for a channel-agnostic match count (the sequence case).'),
          }).openapi('AudienceCountRequest'),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Audience counts',
      content: { 'application/json': { schema: z.object({
        success: z.literal(true),
        count: z.number().int().describe('Will-receive for email/SMS; the match set for WhatsApp and for no channel.'),
        matched: z.number().int().optional().describe('Filter-only total (email + SMS branches).'),
        reachable: z.number().int().optional().describe('Will-receive total (WhatsApp branch).'),
        suppressed: z.number().int().optional().describe('Back-compat top-level key, email only.'),
        excluded: z.record(z.string(), z.number().int()).optional()
          .describe('Independent, possibly-overlapping reason counts. Never sum them.'),
      }).openapi('AudienceCountResult') } },
    },
    400: { description: 'Invalid audience filter, or the count query failed', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Location outside the caller\'s access', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/communications/audience-preview',
  tags: ['Marketing'],
  security: [{ CookieAuth: [] }],
  summary: 'List who an audience filter selects, without sending to it',
  description:
    'The "show me who matches" spot-check. Rows come from the same per-channel SEND builder the count uses, so a '
    + 'preview cannot disagree with the send it is checking; `basis` says which question was answered — '
    + "'will_receive' with a channel (consent, status and suppression applied), 'matching' without one. "
    + 'RETURNS CUSTOMER PII, so the tenant guard answers 404 rather than 403 and location ids are not enumerable. '
    + 'The page is clamped (50 rows, hard max 200) and contact details are masked: this is a spot-check, and an '
    + 'export of a marketing audience is a different feature with different consent implications. `total` is the '
    + 'exact count and rides the same query as the page, so the two cannot disagree.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            location_id: uuidLike,
            audience_filter: audienceFilterSchema.optional(),
            channel: z.enum(['sms', 'whatsapp', 'email']).optional(),
            limit: z.number().int().positive().optional().describe('Clamped to the 200-row maximum.'),
            offset: z.number().int().min(0).optional(),
          }).openapi('AudiencePreviewRequest'),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'A masked page of matching contacts',
      content: { 'application/json': { schema: SuccessResponse(z.object({
        rows: z.array(z.object({
          id: uuidLike,
          name: z.string().nullable(),
          email: z.string().nullable().describe('Masked'),
          phone: z.string().nullable().describe('Masked'),
        }).passthrough()),
        total: z.number().int(),
        offset: z.number().int(),
        limit: z.number().int(),
        channel: z.enum(['sms', 'whatsapp', 'email']).nullable(),
        basis: z.enum(['will_receive', 'matching']),
      }).openapi('AudiencePreview')) } },
    },
    400: { description: 'Invalid audience filter, or the preview query failed', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Location outside the caller\'s access (404 not 403 — ids are not enumerable)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// GAPS-P5 (mig 515) — undo a repeat-bounce escalation. The only write surface
// the feature exposes; the decision itself is made by the nightly
// repeat-bounce-sweep cron.
registry.registerPath({
  method: 'post',
  path: '/api/communications/list-health/{id}/release',
  tags: ['Marketing'],
  security: [{ CookieAuth: [] }],
  summary: 'Undo a repeat-bounce suppression, or dismiss one flagged for review',
  description:
    'Closes the email_bounce_escalations row and, for a suppression, clears contacts.email_suppressed_at so the '
    + 'contact rejoins the marketing audience immediately. The release is recorded as release_reason=operator, '
    + 'which is permanent: the nightly sweep never re-suppresses that contact for repeat bounces again. Since '
    + 'NOENGSUP.1 (mig 537) retired engagement-based suppression, email_suppressed_at has a single meaning — repeat '
    + 'bounces — so this release no longer has the side effect of clearing an unrelated inactivity stamp. '
    + 'A review row never carried a stamp, so dismissing one '
    + 'only records that an operator looked. Requires access to the escalation\'s location; answers 404 (never 403) '
    + 'so ids cannot be enumerated. Repeating the call is a no-op that reports alreadyReleased.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Released (or already released)', content: { 'application/json': { schema: SuccessResponse(z.object({
      id: uuidLike,
      released_at: z.string().optional(),
      decision: z.enum(['suppress', 'review']).optional(),
      stampCleared: z.boolean().optional(),
      alreadyReleased: z.boolean().optional(),
    }).openapi('BounceEscalationRelease')) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'No email permission', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'No such escalation, or outside the caller\'s locations', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Release failed', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// BACKLOG-4 (mig 520) — escalate a REVIEW row to a suppression. The sweep
// deliberately never acts on review rows (the contact HAS been delivered to at
// some point, so the bounces could be a mailbox that was full for a stretch),
// which left an operator who disagreed with no way to act short of SQL.
registry.registerPath({
  method: 'post',
  path: '/api/communications/list-health/{id}/suppress',
  tags: ['Marketing'],
  security: [{ CookieAuth: [] }],
  summary: 'Suppress a contact the sweep flagged for review',
  description:
    'Closes the review row as release_reason=operator_suppressed (mig 520) and opens a NEW decision=suppress row '
    + 'carrying the stamp, rather than flipping the review row in place: the record that the rule said review must '
    + 'survive, which is the whole point of the audit table. Stamps contacts.email_suppressed_at, so the contact '
    + 'leaves the marketing audience but still receives administrative mail. The new row is releasable through the '
    + 'release endpoint like any automatic suppression, and because the review row closed as operator_suppressed '
    + 'rather than operator, the nightly sweep is NOT permanently blocked from re-evaluating the contact. Requires '
    + 'access to the escalation\'s location; answers 404 (never 403) so ids cannot be enumerated. Only a review row '
    + 'can be suppressed; calling it on a suppression is a no-op.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Suppressed (or already suppressed)', content: { 'application/json': { schema: SuccessResponse(z.object({
      id: uuidLike,
      suppressed_at: z.string().optional(),
      alreadySuppressed: z.boolean().optional(),
    }).openapi('BounceEscalationSuppress')) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'No email permission', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'No such escalation, or outside the caller\'s locations', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Suppress failed', content: { 'application/json': { schema: ErrorResponse } } },
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

// SEQGAPS.1 — manual exit for one enrolment. The operator override for when
// neither auto-exit (goal_met / left_audience) fires.
registry.registerPath({
  method: 'post',
  path: '/api/sequences/{id}/enrollments/{enrollmentId}/exit',
  tags: ['Automations'],
  security: [{ CookieAuth: [] }],
  summary: 'Exit one enrolment from a sequence by hand (exit_reason=manual_exit)',
  description:
    'Compare-and-set on status IN (active, paused): the enrolment is marked exited with '
    + "exit_reason='manual_exit' and next_step_at=null, so the scheduler never picks it up again. "
    + 'IRREVERSIBLE — there is no un-exit; re-entry means enrolling the contact again. '
    + 'Bounded honesty: the scheduler ticks every ~5 minutes and may already be mid-step for this '
    + 'enrolment, so a step already handed to the email/WhatsApp/SMS provider will still be delivered. '
    + 'This makes the database state correct; it does not recall a send in flight. '
    + 'Requires the email permission and access to the parent sequence’s location.',
  request: { params: z.object({ id: uuidLike, enrollmentId: uuidLike }) },
  responses: {
    200: {
      description: 'Exited',
      content: {
        'application/json': {
          schema: SuccessResponse(z.object({
            id: uuidLike,
            status: z.literal('exited'),
            exit_reason: z.literal('manual_exit'),
          }).openapi('SequenceEnrollmentExited')),
        },
      },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Email permission required, or the sequence is outside the caller’s locations', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Sequence or enrolment not found (404 not 403, so ids cannot be enumerated)', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'The enrolment is no longer active or paused — already exited or completed. Benign (a double-click or a cron race), not a failure.', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// SEQ-RESUME.1 — registered here by SEQGAPS.1. The route has existed since the
// 2026-07-10 comms-audit remediation but was never added to the spec, so the
// sibling of /exit was missing from /api-docs. Repo convention is that every
// route is registered; recording it now rather than leaving the pair asymmetric.
registry.registerPath({
  method: 'post',
  path: '/api/sequences/{id}/enrollments/{enrollmentId}/resume',
  tags: ['Automations'],
  security: [{ CookieAuth: [] }],
  summary: 'Resume a PAUSED enrolment (clears the error ledger, due now)',
  description:
    'Compare-and-set on status=paused: the enrolment goes active and due immediately with its '
    + 'consecutive-error count cleared — the shape the scheduler expects after MAX_ERRORS auto-paused it. '
    + 'Requires the email permission and access to the parent sequence’s location.',
  request: { params: z.object({ id: uuidLike, enrollmentId: uuidLike }) },
  responses: {
    200: { description: 'Resumed', content: { 'application/json': { schema: SuccessResponse(z.object({ id: uuidLike, status: z.literal('active') }).openapi('SequenceEnrollmentResumed')) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Email permission required, or the sequence is outside the caller’s locations', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Sequence or enrolment not found', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'The enrolment is no longer paused — a double-click or a concurrent resume.', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Sonos studio-music schedules (SONOS.6-16) — replaces the TapoDevice block
// that used to live here (deleted SONOS.14; mig 561 dropped tapo_devices).
// Same device_control permission, same Automations tag; the UI surface is
// now /automations/sonos. Response envelopes are { success, schedules } /
// { success, schedule } — matching the old Tapo routes' convention, not the
// { success, data } standard envelope. GET /household never errors past
// auth: connection/reachability trouble is reported IN a 200 body, since
// "Sonos is unreachable" is a normal state for the config page to render.
//
// SonosWindow's BASE is the shared one — WindowBase from
// @/lib/schedule/windows, the same object the route extends (SHELLY-UI.1),
// so days/on/off cannot drift between the spec and what the API accepts.
// Only the Sonos-specific extension (volume + favorite_id) is written here.
// SonosSchedulePayload is still a hand-kept mirror of the SchedulePayload
// exported from src/app/api/sonos/schedules/route.js: this file derives its
// schemas from src/lib (see file header), never from src/app/api, so keep
// those two in sync by hand.
const SonosWindow = WindowBase.extend({
  volume: z.number().int().min(0).max(100),
  favorite_id: z.string().min(1).max(128),
}).openapi('SonosWindow', {
  description: 'A recurring playback window. Enforced server-side, not representable here: on must differ '
    + 'from off, and no two windows on a schedule may overlap on a shared day — an overlapping save is '
    + 'rejected with 400 rather than silently letting the earlier window always win.',
})

const SonosSchedulePayload = z.object({
  name: z.string().min(1).max(80).optional(),
  player_ids: z.array(z.string().min(1)).max(32).optional(),
  enabled: z.boolean().optional(),
  windows: z.array(SonosWindow).max(16).optional(),
}).openapi('SonosSchedulePayload')

const SonosSchedulePatch = SonosSchedulePayload.extend({
  // Suppression only — deliberately no {state:"on"}: that would have to
  // invent a volume and a favourite, and the honest source for both is a
  // window (mig 560 column comment on sonos_schedules.override).
  override: z.object({
    state: z.literal('off'),
    until: z.string().datetime(),
  }).nullable().optional(),
}).openapi('SonosSchedulePatch')

const SonosSchedule = z.object({
  id: uuidLike,
  location_id: uuidLike,
  name: z.string(),
  player_ids: z.array(z.string()),
  enabled: z.boolean(),
  windows: z.array(SonosWindow),
  override: z.object({ state: z.literal('off'), until: z.string().datetime() }).nullable(),
  last_applied: z.object({
    window_on_at: z.number(),
    action: z.enum(['open', 'close']),
    at: z.string().datetime(),
  }).nullable(),
  last_state: z.object({
    group_id: z.string(),
    playback_state: z.string().nullable(),
    at: z.string().datetime(),
  }).nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).openapi('SonosSchedule', {
  description: 'last_applied/last_state are written by the sonos-reconcile cron (unregistered here — '
    + 'cron routes never are), so a freshly created schedule has both null.',
})

const SonosScheduleResponse = z.object({ success: z.literal(true), schedule: SonosSchedule }).openapi('SonosScheduleResponse')

const SonosGroup = z.object({
  id: z.string(),
  name: z.string(),
  coordinatorId: z.string().nullable(),
  playbackState: z.string().nullable(),
  playerIds: z.array(z.string()),
}).openapi('SonosGroup')

const SonosPlayer = z.object({
  id: z.string(),
  name: z.string(),
}).openapi('SonosPlayer')

const SonosFavorite = z.object({
  id: z.string(),
  name: z.string(),
}).openapi('SonosFavorite')

// SONOSLIVE.4/5 — live control + now-playing. Hand-duplicated from
// src/lib/sonos/actions.js (ACTIONS) and src/lib/sonos/live.js (the `code`
// tag union), same rule as the schedule schemas above: this file never
// imports from src/app/api or src/lib/sonos, so the shapes are kept here
// and updated by hand when those files change.
const SonosControlBody = z.object({
  schedule_id: z.string(),
  action: z.enum([
    'volume_up', 'volume_down', 'set_volume',
    'play', 'pause', 'skip_next', 'skip_previous', 'load_favorite',
  ]),
  value: z.union([z.number(), z.string()]).optional(),
}).openapi('SonosControlBody', {
  description: 'value is read per action: volume_up/volume_down take an optional step size (default 5, '
    + 'range 1-100, sign ignored — direction lives in the action name); set_volume takes a required integer '
    + '0-100; load_favorite takes a required non-empty favorite id. play/pause/skip_next/skip_previous '
    + 'ignore value.',
})

// The `code` tag is a stable machine-readable union runLiveAction '
// (src/lib/sonos/live.js) returns; the route maps each to the HTTP status
// below. `applied`/`failedGroups` appear only on a multi-group dispatch-
// loop failure: volume_up/volume_down are RELATIVE, not idempotent, so a
// caller must not blindly retry the whole action when `applied` already
// lists groups that changed before `failedGroups` failed — a blind retry
// would move an already-changed group a second time.
const SonosControlErrorResponse = ErrorResponse.extend({
  code: z.enum([
    'invalid', 'not_found', 'not_configured', 'not_connected', 'no_group',
    'fixed_volume', 'regrouped', 'no_content', 'rate_limited', 'unreachable',
    'db_error', 'failed',
  ]).optional()
    .describe('Present only on failures returned by the control dispatch (runLiveAction). The auth/validation '
      + 'guards that run before dispatch — no active location, a malformed body, an unusable schedule_id — '
      + 'return a 400/404 with no code at all.'),
  applied: z.array(z.string()).optional(),
  failedGroups: z.array(z.string()).optional(),
}).openapi('SonosControlErrorResponse')

const SonosTrack = z.object({
  name: z.string().nullable(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  imageUrl: z.string().nullable(),
}).openapi('SonosTrack')

const SonosNowPlayingResponse = z.union([
  z.object({
    success: z.literal(true),
    live: z.literal(false),
    reason: z.enum(['not_configured', 'not_connected', 'refresh_failed', 'db_error', 'unreachable', 'no_group']),
    statusCode: z.number().int().optional(),
  }).openapi('SonosNowPlayingOffline', {
    description: 'Deliberately a 200, not an error status — not-connected and unreachable are normal states '
      + 'the control strip renders a specific panel for, polled every 10s. statusCode is present only when '
      + 'reason is unreachable (the failed Sonos groups call\'s HTTP status).',
  }),
  z.object({
    success: z.literal(true),
    live: z.literal(true),
    groupId: z.string(),
    playbackState: z.string().nullable(),
    volume: z.number().int().nullable(),
    muted: z.boolean().nullable(),
    fixedVolume: z.boolean(),
    volumeFailed: z.boolean(),
    metadataFailed: z.boolean(),
    track: SonosTrack.nullable(),
    source: z.string().nullable(),
  }).openapi('SonosNowPlayingLive', {
    description: 'TRAP: fixedVolume:false does NOT mean "not fixed" when volumeFailed is true — the volume '
      + 'GET failed and fixedVolume just defaults to false in that case. A client must check volumeFailed '
      + 'before trusting fixedVolume (or volume/muted, which are null on the same failure). Likewise track/source '
      + 'fall back to null both when Sonos legitimately has no metadata AND when the metadata GET failed — check '
      + 'metadataFailed before reading them as "nothing playing".',
  }),
]).openapi('SonosNowPlayingResponse')

registry.registerPath({
  method: 'get',
  path: '/api/sonos/household',
  tags: ['Automations'],
  security: [{ CookieAuth: [] }],
  summary: 'Live Sonos household snapshot for the config UI (device_control)',
  description:
    'connected:false carries a reason (not_configured | not_connected | db_error | refresh_failed) and no '
    + 'groups/players/favorites. connected:true with reachable:false carries a statusCode from the failed '
    + 'Sonos groups call. connected:true with reachable:true carries groups, players and favorites — '
    + 'favorites is read off the Sonos API\'s `items` key (not `favorites`) and capped at 70 by Sonos itself.',
  responses: {
    200: {
      description: 'Household snapshot — shape varies with connected/reachable, see description',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            connected: z.boolean(),
            reason: z.enum(['not_configured', 'not_connected', 'db_error', 'refresh_failed']).optional(),
            reachable: z.boolean().optional(),
            statusCode: z.number().int().optional(),
            groups: z.array(SonosGroup).optional(),
            players: z.array(SonosPlayer).optional(),
            favorites: z.array(SonosFavorite).optional(),
          }).openapi('SonosHouseholdResponse'),
        },
      },
    },
    400: { description: 'Caller has no active location', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Missing device_control permission', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/sonos/schedules',
  tags: ['Automations'],
  security: [{ CookieAuth: [] }],
  summary: 'List Sonos schedules at the active location (device_control)',
  description: 'Ordered oldest-first, capped at 50 rows. A location that hits the cap is logged '
    + 'server-side (logWarn) but the cap is not surfaced in the response.',
  responses: {
    200: {
      description: "Schedules for the caller's active location",
      content: { 'application/json': { schema: z.object({ success: z.literal(true), schedules: z.array(SonosSchedule) }).openapi('SonosScheduleListResponse') } },
    },
    400: { description: 'Caller has no active location', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Missing device_control permission', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Database error', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/sonos/schedules',
  tags: ['Automations'],
  security: [{ CookieAuth: [] }],
  summary: 'Create a Sonos schedule at the active location (device_control)',
  description: 'Every field is optional (the row falls back to its column defaults — name "Studio music", '
    + 'enabled false, empty player_ids/windows) — the config UI sends a full shape in practice, but nothing '
    + 'here requires it.',
  request: {
    body: { content: { 'application/json': { schema: SonosSchedulePayload } } },
  },
  responses: {
    200: { description: 'Created schedule row', content: { 'application/json': { schema: SonosScheduleResponse } } },
    400: { description: 'Validation failed (bad window shape, on === off, or two windows overlap on a shared day), or the caller has no active location', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Missing device_control permission', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Database error', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/api/sonos/schedules/{id}',
  tags: ['Automations'],
  security: [{ CookieAuth: [] }],
  summary: 'Update a Sonos schedule (device_control)',
  description:
    'All body fields optional — send only what changed; an empty patch is a 400. `override` additionally '
    + 'accepts {state:"off", until} to suppress playback until a set time, or null to clear a suppression. '
    + 'Missing OR cross-location ids return 404 (no ID enumeration); the WHERE clause is scoped by '
    + 'location_id, not just the read-back, so a guessed id from another location cannot be written.',
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: SonosSchedulePatch } } },
  },
  responses: {
    200: { description: 'Updated schedule row', content: { 'application/json': { schema: SonosScheduleResponse } } },
    400: { description: 'Validation failed, no editable fields supplied, or the caller has no active location', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Missing device_control permission', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Schedule not found (or not at your active location)', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Database error', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/api/sonos/schedules/{id}',
  tags: ['Automations'],
  security: [{ CookieAuth: [] }],
  summary: 'Delete a Sonos schedule (device_control)',
  description:
    'Location-scoped in the WHERE clause. Only a malformed id 404s (anti-enumeration); a well-formed id '
    + 'for a nonexistent or cross-location row still deletes zero rows and returns 200 — PostgREST does not '
    + 'error on a no-op DELETE, so this route is idempotent rather than 404-on-already-gone.',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'Deleted (or already gone)', content: { 'application/json': { schema: z.object({ success: z.literal(true) }) } } },
    400: { description: 'Caller has no active location', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Missing device_control permission', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Malformed id', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Database error', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/sonos/schedules/{id}/run-now',
  tags: ['Automations'],
  security: [{ CookieAuth: [] }],
  summary: 'Apply the schedule\'s currently-active window immediately (device_control)',
  description:
    'SONOSLIVE.6: no longer clears last_applied and waits for the next cron tick. It now runs the same '
    + 'volume-then-favourite path the sonos-reconcile cron (unregistered here — cron routes never are) uses '
    + '(applyOpen in src/lib/sonos/apply.js) '
    + 'and stamps last_applied as an open, exactly as a cron-driven open would — immediate, and the close\'s '
    + 'precondition (a record of having opened) is written rather than destroyed. A no-op only when there is '
    + 'no active window right now, or the schedule is disabled — both now report distinctly as 409 rather '
    + 'than a silent no-op 200. On a partial dispatch failure, last_applied is deliberately NOT stamped, so '
    + 'the next cron tick retries. Missing OR cross-location ids return 404 (no ID enumeration).',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: {
      description: 'Applied. A bookkeeping failure after a successful apply still reports success, with a '
        + 'warning field, rather than telling the operator the music did not start when it did.',
      content: {
        'application/json': {
          schema: z.union([
            z.object({ success: z.literal(true), groups: z.array(z.string()) }),
            z.object({ success: z.literal(true), warning: z.string() }),
          ]).openapi('SonosRunNowResponse'),
        },
      },
    },
    400: { description: 'Caller has no active location', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Missing device_control permission', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Schedule not found (or not at your active location)', content: { 'application/json': { schema: ErrorResponse } } },
    409: {
      description: 'The current state blocks an immediate apply: the schedule is switched off, no window is '
        + 'active right now, Sonos is not connected, or none of this schedule\'s speakers are online.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: { description: 'Database error', content: { 'application/json': { schema: ErrorResponse } } },
    502: { description: 'Sonos did not answer, or the dispatch loop failed partway through', content: { 'application/json': { schema: ErrorResponse } } },
    503: { description: 'Sonos is not configured', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/sonos/control',
  tags: ['Automations'],
  security: [{ CookieAuth: [] }],
  summary: 'Immediate live control of a schedule\'s speakers — volume, transport, favourite (device_control)',
  description:
    'SONOSLIVE.3/4: writes nothing to sonos_schedules, deliberately — the schedule only acts at window '
    + 'boundaries, so a live change simply persists until the next one; there is no suppression or '
    + 'reconciliation to invent here. Works even while the schedule is disabled or overridden, on purpose: '
    + 'both of those govern whether the CRON acts, not whether a human may act right now. On failure the '
    + 'body may carry `applied`/`failedGroups` (see SonosControlErrorResponse) — check those before retrying '
    + 'a multi-group volume_up/volume_down, since retrying blind can double-apply the step to a group that '
    + 'already changed.',
  request: {
    body: { content: { 'application/json': { schema: SonosControlBody } } },
  },
  responses: {
    200: {
      description: 'Applied to every resolved group',
      content: { 'application/json': { schema: z.object({ success: z.literal(true), groups: z.array(z.string()) }).openapi('SonosControlResponse') } },
    },
    400: { description: 'Two distinct shapes. An unknown action or an unusable value for a known action comes back from dispatch and carries code: invalid. A malformed body or a caller with no active location is rejected by the guards that run BEFORE dispatch and carries no code at all — which is why code is optional on this schema.', content: { 'application/json': { schema: SonosControlErrorResponse } } },
    401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Missing device_control permission', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Schedule not found, or not at your active location (code: not_found)', content: { 'application/json': { schema: SonosControlErrorResponse } } },
    409: {
      description: 'The current state blocks this action — code distinguishes which: not_connected (Sonos '
        + 'is not connected), no_group (none of this schedule\'s speakers are online), fixed_volume (these '
        + 'speakers are set to a fixed volume), regrouped (the group changed between resolve and act — retry '
        + 'is safe), no_content (nothing is loaded on these speakers, so play/pause/skip have nothing to '
        + 'act on).',
      content: { 'application/json': { schema: SonosControlErrorResponse } },
    },
    429: { description: 'Rate limited by Sonos — try again shortly (code: rate_limited)', content: { 'application/json': { schema: SonosControlErrorResponse } } },
    500: { description: 'Database error (code: db_error)', content: { 'application/json': { schema: SonosControlErrorResponse } } },
    502: { description: 'Sonos is unreachable, or a call in the dispatch loop failed (code: unreachable or failed)', content: { 'application/json': { schema: SonosControlErrorResponse } } },
    503: { description: 'Sonos is not configured (code: not_configured)', content: { 'application/json': { schema: SonosControlErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/sonos/now-playing',
  tags: ['Automations'],
  security: [{ CookieAuth: [] }],
  summary: 'Live now-playing readout for a schedule\'s resolved speaker group (device_control)',
  description:
    'SONOSLIVE.5: not-connected and unreachable states return HTTP 200, not an error status — they are '
    + 'normal expected states the control strip renders a specific panel for (polled every 10s while a strip '
    + 'is open). Genuine auth/scoping failures (missing session, missing permission, no active location, '
    + 'unknown or cross-location schedule id) still return 401/403/400/404 as normal. See '
    + 'SonosNowPlayingLive\'s description for the volumeFailed trap.',
  request: {
    query: z.object({ schedule_id: uuidLike }),
  },
  responses: {
    200: { description: 'Offline-state or live-state readout, see SonosNowPlayingResponse', content: { 'application/json': { schema: SonosNowPlayingResponse } } },
    400: { description: 'Caller has no active location', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Missing device_control permission', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Malformed schedule_id, not found, or not at your active location', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Database error reading the schedule row', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

// Live HR
registry.registerPath({
  method: 'get',
  path: '/api/live/{locationId}',
  tags: ['Live HR'],
  security: [{ CookieAuth: [] }],
  summary: 'Current live HR sessions + available straps for a location (studio_management)',
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
    403: { description: 'Location not in scope, or studio_management not held there', content: { 'application/json': { schema: ErrorResponse } } },
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
    403: { description: 'Coach role, location scope and studio_management all required', content: { 'application/json': { schema: ErrorResponse } } },
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
    403: { description: 'Manager role, location scope and studio_management all required', content: { 'application/json': { schema: ErrorResponse } } },
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
    403: { description: 'Manager role, location scope and studio_management all required', content: { 'application/json': { schema: ErrorResponse } } },
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

// HOME.3 — the needs-attention triage queue: one merged list over the three
// surfaces an operator already checks separately (approvals, email tickets,
// the unified WhatsApp/Instagram inbox). No single `permission` gates these
// two routes — each source self-gates exactly as its own count route does
// (see src/lib/home-queue.js's header).
registry.registerPath({
  method: 'get',
  path: '/api/home-queue',
  tags: ['Dashboard'],
  security: [{ CookieAuth: [] }],
  summary: 'The needs-attention triage queue',
  description: 'Merges approvals, needs-reply email tickets and the unified WhatsApp/Instagram inbox into one sorted list. Each source is gated exactly as its own count route (approvals via the registry\'s per-provider gates, tickets via email_inbox + per-account mailbox visibility, inbox via the whatsapp permission); an ineligible source, or no active location, contributes nothing rather than erroring. Rows are pre-capped to 20 per source, merge-sorted by occurredAt descending and capped at 30 overall; counts are always the TRUE uncapped number per source, reusing each surface\'s own count query. EMAIL-TICKET-CLEANUP.2: a FAILED tickets mailbox-visibility lookup is not the same as "no tickets need a reply" — it reports counts.tickets = null (never 0) and lists `tickets` in `degraded`. A 500 here means every source degraded, not just one.',
  responses: {
    200: { description: '{ rows, counts: { approvals, tickets, inbox|null }, total, degraded? }' },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Every source degraded', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/api/home-queue/count',
  tags: ['Dashboard'],
  security: [{ CookieAuth: [] }],
  summary: 'Count of needs-attention items across approvals + tickets + inbox (nav badge)',
  description: 'Cheap sum of the same three TRUE counts GET /api/home-queue reports — no approval items, ticket subjects or conversation contacts are ever fetched. Every per-source gate mirrors the equivalent count route exactly; a session ineligible for a source contributes 0 for it, the same posture as /api/whatsapp/unread-count. HOME.3\'s sidebar retirement task made this the ONE count endpoint Sidebar.jsx polls (the per-source badge routes it used to poll — /api/approvals/count, /api/issues/count, /api/churn-radar/count, /api/lead-radar/count, /api/hosts/pending-events/count — are deleted). EMAIL-TICKET-CLEANUP.2 is the one exception to "always 200 with a number": a FAILED tickets mailbox-visibility lookup 500s rather than silently answering a lower, confidently-wrong number — the same posture /api/email/tickets/count takes on the identical failure, so the badge poller keeps its last good number instead of overwriting it with a wrong "nothing to do".',
  responses: {
    200: { description: '{ count }', content: { 'application/json': { schema: SuccessResponse(z.object({ count: z.number() })) } } },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorResponse } } },
    500: { description: 'Tickets mailbox-visibility lookup failed — NOT a zero', content: { 'application/json': { schema: ErrorResponse } } },
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
    'its kind matches, and that an explicit version belongs to the plan. TENANT.6: refuses to pin ' +
    'a version whose features carry NONE of the 8 bundle_*/module_cars keys (a pre-BUNDLES.5 ' +
    'version — pinning it as-is would silently deny every bundle at the location) unless force ' +
    'is true; see mig 548_plan_versions_bundle_backfill.sql.',
  request: {
    params: z.object({ orgId: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({
      location_id: uuidLike,
      plan_id: uuidLike.optional().openapi({ description: 'Plan id — provide this or plan_slug.' }),
      plan_slug: z.string().optional().openapi({ description: 'Plan slug — alternative to plan_id.' }),
      plan_version_id: uuidLike.optional().openapi({ description: 'Specific version to pin (grandfathering). Defaults to the plan\'s current active version.' }),
      kind: z.enum(['tier', 'addon']),
      force: z.boolean().optional().openapi({ description: 'Override the pre-bundle version guard and pin anyway. Defaults to false.' }),
    }).openapi('AdminTenantPlanAssignBody') } } },
  },
  responses: {
    200: {
      description: 'Pin created/activated — returns the resulting pin, plan and version',
      content: { 'application/json': { schema: SuccessResponse(z.object({}).passthrough()).openapi('AdminTenantPlanAssignResponse') } },
    },
    400: { description: 'Validation failed — inactive plan, kind mismatch, version not on plan, no active version, or a pre-bundle version pinned without force', content: { 'application/json': { schema: ErrorResponse } } },
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
      // CHROME.1 — platform chrome. This spec documents the PLATFORM's HTTP
      // API to integrators; it names no gym and must not carry a tenant's
      // brand. (The servers list below already leads with crm.repset.ie.)
      title: 'Repset CRM API',
      version: '1.1.0',
      description:
        'HTTP API for the Repset gym CRM. Most endpoints accept either a Supabase ' +
        'session cookie (browser) or a Bearer token for n8n / external integrations — ' +
        'a per-organization `unitk_…` API key (org-scoped) or the legacy shared ' +
        'CRM_API_KEY (unscoped). Mutating endpoints validate request bodies via Zod schemas; ' +
        'invalid input returns 400 with structured `issues` array.' +
        ' Covers the public, inbound-webhook, bridge and mobile integration surface; planned outbound events appear under webhooks.',
    },
    servers: [
      // REPSET-P6.S2 — canonical host leads; legacy host stays listed so
      // existing integrations pointed at it keep a documented base URL.
      { url: 'https://crm.repset.ie', description: 'Production' },
      { url: 'https://crm.un1tdublin.com', description: 'Production (legacy host)' },
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
