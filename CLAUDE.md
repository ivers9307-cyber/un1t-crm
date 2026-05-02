# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
npm run dev                      # Start dev server (localhost:3000)
npm run build                    # Next.js production build
npm start                        # Start production server
npm run lint                     # ESLint check
npm test                         # Run vitest suite once
npm run test:watch               # Re-run tests on file change
npm run check:mobile-parity      # Lint web/mobile feature parity (see "Extending")
```

Tests live alongside source as `*.test.js` (Vitest). Currently covers the security-critical lib helpers in `src/lib/` — webhook signatures, audience-filter whitelist, Zod validation, rate limiting, app URL, OpenAPI spec generation, schema invariants. ~85 tests, run in ~1.5s, no DB required (lib helpers are pure).

Migrations are run manually in Supabase SQL Editor.

## API Reference

OpenAPI 3.1 spec is generated from the Zod schemas in `src/lib/schemas.js` via `src/lib/openapi.js` and exposed at:

- `/api/openapi.json` — raw JSON spec (auth required, same as any API route)
- `/api-docs` — Swagger UI viewer (raw HTML route handler so it bypasses the app's root layout)

When adding a new route or schema, register it in `src/lib/openapi.js` so the spec stays in sync. The cached spec rebuild happens on the first request after deploy; downstream tools (Stoplight, Postman) can re-import freely.

## Architecture

UN1T CRM is a Next.js 14 App Router application with Supabase (PostgreSQL) backend, built for gym lead management and operations across multiple locations.

### Tech Stack

React 18 + Next.js 14, Tailwind CSS 3.4, Supabase Auth (SSR cookies), Postmark (email), WhatsApp Cloud API (Meta v21.0), Zod (input validation), `@asteasolutions/zod-to-openapi` (spec generation), Vitest (testing), `@dnd-kit` (pipeline kanban), lucide-react icons, clsx.

### Key Architectural Patterns

**Multi-tenancy via location scoping** — Every data query filters by `location_id`. Users belong to locations via `profile_locations` junction table. Active location resolved from cookie (`un1t_active_location`) → `is_default` flag → first location.

**Two Supabase clients** — `createBrowserClient()` uses anon key + SSR cookies (client components). `createServerClient()` uses service role key, bypasses RLS (API routes, cron). Both in `src/lib/supabase.js`.

**Auth flow** — `src/middleware.js` enforces auth on all routes except public paths (`/login`, `/reset-password`, `/book/`, `/api/public/`, `/api/webhooks/`, `/api/cron/`). External integrations (n8n) authenticate with `Authorization: Bearer <CRM_API_KEY>`; the middleware validates this constant-time with a pure-JS XOR-accumulate (Edge runtime can't import `node:crypto`). Sessions are validated against Supabase auth cookies for everything else. There is no `x-api-key` bypass anymore — anything not on the public-paths list and without a valid Bearer or session redirects to `/login`. `getCurrentUser()` in `src/lib/auth.js` returns profile + locations + activeLocation; `assertLocationAccess(user, locationId)` returns null or a 403 NextResponse for IDOR-prone routes; `getUserLocationIds(user)` returns the caller's location array.

**Input validation** — POST/PUT routes validate request bodies via `validateBody(request, schema)` from `src/lib/validate.js` against Zod schemas. Returns 400 with `{ success: false, error, issues }` on rejection. Shared schema building blocks live in `src/lib/schemas.js` (`uuidLike`, `isoDate`, `timeOfDay`, `email`, `phone`, `money`, `hours`, `days`, role/status enums, `MANAGER_ROLES`, `ADMIN_ROLES`, `DEFAULT_COLOR`, `passwordSchema`).

**Password policy** — `passwordSchema` in `src/lib/schemas.js` enforces 8+ characters with at least one lowercase letter, one uppercase letter, one digit, and one symbol. This **mirrors the password-strength settings configured in the Supabase Auth dashboard** — keeping both in sync means we surface a clear inline error before round-tripping to Supabase, instead of getting a generic `weak_password` rejection back from `auth.admin.createUser` / `auth.updateUser`. The same module exports `passwordRequirements` (an array of `{ id, label, test }`) and `validatePasswordComplexity(pw)` (returns the first failing rule's message, or `null`). `StaffForm.jsx` (staff create) and `app/reset-password/page.js` both render a live ✓/✗ checklist using these exports — when changing password rules, update the dashboard *and* the schema together so the two never drift apart.

**Role-based access (4 roles)** — `owner`, `manager`, `head_coach`, `staff`. Stored in `profiles.role`. Enforced at three layers: sidebar nav filtering (UI hint, not security), assistant tool filtering (server-side `TOOL_PERMISSIONS` table), and per-route guards (`if (!MANAGER_ROLES.includes(user.role)) return 403`). RLS additionally enforces role checks for the `pipeline_stages` and `webhook_subscriptions` tables. Use the constants `MANAGER_ROLES = ['owner', 'manager', 'head_coach']` and `ADMIN_ROLES = ['owner', 'manager']` from `src/lib/schemas.js` rather than inlining role lists.

**Permissions JSONB** — Separate from `role`. Controls sidebar visibility per user (e.g. `permissions.email = false` hides the Email link). When a user's role changes via the staff edit form, `permissions` is auto-reset to that role's defaults from `defaultPermissionsByRole` in `StaffForm.jsx`. This prevents stale owner-era permissions from sticking around after a demotion.

**Assistant bot** — `src/lib/assistant-prompt.js` defines the system prompt with CRM knowledge. `src/app/api/assistant/chat/route.js` implements tool use with permission levels per tool (`all`, `manager`, `admin`). Tools filtered before sending to Claude API based on user role. **Important:** the route derives `role`, `userId`, and `locationId` from the server session (`getCurrentUser()`), never from the client-supplied `userContext`. The client can only contribute display hints like `currentPage`.

**Audience filter whitelist** — `buildAudienceQuery()` (postmark) and `buildWhatsAppAudience()` (whatsapp) both delegate to `applyAudienceFilter()` in `src/lib/audience-filter.js`, which only allows the (field, op) combinations registered in `AUDIENCE_FIELDS`. Prevents campaign authors from filtering on arbitrary columns or smuggling PostgREST traversal paths like `profiles.role`.

**Light theme with inverted token names** — The `un1t` colour palette in `tailwind.config.js` uses inverted naming for historical reasons: `un1t-black` = #FFFFFF (white bg), `un1t-dark` = #F7F8FA (card bg), `un1t-gray` = #E2E5E9 (borders), `un1t-mid` = #94A3B8 (muted), `un1t-light` = #64748B (secondary text), `un1t-white` = #111827 (primary text), `un1t-accent` = #1E293B (button hover). All components use these tokens. Use literal `text-white` only on coloured backgrounds (bg-blue-*, bg-green-*).

**Report generation** — Shared logic in `src/lib/report-generator.js` used by both manual API route and Vercel cron (`/api/cron/run-scheduled-reports`, daily 7 AM UTC in `vercel.json`). Report types: `staff_hours`, `staff_cost`, `time_off_summary`, `roster_coverage`, `utilisation`. Period boundaries are computed in UTC; if the cron schedule is ever moved earlier than 01:00 UTC, revisit `calculatePeriodForSchedule` so "yesterday" still aligns with Dublin local time.

**Overtime / payroll math** — `src/lib/payroll.js` exposes pure functions used by both the schedule UI (capacity warning) and the `staff_cost` report (cost breakdown). Overtime is a Mon-Sun weekly concept: hours up to `profiles.contracted_hours_per_week` are regular, hours above pay at `profiles.overtime_rate` (or the implicit regular rate if `overtime_rate` is NULL — no premium). FTE-only; contractors are paid `hourly_rate` regardless of total hours. The schedule calendar shows an amber warning panel listing FTE staff at or above their contracted hours for the visible week.

**Bank holidays** — `src/lib/bank-holidays.js` holds country-keyed static public holiday data covering Ireland, UK, Germany, Australia, Kuwait, Malta, Egypt and Cyprus through 2030. The registry (`HOLIDAYS_BY_COUNTRY`) is structured so new countries are a one-line addition. Each `locations` row carries an ISO 3166-1 alpha-2 `country` code (migration 018) which drives the lookup. The schedule calendar fetches `/api/locations/[id]/holidays` which reads the location's country, merges the matching static list with custom per-location entries from `location_holidays` (migration 017), and returns them. Holidays show as amber-tinted day headers with a national or custom prefix; tooltip on hover shows the name. Admins manage custom holidays at `/settings/holidays`. Same-date custom entries override the static name (e.g. relabel St Patrick's Day → "Closed all day"). Islamic dates (KW, EG) follow the Hijri lunar calendar so dates may shift +/- 1 day from official moonsighting; managers can override with custom holidays. The `annotate()` helper de-dupes by date — rare collisions (e.g. EG 2029-04-25 = Eid al-Adha Day 2 + Sinai Liberation Day) render as a single combined entry. Visual only — no impact on cost calc.

**Mobile app (iOS, React Native via Expo)** — Lives in `mobile/` as a sibling to `src/`. Talks to the same Supabase project via `@supabase/supabase-js` + `expo-secure-store` for session persistence. Most CRUD goes direct to Supabase (RLS handles per-location scoping); orchestration calls (Postmark sends, WhatsApp broadcasts, UniFi toggles, the assistant chat, push fanout) hit the existing `/api/*` routes with `Authorization: Bearer <supabase_access_token>`. The middleware (`src/middleware.js`) recognises three Bearer-token shapes: `CRM_API_KEY` (n8n), Supabase JWT (mobile), or no Bearer + cookies (web). `getCurrentUser()` mirrors this — it tries the Bearer header first, then falls back to cookies, so existing route handlers work unchanged from mobile. Mobile's active-location override comes from an `x-active-location` request header (validated against the user's assignments — same IDOR protection as the cookie path). Mobile feature flags live under `permissions.mobile.*` on `profiles` (no schema change — JSONB allows it; defaults per role in `defaultMobilePermissionsByRole` in `StaffForm.jsx`); the iOS app reads them on login via `/api/mobile/me`. **A missing key on mobile is treated as "off"** — adding a new feature here doesn't auto-enable it for existing users. Push notifications use Expo Push Service via `src/lib/push.js`; tokens registered through `POST /api/mobile/device-tokens` (migration 023), pruned automatically when Expo reports `DeviceNotRegistered`. Per-user push preferences honour both the master `permissions.mobile.push_notifications` switch AND per-category `notify_<category>` flags (`time_off`, `schedule`, `swap`, `lead`, `whatsapp`).

**UniFi Access (door control)** — `src/lib/unifi-access.js` is a thin client over the UniFi Developer API (port 12445, Bearer token). Drives a single `unifi_door_access` toggle on staff profiles (migration 019). Per-location config (host, api_token, staff_policy_id, manager_policy_id, allow_self_signed) lives in `locations.settings.unifi`. Pre-create two access policies in UniFi per studio: a *Staff* policy (main door + physio) and a *Manager* policy (+ main office). When the toggle flips on, `PUT /api/staff/[id]` finds-or-creates the UniFi user (search by email first to avoid duplicates, then `POST /users` with the CRM profile id as `employee_number`), then assigns the policy that matches the staff member's role (`manager`/`owner` → manager policy, otherwise staff policy). A role change while the toggle is on auto-re-syncs to the new policy on save — no second click. Toggle off + staff deactivation (`DELETE /api/staff/[id]`) revoke all policies; deactivation is rejected with HTTP 502 if UniFi is unreachable so an ex-employee can't keep door access by accident. UniFi errors return `{ unifi_failed: true }` so the StaffForm bounces the toggle back; CRM and UniFi state never silently diverge. Use Cloudflare Tunnel (or similar) to expose the controller to Vercel — the `allow_self_signed` flag is only for direct-LAN/dev setups. Door-unlock audit logs stay in UniFi; the API token name is the actor (name it e.g. *UN1T CRM (Stillorgan)*).

### Modules

| Module | DB Migrations | API Routes | Lib | Key Component |
|--------|--------------|------------|-----|---------------|
| CRM/Pipeline | 001 | `/api/contacts`, `/api/deals`, `/api/stages`, `/api/notes`, `/api/activities` | — | `KanbanBoard.jsx`, `ContactActions.jsx` |
| Events/Bookings | 002 | `/api/events`, `/api/bookings`, `/api/public/book` | — | `BookingWidget.jsx`, `EventForm.jsx` |
| Timeline | 003 | — (logged by other modules) | — | — |
| Multi-tenant Auth | 004, 009 | `/api/locations`, `/api/staff` | `auth.js` | `LocationSwitcher.jsx`, `StaffForm.jsx` |
| Email Marketing | 005, 006 | `/api/campaigns`, `/api/templates`, `/api/sequences`, `/api/preferences/[token]`, `/api/unsubscribe/[token]` | `postmark.js`, `audience-filter.js` | `CampaignEditor.jsx`, `TemplateEditor.jsx`, `AudienceBuilder.jsx` |
| WhatsApp | 007, 008 | `/api/whatsapp/*` | `whatsapp.js`, `audience-filter.js` | `WAInbox.jsx`, `WABroadcastEditor.jsx` |
| Scheduling | 010, 011 | `/api/schedule/*` | — | `ScheduleCalendar.jsx` |
| HR/Reporting | 012 | `/api/schedule/reports` | `report-generator.js` | `ScheduleReporting.jsx` |
| Branding | 013 | `/api/settings/branding` | — | `BrandingSettings.jsx` |
| Security: RLS | 014, 020, 021, 022 | (DB-level only) | — | — |
| Security: Rate limit | 015 | `/api/cron/prune-rate-limits` | `rate-limit.js` | — |
| Webhooks | (cross-cutting) | `/api/webhooks/postmark`, `/api/webhooks/whatsapp` | `webhook-auth.js` | — |
| API Reference | (cross-cutting) | `/api/openapi.json`, `/api-docs` | `openapi.js` | — |
| Bank holidays | 017, 018 | `/api/locations/[id]/holidays` | `bank-holidays.js` | `HolidayManager.jsx` |
| UniFi Access | 019 | (toggle on `/api/staff/[id]`) | `unifi-access.js` | `StaffForm.jsx`, `LocationForm.jsx` |
| Mobile (iOS) | 023 | `/api/mobile/me`, `/api/mobile/device-tokens` | `push.js` | `StaffForm.jsx` (Mobile Features panel); Expo app in `mobile/` |
| Cars (processing) | 025 | `/api/cars`, `/api/cars/[id]/*` | `cars.js`, `fx.js` | `CarDetail.jsx`, `CarsList.jsx`, `CarsReports.jsx` |
| Cars deposit (Revolut) | 040, 044, 046, 047 | `/api/cars/[id]/issue-deposit-link`, `/api/public/deposit/[token]/*`, `/api/webhooks/revolut`, `/api/cars/[id]/notes` | `revolut.js`, `twilio.js`, `event-reminders.js` | `DepositCard.jsx`, `NotesCard.jsx`, `CarDepositPage.jsx`, `CarDepositSettings.jsx` |
| Sequence runner + triggers | 005, 037, 038, 039 | `/api/cron/run-sequences`, `/api/sequences/[id]/enrol` | `sequences.js`, `event-reminders.js` | `SequencePicker.jsx`, `SequenceEditor.jsx` |
| Saved contact segments | 043 | `/api/contacts/segments`, `/api/contacts/search` (POST) | — | `ContactsView.jsx` (advanced filter + saved segments) |
| Per-event reminders | 044 | (cron-driven) | `event-reminders.js` | `EventForm.jsx` (Reminder section) |

### Shared library helpers (`src/lib/`)

| File | Purpose |
|------|---------|
| `auth.js` | `getCurrentUser()`, `getUserLocationIds()`, `assertLocationAccess()`, `createAuthClient()` |
| `supabase.js` | `createBrowserClient()` (anon + cookies), `createServerClient()` (service role) |
| `api-auth.js` | `requireApiKey()` — Bearer token guard for n8n routes (constant-time compare) |
| `validate.js` | `validateBody()` (Zod-validate request bodies → 400 + issues), `uuidLike` (Postgres-permissive UUID) |
| `schemas.js` | Shared Zod building blocks + `MANAGER_ROLES`/`ADMIN_ROLES`/`DEFAULT_COLOR` constants |
| `audience-filter.js` | `applyAudienceFilter()` whitelist + `AUDIENCE_FIELDS` registry. Powers `postmark.buildAudienceQuery()` and `whatsapp.buildWhatsAppAudience()` |
| `webhook-auth.js` | `verifyMetaSignature()` (HMAC-SHA256 over raw body), `verifySharedSecret()`, `safeEqual()` |
| `rate-limit.js` | Postgres-backed fixed-window limiter; `checkRateLimit()`, `getClientIp()`, `rateLimitResponse()` |
| `app-url.js` | `getAppUrl()` (throws if env var unset), `getRequestOrigin(request)` |
| `postmark.js` | Outbound email + campaign sender; uses `audience-filter.js` |
| `whatsapp.js` | Meta Graph API client + broadcast sender; uses `audience-filter.js` |
| `report-generator.js` | Scheduled report SQL queries + period-of-the-week math |
| `assistant-prompt.js` | System prompt + tool definitions for the assistant bot |
| `openapi.js` | OpenAPI 3.1 registry + spec generator from Zod schemas |
| `bank-holidays.js` | Country-keyed static holiday lists (IE/GB/DE/AU/KW/MT/EG/CY through 2030); `mergeHolidays()` blends static + custom per-location entries |
| `unifi-access.js` | UniFi Developer API client — `findOrCreateUnifiUser()`, `syncUnifiUserPolicyForRole()`, `revokeUnifiUserPolicies()`. Uses undici dispatcher with `rejectUnauthorized:false` only when `allow_self_signed` is set on the location |
| `revolut.js` | Revolut Merchant API client — `createOrder()`, `getOrder()`, `refundOrder()`, `verifyWebhookSignature()`. Bearer auth with `Revolut-Api-Version` header pinned to 2026-03-12. **All field names + enum values verified against `merchant-2026-03-12.yaml`** in the revolut-openapi repo — `Order.state` and `capture_mode` are LOWERCASE; the SDK token field on the order response is `token` (was `public_id` in the deprecated endpoint). |
| `twilio.js` | Twilio SMS client — single `sendSms({ to, body, from })` helper, Basic auth. Sender defaults to alphanumeric ID `CCFautos` (Ireland's only viable A2P route — Twilio's Irish long codes are voice-only). `toE164Ireland()` normaliser handles common formats (`087…`, `+353…`, bare `87…`). |
| `sequences.js` | Sequence runner — `enrolContacts()`, `runSequences()` (cron), `triggerSequencesForBooking()`, `triggerSequencesForStatusChange()`, `triggerSequencesForTagsAdded()`, `runEventReminderTriggers()` (sequence-based event reminders). Audience filter respected via `contactMatchesSequenceAudience()`. |
| `event-reminders.js` | Per-event single-shot reminder runner — `runEventReminderSends()`. Reads `event_types.reminder_*` fields, finds bookings ~N min away, sends via email (Postmark transactional) or WhatsApp UTILITY template. Respects `email_administrative` / `whatsapp_administrative` consent flags (NOT marketing flags — reminders are transactional). Stamps `bookings.reminder_sent_at` for dedup. |

### Email system (`src/lib/postmark.js`)

Two streams: `broadcast` (marketing, GDPR headers) and `outbound` (transactional). `sendCampaign(id)` orchestrates audience building, batch sending (500/chunk), recipient tracking. Audience filtering goes through `applyAudienceFilter()` (whitelisted), so any (field, op) tuple the client passes that isn't in `AUDIENCE_FIELDS` throws `InvalidAudienceFilterError`. Merge tags: `{{first_name}}`, `{{last_name}}`, `{{name}}`, `{{email}}`, `{{phone}}`, `{{lead_status}}`, `{{location_name}}`, `{{unsubscribe_url}}`, `{{preference_url}}`, `{{current_year}}`. Unsubscribe URLs and preference URLs are built from `getAppUrl()`, which throws loudly if `NEXT_PUBLIC_APP_URL` is unset (no silent fallback).

### WhatsApp system (`src/lib/whatsapp.js`)

24h response window enforced — `sendTextMessage` only works in window, `sendTemplateMessage` works anytime. Broadcasts rate-limited (50 msgs, 1s delay). `buildWhatsAppAudience()` checks `whatsapp_marketing` consent. Templates use `{{1}}`, `{{2}}` variable syntax mapped to contact fields via `buildTemplateComponents()`. Inbound webhook is HMAC-verified via `verifyMetaSignature()` against `WHATSAPP_APP_SECRET` over the raw request body — read the body with `await request.text()` first, parse JSON afterwards.

## Database

22 migrations in `supabase/migrations/`. Key tables:

**Core:** `locations`, `profiles`, `profile_locations` (junction; `profiles.role` holds the role, NOT this junction), `contacts`, `deals` (linked to contacts + stages), `pipeline_stages`, `activities`, `notes`, `webhook_subscriptions`.

**Events:** `event_types`, `bookings`, `blocked_times`.

**Email:** `campaigns`, `campaign_recipients`, `email_templates`, `email_sequences`, `sequence_steps`, `sequence_enrollments`, `email_sends`, `contact_preferences` (consent + unsubscribe tokens), `consent_log`.

**WhatsApp:** `whatsapp_conversations`, `whatsapp_messages`, `whatsapp_templates`, `whatsapp_broadcasts`, `whatsapp_broadcast_recipients`.

**Scheduling:** `shifts`, `shift_templates`, `shift_swap_requests`, `time_off_requests`, `staff_allowances`, `schedule_notifications`.

**Reporting:** `generated_reports`, `scheduled_reports`.

**Infrastructure:** `rate_limit_buckets` (fixed-window counter for public endpoints, pruned daily by `/api/cron/prune-rate-limits` at 03:30 UTC).

**Settings:** `company_settings` (logo_url, favicon_url, company_name per location).

**Cars (import workflow):** `cars` — full Tesla-import row (UK + Irish prices, statuses, Xero linkage, deposit fields, buyer details). `car_documents` — uploaded docs per car (V5C, invoice, etc.) with `xero_sent_at` / `xero_send_error` for Bills auto-forward. `car_notes` — per-car timeline of operator-typed and system-generated notes (mig 047); RLS-scoped via denormalised `location_id`.

**Saved contact segments:** `contact_segments` (mig 043) — operator-saved AudienceBuilder filters for the /contacts page. `filter` JSONB shape matches `campaigns.audience_filter` so a segment can later be promoted into a campaign/sequence audience without transformation.

### Row Level Security

Migrations 014 + 020-022 enforce per-location scoping at the DB layer for all data tables. The model:

- **Service role** (used by every API route, cron, and webhook handler via `createServerClient()`) bypasses RLS — application code is the source of truth for cross-cutting logic. RLS is defence-in-depth.
- **Authenticated role** (browser-side calls via `createBrowserClient()`, e.g. `KanbanBoard`, `ContactActions`, `CampaignEditor`) is restricted by helper functions in the `private` schema:
  - `private.auth_is_in_location(uuid)` — true if the row's `location_id` is in the caller's `profile_locations`.
  - `private.auth_role()`, `private.auth_is_owner_or_manager()`, `private.auth_is_owner()` — role checks via `profiles.role`.
  - These were originally created in migration 014 in `public`; migration 022 moved them to `private` so PostgREST stops exposing them as `/rest/v1/rpc/*` endpoints. RLS keeps working because authenticated has `USAGE` on the schema and `EXECUTE` on each function (preserved across `ALTER FUNCTION ... SET SCHEMA`). When writing new RLS policies, always reference the `private.` prefix explicitly.
- **Anon role** has no direct DB access. Migration 021 dropped the legacy `Anon full access` / `Public can ...` policies on `bookings`, `event_types`, `blocked_times`. The public booking widget at `/api/public/*` uses the service role (bypasses RLS). Anon also can't list the `branding` storage bucket (migration 022); public URLs to known files still resolve because the bucket is public.
- Child tables without a direct `location_id` (`consent_log`, `campaign_recipients`, `sequence_steps`, `sequence_enrollments`, `whatsapp_broadcast_recipients`, `blocked_times`) are scoped through the parent's `location_id`.
- `pipeline_stages` is read-any-authenticated, write-owner-or-manager. `webhook_subscriptions` is owner-write.
- `rate_limit_buckets` is service-role-only with an explicit deny-all for anon/authenticated (migration 022). Service role bypasses it; the policy exists for clarity-of-intent.

Migration 014 wrote the policies but never enabled RLS — migration 020 fixed that for the 9 tables it missed (`activities`, `blocked_times`, `bookings`, `contacts`, `deals`, `event_types`, `notes`, `pipeline_stages`, `webhook_subscriptions`). Migration 021 cleaned up `search_path` on 4 trigger/utility functions and revoked RPC access from anon/authenticated on the trigger functions (`handle_new_booking`, `handle_new_user`, `log_*`, `create_contact_preferences`, `rate_limit_hit`, `rls_auto_enable`).

When adding a new table that holds tenant data, add `location_id UUID REFERENCES locations(id)`, run `ENABLE ROW LEVEL SECURITY`, and replicate the `_location_scoped` policy pattern from 014 — referencing the helpers as `private.auth_is_in_location(...)`. Don't add `USING (true)` policies.

## Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
POSTMARK_API_KEY=
POSTMARK_FROM_EMAIL=hello@un1t.ie
POSTMARK_WEBHOOK_TOKEN=          # shared secret sent in X-Webhook-Token by Postmark
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=    # optional
WHATSAPP_WEBHOOK_VERIFY_TOKEN=   # for Meta GET subscription handshake
WHATSAPP_APP_SECRET=             # for X-Hub-Signature-256 verification on POST
ANTHROPIC_API_KEY=               # for the in-app assistant chat
CRM_API_KEY=                     # Bearer token for n8n / external integrations
NEXT_PUBLIC_APP_URL=https://crm.un1tdublin.com
CRON_SECRET=                     # for Vercel cron auth
XERO_CLIENT_ID=                  # Xero OAuth 2.0 web app — see "Xero integration"
XERO_CLIENT_SECRET=
XERO_REDIRECT_URI=https://crm.un1tdublin.com/api/xero/callback
XERO_SALES_ACCOUNT_CODE=         # optional, defaults to 200 (Sales). Set if your chart uses a different code.

# Revolut Merchant — see "Revolut Merchant integration"
REVOLUT_API_KEY=                 # Secret API key (sk_live_... or sk_sandbox_...)
REVOLUT_API_BASE_URL=            # https://merchant.revolut.com (prod) or https://sandbox-merchant.revolut.com
REVOLUT_WEBHOOK_SECRET=          # signing_secret returned when creating /api/webhooks
REVOLUT_API_VERSION=2026-03-12   # optional; default in src/lib/revolut.js
NEXT_PUBLIC_REVOLUT_MODE=        # 'prod' | 'sandbox' — must match REVOLUT_API_BASE_URL
NEXT_PUBLIC_REVOLUT_PUBLIC_KEY=  # Public API key (pk_live_... or pk_sandbox_...) for the embedded checkout widget

# Twilio SMS — see "Twilio integration"
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM=CCFautos             # alphanumeric ID (Ireland) OR E.164 number OR Messaging Service SID

# Buyer-facing payment domain — see "Pay subdomain"
DEPOSIT_BASE_URL=https://pay.ccfautos.com           # used server-side when generating deposit links
NEXT_PUBLIC_DEPOSIT_BASE_URL=https://pay.ccfautos.com  # client-side mirror for operator preview links
PAY_HOSTNAME=pay.ccfautos.com    # middleware uses this to gate which paths are public on the pay host
```

## Xero integration

Per-location OAuth 2.0 connection stored in the `xero_connections` table (migration 029). The same Xero login can grant access to multiple tenants (e.g. UN1T Dublin gym + CCF Autos under one user account); each CRM location is bound to one tenant_id explicitly so we know which org to push into.

`src/lib/xero/client.js` is a hand-rolled fetch wrapper around Xero's REST + OAuth endpoints (the official `xero-node` SDK is deliberately avoided — the surface we use is small and the SDK has churn issues against Next.js). All API calls go through `withFreshToken(locationId)` which transparently refreshes the access_token if it expires within 60 seconds and persists the rotated refresh_token (Xero rotates it on every refresh — failure to persist breaks all future refreshes).

`src/lib/xero/invoices.js` implements `issueCarInvoice(car)` — the customer invoice push for completed cars. Wired to `POST /api/cars/[id]/issue-xero-invoice` and the "Issue invoice" button on `CarDetail`.

OAuth routes:
- `GET /api/xero/connect?location_id=…` — kick off OAuth (sets CSRF cookie, redirects)
- `GET /api/xero/callback` — exchange code, persist tokens, redirect to /settings/integrations
- `POST /api/xero/disconnect` — remove the connection row
- `GET /api/xero/status?location_id=…` — safe subset of the connection row (no tokens) for client UIs
- `GET /api/xero/debug` — dev-only diagnostic; dumps masked env vars + the exact authorize URL

Settings UI lives at `/settings/integrations` (`XeroLocationCard.jsx`).

### Xero OAuth scopes — granular reference

**Critical context:** Xero deprecated the broad `accounting.transactions` and `accounting.reports.read` scopes on **2 March 2026**. Apps registered on/after that date — **including ours** (registered 30 April 2026) — *cannot* request the broad scopes at all and Xero rejects the auth with a misleading `unauthorized_client / Invalid scope for client` error that doesn't actually name the bad scope. Apps registered before the cutoff have until September 2027 to migrate.

**Always use granular scopes when extending the integration.** Quick lookup table for the new scopes our app can request:

| Granular scope (use this) | Endpoints / use case | Replaces (deprecated) |
|---|---|---|
| `accounting.contacts` | Contacts (read+write). **Unchanged** — works for old + new apps. | (n/a) |
| `accounting.invoices` | Invoices, credit notes, items, purchase orders, quotes, repeating invoices, linked transactions | `accounting.transactions` |
| `accounting.payments` | Payments, batch payments, overpayments, prepayments | `accounting.transactions` |
| `accounting.banktransactions` | Bank transactions, bank transfers (reconciled ledger items, NOT bank feeds) | `accounting.transactions` |
| `accounting.manualjournals` | Manual journal entries | `accounting.transactions` |
| `accounting.classicexpenses` | Expense claims, receipts (deprecated endpoint) | `accounting.transactions` |
| `accounting.settings` | Tax rates, tracking categories, branding themes, organisation settings, items | (n/a — unchanged) |
| `accounting.attachments` | File attachments on invoices/contacts/etc | (n/a — unchanged) |
| `accounting.budgets` | Budgets | (n/a — unchanged) |
| `accounting.reports.aged.read` | Aged Payables/Receivables by Contact | `accounting.reports.read` |
| `accounting.reports.balancesheet.read` | Balance Sheet | `accounting.reports.read` |
| `accounting.reports.banksummary.read` | Bank Summary | `accounting.reports.read` |
| `accounting.reports.executivesummary.read` | Executive Summary | `accounting.reports.read` |
| `accounting.reports.profitandloss.read` | Profit & Loss | `accounting.reports.read` |
| `accounting.reports.taxreports.read` | GST / BAS reports | `accounting.reports.read` |
| `accounting.reports.trialbalance.read` | Trial Balance | `accounting.reports.read` |
| `accounting.journals.read` | Journals | (n/a — unchanged, read-only) |
| `offline_access` | Issue refresh_token (REQUIRED for any long-lived integration) | (n/a — unchanged) |

Each scope also has a `.read` variant for read-only access (e.g. `accounting.invoices.read`). Items live under both `accounting.invoices` AND `accounting.settings` — if you only touch items, use settings.

Non-Accounting APIs are unaffected by the granular split: `payroll.*`, `files`, `assets`, `projects`, `bankfeeds`, `practicemanager`, `finance`. Add them as-is when you need them.

**Do not include the OIDC scopes** (`openid`, `profile`, `email`) unless we actually start consuming the id_token for Xero-side identity. Including them on apps that haven't explicitly opted into OIDC also throws the same "Invalid scope" error. The user is already authenticated via Supabase — the access_token is all we need.

When adding a new Xero feature, append the relevant granular scope to `XERO_SCOPES` in `src/lib/xero/client.js`. Existing connected locations need to click "Reconnect" to receive the additional scope on their token (scopes are additive). The integration card on `/settings/integrations` shows the current scope grant in `connection.scopes`.

### Xero invoice push (v2) + bills auto-forward

`src/lib/xero/invoices.js` — `issueCarInvoice(car)` validates required fields, resolves the "Car" branding theme by name (overridable via `XERO_BRANDING_THEME_NAME`), upserts the buyer Contact (find-by-email → name → create; backfills missing email if matched), POSTs the AUTHORISED invoice, calls `/Invoices/{id}/Email` to email it, downloads the PDF via `Accept: application/pdf` and uploads to Supabase Storage at `cars/{id}/xero-invoice-{number}.pdf`. `voidCarInvoice(car)` POSTs the invoice with `Status: VOIDED`. `validateInvoiceFields(car)` is exported and mirrored client-side in `XeroCard` so the button can be disabled before the round-trip.

Routes:
- `POST /api/cars/[id]/issue-xero-invoice` — full issue flow
- `POST /api/cars/[id]/void-xero-invoice?reissue=true` — void + optional reissue (typical use: sale price drifted)
- `GET  /api/cars/[id]/xero-invoice-pdf` — 5-min signed URL for the saved PDF

The "Void & reissue" button only appears in `XeroCard` when `irish_sale_price_ex_vat` differs from `xero_invoice_amount` (the snapshot taken at issue time). Native `confirm()` for the warning to keep the implementation tight.

`src/lib/xero/bills-email.js` — `sendCarDocumentBillEmail(documentId)` reads the per-location `xero_connections.bills_email_address` (set in Settings → Integrations from Xero's UI under **Business → Bills to pay → Create bill from email**), pulls the PDF bytes from Supabase Storage, base64-encodes, and sends via Postmark with the PDF as an attachment. Xero auto-OCR's the inbound email and creates a draft Bill in **Business → Bills to pay → Draft** with supplier/amount/line items extracted. Subject is `<doc-label> — <car-reg>` so the resulting draft is easy to match back to the right car. No Xero scope needed for this path — it's all Postmark + Xero's email-in pipeline.

Route: `POST /api/cars/[id]/documents/[docId]/send-to-xero`. Persists `xero_sent_at` (timestamp) + `xero_file_id` (Postmark message id) + `xero_sent_by` on the `car_documents` row, and `xero_send_error` on failure. `completionGaps()` requires every required-doc-type to have at least one upload with a populated `xero_sent_at` (label suffix: " — send to Xero" when uploaded but not yet forwarded), so a car can't be promoted to completed until the AP side is captured.

`POST /api/xero/bills-email` updates `bills_email_address` on the connection row from the integrations UI. Validated as an email; null clears it.

The earlier Files API path (`src/lib/xero/files.js`) is retained as a deprecation marker only — nothing imports it. Email-to-Bills is the supported path because it doesn't require the per-org "Convert files to bills" Files Inbox toggle.

### Webhook authentication

`src/lib/webhook-auth.js` provides `verifyMetaSignature()` (HMAC-SHA256 over the raw body, used by `/api/webhooks/whatsapp`) and `verifySharedSecret()` (constant-time token compare, used by `/api/webhooks/postmark`). Both routes set `export const runtime = 'nodejs'` so `node:crypto` is available.

Rollout pattern: if the relevant secret env var is unset, the webhook is accepted with a `[security]` warning logged. Once the secret is configured (Meta App Secret / Postmark custom header), enforcement activates automatically — invalid signatures get a 403. **Always set both secrets in production.**

When adding a new webhook handler, read the body with `await request.text()` first (verify HMAC), then `JSON.parse()` — calling `request.json()` consumes the body and the re-serialised JSON won't byte-match the signed payload.

### Rate limiting

`src/lib/rate-limit.js` provides `checkRateLimit(db, key, { max, windowMs })` backed by the `rate_limit_buckets` table (migration 015). Currently wired to:

- `POST /api/public/book` — 5/15 min per IP
- `POST /api/unsubscribe/[token]` — 10/15 min per IP
- `GET/PUT /api/preferences/[token]` — 20/15 min per IP

The limiter is fail-open (DB error → request allowed, warning logged) so a Supabase blip can't take down the booking flow. Routes call `getClientIp(request)` to derive the bucket key from `x-forwarded-for`. Cron `/api/cron/prune-rate-limits` deletes expired buckets nightly at 03:30 UTC.

Add a new public endpoint? Wire the limiter at the top of the handler with a unique bucket prefix (`book:`, `unsubscribe:`, etc.) and `export const runtime = 'nodejs'` so `node:crypto` is available transitively.

## RBAC Matrix

| Capability | Owner | Manager | Head Coach | Staff |
|-----------|-------|---------|------------|-------|
| Pipeline (move deals, create contacts) | ✓ | ✓ | ✗ | ✗ |
| Manage events/campaigns | ✓ | ✓ | ✓ | ✗ |
| Create/modify shifts | ✓ | ✓ | ✓ | ✗ |
| View full roster | ✓ | ✓ | ✓ | ✓ (slim public fields only) |
| View all staff HR data (salary, employment_type, hourly_rate) | ✓ | ✓ | ✗ | ✗ |
| Approve time-off / swap requests | ✓ | ✓ | ✓ | ✗ |
| Generate reports | ✓ | ✓ | ✓ | ✗ |
| Manage staff (create / edit / deactivate) | ✓ | ✗ | ✗ | ✗ |
| Settings / branding | ✓ | ✗ | ✗ | ✗ |
| Assistant tools (write actions) | varies — see `TOOL_PERMISSIONS` in `src/app/api/assistant/chat/route.js` |
| Edit per-location feature gates (Settings → Locations → Features) | ✓ | ✗ | ✗ | ✗ |

### Master role (migration 033)

Platform-level super-admin role added above `owner`. Granted to `richard@richardivers.com` automatically on migration. Multiple masters allowed — they can promote each other.

**Powers** (enforced server-side at every gate):
- Create new locations (`/settings/locations/new` is master-only; "Add Location" button on Settings hub hidden from non-masters)
- Create or promote staff to `owner` or `master` (POST `/api/staff` returns 403 to non-masters trying to grant either role)
- Bypass per-user permission denials — `hasPermission(user, key)` returns `true` for any role-default + user-permission denial once `user.role === 'master'`. Same on mobile (`canMobile`, `canDashboard` skip the per-user check for master)
- See and modify every location's data — RLS helper `private.auth_is_in_location(loc_id)` short-circuits via `private.auth_is_master()`, and `getCurrentUser()` returns every active location instead of just the user's `profile_locations` rows when role is master

**Master honours the location feature gate.** The location-level toggle (Settings → Locations → Features) applies to master too — if a location has `pipeline: false`, no one at that location sees the Pipeline link, master included. Without this, "disabled at this location" wouldn't really mean disabled. (This is by design — it's how multi-tenant studios that share one master account keep operationally distinct sidebars.) The single exception is the `settings` key on web: master always sees the Settings sidebar entry as an escape hatch so they can navigate to `/settings/locations/[id]` to flip features back on. Without that, a master at a location with settings turned off would have no way back into the per-location feature toggles. Mobile has no feature-toggle UI so no escape hatch is needed there.

Switching active location re-evaluates the gate, so a master toggling between locations sees a different sidebar at each one. CCF Autos (cars-only) shows just Cars; UN1T Dublin (full gym) shows the full sidebar. Both visible to the same master account.

**Owners are now studio-scoped:** they can fully manage locations they belong to (edit settings, create staff at non-elevated roles), but can't mint new locations or new owner/master accounts. The role hierarchy is `master → owner → manager → head_coach → staff`.

**Helpers (`src/lib/schemas.js`):**
- `roleSchema` — Zod enum, includes `'master'`
- `MASTER_ASSIGNABLE_ROLES` — `['master','owner','manager','head_coach','staff']`
- `OWNER_ASSIGNABLE_ROLES` — `['manager','head_coach','staff']`
- `ADMIN_ROLES` — `['master','owner','manager']` (existing constant; master added)
- `MANAGER_ROLES` — `['master','owner','manager','head_coach']`

**RLS:** instead of touching every policy, we updated `private.auth_is_in_location(loc_id)` to OR with `private.auth_is_master()`. Existing policies that use that helper now grant master access transparently.

**StaffForm UI** filters the role dropdown by `callerRole` prop. Owners only see Manager/Head Coach/Staff options; masters see all five. If editing an existing owner/master from a non-master account, the current role renders as a disabled option ("(master-only)") so the dropdown value isn't misleadingly hidden.

### Per-location feature gates (migration 032)

Each location row has a `features JSONB` column that gates feature visibility for every user at that location. Three-tier resolution in `hasPermission(user, key)`:

1. **Location gate** — `user.activeLocation.features[key] === false` → DENIED for everyone, including master (only exception: master + `key === 'settings'` on web, which is the escape hatch back to the feature toggles). Notification keys (`notify_*` + anything in `NOTIFY_KEYS`) are exempt — those stay personal.
2. **User override** — `user.permissions[key] === true | false` → that wins. Master skips this tier (and tier 3) once tier 1 passes.
3. **Role default** — fall back to `DEFAULT_WEB_PERMISSIONS_BY_ROLE[role][key]`.

Same logic mirrored in `mobile/lib/permissions.js` (`canMobile`, `canDashboard`, `hasAnyMobileFeature` all take `activeLocation` as the third arg). The mobile `/api/mobile/me` endpoint serialises `features` onto every location.

**Default state.** A row with `features = {}` (the column default) means every feature is enabled — this preserves existing behaviour for all rows post-migration. Owners opt OUT of features they don't want at a particular studio by toggling them off in Settings → Locations → [location] → Features.

**Owner-only.** Editing `locations.features` is gated by the existing `user.role === 'owner'` check on the location edit page. RLS allows location members to UPDATE the row generally, but the UI for the Features section only renders for owners.

**Helpers (`shared/permissions.js`):**
- `isFeatureEnabledAtLocation(location, key)` — primary gate check
- `isFeatureGatedByLocation(key)` — false for notification keys (always personal)
- `NOTIFY_KEYS` — derived from `MOBILE_PERMISSIONS.filter(p => p.isNotify)`

Multi-location users: `activeLocation` determines which gate applies. Switching locations re-evaluates everything.

## Coding conventions

These patterns are enforced across the codebase; follow them when adding routes or features.

**Response shape.** Every API response is `{ success: boolean, error?: string, issues?: [...], data?: ... }` (or a resource-specific key like `sequences`, `templates`, `broadcasts` for legacy compatibility — frontend already reads those). Errors include `success: false` consistently so client code can branch on `data.success === false`.

**Mutation route skeleton.**
```js
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'

const Schema = z.object({ /* ... */ })

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard

  const db = createServerClient()
  // ...DB work...
  return NextResponse.json({ success: true, data })
}
```

**No `x-api-key` magic.** Bearer tokens are the only non-session auth path. The middleware validates `Authorization: Bearer <CRM_API_KEY>` constant-time and either passes through (skipping session check) or sends to `/login`. Routes that want to be called by n8n still use `requireApiKey()` from `src/lib/api-auth.js` for defence-in-depth.

**No silent env fallbacks.** Helpers like `getAppUrl()` throw if their env var is unset. Don't add new `process.env.X || 'some-default'` patterns for security-relevant config — fail loudly so misconfigurations surface in dev.

**Reuse shared schemas.** Import from `@/lib/schemas` (`uuidLike`, `isoDate`, `timeOfDay`, `email`, `money`, `hours`, `days`, role/status enums) rather than redefining locally. UUIDs use the `uuidLike` regex (Postgres-permissive), not `z.string().uuid()` — Zod 4's strict RFC check rejects the seeded Stillorgan location ID.

**No new `console.log` in production paths.** Either remove, gate behind `if (process.env.NODE_ENV !== 'production')`, or use `console.error` for genuine error paths so Vercel captures them.

## Mobile app (`mobile/`)

The iOS app is an Expo (React Native) project living in `mobile/` as a sibling to `src/`. Single repo, separate `package.json` (Expo can't share Next's deps), shared schemas/constants imported via relative paths from `../src/lib/schemas.js`. NativeWind re-exports the same `un1t-*` Tailwind tokens used on web.

### First-time setup

```bash
cd mobile
cp .env.example .env       # then fill in EXPO_PUBLIC_SUPABASE_URL,
                           #   EXPO_PUBLIC_SUPABASE_ANON_KEY,
                           #   EXPO_PUBLIC_API_BASE_URL
npm install
npx expo start             # → press i for iOS simulator, scan the QR with
                           #   Expo Go on a real device, or w for web
```

The Supabase URL + anon key are the same values used by the web app (in `un1t-crm/.env.local`). The mobile app authenticates via Supabase JS with `expo-secure-store` for session persistence; the access token is sent as `Authorization: Bearer <jwt>` to any `/api/*` route the app calls. The `src/middleware.js` at the web layer recognises three Bearer-token shapes — `CRM_API_KEY` (n8n), Supabase JWT (mobile), or no Bearer + cookies (web) — see the "Mobile app" architectural pattern note above.

### Routing model

`expo-router` uses file-based routing under `mobile/app/`:

| Path | Purpose |
|------|---------|
| `app/_layout.jsx` | Root — wraps in SafeAreaProvider + AuthProvider; keeps splash screen up while auth loads. |
| `app/index.jsx` | Decides session → redirect to `(tabs)` or `(auth)/login`. |
| `app/(auth)/login.jsx` | Email/password sign-in via `signInWithPassword`. |
| `app/(tabs)/_layout.jsx` | Bottom tabs. Tabs are conditionally enabled by `permissions.mobile.<key>` — `href: null` removes a tab. Registers Expo push token if `permissions.mobile.push_notifications` is on. |
| `app/(tabs)/index.jsx` | Home — greeting, active-location header, navigation cards based on enabled mobile features. |
| `app/(tabs)/schedule.jsx` | Week strip + day picker + shifts list, time-off banner, long-press to post for swap, floating Request Time Off button. |
| `app/(tabs)/pipeline.jsx` | Stage strip with deal counts + open-deal list. Tap a deal to open `app/pipeline/[dealId].jsx` — contact card, stage move, log activity, mark won/lost, timeline. |
| `app/(tabs)/whatsapp.jsx` | Inbox: conversations sorted by last message, unread badges, 24h window indicator. Tap to open `app/whatsapp/[conversationId].jsx` — iMessage-style bubbles, text composer, template picker for closed-window sends. |
| `app/schedule/time-off-new.jsx` | Modal — type segmented control, date stepper, reason field. |
| `app/(tabs)/more.jsx` | iOS-style settings list — account, location switcher, sign out. |

### Per-user mobile feature flags

Stored under `profiles.permissions.mobile.<key>`. JSONB allows arbitrary keys, so adding a new feature is just an entry in `MOBILE_PERMISSIONS` and `DEFAULT_MOBILE_PERMISSIONS_BY_ROLE` inside **`shared/permissions.js`** — the single source of truth imported by both `src/components/StaffForm.jsx` (web admin) and `mobile/lib/permissions.js` (iOS app). Adding the entry there auto-flows everywhere; `npm run check:mobile-parity` enforces that web and mobile permission sets stay aligned. Read on mobile via `lib/permissions.js → canMobile(profile, key)`. Defaults to `false` for unknown keys — adding a feature here doesn't auto-enable it for existing users; admins must opt-in per user.

### Push notifications

Tokens are registered server-side in the `device_tokens` table (migration 023) via `POST /api/mobile/device-tokens`. `src/lib/push.js` fans out via Expo Push Service, honouring both the master `permissions.mobile.push_notifications` switch and per-category `notify_<category>` flags (`time_off`, `schedule`, `swap`, `lead`, `whatsapp`). `DeviceNotRegistered` responses from Expo automatically prune stale tokens — no cron needed.

For production push (TestFlight / App Store), an Apple Developer account ($99/yr) is required: `eas credentials` configures APNs, then `eas build --platform ios` produces a `.ipa`. During Expo Go development, Expo proxies to its own push channel — no Apple credentials needed.

### Deployment (mobile)

EAS Build for App Store / TestFlight (`eas build --platform ios`). The Vercel-deployed `crm.un1tdublin.com` is the API base URL the mobile app calls — no separate backend deploy.

## Deployment

Vercel. Crons (in `vercel.json`):

- `/api/cron/run-scheduled-reports` — daily 07:00 UTC. Generates due `scheduled_reports`.
- `/api/cron/prune-rate-limits` — daily 03:30 UTC. Deletes expired `rate_limit_buckets` rows.
- `/api/cron/run-sequences` — every 5 minutes via **pg_cron + pg_net** (Vercel Hobby plan caps at 2 crons; rest run from inside Postgres — see migration 038). Phases per tick: (1) `runEventReminderSends()` for per-event single-shot reminders, (2) `runEventReminderTriggers()` for sequence-based event reminder triggers, (3) `runSequences()` to fire due steps. Each phase is independent so a failure in one doesn't stop the others. Auth via a `private.app_config` row holding the same shared secret value Vercel uses for the other crons.

Both Vercel-hosted crons are protected by `Authorization: Bearer ${CRON_SECRET}`. The pg_cron-driven hits use the same secret read from `private.app_config`.

Supabase for database + auth + file storage (`branding` bucket for logos). Migrations are forward-only — there are no down migrations. Apply via the Supabase MCP (`apply_migration` tool) or, when MCP is unavailable, paste the SQL into the Supabase Dashboard SQL Editor. After every DDL change, run the security advisor (`get_advisors` MCP tool, type=security) — RLS misses, missing policies, mutable `search_path`, and over-broad grants get flagged immediately.

## Extending

**New module pattern:** migration → API routes in `src/app/api/` → service lib in `src/lib/` → pages in `src/app/` → components → update Sidebar nav array → add to assistant prompt → register routes/schemas in `src/lib/openapi.js` → write tests in `src/lib/*.test.js` → **add a `WEB_PERMISSIONS` entry in `shared/permissions.js` and update `DEFAULT_WEB_PERMISSIONS_BY_ROLE` for each role** → **decide on the mobile counterpart** (see "Mobile parity" below).

**Mobile parity:** every new web feature requires a deliberate decision: ship the mobile equivalent in the same PR, ship it as a follow-up, or explicitly skip it as web-only. The forcing function is `npm run check:mobile-parity` — fails if a `WEB_PERMISSIONS` entry has no matching `MOBILE_PERMISSIONS` entry (with `webEquivalent: '<web_key>'`) AND isn't listed in the script's `WEB_ONLY_OK` map with a reason. To add a mobile equivalent: append a `MOBILE_PERMISSIONS` entry in `shared/permissions.js` with `webEquivalent: '<key>'`, fill in defaults in `DEFAULT_MOBILE_PERMISSIONS_BY_ROLE` for every role, then add a `<feature>.jsx` screen under `mobile/app/(tabs)/` and reference it from `mobile/app/(tabs)/_layout.jsx`. To deliberately skip: add the web key to `WEB_ONLY_OK` in `scripts/check-mobile-parity.mjs` with a one-line reason. The script runs in ~50ms and gates CI cheaply; run it locally before opening a PR.

**New API route checklist:**
1. `getCurrentUser()` (or `requireApiKey()` for Bearer-auth routes) at the top.
2. `assertLocationAccess(user, locationId)` if it accepts a `location_id`.
3. `validateBody(request, Schema)` for POST/PUT/PATCH bodies.
4. Standard response shape: `{ success, data?, error?, issues? }`.
5. Register the route in `src/lib/openapi.js` so Swagger UI picks it up.

**New pipeline stage:** Insert row in `pipeline_stages`, add colour to `stageColors` in `tailwind.config.js` and `KanbanBoard.jsx`.

**New cron job:** API route at `src/app/api/cron/[name]/route.js` (auth via `Authorization: Bearer ${CRON_SECRET}`) + entry in `vercel.json` `crons` array.

**New role or role-list change:** Update `roleSchema`, `ADMIN_ROLES`, `MANAGER_ROLES` in `src/lib/schemas.js` (single source of truth) and the `defaultPermissionsByRole` map in `src/components/StaffForm.jsx`. The `private.auth_is_owner_or_manager()` / `private.auth_role()` helpers (originally migration 014, moved to `private` schema in 022) may also need a follow-up migration if the new role has elevated DB-level write access.

**New audience filter field:** Add to `AUDIENCE_FIELDS` in `src/lib/audience-filter.js` AND to `FIELD_OPTIONS` in `src/components/AudienceBuilder.jsx`. The whitelist is server-enforced, so missing it on the server side will silently drop the filter.

## Multi-vendor comms architecture

Three providers, each doing what it's best at — kept deliberately split rather than consolidated under one vendor:

| Channel | Provider | Why this one |
|---|---|---|
| Transactional + broadcast email | **Postmark** | Best-in-class deliverability for transactional. Two streams (`outbound`, `broadcast`) with separate suppression lists + reputation. |
| WhatsApp (one-way + two-way + templates) | **Meta WhatsApp Cloud API** (direct) | ~30-50% cheaper per conversation than going through a BSP like Twilio. We're already past the integration cost. |
| SMS | **Twilio** | The only viable SMS provider for Ireland (long codes are voice-only there — see "Twilio integration"). |

**Why not consolidate everything under Twilio (SendGrid + Twilio WhatsApp + Twilio SMS):** Postmark beats SendGrid on transactional deliverability; Twilio adds margin on top of Meta's wholesale WA price; vendor concentration means a Twilio outage takes everything down at once. The "one bill" appeal isn't worth the migration cost + per-message cost increase + deliverability hit. Revisit only if managing three vendor relationships becomes more than ~30min/month of operational pain.

**Each path correctly gates by use-case context:**

| Send path | Code | Template restriction | Consent flag checked |
|---|---|---|---|
| WhatsApp broadcasts (`/communications/broadcasts`) | `lib/whatsapp.js → sendBroadcast` | None (any APPROVED template) | `whatsapp_marketing` |
| Sequence WA steps (runner) | `lib/sequences.js → sendWhatsappStep` | None (operator chooses per step) | inherits sequence audience filter |
| Per-event reminders (`event_types.reminder_*`) | `lib/event-reminders.js → sendWhatsappReminder` | UTILITY / AUTHENTICATION only — refused at runtime if MARKETING | `whatsapp_administrative` |
| Email broadcasts (`/communications/campaigns`) | `lib/postmark.js → sendCampaign` | (n/a) | `email_marketing` (broadcast stream) |
| Email sequences | `lib/sequences.js → sendEmailStep` | (n/a) | inherits sequence audience filter (transactional stream) |
| Per-event email reminders | `lib/event-reminders.js → sendEmailReminder` | (n/a) | `email_administrative` (transactional stream) |
| Deposit-link delivery (cars) | `lib/twilio.js → sendSms` | (n/a — alphanumeric sender, one-way) | (n/a — buyer just submitted booking; implicit) |

**Reminders are administrative, not marketing.** `contact_preferences` separates the two — schema has `email_marketing` + `email_administrative` (and the WA equivalents). Reminder code paths check ONLY the `_administrative` flag; opting out of marketing doesn't stop reminders. Hard signals (`email_status` bounced/complained, `wa_status` blocked/opted_out) cause reminders to skip AND stamp `reminder_sent_at` so the cron doesn't retry forever — only true infra failures stay un-stamped for retry.

## Twilio integration

`src/lib/twilio.js` is the single SMS helper. Used by the deposit-link issue flow; designed to be reused for any future transactional SMS.

**Sender for Ireland.** Twilio's Irish (`+353`) long codes are **voice-only** — the Irish mobile carriers (Vodafone, Three, Eir) don't accept A2P SMS over them. Three viable senders:

| Sender | Cost | Reply support | When to use |
|---|---|---|---|
| Alphanumeric ID `CCFautos` (default) | Free | One-way only | Most utility messages — branded, instantly recognisable |
| UK long code (`+44…`) | ~€1/mo + per-SMS | Two-way | Only if you specifically need replies |
| Irish short code (e.g. `50500`) | €800+/mo + per-SMS | Two-way | Only at very high volume (banks / Glofox use these) |

Set via `TWILIO_FROM` env. Twilio infers the sender type from the value's shape — alphanumeric ID, E.164 number, or `MGxxx...` Messaging Service SID all go in the same field.

**Trial-account gotcha.** Twilio trial accounts can ONLY send to phone numbers verified in the console (Phone Numbers → Manage → Verified Caller IDs). Adding billing flips the account to paid status and lifts the restriction. Alphanumeric senders are blocked entirely on trial accounts — you must upgrade before testing the alpha sender even works.

**Vodafone IE alpha sender filtering.** Some carriers (Vodafone IE specifically) silently drop unregistered alphanumeric senders. Register `CCFautos` in Twilio Console → Messaging → Senders → Alphanumeric Sender IDs (1-2 business day approval) to avoid this. Three IE and Eir generally accept unregistered alpha senders.

**Diagnostics.** Every SMS the issue endpoint sends inserts a system note on the car (`car_notes` table) with the Twilio SID. Operators paste the SID into Twilio Console → Monitor → Logs → Messaging when a customer says "I never got the SMS" — the log shows delivered / failed / queued + the carrier-specific error code.

**E.164 normalisation.** `toE164Ireland(raw)` is a best-effort helper that handles the common Irish formats operators type (`087 1234567`, `0871234567`, `+353…`, bare `87…`). Falls back to passing the input through unchanged so Twilio gets a chance to reject explicitly with a helpful error code.

## Revolut Merchant integration

Used for car deposit payments. **All field names + enum values are verified against `merchant-2026-03-12.yaml`** in the [revolut-openapi](https://github.com/revolut-engineering/revolut-openapi) repo, NOT against my pre-existing knowledge — there are gotchas if you don't read the spec for the version you've pinned.

**API key shape.** Two keys per environment, both generated in Revolut Business → APIs → Merchant API:

- **Secret key** (`sk_live_...` / `sk_sandbox_...`) — `REVOLUT_API_KEY`. Server-side only. `Authorization: Bearer <secret>` on every API call.
- **Public key** (`pk_live_...` / `pk_sandbox_...`) — `NEXT_PUBLIC_REVOLUT_PUBLIC_KEY`. Exposed to the browser bundle (intentional — Revolut's docs explicitly say "the Public key is provided with payment methods at checkout"). Used to initialise the embedded checkout widget on the client.

**API version pinning.** Every request sends `Revolut-Api-Version: 2026-03-12` (configurable via `REVOLUT_API_VERSION`, default in `lib/revolut.js`). When updating to a newer version, **read the changelog AND the OpenAPI spec for that version's enum values** — Revolut has shifted enum casing between versions (e.g. `capture_mode` was upper-snake in older versions, lowercase in newer; the SDK token field renamed from `public_id` to `token`).

**Spec-verified facts.** All values lowercase in the current pinned version:

- `Order.state` enum: `pending`, `processing`, `authorised`, `completed`, `cancelled`, `failed`. **There is NO `refunded` order state** — refunds create a NEW order with `type='refund'` linked via `related_order_id`; the original order's state stays `completed`.
- `capture_mode` enum: `automatic` (default if omitted), `manual`. **Omit the field entirely unless you specifically want manual capture** — sidesteps any future enum-casing changes.
- Order response field for the SDK token: **`token`** (was `public_id` in the deprecated endpoint — don't fall back to `public_id` for new code).
- Webhook signature header: `Revolut-Signature` (multiple `v1=<hex>` candidates separated by commas — any match wins; supports rotation).
- Webhook timestamp header: `Revolut-Request-Timestamp` (Unix milliseconds; reject anything older than 5 min).
- Webhook events for orders: `ORDER_COMPLETED`, `ORDER_AUTHORISED`, `ORDER_CANCELLED`, `ORDER_FAILED`, `ORDER_PAYMENT_DECLINED`, `ORDER_PAYMENT_FAILED` (+ several others for subscriptions / payouts / disputes we don't use).
- Webhook payload discriminator field: `event` (string).
- Webhook payload order id field: `order_id` (snake_case).

**Sandbox vs prod.** Completely separate accounts with separate dashboards, separate API keys, separate webhook secrets. Toggle three env vars together: `REVOLUT_API_KEY` (`sk_sandbox_*` ↔ `sk_live_*`), `REVOLUT_API_BASE_URL` (`https://sandbox-merchant.revolut.com` ↔ `https://merchant.revolut.com`), `NEXT_PUBLIC_REVOLUT_MODE` (`sandbox` ↔ `prod`). **All three must match.** A mismatch causes the SDK to silently fail (iframe loads but renders blank) because the SDK can't validate a prod token against sandbox infrastructure or vice versa. Use Vercel's per-environment env scoping to keep Preview pointing at sandbox while Production takes real money.

**Webhook setup (production).** The webhook UI doesn't surface in every Revolut Business dashboard layout. Cleanest path is the API:

```bash
curl -X POST https://merchant.revolut.com/api/webhooks \
  -H "Authorization: Bearer YOUR_LIVE_REVOLUT_API_KEY" \
  -H "Revolut-Api-Version: 2026-03-12" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://crm.un1tdublin.com/api/webhooks/revolut",
    "events": ["ORDER_COMPLETED", "ORDER_AUTHORISED", "ORDER_PAYMENT_DECLINED", "ORDER_PAYMENT_FAILED"]
  }'
```

Returns `{ id, url, events, signing_secret }`. The `signing_secret` (starts `wsk_`) goes into Vercel as `REVOLUT_WEBHOOK_SECRET`. **Spec note:** unlike the legacy API, `signing_secret` is included in ALL webhook responses (not just creation), so a `GET /api/webhooks/{id}` will retrieve it later. Rotate via `POST /api/webhooks/{id}/rotate-signing-secret`.

**Webhook IPs to allowlist** (per spec, line 13871): production `35.246.21.235`, `34.89.70.170`. Sandbox `35.242.130.242`, `35.242.162.241`.

**Embedded checkout (current widget).** `RevolutCheckout.embeddedCheckout({ publicToken, target, createOrder, onSuccess, onError, onCancel })` mounts a widget inline on our page that handles cards + Apple Pay + Google Pay + Revolut Pay automatically. The order is created on SUBMIT (via the SDK's `createOrder` callback hitting our `/accept-and-pay` endpoint), NOT on page load — drops abandoned-order count in the merchant dashboard. SDK source: `node_modules/@revolut/checkout/esm/embeddedCheckoutLoader.js` confirms `RevolutCheckout.embeddedCheckout` is exposed as a static method on the loaded global. **Don't use the older `createCardField` path** — it's the legacy single-payment-method API.

**Webhook handler is idempotent.** `runs `getOrder(orderId)` to fetch fresh state rather than trusting payload state (Revolut docs explicitly warn payload state can be stale during retries). `paid_at` only stamps if not already set, so duplicate webhook deliveries don't reset the timestamp. Always returns 200 even on unrecognised events so Revolut doesn't auto-disable the hook.

## Pay subdomain (`pay.ccfautos.com`)

Buyer-facing deposit pages live on a separate hostname from the CRM. Same Vercel project — multi-domain via hostname-aware middleware. The CRM stays at `crm.un1tdublin.com`; everything except the deposit pages + their backing public API is 404'd on the pay hostname so buyers never see CRM URLs.

**Implementation.** `src/middleware.js` checks `request.headers.get('host')` first thing:

- If hostname matches `PAY_HOSTNAME` (env, defaults to `pay.ccfautos.com`):
  - Allow `/deposit/*` and `/api/public/deposit/*` through unauthenticated
  - Allow `/_next/*`, `/favicon.ico`, `/robots.txt` (framework assets)
  - 404 everything else (don't redirect — that would leak the CRM URL)
- Otherwise (CRM hostname) — existing auth logic runs.

**Critical layout gotcha:** the deposit page lives at `src/app/deposit/[token]/page.js`, NOT under `/cars/deposit/`. Reason: `src/app/cars/layout.js` runs `getCurrentUser()` + `redirect('/login')` for unauthenticated visitors, and that fires BEFORE the page renders even if middleware allows the route. Anything under `/cars/*` inherits that auth gate. Public buyer pages must live OUTSIDE the `/cars` route segment.

**URL generation.** `src/lib/app-url.js → getDepositBaseUrl()` is the canonical helper for buyer-facing deposit links. Reads `DEPOSIT_BASE_URL`, falls back to `NEXT_PUBLIC_APP_URL`. Three places use it: `/api/cars/[id]/issue-deposit-link` (the link in the SMS), `/api/public/deposit/[token]/accept-and-pay` (Revolut's `redirect_url` so the hosted-page fallback bounces back to the same domain the buyer started on), and `DepositCard.jsx` ('View public deposit page' operator preview link via `NEXT_PUBLIC_DEPOSIT_BASE_URL`).

**DNS setup.** CNAME `pay.ccfautos.com → cname.vercel-dns.com`. Add the domain in Vercel → Settings → Domains. SSL auto-provisioned within ~1 minute of DNS resolving.

## Cars deposit feature

End-to-end flow: operator clicks one button on a car → buyer gets an SMS with a tokenised link → opens `pay.ccfautos.com/deposit/<token>` → reads T&Cs → ticks accept → Revolut embedded checkout widget mounts inline → buyer pays via card / Apple Pay / Google Pay / Revolut Pay → webhook flips the car to **Deposit paid** with audit trail.

**Schema (mig 044, 046, 047).** `cars` row gets:
- `deposit_token` (UUID, unique, indexed) — the public URL key. **Rotates on every issue.**
- `deposit_token_expires_at` — 24h from last issue. Public endpoints reject expired tokens with HTTP 410 + `{ code: 'TOKEN_EXPIRED' }`.
- `deposit_amount` — per-car override of `locations.car_deposit_default_amount` (default €500).
- `deposit_link_sent_at` + `deposit_link_sent_via` (`'sms'` only after the Twilio switch).
- `deposit_terms_accepted_at` + `_ip` + `_version` — evidence trail. Version snapshot at acceptance time so if the operator edits T&Cs later, the buyer's accepted version is preserved.
- `deposit_revolut_order_id` + `_checkout_url` — Revolut order linkage.
- `deposit_status` — `null → sent → terms_accepted → paid` (terminal happy path; `cancelled`, `failed`, `refunded` for sad paths).
- `deposit_paid_at` + `deposit_paid_amount`.

`locations` gets `car_deposit_default_amount`, `car_deposit_terms` (operator-editable text), `car_deposit_terms_version` (bumped server-side every time the wording changes), `car_deposit_whatsapp_template_id` (unused after the Twilio switch — kept in schema for now, can be dropped in a follow-up mig).

**Token rotation.** Every call to `/api/cars/[id]/issue-deposit-link` generates a fresh `deposit_token` (unless the deposit is already paid — then keeps the existing token so the receipt URL stays valid). Old URLs become 404s. Limits the blast radius if a link is forwarded somewhere it shouldn't be. Same call also sets `deposit_token_expires_at = NOW() + 24h` and clears any in-flight Revolut order linkage so the next accept-and-pay creates a fresh order under the new token's idempotency key.

**System notes (mig 047).** `car_notes` table holds two kinds of entries: `manual` (operator-typed) and `system` (auto-generated). Every `issue-deposit-link` call inserts a system note with the URL + the Twilio SID for cross-referencing in Twilio's logs. The note's URL renders as a clickable link with a copy-to-clipboard button in the UI — exactly the affordance an operator needs when they want to copy / re-test / re-share a link without re-clicking the issue button. RLS-scoped via denormalised `location_id`.

**Public page (`src/app/deposit/[token]/page.js`).** Renders `<CarDepositPage>` (a client component). Page loads → fetches deposit data → renders T&Cs + accept checkbox → ticks accept → mounts the Revolut embedded checkout widget → buyer submits → SDK calls `createOrder` callback which POSTs to `/api/public/deposit/[token]/accept-and-pay` → endpoint records the consent (timestamp + IP + terms version snapshot) and creates the Revolut order → returns the order token → SDK takes payment → `onSuccess` fires → page refetches deposit data → green confirmation card. The webhook is the authoritative DB-flip; the SDK callback is just for instant UX feedback.

**Operator UI.** `DepositCard.jsx` (dynamic-imported into `CarDetail.jsx`) shows the status badge, amount input, **Send / Resend deposit link** button, expiry countdown ("expires in 22h 14m"), and a 'View public page' preview link. `CarDepositSettings.jsx` (in `/settings/locations/[id]`) exposes the default amount + terms textarea — saving with changed terms bumps the version automatically.

**Concurrency.** Each car is fully isolated end-to-end (`deposit_token`, `deposit_revolut_order_id`, `deposit_revolut_checkout_url`, idempotency key all keyed off the car). 4-5 simultaneous deposits work without contention — Postgres serializes UPDATEs naturally on different rows, Vercel scales horizontally per request, Revolut webhooks land in different car rows. Only edge case: two operators issuing the same car at the exact same moment would race — easy to fix with row-level lock if it ever matters.

## Comms automation

Three runners share the same cron tick (`/api/cron/run-sequences` every 5 min via pg_cron):

1. **`runEventReminderSends()`** — single-shot reminders attached to event types. Reads `event_types.reminder_*` fields, finds bookings approximately `reminder_minutes_before` away (±1h DST-tolerant window), sends one message via the chosen channel (email or WA UTILITY template), stamps `bookings.reminder_sent_at`. Cheapest path for "send a 24h reminder before each booking" without authoring a sequence. Configured per-event in `EventForm.jsx` (Reminder section).

2. **`runEventReminderTriggers()`** — sequence-based event reminders. For each active sequence with `trigger_type='event_reminder'`, finds bookings ~hours_before away and creates a sequence enrollment. Use this when you need a multi-step reminder flow (24h + 2h + day-of); the simple per-event path covers single-shot.

3. **`runSequences()`** — picks up due enrollments (`status='active' AND next_step_at <= now()`) and sends the next step (email via Postmark, WhatsApp via template, or wait). Failure-counted per enrollment with auto-pause after 5 consecutive errors.

**Sequence triggers (4 types, all in `lib/sequences.js`):**

| Trigger | Fired by | trigger_config | sourceRef |
|---|---|---|---|
| `manual` | `enrolContacts()` direct call (UI: SequencePicker on contact detail / pipeline / contact list bulk) | (none) | `'ui'` |
| `booking_created` | `triggerSequencesForBooking(bookingId)` from `/api/public/book` | `event_type_id?` | booking id |
| `status_change` | `triggerSequencesForStatusChange(contactId, oldStatus, newStatus)` from `PUT /api/contacts/[id]` | `from_status?`, `to_status?` | `'<old>→<new>'` |
| `tag_added` | `triggerSequencesForTagsAdded(contactId, addedTags)` from `PUT /api/contacts/[id]` | `tag` (required) | the added tag |
| `event_reminder` | `runEventReminderTriggers()` cron | `hours_before`, `event_type_id?` | booking id (idempotent across cron ticks) |

All triggers respect the sequence's `audience_filter` via `contactMatchesSequenceAudience(contactId, filter)` — single-row reachability check using `applyAudienceFilter` so the same field/op allowlist as campaigns + broadcasts applies. All triggers are best-effort (errors swallowed + logged) so they can never fail the upstream user mutation.

**Sequence enrolment UI.** `SequencePicker.jsx` is a shared component used in three places: contact detail page (popover, next to + Note / + Activity), pipeline deal cards (3-dots menu → centred modal), and contact list (bulk select with sticky action bar → centred modal). Lists every active sequence at the location with trigger-type chips so operators can pick a manual or automated sequence ad-hoc.

**Saved contact segments (mig 043).** Operator builds an advanced filter on `/contacts` page using the existing `AudienceBuilder`, then saves as a named segment. Stored in `contact_segments` with the same JSON shape as `campaigns.audience_filter` — easy to promote a segment into a campaign / sequence audience later. CRUD via `POST /api/contacts/segments`, `PUT/DELETE /api/contacts/segments/[id]`. UI in `ContactsView.jsx` renders saved segments as chips above the AudienceBuilder; clicking applies the filter, hovering shows a delete X.

## Performance posture

Audit ran in May 2026 captured several wins worth knowing about:

- **`getCurrentUser()` is wrapped in React.cache()** (`src/lib/auth.js`) so multiple server components in one request share a single auth lookup. Falls back to identity in the test environment (where react/server build isn't loaded).
- **Auth queries parallelised** — profile fetch + impersonation cookie load + (master only) all-locations fetch run concurrently. Saves a roundtrip per page load on every authenticated route.
- **`report-generator.js` queries parallelised** via `Promise.all` for staff_cost / roster_coverage / utilisation. Roughly halved the heaviest cron.
- **`bookings(location_id, booking_date DESC)` index** (mig 041) — every bookings query filters by location, the original mig 002 only indexed contact/event/date/status. Was a full-scan that worsened with table size.
- **`contacts(location_id, lead_status) WHERE lead_status IS NOT NULL`** partial index for the pipeline.
- **Public pages statically rendered** — `/book/[slug]`, `/preferences/[token]`, `/unsubscribe/[token]`, `/deposit/[token]` all dropped reflexive `force-dynamic`. Vercel serves a CDN-cached HTML shell instead of running a server render every load.
- **`CarDetail.jsx` code-split** — `XeroCard`, `DocumentsCard`, `DepositCard`, `NotesCard` are dynamic-imported and only rendered for cars in pending/completed status. New-status car detail loads don't ship that JS.
- **`WAInbox` uses Supabase Realtime, not polling** (mig 042 publishes `whatsapp_conversations` + `whatsapp_messages`). 60s heartbeat poll kept as a safety net for missed events. Was previously 10s polling = ~432k requests/day at 50 active users.
- **OpenAPI spec cached via `unstable_cache`** with 24h revalidate so cold-started lambdas don't rebuild the spec from scratch. Module-level `cachedSpec` still handles within-lambda hits. Falls back to direct generation in Vitest where there's no Next runtime.

Things to watch but NOT act on without measurement:

- **WAInbox 60s heartbeat** — wait a few weeks of real Realtime data before deciding whether to drop the heartbeat. If nothing's missed, push to 5min or remove.
- **`'use client'` audit** — 46 components marked client; some likely don't need it. Modest bundle wins, low ROI, no measurement yet.

## Lessons learned

**Read vendor docs for the version you've pinned.** When integrating a third-party API (Revolut, Twilio, Stripe, etc.), always parse the OpenAPI spec / SDK source for the EXACT version you're targeting before writing client code. Don't work from cached knowledge of an older version. Two specific cases that bit on the Revolut integration: `capture_mode` enum casing (changed from `AUTOMATIC` upper-snake to lowercase `automatic` between versions) and the SDK token field name (`public_id` deprecated, replaced by `token`). Both produced misleading error messages that cost a round-trip with the user to fix. The OpenAPI spec is authoritative — if the docs page is a JS-rendered SPA that doesn't fetch cleanly, get the YAML from the vendor's openapi GitHub repo instead.

**Per-vendor specifics that bit hard:**

- **Twilio's Irish long codes are voice-only.** All Irish providers (not just Twilio) face this — the carriers don't accept A2P SMS over local Irish numbers. Alphanumeric sender IDs are the canonical solution for sending SMS to Ireland from a non-Irish entity. Don't waste time looking for Irish SMS-capable numbers in any provider's catalog.

- **Revolut sandbox vs prod is fully separate** — separate dashboards (`business-sandbox.revolut.com` vs `business.revolut.com`), separate API keys, separate webhook secrets. Mismatching env vars across the trio (`REVOLUT_API_KEY`, `REVOLUT_API_BASE_URL`, `NEXT_PUBLIC_REVOLUT_MODE`) causes the SDK iframe to silently render blank instead of throwing a clear error.

- **Twilio trial accounts can only send to verified numbers** (Phone Numbers → Manage → Verified Caller IDs). Adding a payment method flips to paid and lifts the restriction. Alphanumeric senders are blocked entirely on trial.

- **Vercel doesn't auto-redeploy on env-var changes.** Every time the user changes a Vercel env var, they need to manually redeploy. Document this in instructions.

- **Layout auth gates run before pages.** Anything under `src/app/<segment>/` inherits the layout's auth check. Public pages must live OUTSIDE any auth-gated segment — see the deposit page move from `/cars/deposit/[token]` to `/deposit/[token]` in mig of May 2026.

- **Postgres webhook retries should never reset state.** Webhook handlers must be idempotent. Always check "is this state already final?" before stamping timestamps. Always return 200 for unrecognised events so the upstream provider doesn't auto-disable the hook (Revolut, Stripe, Postmark all do this).

- **AppShell has its own publicPaths allowlist** (`src/components/AppShell.jsx`) separate from middleware. Adding a new public-facing page requires adding it to BOTH the middleware auth allowlist AND the AppShell sidebar-suppression list, otherwise the buyer either gets bounced to login OR sees the CRM sidebar.

- **Both consent flag families exist for a reason.** `email_marketing` / `whatsapp_marketing` (broadcasts) vs `email_administrative` / `whatsapp_administrative` (transactional). Reminder code paths check the `_administrative` flag; opting out of marketing should never block a booking reminder.

- **WhatsApp template categories are policy, not just labels.** Sending a MARKETING template under a transactional pretext (e.g. as a reminder) is a Meta policy violation that gets accounts in trouble. Reminder + utility flows refuse MARKETING templates at the picker AND at runtime as a backstop.
