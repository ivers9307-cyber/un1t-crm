# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
npm run dev       # Start dev server (localhost:3000)
npm run build     # Next.js production build
npm start         # Start production server
npm run lint      # ESLint check
```

No test framework is configured. Migrations are run manually in Supabase SQL Editor.

## Architecture

UN1T CRM is a Next.js 14 App Router application with Supabase (PostgreSQL) backend, built for gym lead management and operations across multiple locations.

### Tech Stack

React 18 + Next.js 14, Tailwind CSS 3.4, Supabase Auth (SSR cookies), Postmark (email), WhatsApp Cloud API (Meta v21.0), @dnd-kit (pipeline kanban), lucide-react icons, clsx.

### Key Architectural Patterns

**Multi-tenancy via location scoping** — Every data query filters by `location_id`. Users belong to locations via `profile_locations` junction table. Active location resolved from cookie (`un1t_active_location`) → `is_default` flag → first location.

**Two Supabase clients** — `createBrowserClient()` uses anon key + SSR cookies (client components). `createServerClient()` uses service role key, bypasses RLS (API routes, cron). Both in `src/lib/supabase.js`.

**Auth flow** — `src/middleware.js` enforces auth on all routes except public paths (`/login`, `/reset-password`, `/book/`, `/api/public/`, `/api/webhooks/`, `/api/cron/`). External integrations (n8n) authenticate with `Authorization: Bearer <CRM_API_KEY>` — the middleware validates this constant-time with `crypto.timingSafeEqual`-equivalent. `getCurrentUser()` in `src/lib/auth.js` returns profile + locations + activeLocation; `assertLocationAccess(user, locationId)` returns null or a 403 NextResponse for IDOR-prone routes.

**Input validation** — POST/PUT routes that touch HR, money, role, URLs, or the public booking surface validate request bodies via `validateBody(request, schema)` from `src/lib/validate.js` against Zod schemas. Returns 400 with `{ error, issues }` on rejection.

**Role-based access (4 roles)** — owner, manager, head_coach, staff. Stored in `profile_locations.role`. Enforced at 3 layers: sidebar nav filtering, assistant tool filtering, server-side API guards. Staff see full roster (read-only) but only own time-off/holiday data.

**Assistant bot** — `src/lib/assistant-prompt.js` defines the system prompt with CRM knowledge. `src/app/api/assistant/chat/route.js` implements tool use with permission levels per tool (`all`, `manager`, `admin`). Tools filtered before sending to Claude API based on user role.

**Light theme with inverted token names** — The `un1t` colour palette in `tailwind.config.js` uses inverted naming for historical reasons: `un1t-black` = #FFFFFF (white bg), `un1t-dark` = #F7F8FA (card bg), `un1t-gray` = #E2E5E9 (borders), `un1t-mid` = #94A3B8 (muted), `un1t-light` = #64748B (secondary text), `un1t-white` = #111827 (primary text), `un1t-accent` = #1E293B (button hover). All components use these tokens. Use literal `text-white` only on coloured backgrounds (bg-blue-*, bg-green-*).

**Report generation** — Shared logic in `src/lib/report-generator.js` used by both manual API route and Vercel cron (`/api/cron/run-scheduled-reports`, daily 7 AM in `vercel.json`). Report types: staff_hours, staff_cost, time_off_summary, roster_coverage, utilisation.

### Modules

| Module | DB Migration | API Routes | Lib | Key Component |
|--------|-------------|------------|-----|---------------|
| CRM/Pipeline | 001 | `/api/contacts`, `/api/deals`, `/api/stages` | — | `KanbanBoard.jsx` |
| Events/Bookings | 002 | `/api/events`, `/api/bookings`, `/api/public/book` | — | `BookingWidget.jsx` |
| Timeline | 003 | — (logged by other modules) | — | — |
| Multi-tenant Auth | 004 | `/api/locations` | `auth.js` | `LocationSwitcher.jsx` |
| Email Marketing | 005-006 | `/api/campaigns`, `/api/templates`, `/api/sequences` | `postmark.js` | `CampaignEditor.jsx` |
| WhatsApp | 007-008 | `/api/whatsapp/*` | `whatsapp.js` | `WAInbox.jsx` |
| Scheduling | 009-011 | `/api/schedule/*` | — | `ScheduleCalendar.jsx` |
| HR/Reporting | 012 | `/api/schedule/reports` | `report-generator.js` | `ScheduleReporting.jsx` |
| Branding | 013 | `/api/settings/branding` | — | `BrandingSettings.jsx` |

### Email System (src/lib/postmark.js)

Two streams: `broadcast` (marketing, GDPR headers) and `outbound` (transactional). `sendCampaign(id)` orchestrates audience building, batch sending (500/chunk), recipient tracking. `buildAudienceQuery()` supports filter operators (eq, neq, contains, days_since_gt, etc.) and always enforces email_marketing consent. Merge tags: `{{first_name}}`, `{{email}}`, `{{location_name}}`, `{{unsubscribe_url}}`, `{{current_year}}`.

### WhatsApp System (src/lib/whatsapp.js)

24h response window enforced — `sendTextMessage` only works in window, `sendTemplateMessage` works anytime. Broadcasts rate-limited (50 msgs, 1s delay). `buildWhatsAppAudience()` checks whatsapp_marketing consent. Templates use `{{1}}`, `{{2}}` variable syntax mapped to contact fields via `buildTemplateComponents()`.

## Database

15 migrations in `supabase/migrations/`. Key tables:

**Core:** locations, profiles, profile_locations (junction with role), contacts, deals (linked to contacts + stages), activities, notes.

**Events:** events, bookings, booking_status_history, event_form_fields.

**Email:** campaigns, campaign_recipients, templates, sequences, sequence_steps, email_sends, contact_preferences (consent + unsubscribe tokens).

**WhatsApp:** whatsapp_conversations, whatsapp_messages, whatsapp_templates, whatsapp_broadcasts, whatsapp_broadcast_recipients.

**Scheduling:** shifts, shift_templates, shifts_publish, time_off_requests, swap_requests, shift_swaps, holiday_allowances.

**Reporting:** generated_reports, scheduled_reports.

**Infrastructure:** rate_limit_buckets (fixed-window counter for public endpoints, pruned daily by `/api/cron/prune-rate-limits`).

**Settings:** company_settings (logo_url, favicon_url, company_name per location).

### Row Level Security

Migration 014 enforces per-location scoping at the DB layer for all data tables. The model:

- **Service role** (used by every API route, cron, and webhook handler via `createServerClient()`) bypasses RLS — application code is the source of truth for cross-cutting logic.
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
CRM_API_KEY=                     # for n8n webhook auth
NEXT_PUBLIC_APP_URL=https://crm.un1t.ie
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
| View full roster | ✓ | ✓ | ✓ | ✓ (read-only) |
| View all staff HR data | ✓ | ✓ | ✗ | ✗ |
| Generate reports | ✓ | ✓ | ✓ | ✗ |
| Settings/branding | ✓ | ✗ | ✗ | ✗ |

## Deployment

Vercel. Cron: `/api/cron/run-scheduled-reports` daily 7 AM UTC. Supabase for database + auth + file storage (branding bucket for logos).

## Extending

**New module pattern:** migration → API routes in `src/app/api/` → service lib in `src/lib/` → pages in `src/app/` → components → update Sidebar nav array → add to assistant prompt.

**New pipeline stage:** Insert row in `stages` table, add colour to `stageColors` in `tailwind.config.js` and `KanbanBoard.jsx`.

**New cron job:** API route at `src/app/api/cron/[name]/route.js` + entry in `vercel.json` crons array.
