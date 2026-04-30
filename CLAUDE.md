# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
npm run dev         # Start dev server (localhost:3000)
npm run build       # Next.js production build
npm start           # Start production server
npm run lint        # ESLint check
npm test            # Run vitest suite once
npm run test:watch  # Re-run tests on file change
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

**Input validation** — POST/PUT routes validate request bodies via `validateBody(request, schema)` from `src/lib/validate.js` against Zod schemas. Returns 400 with `{ success: false, error, issues }` on rejection. Shared schema building blocks live in `src/lib/schemas.js` (`uuidLike`, `isoDate`, `timeOfDay`, `email`, `phone`, `money`, `hours`, `days`, role/status enums, `MANAGER_ROLES`, `ADMIN_ROLES`, `DEFAULT_COLOR`).

**Role-based access (4 roles)** — `owner`, `manager`, `head_coach`, `staff`. Stored in `profiles.role`. Enforced at three layers: sidebar nav filtering (UI hint, not security), assistant tool filtering (server-side `TOOL_PERMISSIONS` table), and per-route guards (`if (!MANAGER_ROLES.includes(user.role)) return 403`). RLS additionally enforces role checks for the `pipeline_stages` and `webhook_subscriptions` tables. Use the constants `MANAGER_ROLES = ['owner', 'manager', 'head_coach']` and `ADMIN_ROLES = ['owner', 'manager']` from `src/lib/schemas.js` rather than inlining role lists.

**Permissions JSONB** — Separate from `role`. Controls sidebar visibility per user (e.g. `permissions.email = false` hides the Email link). When a user's role changes via the staff edit form, `permissions` is auto-reset to that role's defaults from `defaultPermissionsByRole` in `StaffForm.jsx`. This prevents stale owner-era permissions from sticking around after a demotion.

**Assistant bot** — `src/lib/assistant-prompt.js` defines the system prompt with CRM knowledge. `src/app/api/assistant/chat/route.js` implements tool use with permission levels per tool (`all`, `manager`, `admin`). Tools filtered before sending to Claude API based on user role. **Important:** the route derives `role`, `userId`, and `locationId` from the server session (`getCurrentUser()`), never from the client-supplied `userContext`. The client can only contribute display hints like `currentPage`.

**Audience filter whitelist** — `buildAudienceQuery()` (postmark) and `buildWhatsAppAudience()` (whatsapp) both delegate to `applyAudienceFilter()` in `src/lib/audience-filter.js`, which only allows the (field, op) combinations registered in `AUDIENCE_FIELDS`. Prevents campaign authors from filtering on arbitrary columns or smuggling PostgREST traversal paths like `profiles.role`.

**Light theme with inverted token names** — The `un1t` colour palette in `tailwind.config.js` uses inverted naming for historical reasons: `un1t-black` = #FFFFFF (white bg), `un1t-dark` = #F7F8FA (card bg), `un1t-gray` = #E2E5E9 (borders), `un1t-mid` = #94A3B8 (muted), `un1t-light` = #64748B (secondary text), `un1t-white` = #111827 (primary text), `un1t-accent` = #1E293B (button hover). All components use these tokens. Use literal `text-white` only on coloured backgrounds (bg-blue-*, bg-green-*).

**Report generation** — Shared logic in `src/lib/report-generator.js` used by both manual API route and Vercel cron (`/api/cron/run-scheduled-reports`, daily 7 AM UTC in `vercel.json`). Report types: `staff_hours`, `staff_cost`, `time_off_summary`, `roster_coverage`, `utilisation`. Period boundaries are computed in UTC; if the cron schedule is ever moved earlier than 01:00 UTC, revisit `calculatePeriodForSchedule` so "yesterday" still aligns with Dublin local time.

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
| Security: RLS | 014 | (DB-level only) | — | — |
| Security: Rate limit | 015 | `/api/cron/prune-rate-limits` | `rate-limit.js` | — |
| Webhooks | (cross-cutting) | `/api/webhooks/postmark`, `/api/webhooks/whatsapp` | `webhook-auth.js` | — |
| API Reference | (cross-cutting) | `/api/openapi.json`, `/api-docs` | `openapi.js` | — |

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

### Email system (`src/lib/postmark.js`)

Two streams: `broadcast` (marketing, GDPR headers) and `outbound` (transactional). `sendCampaign(id)` orchestrates audience building, batch sending (500/chunk), recipient tracking. Audience filtering goes through `applyAudienceFilter()` (whitelisted), so any (field, op) tuple the client passes that isn't in `AUDIENCE_FIELDS` throws `InvalidAudienceFilterError`. Merge tags: `{{first_name}}`, `{{last_name}}`, `{{name}}`, `{{email}}`, `{{phone}}`, `{{lead_status}}`, `{{location_name}}`, `{{unsubscribe_url}}`, `{{preference_url}}`, `{{current_year}}`. Unsubscribe URLs and preference URLs are built from `getAppUrl()`, which throws loudly if `NEXT_PUBLIC_APP_URL` is unset (no silent fallback).

### WhatsApp system (`src/lib/whatsapp.js`)

24h response window enforced — `sendTextMessage` only works in window, `sendTemplateMessage` works anytime. Broadcasts rate-limited (50 msgs, 1s delay). `buildWhatsAppAudience()` checks `whatsapp_marketing` consent. Templates use `{{1}}`, `{{2}}` variable syntax mapped to contact fields via `buildTemplateComponents()`. Inbound webhook is HMAC-verified via `verifyMetaSignature()` against `WHATSAPP_APP_SECRET` over the raw request body — read the body with `await request.text()` first, parse JSON afterwards.

## Database

15 migrations in `supabase/migrations/`. Key tables:

**Core:** `locations`, `profiles`, `profile_locations` (junction; `profiles.role` holds the role, NOT this junction), `contacts`, `deals` (linked to contacts + stages), `pipeline_stages`, `activities`, `notes`, `webhook_subscriptions`.

**Events:** `event_types`, `bookings`, `blocked_times`.

**Email:** `campaigns`, `campaign_recipients`, `email_templates`, `email_sequences`, `sequence_steps`, `sequence_enrollments`, `email_sends`, `contact_preferences` (consent + unsubscribe tokens), `consent_log`.

**WhatsApp:** `whatsapp_conversations`, `whatsapp_messages`, `whatsapp_templates`, `whatsapp_broadcasts`, `whatsapp_broadcast_recipients`.

**Scheduling:** `shifts`, `shift_templates`, `shift_swap_requests`, `time_off_requests`, `staff_allowances`, `schedule_notifications`.

**Reporting:** `generated_reports`, `scheduled_reports`.

**Infrastructure:** `rate_limit_buckets` (fixed-window counter for public endpoints, pruned daily by `/api/cron/prune-rate-limits` at 03:30 UTC).

**Settings:** `company_settings` (logo_url, favicon_url, company_name per location).

### Row Level Security

Migration 014 enforces per-location scoping at the DB layer for all data tables. The model:

- **Service role** (used by every API route, cron, and webhook handler via `createServerClient()`) bypasses RLS — application code is the source of truth for cross-cutting logic. RLS is defence-in-depth.
- **Authenticated role** (browser-side calls via `createBrowserClient()`, e.g. `KanbanBoard`, `ContactActions`, `CampaignEditor`) is restricted by helper functions defined in 014:
  - `auth_is_in_location(uuid)` — true if the row's `location_id` is in the caller's `profile_locations`.
  - `auth_role()`, `auth_is_owner_or_manager()`, `auth_is_owner()` — role checks via `profiles.role`.
- **Anon role** is allowed only by the explicit public policies in 002 (booking widget) and 013 (branding bucket); migration 014 does not change those.
- Child tables without a direct `location_id` (`consent_log`, `campaign_recipients`, `sequence_steps`, `sequence_enrollments`, `whatsapp_broadcast_recipients`, `blocked_times`) are scoped through the parent's `location_id`.
- `pipeline_stages` is read-any-authenticated, write-owner-or-manager. `webhook_subscriptions` is owner-write.

When adding a new table that holds tenant data, add `location_id UUID REFERENCES locations(id)` and replicate the `_location_scoped` policy pattern from 014. Don't add `USING (true)` policies.

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
```

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

## Deployment

Vercel. Crons (in `vercel.json`):

- `/api/cron/run-scheduled-reports` — daily 07:00 UTC. Generates due `scheduled_reports`.
- `/api/cron/prune-rate-limits` — daily 03:30 UTC. Deletes expired `rate_limit_buckets` rows.

Both crons are protected by `Authorization: Bearer ${CRON_SECRET}`.

Supabase for database + auth + file storage (`branding` bucket for logos). Migrations are applied manually in the Supabase SQL Editor (forward-only; no down migrations).

## Extending

**New module pattern:** migration → API routes in `src/app/api/` → service lib in `src/lib/` → pages in `src/app/` → components → update Sidebar nav array → add to assistant prompt → register routes/schemas in `src/lib/openapi.js` → write tests in `src/lib/*.test.js`.

**New API route checklist:**
1. `getCurrentUser()` (or `requireApiKey()` for Bearer-auth routes) at the top.
2. `assertLocationAccess(user, locationId)` if it accepts a `location_id`.
3. `validateBody(request, Schema)` for POST/PUT/PATCH bodies.
4. Standard response shape: `{ success, data?, error?, issues? }`.
5. Register the route in `src/lib/openapi.js` so Swagger UI picks it up.

**New pipeline stage:** Insert row in `pipeline_stages`, add colour to `stageColors` in `tailwind.config.js` and `KanbanBoard.jsx`.

**New cron job:** API route at `src/app/api/cron/[name]/route.js` (auth via `Authorization: Bearer ${CRON_SECRET}`) + entry in `vercel.json` `crons` array.

**New role or role-list change:** Update `roleSchema`, `ADMIN_ROLES`, `MANAGER_ROLES` in `src/lib/schemas.js` (single source of truth) and the `defaultPermissionsByRole` map in `src/components/StaffForm.jsx`. RLS helper functions in migration 014 (`auth_is_owner_or_manager()` etc.) may also need a follow-up migration if the new role has elevated DB-level write access.

**New audience filter field:** Add to `AUDIENCE_FIELDS` in `src/lib/audience-filter.js` AND to `FIELD_OPTIONS` in `src/components/AudienceBuilder.jsx`. The whitelist is server-enforced, so missing it on the server side will silently drop the filter.
