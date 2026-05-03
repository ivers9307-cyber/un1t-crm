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

**Multi-tenancy via location + organization scoping** — Every data query filters by `location_id`. Locations now also belong to an `organization` (mig 079) which is the tenant grouping above locations. Today there are two organizations — **UN1T Group** (gym studios) and **CCF Autos** (cars business) — both run by the same operator under one master account, but the schema is shaped so adding a third tenant business is a row in the `organizations` table plus locations under it; existing per-location RLS continues to enforce tenant isolation transitively (a non-member of any of org X's locations can't read its data). Users belong to locations via `profile_locations` junction table, **each row carrying its own role** (mig 051). The same user can be `owner` at Hatch Street and `head_coach` at Stillorgan with independent rights at each. Active location resolved from cookie (`un1t_active_location`) → `is_default` flag → first location. `getCurrentUser()` returns `rolesByLocation: { [loc_id]: role }`, `organizationsById: { [org_id]: org row }` (mig 079 — every org reachable by the caller), `activeOrganization` (mirrors `activeLocation`), plus `user.role` (the role at the *active* location, or `'master'` for platform admins). The original global value is still on `user.profileRole` for the rare caller that wants the canonical/highest role without location context.

**Two Supabase clients** — `createBrowserClient()` uses anon key + SSR cookies (client components). `createServerClient()` uses service role key, bypasses RLS (API routes, cron). Both in `src/lib/supabase.js`.

**Auth flow** — `src/middleware.js` enforces auth on all routes except public paths (`/login`, `/reset-password`, `/book/`, `/api/public/`, `/api/webhooks/`, `/api/cron/`). External integrations (n8n) authenticate with `Authorization: Bearer <CRM_API_KEY>`; the middleware validates this constant-time with a pure-JS XOR-accumulate (Edge runtime can't import `node:crypto`). Sessions are validated against Supabase auth cookies for everything else. There is no `x-api-key` bypass anymore — anything not on the public-paths list and without a valid Bearer or session redirects to `/login`. `getCurrentUser()` in `src/lib/auth.js` returns profile + locations + activeLocation; `assertLocationAccess(user, locationId)` returns null or a 403 NextResponse for IDOR-prone routes; `getUserLocationIds(user)` returns the caller's location array.

**Input validation** — POST/PUT routes validate request bodies via `validateBody(request, schema)` from `src/lib/validate.js` against Zod schemas. Returns 400 with `{ success: false, error, issues }` on rejection. Shared schema building blocks live in `src/lib/schemas.js` (`uuidLike`, `isoDate`, `timeOfDay`, `email`, `phone`, `money`, `hours`, `days`, role/status enums, `MANAGER_ROLES`, `ADMIN_ROLES`, `DEFAULT_COLOR`, `passwordSchema`).

**Password policy** — `passwordSchema` in `src/lib/schemas.js` enforces 8+ characters with at least one lowercase letter, one uppercase letter, one digit, and one symbol. This **mirrors the password-strength settings configured in the Supabase Auth dashboard** — keeping both in sync means we surface a clear inline error before round-tripping to Supabase, instead of getting a generic `weak_password` rejection back from `auth.admin.createUser` / `auth.updateUser`. The same module exports `passwordRequirements` (an array of `{ id, label, test }`) and `validatePasswordComplexity(pw)` (returns the first failing rule's message, or `null`). `StaffForm.jsx` (staff create) and `app/reset-password/page.js` both render a live ✓/✗ checklist using these exports — when changing password rules, update the dashboard *and* the schema together so the two never drift apart.

**Role-based access (4 roles)** — `owner`, `manager`, `head_coach`, `staff`. Stored in `profiles.role`. Enforced at three layers: sidebar nav filtering (UI hint, not security), assistant tool filtering (server-side `TOOL_PERMISSIONS` table), and per-route guards (`if (!MANAGER_ROLES.includes(user.role)) return 403`). RLS additionally enforces role checks for the `pipeline_stages` and `webhook_subscriptions` tables. Use the constants `MANAGER_ROLES = ['owner', 'manager', 'head_coach']` and `ADMIN_ROLES = ['owner', 'manager']` from `src/lib/schemas.js` rather than inlining role lists.

**Permissions JSONB (per-location, mig 058)** — Separate from `role`. Lives on `profile_locations.permissions`, not on `profiles.permissions` — moved per-location in mig 058 so an owner at one studio + staff at another doesn't get owner-level toggles leaked to the staff studio. `hasPermission(user, key)` reads from `user.activeAssignment.permissions` at tier 2; falls through to role default at tier 3. `profiles.permissions` is no longer read by hasPermission (kept on disk for one-version rollback safety). When an assignment's role changes via StaffForm, that assignment's permissions reset to the role defaults from `defaultPermissionsByRole` — other assignments are untouched. StaffForm UI has a per-location tab strip above the toggle list so admins edit one assignment at a time. `getCurrentUser()` exposes `assignmentsByLocation` and `activeAssignment` so server callers can read either the active or any assigned location's blob.

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
| Organizations (tenant tier) | 079 | (browser-side updates via RLS) | `auth.js` (org loading) | `AdminFeatureMatrix.jsx`, `AdminAccessMatrix.jsx` |
| Master admin matrix | 079 | `/admin/matrix` (server page), `/admin/layout.js` (master gate) | — | `AdminFeatureMatrix.jsx`, `AdminAccessMatrix.jsx` |
| Master admin v2 (editable + audit) | 080 | `/api/admin/assignments`, `/api/admin/assignments/bulk`, `/api/admin/master-toggle`, `/api/admin/audit-log`, `/admin/audit-log` | `assignment-changes.js` | `UserAssignmentsPanel.jsx`, `AuditLogTable.jsx` (matrix + access components updated in place) |
| Add organization UI | (cross-cutting) | `/api/admin/organizations` | `slug.js` | `AddOrganizationButton.jsx`, `LocationForm.jsx` (org picker added) |
| Email Marketing | 005, 006 | `/api/campaigns`, `/api/templates`, `/api/sequences`, `/api/preferences/[token]`, `/api/unsubscribe/[token]` | `postmark.js`, `audience-filter.js` | `CampaignEditor.jsx`, `TemplateEditor.jsx`, `AudienceBuilder.jsx` |
| WhatsApp | 007, 008 | `/api/whatsapp/*` | `whatsapp.js`, `audience-filter.js` | `WAInbox.jsx`, `WABroadcastEditor.jsx` |
| Scheduling | 010, 011 | `/api/schedule/*` (incl. `/copy-week` and `/copy-month`) | — | `ScheduleCalendar.jsx` (week + month views, view toggle in header, copy-last-week / copy-last-month buttons context-aware on the active view) |
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
| Cars deposit (Revolut) | 040, 044, 046, 047, 078 | `/api/cars/[id]/issue-deposit-link`, `/api/public/deposit/[token]/*`, `/api/webhooks/revolut`, `/api/cars/[id]/notes` | `revolut.js`, `twilio.js`, `event-reminders.js`, `deposit-receipts.js` | `DepositCard.jsx`, `NotesCard.jsx`, `CarDepositPage.jsx`, `CarDepositSettings.jsx` |
| Sequence runner + triggers | 005, 037, 038, 039 | `/api/cron/run-sequences`, `/api/sequences/[id]/enrol` | `sequences.js`, `event-reminders.js` | `SequencePicker.jsx`, `SequenceEditor.jsx` |
| Saved contact segments | 043 | `/api/contacts/segments`, `/api/contacts/search` (POST) | — | `ContactsView.jsx` (advanced filter + saved segments) |
| Per-event reminders | 044 | (cron-driven) | `event-reminders.js` | `EventForm.jsx` (Reminder section) |
| Cron monitoring | 053, 054 | `/api/cron/health-check` | `cron-heartbeat.js` | — (operator queries `cron_health` view) |

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
| `twilio.js` | Twilio SMS client. `sendSms({ to, body, from, statusCallback })` (low-level — no production callers as of mig 059, kept for completeness); `sendLocationSms({ location, to, body, statusCallback })` (preferred — per-location alpha sender ID resolution from mig 059, used by deposit flow + ad-hoc SMS + broadcasts); `getLocationSenderId(location)` (pure resolver, useful in UI previews); `validateAlphaSenderId(value)` (max-11 alphanumeric carrier rule). Resolution priority: `location.twilio_alpha_sender_id` → `process.env.TWILIO_FROM` → literal `'CCFautos'`. `toE164Ireland()` normaliser handles common formats (`087…`, `+353…`, bare `87…`). Alpha sender IDs are send-only in IE/UK/EU — recipients can't reply. The optional `statusCallback` arg sets Twilio's `StatusCallback` URL — Twilio POSTs lifecycle updates (queued → sent → delivered / undelivered / failed) to that URL. Used by broadcasts (Phase 5D / mig 065) for delivery analytics; the webhook lives at `/api/webhooks/twilio/status` and verifies the X-Twilio-Signature against TWILIO_AUTH_TOKEN. |
| `sms.js` | SMS broadcast engine (mig 060). `buildSmsAudience(db, filter, locationId)` returns the contacts query with the standard send-eligibility gates (active sms_status + has phone + sms_marketing opt-in (mig 064) + at this location) plus the user's audience filter applied via `applyAudienceFilter`. `sendBroadcast(broadcastId, { maxRecipients })` flips the broadcast to 'sending', loops `sendLocationSms` per recipient up to the per-call cap, writes per-recipient rows to `sms_broadcast_recipients` + activities timeline entries, finalises with sent/failed counts. **Chunked-resumable** (Phase 5B): if `maxRecipients` is hit before the audience is exhausted, the broadcast stays in 'sending' and the cron / next caller resumes via the recipients-table NOT-IN filter. Rate-limits to 25 sends per second. Allowed entry states: draft / scheduled / sending. Mig 061 added the 'scheduled' state — `/api/cron/run-sms-broadcasts` (every 5 min, see vercel.json) pulls scheduled-due AND in-flight 'sending' rows and dispatches via this same `sendBroadcast` with chunk size 1000 per tick (Pro 300s ceiling). Manual "Send now" passes 2000. SMS sequence steps (mig 062) call `sendLocationSms` directly via `sendSmsStep` in `sequences.js` rather than going through `sendBroadcast`. SMS event reminders (mig 063) call `sendLocationSms` directly via `sendSmsReminder` in `event-reminders.js` — the third channel alongside email + WhatsApp on the per-event single-shot reminder path, gated by the new `contact_preferences.sms_administrative` consent flag. |
| `sequences.js` | Sequence runner — `enrolContacts()`, `runSequences()` (cron), `triggerSequencesForBooking()`, `triggerSequencesForStatusChange()`, `triggerSequencesForTagsAdded()`, `runEventReminderTriggers()` (sequence-based event reminders). Audience filter respected via `contactMatchesSequenceAudience()`. |
| `event-reminders.js` | Per-event single-shot reminder runner — `runEventReminderSends()`. Reads `event_types.reminder_*` fields, finds bookings ~N min away, sends via email (Postmark transactional) or WhatsApp UTILITY template. Respects `email_administrative` / `whatsapp_administrative` consent flags (NOT marketing flags — reminders are transactional). Stamps `bookings.reminder_sent_at` for dedup. |
| `cron-heartbeat.js` | `stampHeartbeat(name)` — best-effort UPDATE of `cron_heartbeats.last_ok_at` called by every `/api/cron/*` route on the success path. Never throws, never blocks. Pairs with the `cron_health` view (mig 053) and `/api/cron/health-check` route to give external uptime monitors a single URL that 503s when any cron is stale. |
| `slug.js` | `toSlug(input)` — lowercase kebab-case, ASCII-only slug derivation. Used by `/api/admin/organizations` for org slug auto-derivation and by the `AddOrganizationButton` for the live preview as the operator types the name. Strips non-ASCII (no transliteration) and collapses runs of non-alphanumerics. Returns empty string for unusable input. Pinned by `slug.test.js`. |
| `assignment-changes.js` | Guards + audit writer for the master admin matrix v2 (mig 080). `countActiveMasters(db)`, `wouldLeaveZeroMasters(db, targetId)` — application-layer guard for the at-least-one-master invariant; pairs with the DB trigger `private.guard_at_least_one_master` for defence in depth. `logAssignmentChange(db, { actorId, targetProfileId, locationId, action, before, after })` — best-effort writer to `assignment_change_log`, never throws so an audit failure can't block the underlying mutation. `canRemoveSelfFromLastOwnerLocation(db, actorId, targetId, locationId)` — niche self-protection check that prevents an owner from accidentally removing their last owner-tier assignment. All called from the four `/api/admin/*` routes; can be reused by any future route that needs the same invariants. |
| `deposit-receipts.js` | Buyer-facing receipt SMS when a car deposit is paid (mig 078). `sendDepositReceiptSms({ db, car, location, actorId? })` is the single entry point — fired by the Revolut webhook after `cars.deposit_status` flips to `paid`. Three gates in priority order: location toggle (`car_deposit_receipt_sms_enabled`), idempotency (`cars.deposit_receipt_sent_at`), buyer phone present. On success: stamps the idempotency column AND inserts a `kind='system'` `car_notes` row with the Twilio SID (matches the issue-deposit-link pattern so operators can cross-reference in Twilio Console). Stamp lands ONLY after a confirmed Twilio success so a transient failure can be retried by the next webhook delivery. Best-effort end-to-end — caller (the webhook) swallows any exception so the deposit_status update remains the authoritative customer-facing signal. `buildReceiptBody({ car, location })` is exported separately so tests assert on body shape without standing up the full send flow. |

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
POSTMARK_WEBHOOK_TOKEN=          # shared secret sent in X-Webhook-Token by Postmark (required — route 500s if unset)
POSTMARK_WEBHOOK_TOKEN_PREVIOUS= # optional — old token kept live during rotation; unset after every Postmark webhook config has been flipped to the new value
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

**Postmark.** Auth is enforced — `POSTMARK_WEBHOOK_TOKEN` is required, and a missing env var returns 500 (not 200-with-warning). The 5xx is deliberate: Postmark retries 5xx responses for ~24h, so a config drift gets recovered as soon as the env var is set, instead of silently dropping events. A bad/missing `X-Webhook-Token` returns 403 (Postmark won't retry 4xx — correct behaviour for a deliberately-rogue caller). The auth predicate is exported from the route as `verifyPostmarkRequest({ headerValue, primarySecret, previousSecret })` and unit-tested in `src/lib/postmark-webhook-auth.test.js`. **Token rotation:** set `POSTMARK_WEBHOOK_TOKEN_PREVIOUS` to the old token while you flip every webhook custom-header config in Postmark over to the new one — both are accepted in the meantime, with a `[security]` warning when the previous one matches so you remember to finish the rotation. Unset PREVIOUS after.

**Meta WhatsApp.** Strict HMAC verification via `verifyMetaSignature()` against `WHATSAPP_APP_SECRET`. Missing env var or bad signature → 403.

When adding a new webhook handler, read the body with `await request.text()` first (verify HMAC), then `JSON.parse()` — calling `request.json()` consumes the body and the re-serialised JSON won't byte-match the signed payload. Mirror the Postmark pattern of exporting the pure auth predicate from the route module so the test can exercise it without mocking Supabase (see `verifyTwilioSignature` in the Twilio status webhook for another example).

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

**Owners are now studio-scoped (mig 051):** they can fully manage the studios they're owner at (edit settings, create staff with any per-location role *at that studio* including another owner-at-that-studio), but can't mint new locations, mint masters, or manage assignments at studios they're not owner at. The hierarchy is `master (platform) → per-location role (owner > manager > head_coach > staff)`.

**Helpers (`src/lib/schemas.js`):**
- `roleSchema` — Zod enum, includes `'master'` (used for `profiles.role`)
- `locationRoleSchema` — Zod enum, per-location only: `['owner','manager','head_coach','staff']` (no master)
- `assignmentSchema` — `{ location_id, role, is_default?, unifi_door_access? }` for the staff API
- `MASTER_ASSIGNABLE_ROLES` — `['owner','manager','head_coach','staff']` (per-location). Master itself granted via the separate `is_master` flag.
- `OWNER_ASSIGNABLE_ROLES` — `['owner','manager','head_coach','staff']` (mig 051: owner-at-X can grant another owner-at-X — no longer a platform-level promotion)
- `ADMIN_ROLES` — `['master','owner','manager']`
- `MANAGER_ROLES` — `['master','owner','manager','head_coach']`

**RLS:** `private.auth_is_in_location(loc_id)` OR-shorts via `private.auth_is_master()` — membership policies grant master automatically. Mig 052 added per-location helpers (`auth_is_owner_at(loc)`, `auth_is_admin_at(loc)`, `auth_is_manager_at(loc)`) and switched `pipeline_stages`, `webhook_subscriptions`, `profile_locations`, and `locations` policies to use them, so e.g. an owner-at-Hatch can no longer modify `pipeline_stages` rows that belong to Stillorgan via the authenticated channel. `profiles "Admins can manage profiles"` is master-only at the RLS layer (per-location ownership of a user-level row doesn't have a clean RLS expression); the API enforces per-location authorization for non-master callers.

**StaffForm UI (wizard since mig 051):** Per-location cards instead of a single role dropdown. Each card has its own role + UniFi door-access toggle + default flag. Caller props `callerIsMaster` + `callerOwnerLocationIds` gate which cards are editable; assignments at locations the caller isn't owner at render read-only ("Owner of that studio can edit"). Master callers also see a `Master / Platform Admin` toggle in its own panel above the assignments wizard.

### Per-location feature gates (migration 032)

Each location row has a `features JSONB` column that gates feature visibility for every user at that location. Three-tier resolution in `hasPermission(user, key)`:

1. **Location gate** — `user.activeLocation.features[key] === false` → DENIED for everyone, including master (only exception: master + `key === 'settings'` on web, which is the escape hatch back to the feature toggles). Notification keys (`notify_*` + anything in `NOTIFY_KEYS`) are exempt — those stay personal.
2. **Per-location user override (mig 058)** — `user.activeAssignment.permissions[key] === true | false` → that wins. Profile-wide `user.permissions` is **not** read anymore (was the source of the cross-location leak fixed in mig 058). Master skips this tier (and tier 3) once tier 1 passes.
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

**Light theme palette — text on light cards.** The codebase migrated to a light theme; `un1t-dark` (#F7F8FA) is a near-white card background, not the dark name suggests. Status text on these cards needs the **-700 ramp**, not -300. The dark-theme-tuned values (`text-amber-300`, `text-red-300`, `text-blue-100`) look washed-out and unreadable against the light surface.

| Use case | Class |
|---|---|
| Status text on light card / banner | `text-{red,amber,emerald,blue}-700` |
| Heavy emphasis (header in alert chip) | `text-{red,amber,blue}-800` |
| Icons next to that text | `text-{red,amber,blue}-600` |
| Bar fills / saturated backgrounds | `bg-{red,amber,emerald}-500` (unchanged — solid swatches OK) |
| Tinted background (10-20% opacity) | `bg-{red,amber}-500/10` (unchanged) |

The `RosterSummaryPanel` `STATUS_STYLES` map is the canonical reference. If a new alert chip looks pale in a screenshot, this is almost always why.

**Git operations from terminal — zsh + bracketed paths.** Next.js dynamic-route paths contain `[id]`, `[token]`, `[slug]` etc. Zsh treats `[…]` as a glob character class and aborts the entire command with `zsh: no matches found:` if nothing matches the literal directory name. This silently breaks `git add`, leaving the staging area empty even though earlier files in the same line *looked* like they staged.

Three safe forms when scripting git operations from zsh:

```bash
# 1. Single-quote the bracketed path
git add 'src/app/contacts/[id]/page.js'

# 2. Disable glob expansion for one command
noglob git add src/app/contacts/[id]/page.js src/lib/foo.js

# 3. Stage by directory or use git add -A on a clean staging buffer
git add src/app/contacts/ src/lib/foo.js
```

**Git lock files when an IDE watches the repo.** The `fatal: cannot lock ref 'HEAD': … HEAD.lock: File exists` error usually isn't a real concurrent process — it's an IDE git extension (VS Code, Cursor, GitHub Desktop) racing with a manual `git commit` and leaving stale `.lock` files behind. Recipe:

```bash
# Find every stale lock under .git/ in one shot
find .git -name '*.lock' -delete
```

If the locks come back immediately, an IDE is actively re-creating them. Quit the IDE (Cmd-Q, not just close window) before retrying. Both gotchas have bitten us multiple times — burn them in.

**Fire-and-forget side effects after a primary write.** Sending an email/SMS/push as a follow-up to a write (booking → confirmation, contact stage change → activity log, manager publish over budget → email owners) MUST NOT block or fail the primary response. The pattern across the codebase:

```js
// Primary write — return early on failure.
const { data, error } = await db.from('bookings').insert(...).select().single()
if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

// Side effect — best-effort, swallows its own errors.
let sideEffectResult = null
try {
  const { sendBookingConfirmation } = await import('@/lib/booking-confirmations')
  sideEffectResult = await sendBookingConfirmation(db, data.id)
} catch (e) {
  console.warn(`[booking] confirmation send error: ${e?.message || e}`)
}

return NextResponse.json({ success: true, data, confirmation: sideEffectResult })
```

Three rules:
1. The helper itself catches + logs internally so a `console.warn` is the worst the caller sees.
2. The route's `try/catch` is a belt-and-braces second line — covers the unlikely "helper crashed before its own try ran" case.
3. The side-effect result rides along on the response when it has a value (e.g. `{ confirmation: { sent: ['email'], skipped: [] } }`), so the UI can surface "we emailed you" if it ever wants to. Don't make the response shape *depend* on the side effect succeeding.

Codebase examples to copy from: `/api/public/book` (booking → confirmation), `/api/contacts/[id] PUT` (status change → pipeline-event activity log), `/api/schedule/rosters POST` (over-budget manager publish → owner notification email).

**Multi-channel send gate convention.** Whenever a feature pushes a message that can go via email AND/OR SMS (booking confirmation, reminders), the channels run *independently* in their own `try/catch` rather than bailing on the first failure. The aggregation rule is consistent everywhere:

| Outcome of any one channel | Effect on the others | Aggregate status |
|---|---|---|
| `sent` | other channels still run | counted in `channels_sent[]` |
| `skipped` (consent / status / no-data) | other channels still run | listed in `skipped[]` with reason |
| `failed` (provider error, template missing) | other channels still run; aggregate is `failed` IF nothing else sent | runner doesn't record the dedup row → retries next tick |

This is what `event-reminders.js` (mig 076) does for reminders and `booking-confirmations.js` (mig 077) does for confirmations. Email-down does not take SMS down. Partial sends count as `sent`, not `partial_failure`, because the operator's intent ("notify the customer somehow") was satisfied.

The per-channel gate set is stable across the codebase — copy it verbatim when adding a new send path:

```js
// Email gate
if (c?.email_status && ['bounced', 'complained', 'unsubscribed'].includes(c.email_status)) return skip
if (admin_email_consent === false) return skip
if (!to) return skip

// SMS gate
if (c?.sms_status && c.sms_status !== 'active') return skip
if (admin_sms_consent === false) return skip
if (!phone) return skip
```

**Deprecated columns kept on disk.** When a feature gets a new schema (e.g. mig 076 moved single-reminder columns on `event_types` to a multi-row `event_type_reminders` table), the old columns are NOT dropped in the same migration. Instead:

1. Migration adds new tables / columns + backfills from the old shape.
2. Old columns get a `COMMENT ON COLUMN ... 'DEPRECATED (mig N)'` so the next person on the codebase sees they're stale.
3. Code (runner + form + writers) stops reading the old columns. Forms also stop *writing* them on save, so re-saved rows blank out their stale values.
4. A separate cleanup migration much later (after we're confident the new path is bedded in) drops the columns.

Why: a single migration that drops + replaces is irreversible; a two-stage migration lets us roll back the code change without DB-side action if the new path proves wrong. Examples in the codebase: `event_types.reminder_*` (mig 076 deprecates, no cleanup yet), `public.shifts` (mig 067 deprecates in favour of `shift_blocks` + `shift_assignments`, mig 068 + 069 keep it auto-populated via triggers, no cleanup yet).

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

Stored under `profile_locations.permissions.mobile.<key>` per assignment (mig 058 — was profile-wide on `profiles.permissions.mobile` until mig 058 moved it). JSONB allows arbitrary keys, so adding a new feature is just an entry in `MOBILE_PERMISSIONS` and `DEFAULT_MOBILE_PERMISSIONS_BY_ROLE` inside **`shared/permissions.js`** — the single source of truth imported by both `src/components/StaffForm.jsx` (web admin) and `mobile/lib/permissions.js` (iOS app). Adding the entry there auto-flows everywhere; `npm run check:mobile-parity` enforces that web and mobile permission sets stay aligned. Read on mobile via `lib/permissions.js → canMobile(profile, key, activeLocation)`. The `activeLocation` arg now carries `permissions` (the active assignment's blob, surfaced by `/api/mobile/me`); `canMobile` reads it at tier 2, falls through to `DEFAULT_MOBILE_PERMISSIONS_BY_ROLE[profile.role]` at tier 3. Switching active location flips both the gate and the per-location override since the mobile app re-fetches `/api/mobile/me`.

### Push notifications

Tokens are registered server-side in the `device_tokens` table (migration 023) via `POST /api/mobile/device-tokens`. `src/lib/push.js` fans out via Expo Push Service, honouring both the master `permissions.mobile.push_notifications` switch and per-category `notify_<category>` flags (`time_off`, `schedule`, `swap`, `lead`, `whatsapp`). `DeviceNotRegistered` responses from Expo automatically prune stale tokens — no cron needed.

For production push (TestFlight / App Store), an Apple Developer account ($99/yr) is required: `eas credentials` configures APNs, then `eas build --platform ios` produces a `.ipa`. During Expo Go development, Expo proxies to its own push channel — no Apple credentials needed.

### Deployment (mobile)

EAS Build for App Store / TestFlight (`eas build --platform ios`). The Vercel-deployed `crm.un1tdublin.com` is the API base URL the mobile app calls — no separate backend deploy.

## Deployment

Vercel Pro. Crons (all in `vercel.json` — Pro removes the Hobby 2-cron cap and `>= once-per-day` schedule restriction):

- `/api/cron/run-scheduled-reports` — daily 07:00 UTC (= 07:00 Dublin in winter, 08:00 in summer — `vercel.json` doesn't accept a `timezone` field; use the Vercel dashboard if you ever need DST-stable scheduling). Generates due `scheduled_reports`.
- `/api/cron/prune-rate-limits` — daily 03:30 UTC. Deletes expired `rate_limit_buckets` rows.
- `/api/cron/run-sms-broadcasts` — every 5 minutes. Picks up scheduled-due AND in-flight 'sending' rows, dispatches via `sendBroadcast` with chunk size 1000 per tick (Pro 300s ceiling).
- `/api/cron/run-sequences` — every 5 minutes. Three phases per tick: (1) `runEventReminderSends()` for per-event single-shot reminders, (2) `runEventReminderTriggers()` for sequence-based event reminder triggers, (3) `runSequences()` to fire due steps. Each phase is independent so a failure in one doesn't stop the others. **Migrated from pg_cron + pg_net to Vercel Crons** once we moved to Pro — eliminates the dual-source-of-truth for `CRON_SECRET` that caused the May 1 silent-401 incident (see Cron monitoring below). The legacy `private.app_config.cron_secret` row is retired; Vercel env is the only source.

All crons are protected by `Authorization: Bearer ${CRON_SECRET}` which Vercel Cron injects automatically. Long-running crons set `export const maxDuration = 300` (Pro ceiling) so a busy 5-min window can finish without hitting the function timeout.

### Cron monitoring (mig 053, 054)

`public.cron_heartbeats` (one row per cron name) is stamped via `stampHeartbeat(name)` in `src/lib/cron-heartbeat.js` on every successful tick. The `public.cron_health` view (security_invoker = on, RLS-respecting) computes `is_stale` live as `NOW() - last_ok_at > expected_interval + grace`. `/api/cron/health-check` reads the view and returns **200** when every cron is fresh, **503** when any is stale — auth-gated by `CRON_SECRET`.

External uptime monitors (UptimeRobot, Better Stack, Pingdom — anything that supports HTTP monitors with custom headers) ping `/api/cron/health-check` every few minutes with `Authorization: Bearer ${CRON_SECRET}` and alert on any non-2xx. One URL covers all crons; no per-cron monitor config needed. Vercel Hobby has no native log-based alerting, so external pingers are the right primitive.

Why this exists: on **2026-05-01 14:41 UTC** the `CRON_SECRET` on Vercel drifted from the value stamped into `private.app_config.cron_secret` used by pg_cron via pg_net. `/api/cron/run-sequences` silently 401'd every 5 minutes for ~22 hours. We caught it by chance — there were no due enrolments during the window, so the customer impact was zero, but it could just as easily have been a launch. The heartbeat → view → health-check → external monitor chain means the next drift surfaces within minutes.

When adding a new cron, add a row to `public.cron_heartbeats` (name, expected_interval_seconds, grace_seconds) in the same migration that creates the cron, and call `stampHeartbeat(name)` on the success path of the route. The health-check picks it up automatically.

### Database

Supabase for database + auth + file storage (`branding` bucket for logos). Migrations are forward-only — there are no down migrations. Apply via the Supabase MCP (`apply_migration` tool) or, when MCP is unavailable, paste the SQL into the Supabase Dashboard SQL Editor. After every DDL change, run the security advisor (`get_advisors` MCP tool, type=security) — RLS misses, missing policies, mutable `search_path`, and over-broad grants get flagged immediately.

**Views default to SECURITY DEFINER on Supabase.** Any view created in a migration is owned by the postgres role and runs with its permissions, which bypasses RLS on the underlying tables. The advisor catches this; the fix is `ALTER VIEW <name> SET (security_invoker = on)` (or `WITH (security_invoker=on)` on creation). Mig 054 fixed this for `cron_health`. Always set `security_invoker = on` on new views unless there's a specific reason not to.

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
| Email broadcasts (`/communications/campaigns`) | `lib/postmark.js → sendCampaign` | (n/a) | `email_marketing` (broadcast stream) |
| Email sequences | `lib/sequences.js → sendEmailStep` | (n/a) | inherits sequence audience filter (transactional stream) |
| SMS broadcasts (`/communications/sms/broadcasts`) | `lib/sms.js → sendBroadcast` | (n/a) | `sms_marketing` |
| Sequence SMS steps (runner) | `lib/sequences.js → sendSmsStep` | (n/a) | inherits sequence audience filter |
| Per-event email reminders (mig 076) | `lib/event-reminders.js → sendEmailReminder` | (n/a) | `email_administrative` (transactional stream) |
| Per-event SMS reminders (mig 076) | `lib/event-reminders.js → sendSmsReminder` | (n/a) | `sms_administrative` |
| Booking confirmation email (mig 077) | `lib/booking-confirmations.js → sendEmailConfirmation` | (n/a) | `email_administrative` |
| Booking confirmation SMS (mig 077) | `lib/booking-confirmations.js → sendSmsConfirmation` | (n/a) | `sms_administrative` |
| Booking cancellation email (mig 074) | `/api/bookings/[id]/cancel` route | (n/a) | `email_administrative` |
| Roster approval-request email (mig 072) | `lib/roster-email.js` | (n/a) | (n/a — internal staff notification) |
| Deposit-link delivery (cars) | `lib/twilio.js → sendLocationSms` | (n/a — alphanumeric sender, one-way) | (n/a — buyer just submitted booking; implicit) |
| Deposit-paid receipt (cars, mig 078) | `lib/deposit-receipts.js → sendDepositReceiptSms` (called from Revolut webhook) | (n/a — alphanumeric sender) | (n/a — buyer paid; receipt is implicit follow-on, gated by per-location `car_deposit_receipt_sms_enabled` toggle instead of per-contact consent) |
| Ad-hoc contact SMS (`/api/contacts/[id]/sms`) | `lib/twilio.js → sendLocationSms` | (n/a) | (n/a — operator-initiated, single recipient) |

**Reminders are administrative, not marketing.** `contact_preferences` separates the two — schema has `email_marketing` + `email_administrative` (and the WA / SMS equivalents). Reminder + confirmation + cancellation code paths check ONLY the `_administrative` flag; opting out of marketing doesn't stop them. Hard signals (`email_status` bounced/complained, `sms_status ≠ active`, `wa_status` blocked/opted_out) cause reminders to skip AND record the skip (mig 076: `booking_reminder_sends`; mig 044 legacy: `bookings.reminder_sent_at`) so the cron doesn't retry forever — only true infra failures stay un-recorded for retry.

**WhatsApp is no longer used for transactional reminders.** Mig 074 retired the WA branch from `event-reminders.js` and added a CHECK constraint enforcing `event_types.reminder_channel ∈ {email, sms}`. Mig 076 carried that forward to `event_type_reminders.channels`. Mig 077 inherits the same restriction. The reasoning: WhatsApp templates are reserved for explicit campaigns (where the operator's chosen audience opted into marketing), not for transactional pushes that a CRM-side rule decides to fire. Customers who get a transactional WA message they didn't consent to flag the conversation, which counts against the WABA quality rating, which throttles future broadcast capacity.

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

**Schema (mig 044, 046, 047, 078).** `cars` row gets:
- `deposit_token` (UUID, unique, indexed) — the public URL key. **Rotates on every issue.**
- `deposit_token_expires_at` — 24h from last issue. Public endpoints reject expired tokens with HTTP 410 + `{ code: 'TOKEN_EXPIRED' }`.
- `deposit_amount` — per-car override of `locations.car_deposit_default_amount` (default €500).
- `deposit_link_sent_at` + `deposit_link_sent_via` (`'sms'` only after the Twilio switch).
- `deposit_terms_accepted_at` + `_ip` + `_version` — evidence trail. Version snapshot at acceptance time so if the operator edits T&Cs later, the buyer's accepted version is preserved.
- `deposit_revolut_order_id` + `_checkout_url` — Revolut order linkage.
- `deposit_status` — `null → sent → terms_accepted → paid` (terminal happy path; `cancelled`, `failed`, `refunded` for sad paths).
- `deposit_paid_at` + `deposit_paid_amount`.
- `deposit_receipt_sent_at` (mig 078) — idempotency stamp for the buyer-facing receipt SMS. Set ONLY on a confirmed Twilio success so a transient failure can be retried by the next webhook delivery.

`locations` gets `car_deposit_default_amount`, `car_deposit_terms` (operator-editable text), `car_deposit_terms_version` (bumped server-side every time the wording changes), `car_deposit_whatsapp_template_id` (unused after the Twilio switch — kept in schema for now, can be dropped in a follow-up mig), and `car_deposit_receipt_sms_enabled` (mig 078, BOOLEAN NOT NULL DEFAULT FALSE — per-location opt-in for the deposit-paid receipt SMS; backfilled to TRUE for any location with `car_deposit_default_amount IS NOT NULL` at deploy time so CCF Autos auto-enabled).

**Token rotation.** Every call to `/api/cars/[id]/issue-deposit-link` generates a fresh `deposit_token` (unless the deposit is already paid — then keeps the existing token so the receipt URL stays valid). Old URLs become 404s. Limits the blast radius if a link is forwarded somewhere it shouldn't be. Same call also sets `deposit_token_expires_at = NOW() + 24h` and clears any in-flight Revolut order linkage so the next accept-and-pay creates a fresh order under the new token's idempotency key.

**System notes (mig 047).** `car_notes` table holds two kinds of entries: `manual` (operator-typed) and `system` (auto-generated). Every `issue-deposit-link` call inserts a system note with the URL + the Twilio SID for cross-referencing in Twilio's logs. The note's URL renders as a clickable link with a copy-to-clipboard button in the UI — exactly the affordance an operator needs when they want to copy / re-test / re-share a link without re-clicking the issue button. RLS-scoped via denormalised `location_id`.

**Public page (`src/app/deposit/[token]/page.js`).** Renders `<CarDepositPage>` (a client component). Page loads → fetches deposit data → renders T&Cs + accept checkbox → ticks accept → mounts the Revolut embedded checkout widget → buyer submits → SDK calls `createOrder` callback which POSTs to `/api/public/deposit/[token]/accept-and-pay` → endpoint records the consent (timestamp + IP + terms version snapshot) and creates the Revolut order → returns the order token → SDK takes payment → `onSuccess` fires → page refetches deposit data → green confirmation card. The webhook is the authoritative DB-flip; the SDK callback is just for instant UX feedback.

**Operator UI.** `DepositCard.jsx` (dynamic-imported into `CarDetail.jsx`) shows the status badge, amount input, **Send / Resend deposit link** button, expiry countdown ("expires in 22h 14m"), and a 'View public page' preview link. `CarDepositSettings.jsx` (in `/settings/locations/[id]`) exposes the default amount + terms textarea + the **"Send buyer a receipt SMS when their deposit is paid"** toggle (mig 078) — saving with changed terms bumps the version automatically.

**Deposit-paid receipt SMS (mig 078).** When the Revolut webhook receives `ORDER_COMPLETED` for a car's order, after flipping `deposit_status='paid'` it fires `sendDepositReceiptSms` (`src/lib/deposit-receipts.js`) as a best-effort side effect. Three gates in priority order: location toggle (`car_deposit_receipt_sms_enabled`), idempotency (`cars.deposit_receipt_sent_at`), buyer phone present. Body example: `"Hi Sarah, we've received your €500.00 deposit for Tesla Model 3 241-D-1234. Thanks — we'll be in touch shortly to arrange next steps. CCF Autos."` Single segment for typical car-name lengths. Each successful send stamps `deposit_receipt_sent_at` AND inserts a `kind='system'` `car_notes` entry with the recipient phone + Twilio SID — same diagnostic pattern as the issue-deposit-link route. Failure modes: SMS failure leaves `deposit_receipt_sent_at` unstamped (so a future webhook delivery could retry, though in practice we always 200 so retries don't happen — operator can text the buyer manually if needed and the absence of a system note is the visible signal). The receipt is intentionally **not** part of any consent gate — buyer just paid us money, the receipt is a transactional necessity not a marketing message; the per-location toggle is the right place to opt in/out.

**Concurrency.** Each car is fully isolated end-to-end (`deposit_token`, `deposit_revolut_order_id`, `deposit_revolut_checkout_url`, idempotency key all keyed off the car). 4-5 simultaneous deposits work without contention — Postgres serializes UPDATEs naturally on different rows, Vercel scales horizontally per request, Revolut webhooks land in different car rows. Only edge case: two operators issuing the same car at the exact same moment would race — easy to fix with row-level lock if it ever matters.

## Comms automation

Three cron runners + two synchronous send paths, all anchored on the booking lifecycle. Cron tick is `/api/cron/run-sequences` every 5 min via Vercel Crons — see Deployment.

**Cron runners:**

1. **`runEventReminderSends()`** — multi-reminder runner (mig 076). Reads `event_type_reminders` rows (1..N per event_type), finds bookings approximately `minutes_before` away (±1h DST-tolerant window), runs each channel in `reminder.channels[]` (email + sms, or one of them) independently, dedups via `booking_reminder_sends` UNIQUE(booking_id, reminder_id). Stamps legacy `bookings.reminder_sent_at` on first send for back-compat with the partial index from mig 044. Honours `bookings.skip_reminder` (mig 075) as the operator override that beats every other gate. Configured per-event in `EventForm.jsx` → Reminders section (multi-row list, hours input, per-row channel multi-select).

2. **`runEventReminderTriggers()`** — sequence-based event reminders. For each active sequence with `trigger_type='event_reminder'`, finds bookings ~hours_before away and creates a sequence enrollment. Use this when the reminder flow is more complex than "send X channel(s) once at offset Y" (e.g. branching based on lead_status). The simpler per-event path covers most cases.

3. **`runSequences()`** — picks up due enrollments (`status='active' AND next_step_at <= now()`) and sends the next step (email via Postmark, WhatsApp via template, SMS via `sendLocationSms`, or wait). Failure-counted per enrollment with auto-pause after 5 consecutive errors.

**Synchronous send paths (fired at the moment of the user action, not a cron):**

4. **`sendBookingConfirmation(db, bookingId)`** — mig 077. One-shot at booking creation. Reads `event_types.confirmation_*` columns, runs each configured channel independently, writes a `kind='event'` activity to the contact timeline. Called from `/api/public/book` as a fire-and-forget side-effect — Postmark/Twilio failure never breaks the customer's success response.

5. **`/api/bookings/[id]/cancel`** — mig 074. Operator-initiated cancellation, optional Postmark email to the customer with their reason. Same `email_administrative` opt-out gate as confirmations + reminders. Trigger from mig 074 logs the status flip as a `kind='event'` activity automatically; the route doesn't double-log.

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

## Working from Cowork (Claude sandbox notes)

When Claude is operating on this repo from inside Cowork mode, it runs in an isolated Linux sandbox that bind-mounts the host's `/Users/richardivers/code/` at `/sessions/<sandbox-id>/mnt/code/`. The sandbox has filesystem and tool restrictions that aren't obvious from the README, and we hit all of them during the May 3 2026 session. This section is the durable record so future Claude doesn't re-derive (and re-fail at) any of them.

**The sandbox can read and write files but cannot `unlink()` by default.** First-time symptom: `rm` fails with `Operation not permitted` (EPERM, not EACCES — important, because EPERM means "the operation isn't allowed for this user" rather than "permissions deny it"). Files the sandbox just created with `touch` and 0600 perms still can't be removed. This is a deliberate Cowork safety guardrail at the bind-mount layer — `chmod`, `chown`, `chflags`, ACL edits do nothing because the restriction is above the host filesystem. **The fix is `mcp__cowork__allow_cowork_file_delete`** — call it with the path Claude was trying to delete, the user gets an approval prompt scoped to a directory (`code` in our case), and from that point forward `unlink()` works for everything under the approved dir. This unblocks not just `rm` but also `git gc`, `git reset --hard`, `git checkout` of a branch with deleted files, etc. — anything that needs to delete files. **Default response when an `rm` fails should be to call this tool, not to tell the user it's impossible.**

**`git push` from the sandbox needs explicit credential setup** — the sandbox `HOME` is `/sessions/<sandbox-id>/`, has no `~/.gitconfig`, no `~/.ssh`, no `gh` CLI, and no credential helper. Default `git push` over HTTPS fails with `could not read Username for 'https://github.com'`. The pattern that works (committed-on-disk PAT + sandbox-only credential helper):

1. Fine-grained PAT lives at `/Users/richardivers/code/.github-pat` (one level above the repo, so it's outside `un1t-crm/` and can't accidentally be committed). 0600 perms. **Never moves into the repo, never enters chat history, never goes into a remote URL.** From inside the sandbox the same file is at `/sessions/<sandbox-id>/mnt/code/.github-pat`.
2. PAT permissions for the un1t-crm repo specifically (do NOT grant "All repositories" scope):

   | Permission | Level | Why |
   |---|---|---|
   | Metadata | Read | Required, auto-added |
   | Contents | Read and write | Push commits, create branches, fetch history |
   | Pull requests | Read and write | Open / comment / merge PRs |
   | Actions | Read | See CI status before suggesting merges (optional but cheap) |

   Skip Issues, Workflows (the `.yml` files), Secrets, Variables, Webhooks, Pages, Discussions, Deployments, Codespaces, Packages. Account-level permissions all "No access". Token expiration: 90 days, set a calendar reminder to rotate.

3. Credential helper script in sandbox `/tmp` (sandbox-only path so it never affects the user's terminal git):

   ```bash
   cat > /tmp/git-cred-helper.sh <<'EOF'
   #!/bin/sh
   case "$1" in
     get)
       echo "username=x-access-token"
       printf "password=%s\n" "$(tr -d '\n' < /sessions/<sandbox-id>/mnt/code/.github-pat)"
       ;;
   esac
   EOF
   chmod +x /tmp/git-cred-helper.sh
   ```

4. Push with the helper inline (avoids persisting any credential config to `.git/config`, which would break the user's terminal git):

   ```bash
   git -c credential.helper="/tmp/git-cred-helper.sh" push origin main 2>&1 | sed 's|github_pat_[A-Za-z0-9_]*|github_pat_REDACTED|g'
   ```

   The `sed` filter is belt-and-braces in case git ever logs the URL with creds in an error path. Real PAT tokens start with `github_pat_` (fine-grained) or `ghp_` (classic) — both should be redacted before output is shown to the user.

**Each Cowork session is a fresh sandbox.** `/tmp/git-cred-helper.sh` doesn't survive between sessions. Recreate it on demand at the start of any session that needs to push. The sandbox ID also changes between sessions, so `/sessions/<sandbox-id>/...` paths can't be hard-coded — derive from `pwd` or `$HOME` at runtime.

**GitHub MCP server (api.githubcopilot.com/mcp/) does NOT support dynamic client registration.** Calling `mcp__plugin_engineering_github__authenticate` returns `Incompatible auth server: does not support dynamic client registration. Ask the user to run /mcp and authenticate manually.` This isn't fixable from Claude's side — the user has to type `/mcp` in Cowork chat to open the manual auth panel. Even after that, the real GitHub tools (`create_or_update_file`, `push_files`, `get_file_contents`, etc.) didn't appear in Claude's deferred-tool list during our session — possibly a tool-list refresh issue, possibly the manual flow didn't actually complete the handshake. **The PAT-based push above is the working alternative and doesn't depend on the GitHub MCP server at all.** Revisit GitHub MCP only if the use case calls for API-shaped operations (PR review workflows, issue triage) that are awkward over plain git.

**Common `mobile/eas.json` clutter in `git status`.** It's been there since before any of this work — unrelated to anything Claude has touched, leave it alone. If `git status` shows it as untracked, it's not a regression.

**Auto-pack runs in the background after fetches now that delete works.** You'll see `Auto packing the repository in background for optimum performance` after a `git fetch`. Harmless — it's git's normal `gc --auto` doing housekeeping, which was previously blocked by the no-unlink restriction. Don't react to it.

**If you're using Claude Code (CLI) instead of Cowork, none of this applies.** Claude Code runs natively in the user's terminal with their actual `~/.gitconfig`, `~/.ssh`, and `gh` CLI — `git push` just works. The sandbox-specific knobs (PAT helper, file-delete permission tool) are Cowork-only operational concerns.

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

- **Two-sided secrets need monitoring.** When a secret has to match between two systems we control (Vercel `CRON_SECRET` + `private.app_config.cron_secret`), drift is silent and only surfaces when something downstream notices. The fix isn't "be careful when rotating" — it's "the system tells us within minutes when something stops working". Pattern: every cron writes a heartbeat on success, a view computes is_stale, a single health-check endpoint 503s when anything is stale, an external monitor pings the endpoint. See "Cron monitoring" under Deployment.

- **Supabase views default to SECURITY DEFINER.** Any view created in a migration runs with the postgres role's permissions and bypasses RLS on the underlying tables. The advisor (`get_advisors` MCP, type=security) catches it as an ERROR-level lint. Always include `WITH (security_invoker = on)` on `CREATE VIEW`, or follow up with `ALTER VIEW ... SET (security_invoker = on)`.

- **Cowork sandbox has filesystem and auth restrictions worth knowing about.** Specifically: it can't `unlink()` files by default (fix via `mcp__cowork__allow_cowork_file_delete` — don't tell the user it's impossible), it has no GitHub credentials so `git push` needs an explicit PAT + credential helper setup, and the GitHub MCP server doesn't support DCR so the auto-OAuth flow can't be initiated by Claude. Full operational guide and the working-pattern recipe are in the "Working from Cowork (Claude sandbox notes)" section above. None of this applies if using Claude Code in the user's terminal — it's Cowork-specific.

## Roster v2 — shift template restructure

Active roadmap (May 2026). The schedule today is shift-as-coach-row: a template is "a thing a coach does", and editing the schedule means moving coach rows around. Roster v2 inverts that — templates become **demand windows** ("9:30–10:30 mon–fri, up to 15 coaches"), and the schedule is the **fulfilment layer** where operators assign coaches into those windows week by week.

### The model

```
shift_template
  ├─ start_time, end_time
  ├─ days_of_week text[]               ← new (e.g. {mon,tue,wed,thu,fri})
  ├─ max_coaches smallint default 15   ← new, configurable per template
  └─ location_id

shift_block (instance of a template on a specific date)
  ├─ template_id
  ├─ location_id
  ├─ date
  ├─ start_time, end_time              ← snapshot from template at generation time
  ├─ max_coaches                       ← snapshot
  └─ roster_id                         ← phase 5

shift_assignment (n:m — multiple coaches per block)
  ├─ block_id
  ├─ profile_id
  └─ created_at, created_by

profile (extended in phase 3)
  ├─ employment_type 'fte' | 'contractor'
  ├─ contracted_weekly_hours numeric   ← FTE only (CHECK)
  └─ hourly_rate numeric

locations (extended in phase 4)
  └─ monthly_contractor_budget_eur numeric

rosters (phase 5 — the publish-state container)
  ├─ location_id, period_start, period_end
  ├─ status 'draft' | 'published'
  ├─ published_by, published_at
  └─ over_budget_approval_by, over_budget_approval_at
```

A block exists once the template + date combination becomes a candidate week — even with zero assignments. **An empty block is a problem to flag, not a row to suppress.** Customers will be in the studio either way; the system has to surface "no coach is going to be here for the 9:30 class" loud and early.

### Locked decisions (don't re-derive)

- **FTE is sunk cost.** FTE coaches don't count against the contractor budget. The whole point of an FTE is that they're paid whether or not they coach a specific session — costing their shifts in euros against a budget creates the wrong incentive ("don't roster Sarah, she's expensive"). FTE side is tracked in **hours utilisation** (allocated / contracted), not euros.
- **Contractor euros are the only number that hits the budget.** `monthly_contractor_budget_eur` on the location is a **ceiling** for the variable spend. Calc: sum(contractor block hours × hourly_rate) for the month being viewed.
- **One budget field, not two.** No FTE budget. The FTE target is implicit ("get to 100% utilisation of contracted hours where possible").
- **Default capacity = 15.** Not magic — just "high enough that any conceivable all-hands shift fits". Configurable per template, no hard cap.
- **Empty-block flag = red marker on the calendar cell + count badge on the Today tab for managers/owners.** Operators and coaches don't get the alert. The alert addresses owner/manager liability; staff can't fix it.
- **Publish gate is owner-only when over budget.** Manager can publish a draft if projected contractor spend ≤ budget. Over budget → owner approval required, recorded on the roster row (who, when).
- **Leave is phase 6.** Until then, FTE availability = `contracted_weekly_hours`, leave-blind. Don't try to derive leave from whatever ad-hoc system exists today.

### Phase plan

| Phase | Scope | Migrations | Ships independently? |
|---|---|---|---|
| 1 | Data model: `shift_templates.days_of_week`, `shift_templates.max_coaches`, new `shift_blocks` + `shift_assignments` tables. Backfill: each existing shift → block + 1 assignment. RLS mirrors current shift policies. | 067 | ✅ shipped May 2 2026 |
| 2 | Template editor (multi-day picker + capacity field). ScheduleCalendar renders blocks with "n / max" badge + red marker on empty future blocks. Coach assign/unassign popover. Today-tab unstaffed-block badge for owner/manager. Bidirectional sync trigger (mig 068 forward + mig 069 reverse, both guarded by `pg_trigger_depth()`) keeps `public.shifts` mirrored from new writes so mobile + reports + swap-requests + copy-week + copy-month all keep working unchanged during cutover. | 068, 069 | ✅ shipped May 2 2026 |
| 3 | Profile employment fields (`employment_type`, `contracted_hours_per_week`, `hourly_rate`, `overtime_rate`, `annual_salary`). The columns pre-existed from an earlier payroll pass — phase 3 added the CHECK constraint enforcing `employment_type ∈ {fte, contractor}`, set NOT NULL with default `'fte'`, and added `fetchIncompletePayProfiles()` + a manager-facing completeness chip on the Today tab so phase 4's cost calc isn't silently zero-costing incomplete profiles. | 070 | ✅ shipped May 2 2026 |
| 4 | Week summary panel below ScheduleCalendar: per-coach FTE utilisation bars, contractor euro spend (visible month) vs `monthly_contractor_budget_eur`, FTE implicit-cost context, status-coloured rows (overtime / on-target / underused / no_contract), missing-pay-data warning. Read-only / advisory. | 071 | ✅ shipped May 2 2026 |
| 5 | `rosters` table + draft/published state. New `<PublishRosterModal>` shows the budget impact preview (via `dry_run=true` on POST /rosters), then commits via the same endpoint. Owner publishing over budget can confirm with `force_over_budget=true` (records self-approval). Manager publishing over budget creates a `draft` and emails location owners; approval lives at `/schedule/approvals` (calls POST /rosters/[id]/approve). | 072 | ✅ shipped May 2 2026 |
| 6 | Leave-aware FTE availability. `leaveHoursInWeek()` walks weekdays in the overlap of approved `time_off_requests` and the visible week, deducts `(contracted_hours_per_week / 5)` per weekday from the utilisation denominator. New `on_leave` status flags coaches rostered during full-week approved leave (loudest red, sorts to top). Phase 4 callers that don't pass `timeOff` keep their original behaviour. | — | ✅ shipped May 2 2026 |

### Open questions to revisit at each phase boundary

- **Editing a template's `days_of_week`.** Phase 1 default: only future blocks (date >= today) regenerate; past blocks freeze. Confirm at phase 2 when the editor lands.
- **Coach in multiple blocks at the same time.** Phase 2 should warn ("Sarah is already on the 9:30 Hatch block this morning") but not hard-block — sometimes a coach floats across two studios on adjacent slots.
- **Block-level capacity override.** Phase 1 stores `max_coaches` on the block as a snapshot of the template at generation time. Whether a specific block can be overridden post-generation (e.g. drop one Friday's max from 15 → 8) is a phase 2 UX call.

### Conventions

- All Roster v2 migrations land between mig 067 and mig 070 — reserve those numbers now so we don't fight for them mid-phase.
- Profile employment fields go on `profiles`, not `profile_locations` — a coach's `hourly_rate` follows them across studios. (If a coach is paid differently at different studios, that's phase 3.5 and we'll add `profile_locations.hourly_rate_override`.)
- `shift_blocks` is the new source of truth for the schedule. Anything that today queries `shifts` (reports, mobile schedule view, Today tab) will be pointed at `shift_blocks` + `shift_assignments` joined back to profiles. Do this in phase 1 alongside the migration so there's never a moment where two readers disagree.
- `over_budget_approval_by` on the roster row is the audit trail for the May 1-style "why did we spend €X over budget last month?" question. Keep it forever; never null-out.

## Organizations (multi-tenant tier)

Mig 079 introduced an `organizations` table above `locations`. Every location row carries an `organization_id` (NOT NULL); every existing data table in the system stays scoped by `location_id` and inherits tenant isolation transitively. The org tier is **about grouping and platform admin, not about reshaping the data plane** — RLS policies on data tables didn't change.

**Today's two organizations:** `UN1T Group` (gym studios — Hatch Street, Stillorgan, etc.) and `CCF Autos` (the cars business). Both run by Richard under one master account. The split was seeded by the mig 079 backfill using `car_deposit_default_amount IS NOT NULL` as the heuristic for "this is the cars location," so it was zero-touch.

**Adding a third tenant** is a row in `organizations` (master-only INSERT) followed by location creation under that org. The new tenant's locations get their own per-location RLS automatically since policies key off `location_id`. A non-master non-member of any of the new org's locations cannot read the data, full stop.

**Visibility model:**
- **Master** sees every org and every location. `getCurrentUser()` populates `organizationsById` from a dedicated query when `profile.role === 'master'` and falls back to the org-set derivable from location memberships otherwise. RLS on `organizations` SELECT mirrors this — `private.auth_is_master() OR EXISTS (...location membership join...)`.
- **Non-master** sees only the orgs whose locations they're a member of. Today this means a UN1T staff member sees `UN1T Group` and not `CCF Autos`, and vice versa.

**Helpers:**
- `private.auth_is_in_organization(org_id UUID)` — RLS-callable predicate, mirrors `private.auth_is_in_location(loc_id)` in style. Use as the canonical predicate when adding RLS policies on future org-scoped tables.
- `getCurrentUser()` returns `organizationsById` (map by id) and `activeOrganization` (resolved from `activeLocation.organization_id`).

**What this DOESN'T add (yet, by design):**
- **Org-level roles.** Master remains platform-wide super-admin; non-master access is per-location via `profile_locations.role`. An "org admin" tier (someone who manages all locations within their org but isn't a platform master) can be added later as additional helpers without reshaping existing policies.
- **Cross-org isolation enforcement on data tables.** Existing per-location policies already give us tenant isolation. The org layer adds metadata; it doesn't tighten the data plane.
- **Per-org branding / settings.** Brand chrome is the AppShell roadmap item (still backlog); that work will read from `locations` OR `organizations` depending on UI need.
- **Per-org feature gates.** Today gates live on `locations.features` (mig 032). Could later add `organizations.features` as a second tier (org gate trumps location gate), but YAGNI until a real use-case forces it.

## Master admin matrix (`/admin/matrix`)

The `/admin/*` route segment is master-only via `src/app/admin/layout.js` (hard redirect for non-master `profileRole`). Distinct from `/settings/*` which is per-location operator admin — `/admin/*` is the home for platform-level tools.

**`/admin/matrix`** (mig 079 alongside the orgs schema) renders two stacked sections:

1. **Feature matrix** — `<AdminFeatureMatrix>` editable grid: rows = locations grouped by organization, columns = location-gated feature keys (web + mobile, with `notify_*` keys excluded same as `LocationFeatures`). Each cell is a toggle widget; click flips that one (location, feature) pair via the browser Supabase client (same RLS path as `LocationFeatures` uses). Optimistic update with revert-on-failure, per-cell busy state, `router.refresh()` after a successful flip so server-rendered gates pick up the change. Sticky left column for location names, sticky top header for feature labels.

2. **Access matrix** — `<AdminAccessMatrix>` editable grid (mig 080): rows = staff (filterable by name/email + multi-select checkboxes), columns = locations grouped by organization, cells = role label or `—`. A "Master" badge column on the far right is interactive (single-click promote/demote with confirmation modal). Click a user row to open `<UserAssignmentsPanel>` — slide-in side panel for editing all of that user's assignments inline (per-location role changes, removals, additions, master toggle in one place). Bulk action bar appears when 1+ users are selected: pick a target location + role, "Apply" to assign N users to that location with one API call. Cells with non-default permissions overrides (mig 058) get a small ⚙ icon next to the role pill so masters can spot when a user has tweaked permissions outside the role default.

**Audit log (mig 080).** Every assignment mutation writes a row to `assignment_change_log` via `src/lib/assignment-changes.js#logAssignmentChange`. Append-only, master-only readable. Captures actor, target, location, action, before/after JSONB. Browse at `/admin/audit-log` (`<AuditLogTable>`) — filters by actor / target / location / action / date range, paginated 50 at a time, expandable rows showing the before/after diff, CSV export for compliance review. New action types are additive (no CHECK constraint on `action`) so app code can introduce new categories without a migration. Direct SQL Editor changes are NOT captured (no actor available outside an authenticated request) — by design.

**At-least-one-master invariant (mig 080).** The platform must always have at least one active master so admin operations can never be orphaned. Enforced at two layers:
- **Application layer** (`wouldLeaveZeroMasters` check before any master demotion / deactivation in `/api/admin/master-toggle`) — gives a clean error message: "Cannot demote the last active master. Promote another user to master first."
- **DB layer** (`private.guard_at_least_one_master` trigger on `profiles`) — unconditional last-line-of-defence. Rejects any UPDATE that demotes the last master via role flip OR sets `active=false` on the last master, plus any DELETE of the last master row. Errors with `check_violation` so callers can distinguish from auth failures. Defence in depth: even a future code path that forgets the application-layer check still gets rejected by the trigger.

To remove or demote the current sole master, you have to first promote another user to master. The matrix UI surfaces this rule upfront in the master toggle confirmation dialog so the operator sees it before clicking through.

**Linking:** entry points in the Master tools section on `/settings` — "Platform admin" button (matrix) and "Audit log" button (audit viewer), next to "View as user".

**Adding new organizations.** "Add organization" button at the top-right of `/admin/matrix` opens a modal with name + slug fields (slug auto-derived from name as the operator types, editable for custom values). POSTs to `/api/admin/organizations` (master only, validates slug uniqueness with a clean 409 message on conflict). After creation the matrix refreshes and the new org appears as an empty section in both feature and access matrices. Operator's next step is `/settings/locations/new` to create the first location under the new org — the location create form picks the org from a dropdown (master sees all active orgs). For existing locations the org is shown read-only because moving a location between orgs is rare and would change RLS visibility for every member at the destination org; do that via SQL with intent if ever needed.

**Why it exists:** with two organizations and a handful of locations, clicking through `/settings/locations/[id]` for each one to flip a feature is fine. With three+ tenant businesses on the platform, the per-location flow becomes friction. The matrix lets a master see and modify the entire platform's posture from one screen, which is also the right shape for the eventual "tenant onboarding" flow (provisioning a new org → bulk-toggle features for all its locations → add their team in bulk via the bulk action bar).

## Roadmap & backlog

Mirror of the Cowork task list — kept here as the durable record so that a fresh session has the context even when the task list is cleared. Add new ideas as they come up; mark items as done with the corresponding commit/migration when shipped.

### Done (latest first)

| # | Item | Notes |
|---|------|-------|
| 87 | Add organization UI + LocationForm bug fix | New `POST /api/admin/organizations` master-only route; new `<AddOrganizationButton>` modal at the top of `/admin/matrix` with name + auto-derived slug. New `src/lib/slug.js#toSlug` pure helper (lowercase kebab-case, ASCII-only) covered by 8 unit tests. **Bug fix bundled:** mig 079 made `locations.organization_id` NOT NULL but the existing `LocationForm` didn't supply it, so any new-location create after mig 079 deployed would have failed with a constraint violation (lurking, not yet hit because no new locations created since mig 079). Form now takes an `organizations` prop, renders an org dropdown for new locations and a read-only org name for edits, and includes `organization_id` in the upsert payload. Both the new-location page and the edit-location page fetch organizations and pass them through. |
| 86 | Master admin matrix v2 + audit log | Mig 080. Two pieces: (1) `assignment_change_log` table — append-only audit trail for every assignment mutation, master-only readable, indexed for the common filter axes (target, actor, action, created_at). (2) `private.guard_at_least_one_master` BEFORE UPDATE/DELETE trigger on `profiles` — rejects any operation that would leave zero active masters, regardless of route. New `src/lib/assignment-changes.js` exports the application-layer guards (`wouldLeaveZeroMasters`, `canRemoveSelfFromLastOwnerLocation`) and audit writer (`logAssignmentChange`). Four new master-only API routes: `POST /api/admin/assignments` (single create/update/delete), `POST /api/admin/assignments/bulk` (per-pair partial-success semantics for onboarding flows), `POST /api/admin/master-toggle` (promote/demote with the at-least-one-master guard), `GET /api/admin/audit-log` (paginated read with filters + CSV export mode). Three UI pieces: `<UserAssignmentsPanel>` (slide-in side editor for all of one user's assignments + master toggle in one place), bulk action bar inside `<AdminAccessMatrix>` (multi-select checkboxes + sticky bottom bar with target location + role + apply), and a brand-new `/admin/audit-log` page with `<AuditLogTable>` (filters by actor/target/location/action/date range, expandable rows showing before/after JSON diff, CSV export). Permissions indicator (⚙ icon) added to access matrix cells with non-default permission overrides. 15 unit tests in `assignment-changes.test.js` covering every guard branch + audit writer best-effort guarantees + the self-orphan check. 457 tests passing total. CLAUDE.md updated extensively. |
| 85 | Organizations layer + master admin matrix | Mig 079. New `organizations` table seeded with `UN1T Group` and `CCF Autos`; every existing location backfilled by heuristic (CCF Autos = locations with `car_deposit_default_amount IS NOT NULL`, rest = UN1T Group). New `locations.organization_id` NOT NULL FK + index. RLS on `organizations`: master sees all, non-master sees orgs transitively via location memberships. New `private.auth_is_in_organization(org_id)` helper mirroring `auth_is_in_location` style — canonical predicate for any future org-scoped tables. `getCurrentUser()` extended with `organizationsById` and `activeOrganization` (master fetches all active orgs; non-master derives from location memberships). New master-only `/admin/*` route segment via `src/app/admin/layout.js` (hard redirect for non-master). New `/admin/matrix` server page composes data for two stacked matrices: editable feature toggles (locations × features grouped by org, toggle pattern same as `LocationFeatures`) and read-only access overview (users × locations grouped by org, links into `/settings/staff/[id]` for editing). Entry point added to `/settings` Master tools section. Documented as a new "Organizations" + "Master admin matrix" section in CLAUDE.md. v2 follow-up: editable role assignments inline in the access matrix. |
| 84 | Deposit-paid receipt SMS (cars) | Mig 078. Two new columns: `cars.deposit_receipt_sent_at` (idempotency stamp for at-least-once Revolut webhook delivery) and `locations.car_deposit_receipt_sms_enabled` (BOOLEAN NOT NULL DEFAULT FALSE, per-location opt-in, backfilled TRUE for any location with `car_deposit_default_amount IS NOT NULL` so CCF Autos auto-enabled). New lib `src/lib/deposit-receipts.js#sendDepositReceiptSms({ db, car, location, actorId? })` is the single entry point; three gates (toggle, idempotency, buyer_phone), success path stamps + writes a `kind='system'` `car_notes` row with the Twilio SID. Wired into `/api/webhooks/revolut` after the deposit_status flip as a best-effort side effect — webhook always returns 200. `CarDepositSettings.jsx` gets a checkbox toggle next to the existing default-amount + terms fields. 19 unit tests in `src/lib/deposit-receipts.test.js` covering happy path + every gate + failure modes + best-effort guarantees (stamp UPDATE failure and notes INSERT failure both still return `sent`). Receipt is intentionally NOT part of any per-contact consent gate — buyer just paid us money, receipt is transactional, the per-location toggle is the right place to opt in/out. |
| 83 | Postmark webhook signing enforcement | The auth gate was already present but had a rollout-only "accept-with-warning if env var unset" branch. Removed: missing `POSTMARK_WEBHOOK_TOKEN` now returns 500 (Postmark retries 5xx for ~24h, so a redeploy with the var set picks up missed events; 4xx would be permanent rejection and we'd lose them). Added `POSTMARK_WEBHOOK_TOKEN_PREVIOUS` rotation support — both tokens accepted while you flip every Postmark webhook custom-header config to the new value, with a `[security]` warning logged when the previous one matches. Auth predicate extracted from the route as `verifyPostmarkRequest({ headerValue, primarySecret, previousSecret })` so it's unit-testable without standing up the Supabase mock — mirrors the `verifyTwilioSignature` pattern from the Twilio status webhook. New test file: `src/lib/postmark-webhook-auth.test.js` (10 cases — primary match, previous match during rotation, missing-secret regression guard, missing-header, token-mismatch, half-finished-rotation refusal, etc.). CLAUDE.md "Webhook authentication" section rewritten — Postmark's strict-by-default behaviour is now explicit and the old "Always set both secrets in production" hedge is gone. |
| 82 | Booking confirmation flow | Mig 077. Adds `event_types.confirmation_*` columns: `confirmation_enabled boolean`, `confirmation_channels text[] CHECK ⊆ {email, sms}`, `confirmation_email_template_id`, `confirmation_email_subject`, `confirmation_sms_body`. Confirmation lives on `event_types` directly (not its own table) because it's singular per booking, unlike reminders. New `src/lib/booking-confirmations.js#sendBookingConfirmation(db, bookingId)` runs both channels independently with the same gates as reminders (email_status / sms_status / *_administrative opt-outs). Wired into `/api/public/book` after the booking insert as a best-effort, fire-and-forget call — Postmark/Twilio failure never breaks the customer's success response. EventForm has a new "Booking confirmation" section above Reminders with the same channel-multiselect + email/SMS config blocks pattern. SMS sends also write a `kind='event'` activity to the contact timeline (mirrors reminder pattern). |
| 81 | BookingWidget Calendly-style redesign | Public `/book/[slug]` widget rewritten from a vertical single-column layout into a Calendly-style 2/3-column grid: brand info + location sidebar on the left, calendar pane in the middle, slot list appears as a third column when a date is picked. Compact rounded-circle calendar — available days carry a subtle accent-tint background, today gets a tiny dot under the date number, selected day is solid accent. Time-zone footer (`Times shown in <viewer's IANA zone>`) below the calendar. Form step replaces the calendar pane on continue (saves vertical real estate). On mobile the columns stack. `/api/public/events/[slug]` extended with a join to `locations` so the sidebar can render the address + name without a second round-trip. |
| 80 | Calendly multi-reminder | Mig 076. Two new tables: `event_type_reminders` (1..N reminders per event_type, each with `channels text[] CHECK ⊆ {email,sms}`, `minutes_before`, template/body) and `booking_reminder_sends` (per-(booking, reminder) dedup with `UNIQUE`). `event-reminders.js` runner rewritten to iterate (reminder, booking) pairs, run each channel independently (partial sends are normal — email-down doesn't take SMS down), aggregate outcomes, insert `booking_reminder_sends` row, stamp legacy `bookings.reminder_sent_at` on first send for back-compat. Channel functions take a per-reminder `ctx` object instead of legacy `event_types.reminder_*` columns. New API: `GET/PUT /api/events/[id]/reminders` for bulk read/replace. EventForm reminder section rewritten as a multi-reminder list — Add/Remove buttons, hours input (form converts → minutes on save), per-reminder email + SMS multi-checkbox channel picker, shared email-template picker. Legacy `event_types.reminder_*` columns still on disk but comment-marked deprecated; runner no longer reads them, form no longer writes them. |
| 79 | Calendly tier 3 — per-booking reminder override | Mig 075. New `bookings.skip_reminder boolean default false`. Operator-side flag for the "customer asked us not to remind them about this specific booking" case (without unsubscribing them from administrative messages entirely). `event-reminders.js` checks the flag before any channel logic; on hit, stamps `reminder_sent_at` so the booking falls out of the partial index immediately, increments stats.skipped, continues. New `<BookingSkipReminderToggle>` (Bell ↔ BellOff) on each /bookings row, hidden once `reminder_sent_at` is stamped or the date is past. Tier 3's other items (embed customisation docs, webhook retry/dead-letter pattern) intentionally still deferred — premature without usage signal. |
| 78 | Calendly tier 2 alignment | New `POST /api/bookings/[id]/cancel` endpoint replaces the previous "BookingStatusToggle writes directly to bookings via createBrowserClient" path for the cancel case. Adds: manager-or-master permission gate, per-location ownership check, transition guards (refuse confirmed→cancelled if already cancelled or completed), optional customer-notification via Postmark transactional email (gated on contact_preferences.email_administrative). New `<CancelBookingModal>` inside BookingStatusToggle prompts for confirmation + the optional reason that goes into the email. The other transitions (confirmed→completed, confirmed→no_show) stay on the direct-write path — no side effects, no need for the API hop. Status pill colours retuned for the light theme (-700 instead of -400). New `src/lib/booking-validation.js#validateCustomResponses` hardens `/api/public/book` against missing required fields, bad dropdown/radio values, non-boolean checkbox values, and non-string text — covered by 16 unit tests. BookingWidget palette verified clean (gray-900/500/400 hierarchy was always tuned for the public light page; no dark-theme leftovers). |
| 77 | Calendly tier 1 alignment | Mig 074. Three things in one shot. **(a)** Booking → activity classification fix: the mig 003 trigger was inserting booking activities with `due_date = NEW.booking_date`, which the mig 073 backfill rule classified as `kind='task'`. Bookings show up in /tasks (wrong). Fixed: trigger now writes `kind='event'` explicitly with NULL due_date/due_time, plus a one-shot UPDATE on existing rows. Backfill verified: 0 misclassified, 2 reclassified. **(b)** WhatsApp dropped as a booking-reminder channel. CHECK constraint enforces `reminder_channel ∈ {email, sms}` going forward; EventForm picker hides the WhatsApp button; `sendWhatsappReminder()` + `fillReminderTemplate()` removed from src/lib/event-reminders.js (dead code post-CHECK). Live data was already clean. WhatsApp templates remain available for explicit campaigns; just not for transactional reminders. **(c)** "Event" → "Event type" page-title sweep on /events, /events/new, /events/[id]/edit, EventForm submit button — finishes the Calendly merge naming consistency. |
| 76 | Activities revamp phase 1 (evaluation in prod) | Mig 073. Adds `activities.kind text` (CHECK ∈ {task, event}, NOT NULL default 'event'). Backfill rule: `due_date IS NOT NULL → task, else event`. Resolves the long-standing identity crisis where the activities table did two unrelated jobs (manual to-dos + auto-logged interactions) under one schema. `/activities` page now filters `kind='task'` and is renamed "Tasks" — auto-logged events stay on the contact-detail timeline. Contact detail sidebar "Activities" → "Open tasks" (also `kind='task'` filter). One demo writer added: `src/lib/activity-events.js#logPipelineEvent` writes a `kind='event'` row when `lead_status` flips on a contact, called from `PUT /api/contacts/[id]` next to the existing sequence-trigger fan-out. Phase 1 is intentionally a one-week prod evaluation: if the timeline doesn't earn its keep, drop the kind column + the new writer in one cleanup migration. Phase 2 (more writers — deposit-paid, sequence-enrolled, swap-approved) is conditional on the eval. |
| 73 | Roster v2 phase 6 | New `leaveHoursInWeek()` helper in `src/lib/roster-summary.js` walks weekdays in the overlap of approved `time_off_requests` and the visible week and returns `weekdays_in_overlap × (contracted_hours_per_week / 5)`, capped at the contract. `summarizeWeek()` accepts an optional `timeOff` array; FTE rows now expose `leave_hours` + `effective_contracted_hours` and a new `on_leave` status that flags coaches rostered during full-week approved leave (sorts to the top of the panel as the loudest red). RosterSummaryPanel renders the new label "21h / 12h (of 30h)" with "9h on leave this week" subtext. Phase 4 callers that omit `timeOff` get the original behaviour, no breaking change. Phase 6 was originally listed as deferred — `time_off_requests` already had everything we needed (status, start_date, end_date, type), so it shipped same-day. |
| 72 | Roster v2 phase 5 | Mig 072 (`rosters` table + `shift_blocks.roster_id` FK). New API: `POST /api/schedule/rosters` (with `dry_run`, `force_over_budget`), `GET /api/schedule/rosters`, `POST /api/schedule/rosters/[id]/approve`. New `src/lib/roster-publish.js#projectPublishImpact` computes month-total contractor cost = (already-published-this-month) + (about-to-publish-period). Publish modal in ScheduleCalendar shows the impact preview; under budget → publish, over budget + owner → confirm-and-record-self-approval, over budget + manager → draft + email owners + render approvals queue. New `/schedule/approvals` page lists drafts; `RosterApprovalActions` is the approve button. `src/lib/roster-email.js` sends the approval-request email (Postmark, transactional stream) to all owners-at-the-location. |
| 71 | Roster v2 phase 4 | Mig 071 (`locations.monthly_contractor_budget_eur` numeric, nullable, CHECK ≥ 0). New pure helpers: `summarizeWeek` + `summarizeMonth` in `src/lib/roster-summary.js`. New `<RosterSummaryPanel>` component below the schedule calendar (manager-only) showing per-coach FTE utilisation bars (overtime/on-target/underused/no_contract status colours), contractor euro spend for the focused month vs budget, FTE implicit-cost context, missing-pay-data warning. LocationForm has a new "Coaching Budget" section feeding the new column. Read-only / advisory — phase 5 wires the publish gate. |
| 70 | Roster v2 phase 3 | Mig 070 (employment_type NOT NULL + CHECK ∈ {fte, contractor}). The cost columns themselves pre-existed: `employment_type` text default 'fte', `contracted_hours_per_week` numeric default 40, `hourly_rate`/`overtime_rate`/`annual_salary` numeric. StaffForm + /api/staff already exposed them. Phase 3 work was the constraint + `fetchIncompletePayProfiles()` in shared/dashboard-data.js + amber chip on Today tab listing staff whose pay data would silently zero-cost their shifts in phase 4. Vitest config expanded to include `shared/**/*.test.js`. |
| 69 | Roster v2 phase 2 | Migs 068 + 069 (bidirectional shift_assignments ↔ public.shifts triggers, `pg_trigger_depth()` loop guard). New API: `/api/schedule/blocks` (GET/POST), `/api/schedule/blocks/[id]` (DELETE), `/api/schedule/blocks/[id]/assignments` (POST), `/api/schedule/assignments/[id]` (DELETE). Templates POST/PUT extended with `days_of_week` + `max_coaches`; auto-generates 8 weeks of blocks via `src/lib/roster.js#generateBlocksForTemplate`. ScheduleCalendar reads from `/blocks` and renders one card per block with `count/max` capacity badge, list of coach names, red border on unstaffed future blocks. Today tab gets unstaffed-block alert chip for owner/manager via `fetchUnstaffedBlocksThisWeek()` in shared/dashboard-data.js. Legacy `/api/schedule/shifts/*` (copy-week, copy-month, publish, swaps) still works because the reverse trigger keeps blocks/assignments populated from any write to `public.shifts`. |
| 68 | Roster v2 phase 1 | Mig 067. `shift_templates.days_of_week` (CHECK ⊆ mon..sun) + `shift_templates.max_coaches` (1..50, default 15). New `shift_blocks` (location × template × date snapshot) + `shift_assignments` (n:m coach × block, unique on pair). RLS via per-location helpers (`auth_is_in_location`, `auth_is_manager_at`). Idempotent backfill: each legacy `shifts` row → 1 block + 1 assignment. `public.shifts` comment-marked deprecated; phase 5 cleanup migration drops it. |
| 57 | Cron heartbeat + health-check + external monitor | Migs 053, 054. `cron_heartbeats` table stamped by every `/api/cron/*` route via `stampHeartbeat(name)` from `src/lib/cron-heartbeat.js`. `cron_health` view (`security_invoker = on`) flags is_stale. `/api/cron/health-check` returns 200/503 for an external monitor (UptimeRobot etc.) to ping. Caught and root-caused after the May 1 cron-secret drift. |
| 56 | Per-location RLS precision | Mig 052. Tightened `pipeline_stages`, `webhook_subscriptions`, `profile_locations`, and `locations` policies to use the new per-location helpers. `profiles "Admins can manage profiles"` is master-only at RLS; API enforces per-location ownership for non-masters. |
| 55 | Per-location roles + StaffForm wizard | Mig 051. `profile_locations.role` (CHECK enforces no `master` at the per-location level). `getCurrentUser()` returns `rolesByLocation` + active-location-aware `user.role`. New helpers: `get_user_role_at`, `auth_is_owner_at`, `auth_is_admin_at`, `auth_is_manager_at`. Latent `public.auth_role()` typo in `auth_is_owner` / `auth_is_owner_or_manager` fixed at the same time. StaffForm rewritten as a per-location card wizard. Staff API routes accept `assignments[]` + optional `is_master`. |
| 54 | Master honours per-location feature gate | `17c5213`. Master sidebar now collapses at locations with features off. `settings` is the only escape-hatch key on web. |
| 53 | Switch to Revolut Embedded Checkout widget | Replaced deprecated `createCardField` with `RC.embeddedCheckout({publicToken, target, createOrder, onSuccess, onError, onCancel})`. Cards + Apple/Google/Revolut Pay in one mount. |
| 52 | Switch deposit delivery to SMS via Twilio | Email + WhatsApp delivery removed. Sender = alphanumeric `CCFautos` (Irish long codes are voice-only). |
| 51 | Pay subdomain (`pay.ccfautos.com`) | Hostname-aware middleware on the same Vercel project. Only `/deposit/*` and `/api/public/deposit/*` reachable on the pay host. |
| 50 | Car notes + 24 h deposit link expiry | Token rotation on every send. |
| 49 | Embedded Revolut card field | Initial implementation, later replaced by full Embedded Checkout in #53. |
| 44–48 | Cars deposit feature end-to-end | Schema, API routes, public buyer page, car-detail Deposit section + per-location terms. |
| 43 | WA template media upload + Meta approval | Resumable Upload API, real submission to Meta (not local-only stub). |
| 41–42 | Per-event reminders + utility/marketing semantics | Reminder runner refuses MARKETING templates. |
| 39–40 | Sequence event_reminder runner + saved segments | |
| 38 | Sequence triggers: status_change + tag_added | |
| 36–37 | Sequence enrolment UI + advanced contact filtering | |
| 28–34 | Performance pass | Master gates in handlers, `bookings(location_id)` index, parallel report queries, `force-dynamic` audit, CarDetail split, WAInbox → Realtime, OpenAPI cache. |

### Backlog — picked up when relevant

These are not commitments, just durable notes so we don't re-derive them every session.

**Comms / delivery hardening**
- ~~Register `CCFautos` as a Sender ID (not just alphanumeric) with Twilio's IE compliance team — improves deliverability past Vodafone/Three filters.~~ — **completed** operationally. Sender ID registered with Twilio's IE compliance team; carrier filters no longer dropping `CCFautos` traffic. No code change.
- ~~Add an SMS delivery webhook (`MessageStatus=delivered|failed`) to mirror the Postmark + Meta event capture pattern.~~ — **shipped in Phase 5D / mig 065** (`/api/webhooks/twilio/status`, signature-verified, idempotent). `sms_broadcast_recipients.status` now goes `pending → sent → delivered | undelivered | failed` with timestamps.
- ~~Postmark webhook signing — verify shared secret on every event before trusting it (today we accept-with-warning if the env var is unset, which was meant to be a rollout-only fallback).~~ — **shipped** (#83). Strict enforcement, rotation env var, route-level test.

**Deposits / payments**
- ~~Refund UI on the car-detail Deposit section.~~ — **dropped**. CCF Autos deposits are non-refundable and that policy isn't changing, so the operator-facing button would be unused. The `refundOrder()` lib helper in `src/lib/revolut.js` stays — it's the right primitive to reach for if/when the gym side of the business introduces payments (memberships, class packs, retail) where partial/full refunds ARE part of the customer journey. Revisit the UI question then; the lib doesn't need touching now.
- ~~Multi-currency support for deposits (today EUR-only). UK customers buying RHD stock would value GBP.~~ — **dropped**. Not selling to UK customers. Revisit if/when the customer geography changes.
- ~~Surface the buyer-side payment-method icons (cards / Apple Pay / Google Pay / Revolut Pay) on the deposit page above the widget so the buyer knows what to expect before clicking pay.~~ — **dropped**. Not needed; the embedded checkout widget surfaces the icons inline once it mounts.
- ~~Email receipt to buyer on `deposit.paid` webhook — currently we only display the in-page receipt. A Postmark transactional email gives them something to forward to insurance/finance.~~ — **shipped as SMS instead** (#84, mig 078). Decision was to standardise on SMS as the buyer touch-channel for cars (one comms story, no email-vs-SMS choice). Per-location `car_deposit_receipt_sms_enabled` toggle so future business units (gym memberships if/when payments arrive) can opt in independently or use email if that fits their flow better.

**Permissions / multi-tenant**
- ~~Master "all locations at a glance" admin page — shows every location's feature toggles in one matrix so a master can flip CCF Autos vs UN1T configs without clicking through each location.~~ — **shipped** (#85, mig 079) at `/admin/matrix`, alongside the new organizations layer. Includes a read-only access overview as a second section. v2 will add inline editing of access assignments.
- API-route-level test for the location gate (not just the helper). The helper has 20 tests; the routes that consume it are still trusted by inspection.
- ~~Master admin matrix v2 — make the access matrix at `/admin/matrix` editable inline. Per-cell role dropdown (none / staff / head_coach / manager / owner), add-user-to-location action, master toggle (promote/demote). Today the matrix is read-only and links into `/settings/staff/[id]` for edits.~~ — **shipped** (#86, mig 080) with bulk operations included. Side panel editor instead of per-cell dropdown (felt safer for destructive ops); bulk action bar with multi-select for the onboarding flow; audit log table + viewer at `/admin/audit-log`; at-least-one-master invariant enforced by both app-layer guards and a DB trigger.
- ~~"Add organization" UI on `/admin/matrix`. Today new organizations have to be inserted via SQL~~ — **shipped** (#87). Name + auto-slug modal; LocationForm extended to pick the org for new locations. Full org-onboarding wizard (initial owner, default features) is still a follow-up if/when the third tenant arrives.
- Extend `MOBILE_PERMISSION_KEYS` iteration in `hasAnyMobileFeature` to also evaluate cross-platform `dashboard_*` keys so the empty-state Home tab on mobile is correct for master at a partial-features location.

**Sequences / segments**
- New trigger: `segment_added` / `segment_removed` so saved segments can drive sequence enrolment alongside the existing `status_change` + `tag_added` triggers.
- "Preview enrolments" before committing a sequence — show the candidate contact list so an operator can spot-check before turning the runner loose.

**Performance / infrastructure**
- ~~Cron consolidation strategy when we cross 2 crons (Vercel Hobby cap)~~ — **resolved by upgrading to Pro**. All crons live in `vercel.json` now; `pg_cron + pg_net` retired.
- React Server Components audit pass #2 — components touched after the first audit may have re-introduced `'use client'` unnecessarily.
- Move car photos to Supabase Storage signed URLs (today they're public-bucket URLs, fine for inventory but limits the option to gate gallery views).
- Upgrade Next.js 14.2 → 16.x and clear outstanding `npm audit` advisories. Five Next.js CVEs surface from `npm audit`; most are mitigated by Vercel's hosted runtime (cache-poisoning, image-optimisation, SSRF-via-middleware) or don't apply to our config (no `rewrites`, no `remotePatterns`, no self-hosting). The practically-applicable one is **CVE-2024-... DoS via React Server Components** — low risk for our traffic volume but still worth closing. The fix path is `npm audit fix --force` which jumps to `next@16.2.4` (major). Treat as a focused PR, **not** bundled with feature work: 14→16 spans two majors so expect router/middleware breaking changes (params now async, `headers()`/`cookies()` async, `next/image` defaults moved). Plan: branch → upgrade → run full test suite → smoke-test cron routes + Twilio webhooks + middleware multi-domain rewrite → deploy preview → merge.

**Multi-brand / platform**
- Factor the multi-domain middleware so adding a third brand (e.g. another car business or a partner gym) is a config row, not new code.
- Brand-aware AppShell — pull header logo + favicon + theme tokens off the active location so CCF Autos visitors at `crm.un1tdublin.com` see car-brand chrome, not gym chrome, without separate deployments.

### Process notes

- Backlog items move to in-progress as a numbered task in Cowork before implementation starts.
- Lessons learned from each shipped task get rolled into the relevant CLAUDE.md section (Coding conventions, Lessons learned, Multi-vendor comms, etc.) — not into this list.
- This list is intentionally not a project plan — no dates, no commitments. It's a durable scratchpad.
