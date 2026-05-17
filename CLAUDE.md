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

Tests live alongside source as `*.test.js` (Vitest). Covers the security-critical lib helpers in `src/lib/` — webhook signatures, audience-filter whitelist, Zod validation, rate limiting, schema invariants — plus the policy contracts that drive permissions, contact merge, sequence cooldowns, branch routing, and so on. **634 tests as of mig 093**, run in ~5s, no DB required (lib helpers are pure).

Migrations are run via Supabase MCP from this session, or manually in the Supabase SQL Editor.

### Before pushing — run the full CI mirror locally

The Web CI workflow (`.github/workflows/web-ci.yml`) runs three steps in order: vitest, ESLint, mobile-parity. Push hygiene = run all three before `git push`:

```bash
npm test && npm run lint && npm run check:mobile-parity
```

The parity linter is the one that's bitten this codebase the most — it catches drift between `WEB_PERMISSIONS` and `MOBILE_PERMISSIONS` in `shared/permissions.js`. When you add a new web permission key, you have three options the linter will accept:

1. **Add a mobile counterpart** with `webEquivalent: '<key>'` in `MOBILE_PERMISSIONS`.
2. **Add it to `WEB_ONLY_OK`** in `scripts/check-mobile-parity.mjs` with a reason string (the reason is mandatory — it's there so future readers know if the key SHOULD eventually grow a mobile counterpart vs. is genuinely web-only by design).
3. **Add it to `CROSS_PLATFORM_KEYS`** in `shared/permissions.js` if both web and mobile read the same key (top-level, not nested under `mobile.*`). Used today by the dashboard sub-views and `studio_management`.

Skipping the parity check locally was the root cause of the five red Web-CI runs after mig 092 / 093 — every commit between `8823a59` and `fe5ec5b` failed for the same latent drift, masked because lint + tests were clean. The fix landed in `b1e54d3`.

**If you touched `mobile/package.json`, also re-sync the lock file** before pushing — EAS Build runs `npm ci --include=dev` which refuses to install when the manifest and lock disagree:

```bash
cd mobile && npm install --package-lock-only && cd -
```

Skipping this step was what burned the first iOS production EAS build (commit `52c38a3` on 2026-05-06): two packages from the contractor-invoices sprint (`expo-document-picker`, `expo-web-browser`) were in `package.json` but missing from `package-lock.json`, so EAS aborted with `npm error Missing: <pkg> from lock file` before any native build started.

### Pushing commits from the sandbox

The sandboxed bash has no GitHub credentials configured (no `~/.gitconfig`, no `GH_TOKEN`, no credential helper). Plain `git push` will fail with `fatal: could not read Username for 'https://github.com'`.

A GitHub PAT lives at `/Users/richardivers/code/.github-pat` (one directory above this repo). To push from the sandbox:

```bash
PAT=$(cat /Users/richardivers/code/.github-pat | tr -d '[:space:]') && \
  git push "https://x-access-token:${PAT}@github.com/ivers9307-cyber/un1t-crm.git" main
```

Inside the sandbox the file is at `/sessions/<session>/mnt/code/.github-pat` — same content, mounted from the host. The file lives one directory above this repo so it's already outside the working tree (no `.gitignore` entry needed). Don't echo the token in the conversation.

## API Reference

OpenAPI 3.1 spec is generated from the Zod schemas in `src/lib/schemas.js` via `src/lib/openapi.js` and exposed at:

- `/api/openapi.json` — raw JSON spec (auth required, same as any API route)
- `/api-docs` — Swagger UI viewer (raw HTML route handler so it bypasses the app's root layout)

When adding a new route or schema, register it in `src/lib/openapi.js` so the spec stays in sync. The cached spec rebuild happens on the first request after deploy; downstream tools (Stoplight, Postman) can re-import freely.

## Architecture

UN1T CRM is a Next.js 14 App Router application with Supabase (PostgreSQL) backend, built for gym lead management and operations across multiple locations.

### Companion projects (May 2026 onward)

This repo is no longer the only Next.js app talking to the un1t-crm Supabase project. There are now three deployments sharing the same database:

- **un1t-crm** (this repo) — staff / admin / operator surface. `crm.un1tdublin.com`. Heavy: contacts, scheduling, contractor invoices, sequences, Xero, WhatsApp, audit logs, every back-office tool.
- **champ-app** (`/Users/richardivers/code/champ-app`) — customer-facing portal. `app.champfitness.ie`. Members log in with magic links to see their own heart rate sessions, post-class reports, and OAuth connections to Fitbit/Whoop/Apple/Garmin. **Deliberately scoped to one customer's own data only — no admin features should ever appear there.** First feature is the Myzone replacement (mig 110+).
- **un1t-platform** — multi-tenant admin/sentinel dashboard (older project, separate brief).

Customer auth model: a "customer" is `auth.users` row + `contacts.user_id` link. We don't add a `customer` value to `profiles.role` — profiles stays staff-only. The `private.auth_contact_id()` SECURITY DEFINER helper (mig 110) returns the current user's contact_id for customer-self RLS:

```sql
CREATE POLICY "Customers can view own sessions"
  ON heart_rate_sessions FOR SELECT TO public
  USING (contact_id = private.auth_contact_id());
```

Invite flow: admin clicks **Invite to App** on a contact's profile in this CRM (`POST /api/contacts/[id]/invite-app`). That calls `supabase.auth.admin.inviteUserByEmail` with `redirectTo = https://app.champfitness.ie/auth/callback`. The champ-app callback exchanges the code, looks up `contacts` by email (service-role), and links `contacts.user_id`. Idempotent: existing-user case falls back to a fresh magic link via `auth.admin.generateLink`. Tests in `src/app/api/contacts/[id]/invite-app/route.test.js`.

In-class TV display + the BLE bridge service for live heart-rate aggregation will live where they best fit:
  - **TV display**: a public route in *this* CRM (matches the existing `/race/[slug]/tv` pattern) — no auth, reads aggregated session state for a single location.
  - **BLE bridge**: separate `champ-bridge` repo (Node.js, runs on a Pi at each gym, USB BLE adapter for >7 simultaneous straps), forwards data via WebSocket to an API endpoint *also in this CRM* (because bridges authenticate against admin-issued tokens stored in `ble_bridges.api_token_hash`).

Schema for the heart-rate work (mig 110): `heart_rate_sessions`, `hr_samples`, `hr_provider_connections` (OAuth tokens), `ble_bridges`, `strap_assignments`, plus `contacts.user_id` and `contacts.max_hr_override`. RLS on all five new tables — staff at the location can read, customers can read their own, writes are service-role only (the bridge + sync workers).

### Tech Stack

React 18 + Next.js 14, Tailwind CSS 3.4, Supabase Auth (SSR cookies), Postmark (email), WhatsApp Cloud API (Meta v21.0), Zod (input validation), `@asteasolutions/zod-to-openapi` (spec generation), Vitest (testing), `@dnd-kit` (pipeline kanban), lucide-react icons, clsx.

### Key Architectural Patterns

**Multi-tenancy via location + organization scoping** — Every data query filters by `location_id`. Locations now also belong to an `organization` (mig 079) which is the tenant grouping above locations. Today there are two organizations — **UN1T Group** (gym studios) and **CCF Autos** (cars business) — both run by the same operator under one master account, but the schema is shaped so adding a third tenant business is a row in the `organizations` table plus locations under it; existing per-location RLS continues to enforce tenant isolation transitively (a non-member of any of org X's locations can't read its data). Users belong to locations via `profile_locations` junction table, **each row carrying its own role** (mig 051). The same user can be `owner` at Hatch Street and `head_coach` at Stillorgan with independent rights at each. Active location resolved from cookie (`un1t_active_location`) → `is_default` flag → first location. `getCurrentUser()` returns `rolesByLocation: { [loc_id]: role }`, `organizationsById: { [org_id]: org row }` (mig 079 — every org reachable by the caller), `activeOrganization` (mirrors `activeLocation`), plus `user.role` (the role at the *active* location, or `'master'` for platform admins). The original global value is still on `user.profileRole` for the rare caller that wants the canonical/highest role without location context.

**Two Supabase clients** — `createBrowserClient()` uses anon key + SSR cookies (client components). `createServerClient()` uses service role key, bypasses RLS (API routes, cron). Both in `src/lib/supabase.js`.

**Auth flow** — `src/middleware.js` enforces auth on all routes except public paths (`/login`, `/reset-password`, `/book/`, `/api/public/`, `/api/webhooks/`, `/api/cron/`). External integrations (n8n) authenticate with `Authorization: Bearer <CRM_API_KEY>`; the middleware validates this constant-time with a pure-JS XOR-accumulate (Edge runtime can't import `node:crypto`). Sessions are validated against Supabase auth cookies for everything else. There is no `x-api-key` bypass anymore — anything not on the public-paths list and without a valid Bearer or session redirects to `/login`. `getCurrentUser()` in `src/lib/auth.js` returns profile + locations + activeLocation; `assertLocationAccess(user, locationId)` returns null or a 403 NextResponse for IDOR-prone routes; `getUserLocationIds(user)` returns the caller's location array.

**Input validation** — POST/PUT routes validate request bodies via `validateBody(request, schema)` from `src/lib/validate.js` against Zod schemas. Returns 400 with `{ success: false, error, issues }` on rejection. Shared schema building blocks live in `src/lib/schemas.js` (`uuidLike`, `isoDate`, `timeOfDay`, `email`, `phone`, `money`, `hours`, `days`, role/status enums, `MANAGER_ROLES`, `ADMIN_ROLES`, `DEFAULT_COLOR`, `passwordSchema`).

**Password policy** — `passwordSchema` in `src/lib/schemas.js` enforces 8+ characters with at least one lowercase letter, one uppercase letter, one digit, and one symbol. This **mirrors the password-strength settings configured in the Supabase Auth dashboard** — keeping both in sync means we surface a clear inline error before round-tripping to Supabase, instead of getting a generic `weak_password` rejection back from `auth.updateUser`. The same module exports `passwordRequirements` (an array of `{ id, label, test }`) and `validatePasswordComplexity(pw)` (returns the first failing rule's message, or `null`). `app/reset-password/page.js` renders a live ✓/✗ checklist using these exports for both initial-set (invite acceptance) and reset (recovery) flows — when changing password rules, update the dashboard *and* the schema together so the two never drift apart.

**Onboarding via invitation, not admin-set password.** Staff create no longer accepts a password from the admin. Instead, `POST /api/staff` calls `auth.admin.inviteUserByEmail(email, { data: { full_name }, redirectTo: $APP_URL/reset-password })`. Supabase sends an invite email; the new user clicks the link, lands on `/reset-password` with `#type=invite` in the URL hash, and sets their own initial password. The admin never handles the credential. If the email is already registered, the route returns 409 with a clean message suggesting "Send password reset" on the existing profile instead. The Supabase invite email template is configured in the Supabase dashboard (Auth → Email Templates → Invite User); customising the copy or branding is dashboard-only — no code change required. Future enhancement: swap to a Postmark-sent invite via `auth.admin.generateLink({ type: 'invite' })` for full template control if the dashboard template doesn't fit. **Admin-initiated password reset:** `POST /api/staff/[id]/send-password-reset` (master/admin only) calls `auth.resetPasswordForEmail()` with the same `/reset-password` redirect. Same primitive the login page's "Forgot password?" link uses, just initiated by an admin against another user. Surfaced as a "Send password reset email" button on `<StaffForm>` in edit mode with a small inline confirmation prompt.

**Role-based access (4 roles)** — `owner`, `manager`, `head_coach`, `staff`. Stored in `profiles.role`. Enforced at three layers: sidebar nav filtering (UI hint, not security), assistant tool filtering (server-side `TOOL_PERMISSIONS` table), and per-route guards (`if (!MANAGER_ROLES.includes(user.role)) return 403`). RLS additionally enforces role checks for `pipeline_stages`. Use the constants `MANAGER_ROLES = ['owner', 'manager', 'head_coach']` and `ADMIN_ROLES = ['owner', 'manager']` from `src/lib/schemas.js` rather than inlining role lists.

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
| Teams + race tracking | 081 | (mig 081 routes deleted in mig 082 cleanup) | `race-control.js` | (merged version stripped in mig 082) |
| Standalone race events | 082 | `/api/races`, `/api/races/[id]`, `/api/races/[id]/control-board`, `/api/registrations/[id]/race-{start,finish,reset}`, `/api/public/races/[slug]`, `/api/public/races/[slug]/register` | `race-control.js` | `RaceEventForm.jsx`, `RaceSignupWidget.jsx`, `RaceControlPanel.jsx` (repurposed) |
| Race waves (per-time-slot capacity) | 083 | (waves[] in races CRUD; per-wave capacity in public race endpoints) | — | `RaceEventForm.jsx`, `RaceSignupWidget.jsx`, `RaceControlPanel.jsx` (extended) |
| Race members + payments | 084 | `/api/public/races/[slug]/check-member`, `/api/public/race-payments/[id]`, `/api/public/race-registrations/[id]`, `/api/webhooks/revolut/race-payments` | `member-validation.js`, `race-payments.js`, `race-confirmations.js` | `RaceCheckoutPage.jsx`, `RaceConfirmedPage.jsx`, `RaceEventForm.jsx`/`RaceSignupWidget.jsx`/`RaceControlPanel.jsx` (extended) |
| Orders + events + tags (Phase 2) | 085 | `/api/orders`, `/api/segments`, `/api/cron/race-timing-events` | `orders.js`, `contact-events.js` | `OrdersTable.jsx`, `SegmentsGrid.jsx`, `Sidebar.jsx` (extended) |
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
| `race-control.js` | Helpers for the timed-event race UI (mig 081). Pure: `formatElapsed(seconds)` (MM:SS or H:MM:SS), `classifyBookingState(b)` → `'next_up' \| 'on_course' \| 'completed' \| 'no_show'`, `elapsedSecondsBetween(startIso, endIso)` (clamps negative to 0). IO: `ensureTeamForBooking(db, booking)` — find-or-create team by `(location_id, name)` for a booking, link the booking, seed the captain as a `team_member` row. Used by the race-start API route as a back-stop when a timed-event booking lands without a `team_id` (e.g. created before mig 081 or via a non-widget admin path); the booking widget's normal path creates the team at signup time. Tested in `race-control.test.js` (19 cases — every formatter branch + every classifier branch + the four ensureTeamForBooking paths). |
| `slug.js` | `toSlug(input)` — lowercase kebab-case, ASCII-only slug derivation. Used by `/api/admin/organizations` for org slug auto-derivation and by the `AddOrganizationButton` for the live preview as the operator types the name. Strips non-ASCII (no transliteration) and collapses runs of non-alphanumerics. Returns empty string for unusable input. Pinned by `slug.test.js`. |
| `assignment-changes.js` | Guards + audit writer for the master admin matrix v2 (mig 080). `countActiveMasters(db)`, `wouldLeaveZeroMasters(db, targetId)` — application-layer guard for the at-least-one-master invariant; pairs with the DB trigger `private.guard_at_least_one_master` for defence in depth. `logAssignmentChange(db, { actorId, targetProfileId, locationId, action, before, after })` — best-effort writer to `assignment_change_log`, never throws so an audit failure can't block the underlying mutation. `canRemoveSelfFromLastOwnerLocation(db, actorId, targetId, locationId)` — niche self-protection check that prevents an owner from accidentally removing their last owner-tier assignment. All called from the four `/api/admin/*` routes; can be reused by any future route that needs the same invariants. |
| `deposit-receipts.js` | Buyer-facing receipt SMS when a car deposit is paid (mig 078). `sendDepositReceiptSms({ db, car, location, actorId? })` is the single entry point — fired by the Revolut webhook after `cars.deposit_status` flips to `paid`. Three gates in priority order: location toggle (`car_deposit_receipt_sms_enabled`), idempotency (`cars.deposit_receipt_sent_at`), buyer phone present. On success: stamps the idempotency column AND inserts a `kind='system'` `car_notes` row with the Twilio SID (matches the issue-deposit-link pattern so operators can cross-reference in Twilio Console). Stamp lands ONLY after a confirmed Twilio success so a transient failure can be retried by the next webhook delivery. Best-effort end-to-end — caller (the webhook) swallows any exception so the deposit_status update remains the authoritative customer-facing signal. `buildReceiptBody({ car, location })` is exported separately so tests assert on body shape without standing up the full send flow. |

### Email system (`src/lib/postmark.js`)

Two streams: `broadcast` (marketing, GDPR headers) and `outbound` (transactional). `sendCampaign(id)` orchestrates audience building, batch sending (500/chunk), recipient tracking. Audience filtering goes through `applyAudienceFilter()` (whitelisted), so any (field, op) tuple the client passes that isn't in `AUDIENCE_FIELDS` throws `InvalidAudienceFilterError`. Merge tags: `{{first_name}}`, `{{last_name}}`, `{{name}}`, `{{email}}`, `{{phone}}`, `{{pipeline_stage}}` (canonical, reads `contacts.pipeline_stage_slug`), `{{lead_status}}` (deprecated alias — kept for back-compat, also reads `pipeline_stage_slug`), `{{location_name}}`, `{{unsubscribe_url}}`, `{{preference_url}}`, `{{current_year}}`, `{{glofox_passcode}}`. Unsubscribe URLs and preference URLs are built from `getAppUrl()`, which throws loudly if `NEXT_PUBLIC_APP_URL` is unset (no silent fallback).

**Audience query shape (CLASSIFY.1, May 2026):** `buildAudienceQuery*` filters `contacts` as a single-table query — no joins, no embeds. `email_marketing` is a denormalised column on `contacts` (kept in sync with `contact_preferences.email_marketing` via the trigger from mig 155). `pipeline_stage_slug` is also denormalised on `contacts` (synced from the most-recent open deal's stage via trigger). This kills a long line of PostgREST embedded-resource filter bugs that surface when overlaying a count-only select (`{ count:'exact', head:true }`) on top of an `inner` join — the embed silently drops its filter binding and counts return 0 with no error. The fix isn't to wrestle PostgREST; it's to remove the embed from the count path entirely. See "Audience classification model" below.

### WhatsApp system (`src/lib/whatsapp.js`)

24h response window enforced — `sendTextMessage` only works in window, `sendTemplateMessage` works anytime. Broadcasts rate-limited (50 msgs, 1s delay). `buildWhatsAppAudience()` checks `whatsapp_marketing` consent. Templates use `{{1}}`, `{{2}}` variable syntax mapped to contact fields via `buildTemplateComponents()`. Inbound webhook is HMAC-verified via `verifyMetaSignature()` against `WHATSAPP_APP_SECRET` over the raw request body — read the body with `await request.text()` first, parse JSON afterwards.

## Database

22 migrations in `supabase/migrations/`. Key tables:

**Core:** `locations`, `profiles`, `profile_locations` (junction; `profiles.role` holds the role, NOT this junction), `contacts`, `deals` (linked to contacts + stages), `pipeline_stages`, `activities`, `notes`.

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
- `pipeline_stages` is read-any-authenticated, write-owner-or-manager.
- `rate_limit_buckets` is service-role-only with an explicit deny-all for anon/authenticated (migration 022). Service role bypasses it; the policy exists for clarity-of-intent.

Migration 014 wrote the policies but never enabled RLS — migration 020 fixed that for the 9 tables it missed (`activities`, `blocked_times`, `bookings`, `contacts`, `deals`, `event_types`, `notes`, `pipeline_stages`, `webhook_subscriptions`). Migration 021 cleaned up `search_path` on 4 trigger/utility functions and revoked RPC access from anon/authenticated on the trigger functions (`handle_new_booking`, `handle_new_user`, `log_*`, `create_contact_preferences`, `rate_limit_hit`, `rls_auto_enable`). `webhook_subscriptions` was dropped in mig 097 (never had any rows; was the last consumer of `pg_net`).

When adding a new table that holds tenant data, add `location_id UUID REFERENCES locations(id)`, run `ENABLE ROW LEVEL SECURITY`, and replicate the `_location_scoped` policy pattern from 014 — referencing the helpers as `private.auth_is_in_location(...)`. Don't add `USING (true)` policies.

## Audience classification model (CLASSIFY.1+2, May 2026)

The canonical "where is this contact in the funnel" field is `contacts.pipeline_stage_slug`. It's a denormalised mirror of `deals.stage_id → pipeline_stages.slug` for the contact's most recent open deal, kept in sync by an `AFTER INSERT OR UPDATE OR DELETE ON deals` trigger from mig 155. **Operators never write to this column directly** — pipeline assignment flows from Glofox sync (`applyMemberSync` → `ensureDealForContact`) plus the nightly classifier cron (`pipeline-reclassify`). The 9 PIPELINE5 slugs are:

  `new_lead`, `active_trial`, `hot_conversion`, `active_member`, `at_risk_member`, `classpass_active`, `lapsed`, `dormant`, `dormant_classpass`

**`contacts.email_marketing`** (also added in mig 155) is a denormalised mirror of `contact_preferences.email_marketing`, synced by an `AFTER INSERT OR UPDATE OF email_marketing ON contact_preferences` trigger. Audience queries filter directly on the contacts column — no inner-join on `contact_preferences` needed. Treat `contact_preferences` as the source of truth and write to it directly (the trigger propagates); the contacts mirror is read-only as far as app code is concerned.

**Field hierarchy in the AudienceBuilder UI:**

  1. **Stage** (`pipeline_stage_slug`) — primary. The 9 PIPELINE5 slugs. This is what operators reach for intuitively.
  2. **Glofox Raw Status (advanced)** (`glofox_membership_status`) — the Glofox-side status that *feeds* the pipeline classifier. Power-user filter for targeting credit_member upsells or classpass_payg cohorts specifically. Don't reach for this by default.
  3. **Email Status, Lead Source, Has Phone, etc.** — orthogonal axes.

**`contacts.lead_status` is being removed.** It was the legacy "where in the funnel" field but was never maintained — 99.9% of Stillorgan contacts had the import default `'active_trial'` and no code reliably wrote `'member'` or other meaningful values back. CLASSIFY.2 (commit `2d9c966`) removed every read+write from app code; the column itself still exists pending a final cleanup pass (CLASSIFY.3) covering `mobile/` (5 files) + `shared/dashboard-data.js` + a SQL UPDATE for `email_sequences.trigger_type='status_change'` → `'pipeline_stage_change'` + JSONB rewrites for any production audience filters that still reference `lead_status`, then mig 156 `DROP COLUMN`.

**Glofox-side `lead_status` is a different field.** The Glofox `/2.0/members` API has its own `lead_status` field (uppercase enum: `LEAD`/`COLD`/`TRIAL`/`MEMBER` etc.) — completely separate taxonomy. Glofox-facing code (`src/lib/glofox-sync.js`, `src/lib/glofox-push.js`, `src/lib/glofox.js`, `src/app/api/glofox/*`) still reads and writes this. **Don't confuse the two** — anything that reads from a Glofox payload is OK; anything that reads from a local `contacts` row is the column being removed.

**Sequence trigger rename.** CLASSIFY.2 renamed the sequence trigger type `'status_change'` to `'pipeline_stage_change'` and the trigger function `triggerSequencesForStatusChange` to `triggerSequencesForPipelineStageChange`. The trigger now diffs on `contacts.pipeline_stage_slug` instead of `contacts.lead_status`. A SQL one-shot is needed before CLASSIFY.3's column drop: `UPDATE email_sequences SET trigger_type='pipeline_stage_change' WHERE trigger_type='status_change'` (otherwise any operator-created sequences still using the old trigger type silently stop firing).

**Sequence goal `lead_status` type is deprecated but aliased.** `scheduler.isGoalMet` still accepts `goal.type === 'lead_status'` for back-compat but reads `pipeline_stage_slug` under the hood and emits a `console.warn`. New sequences should use `goal.type === 'pipeline_stage'`.

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
REVOLUT_WEBHOOK_SECRET=          # signing_secret for the CARS deposit webhook (/api/webhooks/revolut)
REVOLUT_RACE_WEBHOOK_SECRET=     # signing_secret for the RACE-PAYMENTS webhook (/api/webhooks/revolut/race-payments). Mig 084. If unset, race route falls back to REVOLUT_WEBHOOK_SECRET (single-merchant transitional case).
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

**RLS:** `private.auth_is_in_location(loc_id)` OR-shorts via `private.auth_is_master()` — membership policies grant master automatically. Mig 052 added per-location helpers (`auth_is_owner_at(loc)`, `auth_is_admin_at(loc)`, `auth_is_manager_at(loc)`) and switched `pipeline_stages`, `profile_locations`, and `locations` policies to use them, so e.g. an owner-at-Hatch can no longer modify `pipeline_stages` rows that belong to Stillorgan via the authenticated channel. `profiles "Admins can manage profiles"` is master-only at the RLS layer (per-location ownership of a user-level row doesn't have a clean RLS expression); the API enforces per-location authorization for non-master callers.

**StaffForm UI (wizard since mig 051):** Per-location cards instead of a single role dropdown. Each card has its own role + UniFi door-access toggle + default flag. Caller props `callerIsMaster` + `callerOwnerLocationIds` gate which cards are editable; assignments at locations the caller isn't owner at render read-only ("Owner of that studio can edit"). Master callers also see a `Master / Platform Admin` toggle in its own panel above the assignments wizard.

### Per-location feature gates (migration 032)

Each location row has a `features JSONB` column that gates feature visibility for every user at that location. Three-tier resolution in `hasPermission(user, key)`:

1. **Location gate** — `user.activeLocation.features[key] === false` → DENIED for everyone, including master (only exception: master + `key === 'settings'` on web, which is the escape hatch back to the feature toggles). Notification keys (`notify_*` + anything in `NOTIFY_KEYS`) are exempt — those stay personal.
2. **Per-location user override (mig 058)** — `user.activeAssignment.permissions[key] === true | false` → that wins. Profile-wide `user.permissions` is **not** read anymore (was the source of the cross-location leak fixed in mig 058). Master skips this tier (and tier 3) once tier 1 passes.
3. **Role default** — fall back to `DEFAULT_WEB_PERMISSIONS_BY_ROLE[role][key]`.

Same logic mirrored in `mobile/lib/permissions.js` (`canMobile`, `canDashboard`, `hasAnyMobileFeature` all take `activeLocation` as the third arg). The mobile `/api/mobile/me` endpoint serialises `features` onto every location.

**Default state.** A row with `features = {}` (the column default) means every feature is enabled — this preserves existing behaviour for all rows post-migration. Master operators opt OUT of features they don't want at a particular studio by toggling them off in Settings → Locations → [location] → Features.

**Master-only since mig 092 audit.** Editing `locations.features` was previously owner-or-master via the page guard, but RLS still let any owner write the column directly. Now restricted via `canEditLocationFeatures()` in `src/lib/staff-access.js`. The `<LocationFeatures>` section only renders for master at `/settings/locations/[id]`, AND the save goes through `PUT /api/locations/[id]/features` (master-only server-side) instead of writing direct via the browser Supabase client. `<AdminFeatureMatrix>` at `/admin/matrix` also routes through the same endpoint for consistency.

**Helpers (`shared/permissions.js`):**
- `isFeatureEnabledAtLocation(location, key)` — primary gate check
- `isFeatureGatedByLocation(key)` — false for notification keys (always personal)
- `NOTIFY_KEYS` — derived from `MOBILE_PERMISSIONS.filter(p => p.isNotify)`
- `CROSS_PLATFORM_KEYS` — keys that live top-level on `permissions` (not nested under `mobile.*`) and are read by both web and mobile from the same key. Today: the three `dashboard_*` keys + `studio_management`. When adding a new shared-by-design key, add it here so the parity linter knows not to demand a `webEquivalent`.

Multi-location users: `activeLocation` determines which gate applies. Switching locations re-evaluates everything.

**Persistence pitfall (mig 092 audit).** When a server page narrows a Supabase SELECT on `profile_locations`, it's easy to silently drop the `permissions` JSONB column — the form then falls back to role defaults and POSTs those default values back over the operator's real overrides on save. Verified via `mapProfileLocationToAssignment()` in `src/lib/staff-access.js`. ANY future SELECT that hydrates per-user permissions for the StaffForm should go through that helper (or extend it) — its contract test would break loudly if a future change re-introduces the bug.

**Owner edit constraints (mig 092 audit).** Owners can no longer edit themselves or other owners. `canEditStaffMember(caller, target)` enforces: master can edit anyone (incl. self); owner can't self-edit, can't edit peer owners, can edit manager / head_coach / staff at their owner-locations. Wired into `/settings/staff/[id]/page.js` (page redirect) AND `/api/staff/[id]` PUT (defence-in-depth — a hand-crafted PUT can't bypass the page guard). The Settings → Staff list renders "Locked" instead of "Edit" for rows the caller can't touch.

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

**Always paginate Supabase reads of >1k rows.** PostgREST silently caps every response at the project's `db-max-rows` (1000 on this project). `.limit(20_000)` does NOT override it — the cap applies regardless. Worse, without an `.order()` the row order on a capped response is non-deterministic, so re-runs of the same query return *different* slices of the same 1000 rows.

This bit us **three times** in the PIPELINE5.x rollout (re-classify contacts read, re-classify deals read, invoice-backfill contact lookup) before we caught the pattern. Symptoms: silently truncated maps, run-to-run variance on idempotent operations, member lookups missing for contacts that definitely exist.

Use `.range(start, end)` pagination with an explicit `.order()` whenever the result set could plausibly cross 1k rows:

```js
const PAGE_SIZE = 1000
const HARD_LIMIT = 20_000
const rows = []
let pageStart = 0
// eslint-disable-next-line no-constant-condition
while (true) {
  const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, HARD_LIMIT - 1)
  const { data: page, error } = await db
    .from('contacts')
    .select('id, glofox_member_id')
    .eq('location_id', locationId)
    .order('id', { ascending: true })
    .range(pageStart, pageEnd)
  if (error) { /* handle */ break }
  if (!Array.isArray(page) || page.length === 0) break
  rows.push(...page)
  if (page.length < PAGE_SIZE) break
  if (rows.length >= HARD_LIMIT) break
  pageStart += PAGE_SIZE
}
```

Reference implementations: `src/lib/pipeline-reclassify.js` (contacts + deals), `src/app/api/admin/glofox-invoice-backfill/route.js` (contact-id map). Don't re-roll — copy from one of those.

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

Two distinct pipelines — **EAS Update** for JS-only changes (over-the-air, no review) and **EAS Build** for native binaries (required for App Store / TestFlight / Custom App via ABM).

**EAS Update (JS only).** Auto-runs on every push to `main` via `.github/workflows/eas-update.yml`. Ships only the JS bundle; existing installs pick it up on next launch. Use for any change that doesn't add/remove a native module or change permissions, plugins, icons, or bundle identifier. ~30 sec to publish, no Apple review.

**EAS Build (native binary).** Required when `app.config.js` plugins / `package.json` native deps / icons / bundle id / version change. Three ways to trigger:

1. **EAS Workflow (recommended)** — `mobile/.eas/workflows/release.yml` defines a manually-triggered "Release" workflow that builds AND submits BOTH platforms in parallel: iOS to App Store Connect (Custom App / ABM) and Android to Google Play Internal Testing track. Trigger from expo.dev → Workflows → Run. Single click, no laptop needed, total wall-clock ~25 min (slower of the two builds). Each platform's submit job depends only on its own build so a failure on one doesn't block the other. This is the steady-state path for shipping new native releases.
2. **CLI** — from `mobile/`:
   ```bash
   eas build --platform ios --profile production
   eas submit --platform ios --profile production --latest
   eas build --platform android --profile production
   eas submit --platform android --profile production --latest
   ```
   Used for the very first build per platform (because credentials need interactive setup — Distribution Cert for iOS, upload keystore for Android) and as a fallback if EAS Workflows is unavailable.
3. **expo.dev web UI ad-hoc** — Project → Builds → "Build". Equivalent to the CLI route but no laptop needed. First time, link GitHub at Project settings → GitHub with **Base directory = `mobile`** (this is a monorepo; without the base dir EAS tries to build the Next.js app and fails).

The Vercel-deployed `crm.un1tdublin.com` is the API base URL the mobile app calls — no separate backend deploy.

#### Distribution: closed-track only, no public stores

UN1T CRM is an internal staff tool, not a consumer product, so neither store version is publicly listed:

- **iOS**: ships as a **Custom App for Business or Education** via Apple Business Manager. Distribution is gated by ABM organisation membership.
- **Android**: ships to the **Internal Testing track** on Google Play Console. Up to 100 testers managed by email lists; testers click a "Become a tester" link, app appears in their Play Store. App is not searchable publicly.

The two platforms have parallel-but-not-identical setup paths. iOS specifics first, then Android.

##### iOS — Custom App via Apple Business Manager

**One-time prerequisites (already done as of 2026-05):**
- Apple Developer Program membership (annual fee).
- Apple Business Manager account for UN1T Dublin Ltd (requires D-U-N-S; free).
- Bundle ID `com.un1tdublin.crmmobileios` registered at developer.apple.com → Identifiers, with **Push Notifications** capability ticked.
- App Store Connect record created (ID `6766947870`), distribution method set to **Custom App for Business or Education**, ABM org listed as recipient.
- Privacy policy live at `crm.un1tdublin.com/privacy` (page lives at `src/app/privacy/page.js`).
- App icons at `mobile/assets/icon.png` (iOS, 1024×1024 RGB no alpha), `adaptive-icon.png` (Android), `notification-icon.png`, `splash.png` — generated as a black/white wordmark using **Poppins Bold** as a SIL-licensed stand-in for NEXA.
- `mobile/eas.json` `submit.production.ios` populated: `appleId`, `appleTeamId` (`535XMCT5PY`), `ascAppId` (`6766947870`).

**Per-version submission flow:**
1. Bump `version` in `mobile/app.config.js` (semver). Use the helper:
   ```bash
   cd mobile
   npm run version:patch    # 0.1.0 -> 0.1.1   (bug fix)
   npm run version:minor    # 0.1.0 -> 0.2.0   (new feature)
   npm run version:major    # 0.1.0 -> 1.0.0   (breaking / milestone)
   ```
   The script (`mobile/scripts/bump-version.mjs`) edits `app.config.js`, commits with a descriptive message, tags the commit `mobile-vX.Y.Z`, and pushes — all in one go. Add `--no-commit` and/or `--no-push` if you want to stage manually. EAS Build auto-increments `buildNumber` on every native build, so we only manage the marketing version here.
2. Verify lock file is in sync (see "Before pushing" above) — `npm ci` is what EAS runs and the lock-drift failure is silent in local dev.
3. Trigger build via the **Release iOS** EAS Workflow at expo.dev → Workflows → Run. ~15–25 min build, automatically followed by submit (~3–5 min upload + 10–20 min Apple processing). For first-time builds or when EAS Workflows is unavailable, fall back to the CLI route.
4. The build appears under App Store Connect → My Apps → UN1T CRM → TestFlight tab once Apple finishes processing.
5. In App Store Connect, attach the build to the version, fill metadata (screenshots, App Privacy nutrition label, age rating, content rights, review notes), submit for review. Custom App reviews are typically 24–48h.
6. Once approved, distribute via ABM → Apps & Books — assign to staff Apple IDs by email or Managed Apple ID. App appears in their App Store app library, not searchable publicly.

**App Privacy declarations** (the "nutrition label") for UN1T CRM iOS: Name, Email Address, Phone Number, User ID, Device ID, Photos/Videos (invoice PDFs), Customer Support (WhatsApp/email/SMS history), Crash Data, Performance Data — all linked, none used for tracking, all purposes are App Functionality (+ Customer Support for phone/messages, + Analytics for diagnostics). Do NOT declare: Location, Contacts (the iOS Contacts app — CRM "contacts" is a different concept), Payment Info (Revolut handles cards, app never sees them), Health/Fitness (no HealthKit access), IDFA. Age rating: all "None"/"No" → 4+. Content rights: No (no licensed third-party media).

**Common iOS build/submit failures and their fixes:**
- `npm error Missing: <pkg> from lock file` → run `npm install --package-lock-only` in `mobile/` and recommit (see "Before pushing").
- `Bundle ID dropdown empty in App Store Connect` → bundle ID has to be registered at **developer.apple.com → Identifiers** first; App Store Connect only lists pre-registered IDs.
- Apple credentials prompt during build → first-time only; let EAS generate the cert + provisioning profile.
- iPad screenshots required — set `supportsTablet: false` in `app.config.js` if iPad isn't a target, otherwise Apple rejects for missing 13" iPad screenshots.

##### Android — Internal Testing track on Google Play (build-only automation)

**Important: Android submit is NOT automated.** UN1T's Google Workspace organisation policy `iam.disableServiceAccountKeyCreation` blocks creating the service-account JSON that `eas submit --platform android` needs. Disabling that constraint requires Cloud Org Administrator role at the Workspace level which isn't worth the bureaucratic adventure for what's a roughly quarterly native release. Instead:

- The EAS Workflow **builds** the Android `.aab` automatically.
- You **download and upload manually** to Play Console (~2 min per release).

If we ever want to re-enable automated submit, the path is either: (1) become Cloud Org Admin → disable the org policy → create a service-account JSON → upload to expo.dev → restore the `submit.production.android` block in `eas.json` → restore the `submit_android` job in `release.yml`. Or (2) set up Workload Identity Federation in EAS, which doesn't need a JSON key but is more involved.

**One-time prerequisites:**
- Google Play Console developer account ($25 one-time).
- App record created in Play Console with the matching package name (`com.un1tdublin.crmmobileios`).
- App content forms completed: Privacy Policy URL (`https://crm.un1tdublin.com/privacy`), Account Deletion URL (`https://crm.un1tdublin.com/account-deletion`), Data Safety form (Android's privacy nutrition label), Content Rating questionnaire, Target Audience (18+), App Category, Ads disclosure (no ads).
- Main Store Listing filled in (icon 512×512 RGB, feature graphic 1024×500, 3+ phone screenshots at 1080×2160, full description).
- Android upload keystore: auto-generated on first interactive `eas build --platform android --profile production`. Stored on EAS, reused indefinitely. **Never delete it** — Play App Signing pins your app to its fingerprint, deleting locks you out of the Play listing forever.
- Internal Testing track configured in Play Console with the staff tester email list.

**Per-version submission flow:**
1. Bump version (shared with iOS): `npm run version:patch` from `mobile/`.
2. Trigger the `Release` EAS Workflow at expo.dev → Workflows → Run. iOS auto-submits; Android only builds.
3. Once the Android build is green: open it on expo.dev, click **Download** to get the `.aab`.
4. Play Console → Testing → Internal testing → **Create new release** → drag the `.aab` in → fill release notes → **Save → Review release → Start rollout to Internal testing**.

The first build to a fresh app record always has to be uploaded manually like this anyway — even with a service account configured, Play Console requires the first AAB through the web UI to "create" the listing.

**Common Android build failures and their fixes:**
- Upload keystore prompts during build → first-time only; let EAS generate it. After this, never delete the keystore on EAS.
- `Version code already exists` (when manually uploading) → `appVersionSource: 'remote'` in eas.json should auto-increment, but if a build was rejected and resubmitted under the same code, force a new build to get a fresh code.
- Manual upload rejected for "metadata not complete" → Play Console requires every form in App Content to be green-ticked before any upload is accepted. Check the "App content" sidebar for amber dots.

## Deployment

Vercel Pro. Every scheduled job lives in `vercel.json` — there is no `pg_cron` and no `pg_net` in the database (mig 097 removed both extensions along with the legacy `webhook_subscriptions` table that was the last `pg_net` consumer). One source of truth, no drift surface.

- `/api/cron/run-scheduled-reports` — daily 07:00 UTC (= 07:00 Dublin in winter, 08:00 in summer — `vercel.json` doesn't accept a `timezone` field; use the Vercel dashboard if you ever need DST-stable scheduling). Generates due `scheduled_reports`.
- `/api/cron/prune-rate-limits` — daily 03:30 UTC. Deletes expired `rate_limit_buckets` rows.
- `/api/cron/run-sms-broadcasts` — every 5 minutes. Picks up scheduled-due AND in-flight 'sending' rows, dispatches via `sendBroadcast` with chunk size 1000 per tick (Pro 300s ceiling).
- `/api/cron/run-sequences` — every 5 minutes. Three phases per tick: (1) `runEventReminderSends()` for per-event single-shot reminders, (2) `runEventReminderTriggers()` for sequence-based event reminder triggers, (3) `runSequences()` to fire due steps. Each phase is independent so a failure in one doesn't stop the others.
- `/api/cron/race-timing-events` — every 15 minutes. Emits time-anchored race events (`race.starts_in_24h`/`_1h`, `race.completed_24h_ago`) that drive retargeting tags. Idempotent via the partial unique index on `contact_events (source_type, source_id, event_type)`.
- `/api/cron/process-contact-imports` — every minute. Drains the `contact_imports` queue (status='pending'), running each via the shared `runImportCommit()` runner. Stuck-job recovery resets anything in 'processing' for >5 min back to 'pending'.

All crons are protected by `Authorization: Bearer ${CRON_SECRET}` which Vercel Cron injects automatically. Long-running crons set `export const maxDuration = 300` (Pro ceiling) so a busy 5-min window can finish without hitting the function timeout.

### Cron monitoring (mig 053, 054)

`public.cron_heartbeats` (one row per cron name) is stamped via `stampHeartbeat(name)` in `src/lib/cron-heartbeat.js` on every successful tick. The `public.cron_health` view (security_invoker = on, RLS-respecting) computes `is_stale` live as `NOW() - last_ok_at > expected_interval + grace`. `/api/cron/health-check` reads the view and returns **200** when every cron is fresh, **503** when any is stale — auth-gated by `CRON_SECRET`.

External uptime monitors (UptimeRobot, Better Stack, Pingdom — anything that supports HTTP monitors with custom headers) ping `/api/cron/health-check` every few minutes with `Authorization: Bearer ${CRON_SECRET}` and alert on any non-2xx. One URL covers all crons; no per-cron monitor config needed. Vercel Hobby has no native log-based alerting, so external pingers are the right primitive.

Why this exists: on **2026-05-01 14:41 UTC** the `CRON_SECRET` on Vercel drifted from a copy of the same secret stored inside Postgres (`private.app_config.cron_secret`) that the old pg_cron + pg_net path read on each tick. `/api/cron/run-sequences` silently 401'd every 5 minutes for ~22 hours. We caught it by chance — there were no due enrolments during the window, so the customer impact was zero, but it could just as easily have been a launch. The heartbeat → view → health-check → external monitor chain means the next drift surfaces within minutes. The dual source of truth is also gone: mig 066 dropped `private.app_config`, then mig 097 dropped pg_cron and pg_net entirely, so `CRON_SECRET` only exists in Vercel env now.

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
| `pipeline_stage_change` | `triggerSequencesForPipelineStageChange(contactId, oldSlug, newSlug)` from `PUT /api/contacts/[id]` (CLASSIFY.2 rename — was `status_change` on `lead_status`) | `from_stage?`, `to_stage?` | `'<old>→<new>'` |
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
- **`contacts(location_id, pipeline_stage_slug)`** partial index for the pipeline (replaces the old `(location_id, lead_status) WHERE lead_status IS NOT NULL` index — mig 155 added the new one; CLASSIFY.3 will drop the old one + the column).
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

- **Next 14 caches third-party fetch responses inside the data cache, even on `force-dynamic` routes.** `dynamic = 'force-dynamic'` opts the route into dynamic rendering and sets fetch defaults to no-store FOR fetches issued by the route's own code. The Supabase JS client opens its own internal fetch instance that doesn't inherit those defaults. Symptom: an UPDATE in Postgres is invisible to the next read on the same deployment until the data cache evicts (or you redeploy). Hit this on 2026-05-05 when extending a deposit token's expiry — the DB row was correct, the API kept returning `TOKEN_EXPIRED` from a stale cached fetch, and `x-vercel-cache: MISS` is no help here because the cache lives at the data-cache layer, not the CDN. Fix landed in `src/lib/supabase.js` — `createServerClient()` now passes `{ global: { fetch: noStoreFetch } }` so every read is fresh. Applies the same pattern to any third-party SDK that internally `fetch()`es; if it doesn't accept a fetch wrapper, you have to wrap the route's call in `unstable_cache` with a tag and bust the tag on writes — clumsier.

- **Every cron with a heartbeat row MUST stamp the heartbeat in its route.** A cron can be firing fine (Vercel logs show 200s every tick) and still go "stale" because the route forgot to call `stampHeartbeat()`. The health-check correctly raises 503 — the cron itself is dead in the heartbeat sense even though it's alive in the run sense. Hit this on 2026-05-05 with `race-timing-events`: the row was seeded by mig 097 with `last_ok_at = NOW()` and immediately started the slow drift to staleness because the route never refreshed it. Pattern check: `grep -L stampHeartbeat src/app/api/cron/*/route.js` should return only `health-check/route.js` (which is the checker itself, not a stamper). Anything else missing from that list is a latent staleness bug.

- **Per-domain branding on a single Next app uses the location-id as the brand key.** un1t-crm runs on two hostnames — `crm.un1tdublin.com` (UN1T) and `pay.ccfautos.com` (CCF Autos). The deposit page on the pay.* hostname needs CCF branding; UN1T pages need UN1T branding. We don't switch on Host header — we switch on the car's `location_id` because the same hostname can technically serve any location's car. Pattern: `app/deposit/[token]/page.js` has a server-side `generateMetadata({ params })` that joins `cars → locations → company_settings` and returns `icons` + dynamic title; the page component renders `branding.logo_url` at the top of the layout. Same approach for any future buyer-facing page on a brand hostname — branch on the source row's `location_id`, not the request hostname.

- **PostgREST embedded-resource filters are brittle under count-only selects.** A query like `.from('contacts').select('*, contact_preferences!inner(*)').eq('contact_preferences.email_marketing', true)` works when you await full rows. The moment you overlay `.select('id', { count: 'exact', head: true })` to get just a count, the embedded `contact_preferences` filter silently loses its binding and counts return **0 with no error**. Keeping the same embed shape in the count select (`.select('id, contact_preferences!inner(id)', ...)` or even `.select('*, contact_preferences!inner(*)', ...)`) doesn't help — head:true changes the semantics in a way that drops the relationship link. Don't fight this. **Denormalise the columns you filter on** into the parent table and filter the parent as a single-table query. Mig 155 added `contacts.email_marketing` (denormalised from contact_preferences via trigger) and `contacts.pipeline_stage_slug` (denormalised from deals via trigger) specifically to kill this whole class of bug. CAMPAIGN.6→.9 each tried to fix the symptom inside the embed approach and each exposed a new seam (zero-row counts, URL-length 400s, etc.) before we conceded and denormalised. If a future audience query needs a field that isn't already on `contacts`, the answer is "denormalise it via trigger", not "make the embed work."

- **Booking `start_time` + `booking_date` are Dublin wall-clock, not UTC.** The `bookings` table stores `booking_date` as `YYYY-MM-DD` and `start_time` as `HH:MM:SS` — both are operator-local Dublin time without any timezone semantics in the DB. **Never** build a Date from them with a `Z` suffix (`new Date(\`${dateStr}T${timeStr}Z\`)`) — that forces UTC parsing, then formatting the resulting instant in Europe/Dublin adds the BST offset (+1h March→October), so a 17:00 booking renders as 18:00 in the confirmation SMS. Use the time string verbatim and only go through `Intl.DateTimeFormat` for the weekday/date label (anchor on noon UTC of the booking date — safe across timezones). Hit this in BOOKING.2 (commit `13452dc`); the fix lives in `src/lib/booking-confirmations.js` `fmtBookingTime()`. Same convention applies to anywhere else you find these two columns being composed into a Date.

- **`/api/public/book` must copy `event_type.location_id` onto the booking insert.** Operator hit this on 2026-05-13 — Sarah's consultation booking didn't appear in `/bookings` because the location-scoped query filtered out rows with `location_id IS NULL`, and the public booking insert was loading `event.location_id` for downstream consent + Glofox push but never writing it onto the booking row itself. Fix: explicit `location_id: event.location_id` in the insert payload (BOOKING.1, commit `13452dc`); mig 154 backfilled existing rows. **Rule of thumb:** any insert into a tenant-scoped table whose source data already carries a `location_id` must propagate it, even if a downstream consumer (Glofox push, sequence trigger) reads it via the parent's join. The /bookings page reads the booking's own `location_id`, not the event_type's.

- **Vercel runtime log viewer truncates `console.log` output.** The MCP `get_runtime_logs` tool only shows the first/last log line per request — anything you `console.log` mid-handler is captured but invisible in the table view. For diagnostic logging, **embed the data in the API response itself** under a `_debug` key and read it from DevTools → Network → Response. CAMPAIGN.7 burned a round-trip pushing console diagnostics that couldn't be read; CAMPAIGN.7b switched to response-body diagnostics and found the bug in one refresh.

- **postgrest-js's `.select()` has two overloads — only the FIRST one reads options.** `PostgrestQueryBuilder.select(columns, options)` (the first `.select()` after `.from()`) reads `options.head` + `options.count`, switches method to HEAD, adds `Prefer: count=exact`. `PostgrestTransformBuilder.select(columns)` (any `.select()` chained AFTER a filter like `.eq` / `.not` / `.in`) takes ONLY a columns argument — a second argument is silently ignored, JS doesn't enforce arity. The pattern `db.from('x').select('*').eq(...).select('id', {count:'exact', head:true})` looks like it should give you a HEAD count request, but the chained `.select` is the no-options TransformBuilder overload — it just resets `select=id` and you keep your method=GET with no count Prefer. Supabase-js parses `count` as `null` and `count || 0` renders 0. CAMPAIGN.10 traced this; the fix is to request `head`+`count` on the FIRST `.select()` only. **When supabase-js returns 0 from a count query but you expect rows, check whether you're chaining `.select()` twice.**

- **Supabase / PostgREST has a default 1,000-row select cap.** Every `await db.from('x').select(...)` returns at most 1,000 rows unless you explicitly `.range()` past it. For any fan-out (campaign send, contact import, bulk webhook handling, sequence enrollment), page with `.range(from, from + N - 1)` until a short page comes back. CAMPAIGN.11 was a 1k-vs-3k silent send because the audience query happily returned 1,000 rows and downstream code never asked for more. CAMPAIGN.11-RECOVERY's first attempt hit the same cap on a *different* query (the `campaign_recipients` lookup to find already-sent contacts) — assume every unbounded select is capped until proven otherwise.

- **`PostgrestFilterBuilder` instances are single-use.** Awaiting once consumes the thenable. To page or to re-run the same query against different `.range()`s, **rebuild the builder per iteration** — don't try to reuse a single builder reference. Tag-filter resolution / audience-filter application is cheap; this re-build cost is negligible.

- **`.update().eq()` in supabase-js MUST be awaited or it never fires.** The filter builder only dispatches an HTTP request when its thenable is consumed (await / `.then`). An "update" tucked inside an outer `.then()` without `await` looks correct but is a silent no-op. CAMPAIGN.12 hit this in 4 places — every campaign rollup counter (opens/clicks/bounces/complaints) stuck at 0 for months because of `await db.from('campaigns').select(...).single().then(({data}) => { db.from('campaigns').update(...).eq(...) })`. Fix is either `await` the inner builder or — better — replace the read-then-write with an atomic RPC like `increment_campaign_metric`.

- **High-volume webhook handlers must defer work.** Postmark fires Delivery + Open + Click + Bounce events per recipient. A 3k-recipient campaign produces ~5k webhook calls in 20s. If each handler does 3-5 sequential DB writes inline, Vercel's lambda concurrency limit trips and webhooks 5xx before reaching your code — Vercel's "Massive burst, 8x faster failures, no error logs, platform/validation level" alert is the tell. **Pattern that works:** webhook handler does auth + dedup + 1 INSERT into a queue table + return 200 (under 50ms). A separate cron drains the queue at controllable rate. Same `recordWebhookEvent` dedup pattern from mig 107 stays as a pre-queue gate so retries don't re-queue. CAMPAIGN.13's `postmark_webhook_queue` + `process-postmark-webhooks` cron is the reference shape.

- **Long-running fan-outs belong on cron, not on the request thread.** `sendCampaign` v1 loaded the whole audience and looped through it in one function invocation — fine for 100 recipients, broke for 3,000 (Vercel function timeout) and burst the webhook receiver. **Pattern:** request endpoint flips status to 'queued' and returns; a per-minute cron picks up queued/sending rows and processes one chunk (≤500 per tick) per invocation, updating progress eagerly so the UI's poll-every-3s progress bar moves. Throttles naturally to ~500/min/campaign — well under Postmark's batch limit and under Vercel's request rate. CAMPAIGN.13 = `run-campaigns` cron + `tickCampaignSend` is the reference shape. Same pattern works for sequence-step backfills, bulk imports, anything fan-out shaped.

- **`List-Unsubscribe-Post: List-Unsubscribe=One-Click` requires the URL to actually accept POST.** Gmail / Outlook / Apple Mail / etc. follow RFC 8058 and POST (empty body) to the URL in `List-Unsubscribe` when the user clicks the built-in Unsubscribe button. If that URL resolves to a Next.js page route (GET-only), the request returns 405 silently — Postmark records the unsub on its own suppression list (so future sends to that address are blocked at the ESP level) but the CRM never sees it; the contact stays opted-in. **Convention:** the URL in the body / merge-tag points at the friendly page (`/unsubscribe/[token]/page.js`); the URL in the `List-Unsubscribe` HEADER points at the POST endpoint (`/api/unsubscribe/[token]/route.js`). UNSUB.3 added a `toListUnsubscribeUrl(pageUrl)` helper that swaps `/unsubscribe/` → `/api/unsubscribe/` for the header. **General rule for headers that mandate POST-able URLs:** verify the target route exposes a POST handler, not a page render.

- **Postmark suppression list is the source of truth for ESP-side opt-outs.** Hard bounces, spam complaints, and one-click unsubscribes via email-client buttons all add the recipient address to Postmark's broadcast-stream suppression list. If your DB drifts out of sync (UNSUB.3 was a several-day gap where one-click unsubs were lost), you can backfill via `GET /message-streams/<stream>/suppressions/dump` (paged 500/call). Lowercase-normalise emails for comparison; `contacts.email` is stored lowercase already so a direct `.in()` matches. UNSUB.4 is the reference pattern — reconciled 23 contacts in one run.

- **Next.js App Router rejects two different dynamic-segment names at the same path depth.** `/tv/[locationId]` and `/tv/[token]` won't coexist — build fails with `You cannot use different slug names for the same dynamic path`. Either rename one to match (often wrong — the param semantically differs) or move one to a different depth (`/tv/cast/[token]`). TV.1 hit this against the existing `/tv/[locationId]` HR live board; moved the cast variant to `/tv/cast/[token]`. **Before adding a new dynamic segment to an existing parent dir, grep for siblings: `find src/app/<parent> -type d -name '[*]'`.**

- **UC Cast (basic) doesn't expose a web-URL content source — UC Cast Pro does.** The basic UC Cast only supports media-library uploads + YouTube (beta). Pro adds "Web URL" which lets you point the cast at any URL. **If you're integrating with UniFi Connect from a CRM:** verify the Pro tier first; the basic-tier integration story is reverse-engineering an undocumented controller API + ongoing maintenance against version changes; Pro+web-URL is just "host a page". Connect's content-management API has no published public surface as of 2026-05.

- **Cowork sandbox can't unlink files in `.git/` or in mounted workspace dirs.** Recurring all-session bug: every `git` operation that creates a `.lock` file (commit, add, push, branch ops) leaks the lock because the sandbox kernel rejects `unlink` on those paths. Workaround: do code edits + DB migrations from the sandbox (which work fine), but **run all `git` commands from the host shell**. Shipping scripts at the workspace root (`_<feature>_ship.sh`) that the user `bash`-runs on their host became the standard pattern for the second half of the session. The sandbox itself can write new files freely — it's only `unlink` that fails. Same constraint shows up on empty-directory cleanups — `rmdir` from sandbox is also rejected.

- **Native-binary npm deps (sharp, etc.) installed in the Cowork sandbox are wrong-platform for your Mac.** The sandbox is aarch64 Linux; your Mac is aarch64 darwin. When sandbox-side `npm install <dep>` runs for a package like `sharp` that ships per-platform `.node` binaries, only the linux-arm64 binary gets fetched into the shared `node_modules` (the darwin-arm64 sibling directory exists per the lockfile but stays empty — npm skips non-matching platform binaries by design). Tests pass in the sandbox; the first time you run `npm test` on the Mac, sharp's loader errors with `Could not load the "sharp" module using the darwin-arm64 runtime`. **Fix:** on the Mac, `cd <repo> && rm -rf node_modules && npm install`. Lockfile is preserved (already has the darwin-arm64 entry with integrity hash); npm rebuilds node_modules and fetches the host-matching binary. **Avoid the trap:** when adding any dep that ships a `.node` file or has a `binding.gyp`, prefer installing it from the Mac terminal directly. Vercel's CI is unaffected — its linux-x64 builders fetch the right binary at build time. Same applies to `canvas`, `bcrypt`, anything with a native compile step.

- **Postmark caps attachments at 10 MB per email — merge multi-file packs into one compressed PDF rather than sending N separate attachments.** `pdf-lib` + `sharp` together on Vercel's Node runtime handle the canonical shape: PDFs pass through verbatim (`PDFDocument.copyPages`), images are pre-compressed via sharp (`.rotate()` to honour EXIF then strip, `.resize({fit: 'inside', withoutEnlargement: true})` to a sane max side like 2000px, `.jpeg({quality: 80, mozjpeg: true})`) and embedded as A4 pages with a small label header. Realistic 10-doc pack with phone photos lands at 1.5–4 MB after compression, well under the cap. Reject post-merge over-size with a per-source size breakdown so the operator knows which doc to shrink. Sharp ships precompiled binaries for Vercel's Node runtime — no extra build config needed, ~500 ms cold-start penalty on first call after a deploy is acceptable for a manual operator action. Lazy-import sharp + pdf-lib inside the helper so endpoints that don't merge (Phase 1 staging-only routes, listing endpoints) don't load them on every cold start. Reference shape: `src/lib/bca-merge.js` + `src/app/api/cars/[id]/bca/submit/route.js` from BCA.1 Phase 2. Same pattern works for any "operator wants to send N attachments to an external party" flow — e.g. supplier-onboarding doc packs, race-day medical packs, etc.

- **Don't mix local-time Date parsing with UTC ISO formatting.** `new Date('2026-05-04T00:00:00')` (no `Z` suffix) is parsed as LOCAL time; `new Date('2026-05-04T00:00:00Z')` is UTC. Then `d.toISOString().slice(0, 10)` always returns the UTC date. If you build a "week start" Date with local-time parsing and then format successive days via `toISOString().slice(0, 10)`, you'll silently get dates one day earlier in any TZ east of UTC. roster-summary.test.js had this bug in 3 places — passed in CI (UTC) for months, failed on a Dublin BST mac as soon as anyone ran `npm test` locally. **Two safe patterns:** (a) parse with `'Z'` AND use `getUTCDate` / `setUTCDate` for arithmetic; (b) parse local AND format with the production formatter (`getFullYear` / `getMonth` / `getDate` → `YYYY-MM-DD`) — i.e. don't reach for `toISOString().slice(0, 10)` at all unless your Date is genuinely UTC-anchored. Pattern (b) is what the test fix uses — added an `isoDay(base, offset)` helper that imports `formatDate` from `./roster` so the test stays internally consistent with the production code in any timezone. **General rule for date-y test code:** if the assertion compares an ISO date string, run the test under `TZ=Europe/Dublin` AND `TZ=America/Los_Angeles` once before trusting it — `for tz in UTC Europe/Dublin America/Los_Angeles Asia/Tokyo; do TZ=$tz npx vitest run path/to/file.test.js; done` is a one-shot guard.

- **Wrap `auth.uid()` (and `auth.role()` / `auth.jwt()`) inside `(SELECT …)` in every RLS policy.** A raw `auth.uid()` call in a policy's USING / WITH CHECK clause is re-evaluated **per row** during a query — PG treats it as a stable function but doesn't fold the call into an InitPlan when it's not subqueried. Wrapping turns it into `InitPlan 1 (returns $0)` that runs **once per query** and gets cached; the per-row cost drops from "function call + JWT decode" to "fetch $0 from memory". The Supabase advisor calls this `auth_rls_initplan`. Same wrap works for any stable function whose value is constant within a query (`current_setting('jwt.claims.sub')`, `current_user`, custom `auth_is_master()` helpers — wrap those too). PERF.1 (mig 162) rewrapped 8 policies; pattern is `WHERE pl.profile_id = (SELECT auth.uid())` instead of `WHERE pl.profile_id = auth.uid()`. **General audit query:** `SELECT tablename, policyname FROM pg_policies WHERE schemaname='public' AND ((qual ~ '(^|[^.(])auth\\.(uid|role|jwt|email)\\(\\)' AND qual !~ 'SELECT auth\\.') OR (with_check ~ '(^|[^.(])auth\\.(uid|role|jwt|email)\\(\\)' AND with_check !~ 'SELECT auth\\.'))`. Run after any RLS migration. Related advisor flags to fix in the same pass when they surface: `multiple_permissive_policies` (two policies of the same kind on the same role+command — usually a stray `Service role full access` with `qual=true, roles=public` that grants every db role full access, sitting alongside the real in-location policy; service_role bypasses RLS anyway so the wide-open policy is both a security smell and a perf hit), `unindexed_foreign_keys` (every FK column should have a covering index — `WHERE col IS NOT NULL` partial when nullable so the index is tight), and `duplicate_index` (non-unique twin of a unique constraint — drop the non-unique one; watch out for false positives where the "duplicate" has a different partial WHERE serving a separate query). The 237 `unused_index` flags are a separate question — "no scans since stats reset" doesn't mean "safe to drop", audit those in a dedicated pass.

- **`supabase.auth.admin.updateUserById` + `auth.admin.signOut(userId, 'global')` is the canonical admin password-override pattern.** When an operator needs to set a user's password directly (vs sending a reset-email link), use the **standard `@supabase/supabase-js` client constructed with the SERVICE_ROLE key** — admin APIs aren't exposed through `@supabase/ssr`'s server client. After `updateUserById({ password })` succeeds, call `signOut(userId, 'global')` to invalidate every existing session for that user (browser, mobile, API tokens — any active access tokens become invalid). The 'global' scope is critical: a per-session signOut leaves other devices logged in with stale credentials. Audit the act of override (who, when, against whom, optional reason) — never store the new password. Show it to the admin once in the response payload so they can pass it to the user via WhatsApp / in-person / etc., then it's gone. AUTH.1 in `/api/admin/password-override` is the reference shape; pattern reusable for any "admin acts on behalf of user" auth operation (email change, MFA reset, etc.). Forced minimum is 12 chars when admin types manually; otherwise use a crypto.getRandomValues-sourced generator over an alphabet that excludes visually-confusable chars (0/O, 1/l/I) and shell specials so the password is safe to dictate over a phone call.

## Sentinel monitoring agent (`un1t-sentinel` repo)

A separate repo at [github.com/ivers9307-cyber/un1t-sentinel](https://github.com/ivers9307-cyber/un1t-sentinel) runs an always-on monitor for un1t-crm via GitHub Actions cron. Lives in its own Supabase project (`tpttqakxmyxrwnqjepfm`) so a CRM outage doesn't blind the watcher.

**Phase 1 (deterministic watchers, every 5 / 30 min):** pings `/api/cron/health-check`, the latest Vercel deployment status, the Supabase advisor, Twilio undelivered ratio + balance, Postmark bounce + complaint rate, Revolut order-status mix + orphan pending. Writes signals to a `signals` table; non-`ok` signals get an email via Postmark, deduped by per-fingerprint cooldown (warn 4h / error 1h / critical 15m).

**Phase 2 (Claude-driven investigation, every 5 min):** picks unprocessed `error` + `critical` signals, asks Claude Sonnet 4.6 to form a root-cause hypothesis using a strictly-read-only toolset: Vercel runtime logs, Vercel deployments, GitHub commits, GitHub repo file read, Supabase whitelisted-table reads, cron heartbeats. Writes one `incidents` row per investigation with the structured output (summary, root cause, evidence, suggested action, confidence, urgency) plus a token-cost audit trail. Sends an enriched email replacing the raw watcher email.

**Caveat — `warn` is intentionally NOT investigated** (as of 2026-05-05). Phase 2 ships investigating only `error` + `critical` to keep token spend bounded during the rollout. Most warns are noise that the cooldown system handles fine. To widen the net later: edit `SEVERITIES_INVESTIGATED` in `src/lib/investigator.js` in the sentinel repo. Token cost on Sonnet 4.6 is roughly $0.05–$0.15 per investigation; deduplication by fingerprint within 4h means a flapping cron alert costs nothing on the second-through-Nth signal.

**Phase 3 (planned, not shipped):** auto-remediation under a tightly-scoped safe-list with operator approval via signed magic link in the email. The first safe-list candidates: reset stuck `contact_imports` rows, retry a failed cron tick, mark `pending` Revolut orders as `abandoned` after 24h.

**Operational notes from the un1t-crm side:**
- Sentinel reads via the CRM's `service_role` Supabase key. Adding a new table to the investigator's whitelist is a sentinel-side change in `src/lib/tools/crm-db.js` `ALLOWED_TABLES` — no CRM change needed.
- Sentinel reads files from `ivers9307-cyber/un1t-crm` via a fine-grained PAT (Contents:Read + Metadata:Read). If the repo moves or is renamed, update sentinel-side `REPO` in `src/lib/tools/github.js`.
- The `cron_heartbeats` table on the CRM project is the single source of truth for cron health — sentinel just reads it. Adding a new cron requires (a) the cron route stamping the heartbeat, (b) a row in `cron_heartbeats` with the right `expected_interval_seconds`, AND (c) optionally a sentinel-side check if it's worth alerting beyond the generic health-check ping. See "Lessons learned" above for the heartbeat-or-bust trap.

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

## Staff attendance — zero-touch via UniFi Access (mig 120)

**Status: Phase 1 shipped May 9 2026.** Auto-stamps shift arrivals from UniFi Access door-unlock webhooks. Owner / manager / master see the report at `/schedule/attendance`; staff do not (gated by the `attendance_reports` permission, default off for `staff` and `head_coach`).

### Architecture

```
UniFi Access controller (Stillorgan)
     │
     │  Alarm rule: "Door Unlocked" + All Users + All Methods
     │  POST → https://crm.un1tdublin.com/api/webhooks/unifi-access
     │  Header: X-Webhook-Token: <UNIFI_ACCESS_WEBHOOK_TOKEN>
     ▼
/api/webhooks/unifi-access
     │  1. Auth on shared secret (rotation: UNIFI_ACCESS_WEBHOOK_TOKEN_PREVIOUS)
     │  2. Iterate payload.events[]
     │  3. Resolve actor.user → profile_locations.unifi_user_id
     │  4. Match shift in ±4h window with start_time_override IS NULL
     │  5. Stamp shift_assignments.start_time_override = arrival time
     │  6. Always insert audit row to staff_attendance_events
     ▼
shift_assignments.start_time_override     staff_attendance_events
     │                                          │
     ▼                                          ▼
/schedule/attendance                       (audit trail / debugging)
  → on-time / late / no-show / pending
```

### UniFi alarm payload shape (firmware ~v3.x, observed live 2026-05-09)

This was discovered by capture, not docs. The shape is **alarm-envelope, not flat event** — earlier code that tried to parse a flat `event_type` / `actor.id` shape silently dropped every fire.

```json
{
  "alarm_id": "019e0da5-d0f3-7ec3-81c8-827431b33ecc",
  "events": [{
    "id": "access.entry.granted" | "access.unlocks.location_unlocked" | ...,
    "user": "<uuid>",                  // actor — links to profile_locations.unifi_user_id
    "device": "<uuid>" | "",           // door (empty for remote unlocks)
    "location": "<uuid>",              // UniFi internal location id (NOT our locations.id)
    "scope": { "locations": "<uuid>" },
    "time": "<iso>" | "",              // empty for remote unlocks → fall back to receipt time
    "unlock_method_text": <see method taxonomy below>
  }],
  "data": { "custom_content": "" }
}
```

**`unlock_method_text` taxonomy** (observed values, May 9-10 2026 at Stillorgan — verified live for everything below):

| Method | Semantics | Stamp? |
|---|---|---|
| `NFC` | Physical card tap on the door reader | ✅ |
| `Mobile Tap` | Phone NFC tap on the reader | ✅ |
| `Touch to Unlock` | Apple Wallet / Google Wallet hold-to-unlock | ✅ |
| `Face Unlock` | Door reader's built-in face recognition (NOT the Protect camera) | ✅ |
| `PIN` | Keypad code | ✅ |
| `Remote Unlock` | Operator pressed unlock in the desktop UniFi app or `/studio-management` UI | ❌ |
| `Mobile Button` | Operator pressed unlock in the UniFi mobile app — same conceptual action as Remote Unlock | ❌ |
| `request-to-exit device` (or `REX`) | Passive motion sensor / button on the inside of the door, fires on EXIT. Often arrives with `unifi_user_id=null` so it lands as `unknown_user` regardless | ⚠️ ambiguous |

The receiver's `REMOTE_UNLOCK_METHODS` regex matches the two operator-pressed methods (Remote Unlock + Mobile Button) so they're recorded for audit but never stamp a shift — the actor in the payload is the operator, not whoever walked through.

**Critical gotchas, all learned the hard way:**

- UniFi **reuses `alarm_id` across every fire** of the same alarm rule. A naive `dedupKey = alarm_id:index` silently drops every fire after the first. We add a 60-second receipt-time bucket to the dedup key so retries-within-a-minute dedupe but new fires don't (`${alarm_id}:${i}:${minute_bucket}`).
- The **alarm has an array of events** — process each one. The CRM iterates `events[]` rather than treating the alarm as a single event.
- `Mobile Button` looks deceptively in-person but isn't — it's the unlock button in the UniFi mobile app. Looks identical to Remote Unlock from the data plane's perspective. Initially missed in Phase 1; bitten on the May 10 morning verification when a Mobile Button event would have stamped the operator's shift if their UniFi user had been linked. Keep this in mind whenever new method strings appear: default to "don't stamp until proven in-person."
- Real card taps populate `device` (door uuid) and put one of the in-person methods in `unlock_method_text`. Verified end-to-end on May 10 morning: Mobile Tap and Face Unlock both flowed through cleanly with `match_outcome='unknown_user'` (because the morning-shift staff's UniFi users aren't linked to CRM profiles yet — link via the UnifiUserPicker in StaffForm to start auto-stamping).

### Webhook setup per location

1. Generate a long random token (`crypto.randomBytes(48).toString('base64url')`)
2. Vercel → un1t-crm → Settings → Environment Variables → Production: `UNIFI_ACCESS_WEBHOOK_TOKEN = <token>`. Redeploy after saving (Vercel doesn't pick up new env vars until next deploy).
3. UniFi Access app → Settings → Alarms → Add:
   - **Trigger**: Door Unlocked + All Users + All Methods
   - **Action**: Webhook
   - **URL**: `https://crm.un1tdublin.com/api/webhooks/unifi-access`
   - **Custom Header**: `X-Webhook-Token: <token>`
4. Tap a card on-site or remote-unlock from the app — within ~2s a row lands in `staff_attendance_events`.

### Linking staff to UniFi users

Each staff member needs `profile_locations.unifi_user_id` set per location, otherwise the webhook lands as `match_outcome='unknown_user'` and shifts never auto-stamp. Two paths:

1. **Auto** (existing) — flipping the per-location Door Access toggle in StaffForm runs `findOrCreateUnifiUser(cfg, profile)`, which finds the UniFi user by email or creates one. Works when the email on UniFi matches the CRM email, which it often doesn't (cards registered under personal not work emails).
2. **Manual picker** (new — `UnifiUserPicker` in StaffForm.jsx) — owner / manager / master picks the right UniFi user from a dropdown per location. Lazy-fetches from `GET /api/locations/[id]/unifi-users`. Sends `unifi_user_id` in the assignment payload to PUT /api/staff/[id], which honours the explicit value over the auto-create path (`skipFindOrCreate=true`).

### Match-outcome buckets (`staff_attendance_events.match_outcome`)

| Value | Meaning |
| ----- | ------- |
| `matched` | Stamped successfully — see `matched_assignment_id` |
| `no_shift_in_window` | Staff identified, but no shift starting within ±4h at this location (this is what remote unlocks settle on too) |
| `already_stamped` | Found a candidate shift but a parallel webhook beat us to it (race-guarded via `UPDATE … IS NULL`) |
| `unknown_user` | The `event.user` UUID doesn't match any `profile_locations.unifi_user_id` at this location — link the user via the picker |
| `wrong_location` | The staff member is registered in a different studio's UniFi instance — they tapped at this controller anyway |

For "I expected to be auto-stamped but wasn't", check this column to know which knob to turn.

### Files & routes

- **mig 120** `supabase/migrations/120_staff_attendance_events.sql` — table + `unifi_access` added to `webhook_events_provider_check`
- **`src/lib/staff-attendance.js`** — pure helpers: `resolveScheduledAt`, `bucketLateness`, `minutesLate`, `arrivalToTimeOnly`, `matchArrivalToShift` (27 tests)
- **`src/lib/unifi-access.js`** — `listUnifiUsers(cfg)` walks `/users/search` pagination; existing `findOrCreateUnifiUser` / `setUnifiUserPolicies` unchanged
- **`src/app/api/webhooks/unifi-access/route.js`** — receiver, alarm-envelope parser, dedup, stamp logic
- **`src/app/api/locations/[id]/unifi-users/route.js`** — lists UniFi users for the picker (owner / manager / master)
- **`src/app/api/attendance/route.js`** — owner-side report query (PostgREST embed uses `profile:profiles!profile_id` — `shift_assignments` has two FKs to profiles so disambiguation is required)
- **`src/app/schedule/attendance/page.js`** + **`src/components/AttendanceReportClient.jsx`** — the report UI (date range, status filter, CSV export)
- **`src/components/StaffForm.jsx`** — `UnifiUserPicker` subcomponent at the bottom of the file

### Resume notes

- **Pending: on-site card-tap smoke test (task #407)** — need a real NFC unlock at Stillorgan to confirm `event.id` for in-person taps matches `UNLOCK_EVENT_RE`. The remote-unlock path (`access.unlocks.location_unlocked`) is verified end-to-end. The regex `/access\.(entry|door|unlocks?)\.|door\.unlocked|entry\.(granted|success)/i` should catch real taps but won't be confirmed until a card actually fires.
- Only Stillorgan has UniFi Access today. Hatch Street will follow when the keys arrive — same runbook, new token can stay shared (the receiver fingerprints location from `locations.settings.unifi.host` matching the only-one-configured fallback today; multi-location will need a controller_id mapping).
- Richard's UniFi user `061ed911-2ca5-4bdf-bd44-614d3bd79dda` is manually linked to his CRM profile at Stillorgan. Other staff are unlinked — they need someone to click through the picker on each profile (or wait for the owner-driven onboarding pass).

### Phase 2 — UniFi Protect face-recognition (mig 142)

**Status: shipped May 12 2026.** Sibling pipeline to Phase 1 — when a Protect camera matches a staff member's enrolled face at the gym door, we auto-stamp their shift the same way Access card-taps do. Both receivers are co-equal: whichever fires first wins the stamp; the loser writes an `already_stamped` audit row pointing at the same matched_assignment_id. Defence in depth: tailgate detection (Protect fires, Access doesn't), card-reader fallback (Access broken, Protect still stamps), audit corroboration (both fire → high confidence).

```
Protect camera → Smart Detection → Alarm Manager → POST /api/webhooks/unifi-protect
                                                        │  X-Webhook-Token: <UNIFI_PROTECT_WEBHOOK_TOKEN>
                                                        ▼
                                                   1. Verify token
                                                   2. Resolve location by Protect host
                                                   3. Extract face_id (best-effort across firmwares)
                                                   4. profile_locations.protect_face_id → profile_id
                                                   5. matchArrivalToShift (shared with Access)
                                                   6. UPDATE shift_assignments WHERE start_time_override IS NULL
                                                   7. INSERT staff_attendance_events (source='protect')
```

**Key files:**
- `src/app/api/webhooks/unifi-protect/route.js` — receiver
- `src/lib/unifi-protect.js` — config + face-library client
- `ProtectFacePicker` in `src/components/StaffForm.jsx` — per-location picker (dropdown if Protect API reachable, else free-text fallback)
- `/api/locations/[id]/protect-faces` — backs the picker
- `profile_locations.protect_face_id` — the mapping (mig 142)
- `/schedule/attendance` Source column + Tailgates panel (P2.6/P2.7)

**Operator setup runbook:** `docs/unifi-protect-setup.md` covers prerequisites (AI Key, camera positioning, face enrolment), CRM-side config (`locations.settings.unifi_protect`), Alarm Manager wire-up, picker workflow, and end-to-end verification.

**Resume notes:**
- Receiver was dark-launched at mig 121 (P2.1) — every Protect alarm landed as `unknown_user` until mig 142 + the wire-up.
- The face_id field on the event payload is undocumented per-firmware. The receiver tries: `metadata.recognition_id`, `metadata.recognition.id`, `smartDetectFaceID`, `face_id`, `faceId`. Add more paths to that switch as new Protect versions surface different shapes.
- Faces enrolled in Protect but not linked in CRM appear in the Tailgates panel — operator action is to open the staff profile and use the Protect face picker. The picker degrades to manual text entry when the Protect API can't be reached, so the operator can always paste a face id directly from UniFi.

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

## Events (race + workshop + seminar + open_day + masterclass)

Was titled "Teams + race events" until the events expansion (mig 122 + commits 728bced…f22a360). Same `race_events` table on disk; the table now holds any kind of standalone event via the `kind` discriminator column. URL space is `/events/*` operator and `/event/[slug]` public; the legacy `/races/*` and `/race/[slug]` URLs forever-rewrite to the new paths so externally shared signup links keep working.

Three migrations form the current architecture:
- **Mig 081** introduced `teams` + `team_members` (kept) and shoehorned race tracking into the booking flow (`event_types.is_timed_event`, `bookings.race_started_at`, etc — all DEPRECATED in mig 082, see below).
- **Mig 082** unmerged race events into a standalone first-class entity. Race events got their own table, URL space, and signup widget — independent of the Calendly-style booking flow.
- **Mig 122** added the `kind` discriminator to `race_events`, turning it into a multi-kind events table. App-level UI gates on `kind` to show / hide race-specific bits (waves, race-day control panel, TV display); the underlying data shape (waves[], team_members per-seat capture, race_payments, member/non-member pricing) is uniform across kinds.

The deprecated mig 081 columns stay on disk per the codebase convention. The table is intentionally NOT renamed `events` — see the architectural decision in the events-expansion commits: a rename would cascade through every FK / RLS policy / sequence-step source_type reference, which isn't worth the churn.

### Kind capability matrix

| Capability                          | race | workshop / seminar / open_day / masterclass |
|-------------------------------------|------|---------------------------------------------|
| Per-seat name + email capture       | ✅   | ✅ (every seat — solo, +1 friend, group)    |
| Member vs non-member pricing (mig 084) | ✅   | ✅ (same code path)                         |
| Revolut Race payment pipeline        | ✅   | ✅ (same code path)                         |
| Single time slot                    | n/a  | ✅ (auto-becomes one synthetic wave)        |
| Multiple waves with capacity         | ✅   | ❌                                          |
| Team name required                   | ✅   | ❌ (synthesised from captain on submit)     |
| Race-day control panel + start/finish/reset timing | ✅ | ❌ (page redirects, API 4xx) |
| Race-timing cron (race.starts_in_24h etc) | ✅ | ❌ (cron filtered to kind='race') |
| TV display board                     | ✅   | ❌ (API 404s, no operator link)             |

Adding a new kind: one CHECK-constraint value in mig 122 + one entry in `KINDS` (RaceEventForm) + one entry in `KIND_COPY` (RaceSignupWidget) + one entry in `KIND_BADGE` (events index page).

### Schema (current)

- **`teams`** (mig 081, kept) — per-location, persistent across events. UNIQUE `(location_id, name)` so a returning team booking with the same name auto-links to the same row. Carries `size`, `captain_contact_id`, `notes`. The persistence is the point — leaderboards / "best time across N events" need the team_id link. For non-race kinds, the team row exists but is essentially a registration grouping (synthesised name on signup); the FK is satisfied without changing the registration storage path.
- **`team_members`** (mig 081, kept) — captain row has `contact_id` set; non-captain members have name+email captured via the signup form with `contact_id = NULL`. Per-seat capture for ALL kinds.
- **`race_events`** (mig 082, multi-kind from mig 122) — one row per event occurrence. Per-location. UNIQUE `(location_id, slug)`. Carries `name, slug, race_date, start_time, registration_opens_at, registration_closes_at, capacity, allowed_team_sizes (INT[]), description, active, kind`. No relation to `event_types` — completely standalone.
- **`race_registrations`** (mig 082, extended in 083) — one row per (race_event, team) with UNIQUE constraint preventing double-registration. Carries `status, race_started_at, race_finished_at, registered_at`. **`wave_id`** added in mig 083 — FK to race_waves, nullable at the schema level so race-event delete can cascade-set-null but required by app code at signup time. For non-race kinds, `race_started_at` / `race_finished_at` stay NULL forever (the API gates on kind='race' so they're never written).
- **`race_waves`** (mig 083) — one row per start-time slot in a race. Carries `start_time, capacity, label, display_order`. UNIQUE `(race_event_id, start_time)` so two waves can't share a start time. For non-race kinds, exactly one wave is auto-created on submit from the form's "Start time" + "Capacity" inputs (the wave is essentially the event's time slot).

### Operator UI

- **`/events`** — index of events at the active location. Sidebar entry "Events" gated on the `races` permission key (kept internally — gates UI for the entire multi-kind feature; renaming the key would cascade to every per-role default + every location's saved overrides). Each row shows a kind pill (race=emerald, workshop=sky, seminar=indigo, open_day=amber, masterclass=pink) so kinds visually distinguish at a glance. Race-only "Race day" link is hidden for non-race kinds; "Teams" → "Attendees" for non-race kinds.
- **`/events/new`** + **`/events/[id]/edit`** — `<RaceEventForm>` (filename keeps the Race prefix — file path matches import sites; only operator-facing UI says "Event"). Kind picker at the top (5 cards: race, workshop, seminar, open_day, masterclass). Race kind shows the original waves UI + TV display logos section; non-race kinds show a single "Start time" + "Capacity" input pair and hide TV logos. Group-size selector relabels "n-person" → "n-seat" for non-race kinds. The `KINDS` metadata table at the top of the file drives all per-kind labels + flags (`showWaves`, `showLogos`).
- **`/events/[id]/control`** — race-day operator UI. Race-only — page redirects to `/events/[id]/edit` if `kind != 'race'`. `<RaceControlPanel>` polls `/api/events/[id]/control-board` every 2s. Three sections: On Course (sorted longest-on-course first, the most-likely-next-finisher heuristic), Next Up (registration order), Completed (fastest first leaderboard view). Live elapsed timer ticks at 500ms.

### Public signup

- **`/event/[slug]`** — standalone public signup page (operator and shared externally). `<RaceSignupWidget>` is kind-aware (filename keeps the Race prefix for the same reason as RaceEventForm). For race kind: original team-first signup (team name + size radio + wave picker + N-1 member name+email pairs + captain contact details). For non-race kinds: hide team name + wave picker (single auto-selected wave); "Team size" → "How many seats?" / "How many spots?"; per-seat capture still renders for N>1. The `KIND_COPY` map at the top of the file holds every kind-keyed string. Validates the registration window state (`not_yet_open` / `open` / `closed` / `full`) from the public events API. Confirmation card after success.

**Public/operator capacity split.** The public events API (`/api/public/events/[slug]`) deliberately strips raw capacity numbers from its response — neither event-level capacity nor per-wave `remaining_capacity` are ever exposed to public callers. Each wave object only carries `is_full: boolean`. The widget renders "Full" next to a wave card when `is_full`, nothing otherwise (clickability implies availability). Operator surfaces (`/events` index showing "X / Y signups", `<RaceEventForm>` with numeric capacity inputs) go through the auth-gated `/api/events` endpoints which DO return raw capacity. Customers see "is this slot bookable" — operators see the actual numbers.

### API surface

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/events` | GET | manager+ | List events at location(s) |
| `/api/events` | POST | manager+ | Create event (CreateSchema accepts `kind`, default 'race') |
| `/api/events/[id]` | GET | manager+ | Read one event + registrations |
| `/api/events/[id]` | PUT | manager+ | Update event fields (kind NOT accepted on update — locked after creation to prevent orphaning data) |
| `/api/events/[id]` | DELETE | manager+ | Soft-delete (active=false) |
| `/api/events/[id]/control-board` | GET | manager+ | Race-day polling endpoint (404 if `kind != 'race'`) |
| `/api/registrations/[id]/race-start` | POST | manager+ | Stamp `race_started_at = NOW()` (409 if `kind != 'race'`) |
| `/api/registrations/[id]/race-finish` | POST | manager+ | Stamp `race_finished_at = NOW()` (409 if `kind != 'race'`) |
| `/api/registrations/[id]/race-reset` | POST | manager+ | Clear both timestamps (409 if `kind != 'race'`) |
| `/api/public/events/[slug]` | GET | public | Event details + capacity state (returns `kind` so widget renders correctly) |
| `/api/public/events/[slug]/register` | POST | public, rate-limited | Signup (kind-agnostic) |
| `/api/public/events/[slug]/display` | GET | public | TV display board data (404 if `kind != 'race'`) |

Legacy `/api/races/*`, `/api/public/races/*`, `/race/[slug]`, `/race-pay/[paymentId]` and `/races` URLs are alive forever via Next.js rewrites in `next.config.js`. Operator emails / shared QR codes / calendar invites that pre-date the events expansion keep working.

Race-only routes deliberately NOT renamed: `/api/cron/race-timing-events` (Vercel cron config + race-specific by definition), `/api/registrations/[id]/race-{start,finish,reset}` (race-day timing — gates internally on kind), `/api/webhooks/revolut/race-payments` (Revolut's webhook URL is configured against this exact path, renaming = friction without benefit).

### Public-signup flow internals

`POST /api/public/events/[slug]/register` does, in order: validate body shape, check event active + registration window + capacity, find-or-create the captain contact by `(location_id, lower(email))`, find-or-create the team by `(location_id, name)` updating size/captain on conflict, refresh `team_members` (clear + re-insert captain + N−1 others), insert the `race_registration`. UNIQUE `(race_event_id, team_id)` surfaces double-registration as a clean 409 with `code: 'already_registered'`. Capacity is soft-enforced (count vs configured) — concurrent signups could in theory both squeeze in over the cap; acceptable for v1.

For non-race kinds, the widget client-side synthesises a `team_name` from the captain (e.g., `"Richard"` for solo or `"Richard (+3)"` for a group buy) before POSTing — the server is indifferent. team_name is stored as-is so the operator's "teams" tab on the event detail page shows something meaningful.

### Race members + per-head pricing (mig 084)

Per-head pricing for races, with live UN1T-member validation and a brand-new payment table that stays separate from the cars deposit flow.

- **Schema** — `race_events` gets `member_pricing_enabled BOOLEAN`, `member_fee_cents INT NULL`, `non_member_fee_cents INT NULL`, `members_only BOOLEAN`, `payment_currency TEXT DEFAULT 'EUR'`. `team_members` gets `is_member`, `member_validation_status` (`not_applicable`/`pending`/`verified`/`failed`), `member_contact_id`, `member_validated_at`. `race_registrations` gets `team_composition` (`all_members`/`mixed`/`all_non_members`) plus `active_payment_id` and a `pending_payment` status state.
- **`race_payments`** — NEW standalone table. Carries `race_event_id`, `race_registration_id`, captain contact details, `amount_cents`, `currency`, per-team breakdown columns (`member_count`, `non_member_count`, `member_fee_cents`, `non_member_fee_cents`), lifecycle status (`pending`/`completed`/`failed`/`abandoned`/`refunded`), `payment_provider` (default `revolut`), `payment_provider_ref` (Revolut order id), `payment_checkout_token`, all the `*_at` timestamps including `confirmation_email_sent_at` + `confirmation_sms_sent_at` (idempotency stamps), and a `metadata` JSONB for future analytics. **Deliberately separate from `cars.deposit_*`** — UN1T (gym + races) and CCF Autos (cars) are different businesses. Phase 2 will generalise this into a polymorphic `orders` table; the column shape was chosen to make that future migration a renamed-table operation.
- **Pricing model** — per-head. A 4-person team with 2 verified members + 2 non-members pays `2 × member_fee + 2 × non_member_fee`. `null` fees mean free entry for that category. `members_only=true` blocks any team containing an unverified member at signup time (server-side gate; client-side UX hint).
- **Member match key** — email only. The signup form shows a prominent amber notice telling members to use the email on their UN1T account. Match is `(location_id, lower(email))` against `contacts` where `pipeline_stage_slug = 'active_member'` (CLASSIFY.2 — was `lead_status = 'member'`). Same response shape regardless of whether the email is unknown or known-but-not-a-member, so the public endpoint can't be used to enumerate contacts.
- **Lib helpers** — `src/lib/member-validation.js` exports `validateMemberByEmail`, `validateTeamRoster`, and pure `computeTeamPricing` (heavily unit-tested — pricing is what operators trust to bill correctly). `src/lib/race-payments.js` owns `createRacePayment` (free entry skips Revolut entirely; paid entry creates the order using `registration.id` as the idempotency key), `markRacePaymentStatus` (idempotent webhook-driven state changes), and `refreshRacePaymentFromProvider` (live-refresh on the public status read so the front-end gets the answer even if the webhook is slow). `src/lib/race-confirmations.js` is UN1T-branded email + SMS, deliberately not sharing copy or templates with `booking-confirmations.js` or `deposit-receipts.js`.
- **Webhook split** — `/api/webhooks/revolut/race-payments` is a SECOND webhook URL configured in the Revolut dashboard. Verifies its own signature (shares `REVOLUT_WEBHOOK_SECRET` with cars in v1; can split later via `REVOLUT_RACE_WEBHOOK_SECRET`). The cars handler at `/api/webhooks/revolut` doesn't change — it stays cars-only and returns `{skipped: 'unknown_order'}` if a misrouted race webhook hits it.
- **Public flow** — captain fills the form → `/api/public/races/[slug]/register` validates the roster, computes pricing, creates the registration in `pending_payment`, calls `createRacePayment`, returns `{ payment: { id, free, token, url } }`. Free → push to `/race/[slug]/confirmed`. Paid → push to `/race-pay/[paymentId]` which mounts Revolut Embedded Checkout against the existing order token. On success → `/race/[slug]/confirmed?registration=...` polls the registration until the webhook flips it to `confirmed` (~2s in practice).
- **Revolut SDK separation** — the generic `src/lib/revolut.js` HTTP client is the only shared piece (it's pure transport). The cars deposit page and the new `RaceCheckoutPage.jsx` each own their own SDK lifecycle — no shared component.
- **Email lookup is a high-volume keystroke endpoint** — `/api/public/races/[slug]/check-member` is rate-limited at 60/min/IP and short-circuits when the race has no member-relevant config (no `member_pricing_enabled` AND no `members_only`).

### What's deferred to Phase 2 / v3

- **Orders tab + events/tags for retargeting.** Generic `orders` table that rolls up race_payments + cars deposits + future memberships, with retry-detection (failed/abandoned → completed within N days = "recovered"). `contact_events` log + `contact_tags` for time-based retargeting (race.starts_in_24h, race.completed_24h_ago, etc). Detailed plan in the deployment outline thread.
- **Cross-location member match.** v1 scopes member lookup to the race's location only — a Cork member registering for a Dublin race won't auto-verify even if both gyms are in the same org.
- **Refunds for cancelled registrations** — `refundOrder()` exists in `src/lib/revolut.js`; needs a wired-up operator UI + state transition.
- Email customer their result — straightforward Postmark template once race_registration timing exists; iterate `team_members[*].email` for recipients.
- Public leaderboard / results page (`/race/[slug]/results`).
- Hard capacity enforcement via UNIQUE constraint or trigger (current is soft).
- Returning-team badge in the race-day UI ("3rd time at this event").
- Realtime sync via Supabase Realtime instead of 2s polling.
- Auto-promoting non-captain members to standalone CRM contacts.

### Architectural note: why the unmerge

Mig 081 tried to layer race tracking on top of event_types/bookings via an `is_timed_event` flag + extra columns. The booking widget rendered team fields conditionally, slot generation produced calendar slots that don't match a "race runs once on Saturday" reality, and `max_advance_days` accidentally hid race signup pages until ~3 days before the event. The clunkiness was structural — a Calendly-style "pick a slot from recurring availability" abstraction is the wrong shape for "register your team for the event next month, capacity 12." Mig 082 separates the two concerns into independent tables and URL spaces; the booking flow goes back to being clean, races get to be themselves.

## Roadmap & backlog

Mirror of the Cowork task list — kept here as the durable record so that a fresh session has the context even when the task list is cleared. Add new ideas as they come up; mark items as done with the corresponding commit/migration when shipped.

### Done (latest first)

| # | Item | Notes |
|---|------|-------|
| 160 | SETTINGS.4 — Team Members behind a searchable index page | The Team Members table inline on `/settings` was growing long (currently 30+ rows; not a huge dataset but enough to dominate the page). Moved the table to a new `/settings/staff` index with a client-side search box (matches name, email, role label, location names) and a 3-way status filter pill (`All` / `Active` / `Inactive`). `/settings` itself now shows a compact "View team" link card with just the count, leaving the Add Staff CTA next to the section header for the most common action. New `StaffSearchableList.jsx` client component holds the filter state + table render; the new server-rendered `app/settings/staff/page.js` fetches the full list + pre-computes each row's `canEdit` boolean (via `canEditStaffMember`) so the client doesn't need to know about the master/owner peer rules. `/settings/page.js` now uses `head: true, count: 'exact'` for the badge so it doesn't drag 30+ rows + `profile_locations` joins just to render a number. Tests 1713/1713 still green. |
| 159 | SETTINGS.3 — Reorganize top-level /settings page | Top-level `/settings` page had grown an inconsistent stack of sections (per-location stuff mixed with global stuff, with duplicates). Four cleanups: **(1)** Master tools moved to the TOP (was buried mid-page). **(2)** Shift Templates + Bank Holidays sections removed — both are location-scoped data (`shift_templates.location_id`, `location_holidays.location_id`); they now live as link cards on the per-location settings page under a "Schedule" header. **(3)** Top-level Integrations section removed — Xero now lives in the per-location Integrations tab strip (SETTINGS.1), the standalone cross-location overview is gone. `/settings/integrations` URL kept as a redirect-to-`/settings` for any operator bookmarks (deletion proper is a follow-up once `/api/xero/callback` updates its return URL). **(4)** Top-level Branding section removed — it was the same `<BrandingSettings>` component already on the per-location page, just rendered without a `locationId` prop, which made it edit whichever location happened to be active. The per-location surface is the only honest place for it. Result: `/settings` is now a clean stack of Master tools → Team Members → Locations → Security. Tests 1713/1713 still green; lint + parity clean. |
| 158 | SETTINGS.2 — Twilio in Integrations + collapsible Features | Two follow-ups on the SETTINGS.1 refactor. **(1)** Moved SMS (Twilio) alpha sender ID out of `LocationForm` into a new `TwilioIntegrationTab` in the Integrations tab strip — same shape as the other integration tabs (own state, own save, validates via `validateAlphaSenderId`). Tab visible to owners + masters when SMS feature is on OR the location already has a sender ID configured. Tab order: Xero / Glofox / **Twilio (SMS)** / UniFi Access / Sensibo / BCA Submit. **(2)** `LocationFeatures` is now collapsible — wrapped the entire toggle list (35+ features across web + mobile) in a native `<details>` element, **collapsed by default**. Summary shows feature count and a chevron that rotates 90° when open via `group-open:rotate-90`. Operators usually open Features to flip one thing, not browse — collapsed default removes the scroll wall on the location settings page. Tests still 1713/1713 green; LocationForm now down to 351 LOC (from 366 after SETTINGS.1). |
| 157 | SETTINGS.1 — Tabbed Integrations section on location settings page | Per-location credential-bearing config (Xero, Glofox, UniFi Access, Sensibo, BCA Submit) extracted from the 878-line `LocationForm` + standalone `/settings/locations/[id]/bca` sub-page into a new tabbed `LocationIntegrations` container at the bottom of `/settings/locations/[id]`. **LocationForm slimmed from 878 → 366 lines** — now just Location Details + SMS (Twilio alpha sender) + Coaching Budget. **New components**: `src/components/settings/LocationIntegrations.jsx` (tab strip, `?tab=` query param for shareable URLs, status pill per tab) + 5 per-integration tab components under `src/components/settings/integrations/` (`XeroIntegrationTab` wraps existing `XeroLocationCard`; `GlofoxIntegrationTab` owns the 7-field Glofox creds + trial-membership picker; `UnifiIntegrationTab` owns the 5-field controller config, master-only; `SensiboIntegrationTab` owns api_key + pod_id + AC defaults + Load Pods helper; `BcaIntegrationTab` wraps existing `BcaSubmitSettings`). **Each tab saves its own slice** via `db.from('locations').update({ settings: {...existing, glofox: newGlofoxSlice} })` or its dedicated columns — by deliberately omitting other tabs' slices from the update, Postgres leaves them untouched, so two tabs never clobber each other's saves. **Tab visibility rule**: hidden when the corresponding feature is off at this location (BCA tab only on CCFA, Xero only when `car_processing` is on, UniFi only when `studio_management` is on AND caller is master). **BCA sub-page deleted** — `/settings/locations/[id]/bca` removed; any deep links land back at `/settings/locations/[id]?tab=bca`. **Standalone `/settings/integrations`** (Xero cross-location overview) kept untouched per the SETTINGS.1 spec — gives operators a fleet-wide view alongside the new per-location tab. Tests 1713/1713 still green; lint + parity clean. |
| 156 | SEC.2 — Clear INFO advisor flags + document SECURITY DEFINER exceptions (mig 168) | Two-part cosmetic cleanup with zero behaviour change. **(1)** Added one RESTRICTIVE `qual=false` policy named `no_anon_or_authenticated_access` to each of 5 service-role-only tables (`ac_sessions`, `contractor_invoices`, `cron_heartbeats`, `glofox_webhook_events`, `webhook_events`) — clears the `rls_enabled_no_policy` INFO lint on each. RESTRICTIVE policies are AND'd with permissive results; these tables have zero permissive policies, so the restrictive never evaluates at query time — runtime cost is unchanged. **(2)** Added `COMMENT ON FUNCTION` to `list_enabled_integrations()` + `scan_straps_for_contact()` documenting why each is permanently SECURITY DEFINER: the former redacts secrets from `service_integrations`, the latter does cross-location reads of `ble_bridges`. Both would break under SECURITY INVOKER. The advisor still flags both as `authenticated_security_definer_function_executable` — that's by design; the comments are there so future-me doesn't have to re-derive the reasoning. Final advisor state: 5 INFO → 0, 3 remaining WARN are all documented exceptions (the 2 functions above + `auth_leaked_password_protection` which is gated on Supabase Pro plan). |
| 155 | PERF.4 — Consolidate multiple_permissive_policies WARN (mig 167) | The perf advisor flagged 13 tables/cmds where two PERMISSIVE policies were both evaluated on every query — all legitimate "customer can see own data OR staff can see customer data at their location" pairs, or "master OR owner" pairs. Replaced each pair with a single permissive policy that ORs the conditions. Functionally identical, halves the per-query RLS cost. Tables touched: `contact_achievements` (SELECT), `contact_devices` (SELECT/INSERT/UPDATE/DELETE), `contact_external_integrations` (SELECT), `heart_rate_sessions` (SELECT), `strap_assignments` (SELECT), `shifts` (dropped redundant Managers-view-all — Managers-manage ALL already covers SELECT), `contracts` (SELECT 3→1, ALL 2→1), `contract_templates` (ALL 2→1), `profiles` (SELECT 3→1 — Admins-manage ALL stays for masters). Policy names renamed to per-cmd shape (`contact_devices_read` etc) so future operators reading pg_policies see structure not role split. After: zero multi-permissive groups left. service_role bypasses RLS so cron/webhook/submit unaffected. |
| 154 | SEC.1 — Address remaining Supabase security WARN advisor flags (mig 166) | Three categories of WARN cleaned up in one migration. **(1)** Pinned `search_path` to `pg_catalog, public` on 8 functions flagged by `function_search_path_mutable` (`increment_sms_broadcast_delivered`/`_undelivered`, `tg_contractor_invoices_validate_period`, `sms_broadcasts_set_updated_at`, `touch_hr_provider_connections_updated_at`, `touch_contact_devices_updated_at`, `auto_unsubscribe_classpass`, `sync_activity_done_status`) so schema-shadowing attacks can't redirect unqualified built-ins. **(2)** `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` on 6 trigger functions (`handle_booking_status_change`, `shift_assignments_mirror_to_shifts`, `shift_blocks_cleanup_legacy_shifts`, `shifts_mirror_to_assignments`, `sync_contacts_email_marketing`, `sync_contacts_pipeline_stage_slug`) + 2 service-role-only RPCs (`increment_campaign_metric`, `recalculate_campaign_stats`). Triggers still fire normally — REVOKE only blocks `/rest/v1/rpc/<name>` exposure. service_role keeps EXECUTE via its explicit grant; webhook processor + campaign sender unaffected. **(3)** Dropped `"Service role full access"` on `booking_reminder_sends` (`qual=true` + `roles=public` = same anon-grants-everything security smell PERF.1 fixed on 4 other tables). Net: security WARN count went 28 → 3. Remaining 3 are intentional documented exceptions: `list_enabled_integrations` + `scan_straps_for_contact` are legit authenticated RPCs (champ-app + integrations settings UI), and `auth_leaked_password_protection` is a Supabase dashboard toggle (HaveIBeenPwned check, needs to be enabled at Authentication → Policies). 5 INFO-level `rls_enabled_no_policy` on service-role-only tables left as cosmetic — they're intentional. |
| 153 | BCA.1 Phase 5 — CCFA domain + email + link tracking metrics | Three operator asks in one ship. **(1) Domain**: BCA's re-download URL now resolves through new `getBcaBaseUrl()` helper with fallback chain `BCA_BASE_URL → DEPOSIT_BASE_URL → NEXT_PUBLIC_APP_URL`. Set `BCA_BASE_URL=https://ccfautos.com` in Vercel env for the CCFA-branded URL the operator wants (with the domain pointed at Vercel of course); until set, falls back to `pay.ccfautos.com` (already CCFA-branded) or the CRM host. Same helper used by the submit endpoint footer + the operator-side `public_download_url` exposed on the GET endpoint. **(2) Email tracking**: flipped `TrackOpens: true` + `TrackLinks: 'HtmlAndText'` on bca-submit Postmark sends so Postmark fires Open + Click events for the pixel + link in the body. **(3) Link tracking**: replaced the public page's direct Supabase signed URLs with new `/api/public/bca/[token]/merged` and `/api/public/bca/[token]/file/[slug]` tracking-redirect endpoints that validate token + expiry, log the event, then 302 to a fresh 1h signed URL. Mig 165: adds 18 metric columns to `car_bca_submissions` (delivered_at, first/last_opened_at, open_count, click_count, bounce_type/description, complaint_at, first/last_viewed_at, view_count, first/last_merged_download_at, merged_download_count, last_postmark_event_at, delivered_to) plus a new `car_bca_submission_events` audit table (event_type CHECK + ip + user_agent + raw_payload JSONB + per-submission/per-type indexes + RLS read-at-location). New `src/lib/bca-events.js` exports `findBcaSubmissionByMessageId`, `recordBcaPostmarkEvent` (insert row + rollup the right counter / first / last per RecordType), `recordBcaPageView`, `recordBcaDownload`, `getBcaFileDownloadCounts`, `getClientIp` helper. `postmark-webhook-processor.js` extended with an early-return shortcut on `body.Tag === 'bca-submit'` — if the message_id matches a `car_bca_submissions` row, route into `recordBcaPostmarkEvent` and return; otherwise fall through to the marketing handlers as before. Public page `/bca/[token]` now records a page_view server-side on every render (best-effort, never blocks the render) and routes file downloads through the tracking endpoints. `BcaSubmitCard` adds a new `BcaMetricStrip` component that renders chips for delivered / opened (N×) / clicked (N×) / bounced / spam-complaint / page-viewed / merged-downloaded; appears at the top of the card on the active submission (above the slot grid) AND per-row in the history accordion. Empty state renders "No activity yet from BCA" so the operator knows tracking is wired even before the recipient interacts. Tests: 1713/1713 green; lint + parity clean. **Operator note**: a Postmark webhook for the broadcast stream's Open + Click event types must be enabled in the Postmark dashboard if it isn't already (most existing accounts already have Delivery + Bounce + SpamComplaint webhooks configured from the campaign work; add Open + Click if not). |
| 152 | BCA.1 Phase 4 — 60-day public re-download page for BCA recipients | Operator-driven addition: BCA's email recipient occasionally can't open the attached merged PDF (corporate mail server strips, attachment corrupts, gets lost). New per-submission public page at `/bca/<token>` lets them re-download the merged PDF + each source file individually for 60 days, no auth required, no operator action needed. Mig 164: adds `download_token TEXT` + `download_expires_at TIMESTAMPTZ` to `car_bca_submissions` with a partial UNIQUE index on token (NULL OK for pre-Phase-4 rows; prod had 0 rows at ship time so no backfill). Submit endpoint mints 24-byte URL-safe base64 token (~190 bits entropy, infeasible to guess) at INSERT, sets expires_at = submitted_at + 60d, and auto-appends a footer to the email body via new `appendBcaDownloadFooter(body, url)` helper ("Need to re-download? Available individually for 60 days at: …"). New helpers in `src/lib/bca.js`: `buildBcaDownloadUrl(token, baseUrl)` (strips trailing slashes), `appendBcaDownloadFooter` (normalises trailing-newline body so the separator is always one blank line), `BCA_DOWNLOAD_WINDOW_DAYS` constant. Public page `/bca/[token]/page.js` is server-rendered with `createServerClient()` (service-role, RLS-bypassed; trust boundary is the token itself), reads the submission + joined cars/locations/company_settings for per-location branding (logo + favicon + tab title), mints fresh 1h Supabase signed URLs for the merged PDF + each source doc at render time, renders three states: 404 (unknown / superseded token), Expired (past download_expires_at — shows "ask the sender to resubmit"), or the happy path (claim header + hero "Download merged PDF" button + per-doc list with size/filename/Download link). GET `/api/cars/[id]/bca` now returns `public_download_url` + `download_expires_at` per submission row; `BcaSubmitCard` history accordion adds a "Public link (exp YYYY-MM-DD)" anchor next to the Download merged PDF anchor so the operator can forward the URL to BCA on request without re-opening their email. 8 new unit tests in `bca.test.js` cover the URL builder + footer normaliser + the 60-day constant. Full suite 1713/1713 green; lint + parity clean. **Security note worth keeping in mind:** the public page exposes whatever's in the 10 source docs (V5C scans, customer addresses, VINs, etc.) to anyone who has the URL. 190-bit token entropy makes guessing infeasible, but operators should treat the URL itself as moderately sensitive (don't post it on a public Slack channel etc.). Auto-expiry after 60 days bounds the risk window. |
| 151 | BCA.1 Phase 3 — completion gate wired on Mark completed | `completionGaps(car, opts)` now takes a second `opts` arg with `bcaEnabled` + `hasActiveBcaSubmission` booleans (both default false so every pre-Phase-3 caller stays unchanged). When `bcaEnabled` is true at the car's location AND there's no active non-error submission, the function appends "BCA pack submitted to claim UK VAT" to the gaps list — placed last so the operator fixes upstream items (buyer details / Xero invoice / VAT refund / required docs) first. Failed submissions (`postmark_error_code` populated) and in-flight ones (no `postmark_message_id`, no error) both fail the gate; the operator has to resubmit successfully. **Server-side**: `/api/cars/[id]/promote` now resolves the same two facts via a parallel pair of queries (`locations.features` + `count(car_bca_submissions) WHERE superseded_at IS NULL AND postmark_message_id IS NOT NULL`) before calling `completionGaps`. UI was already mirroring server-side via `completionGaps` in `CarDetail.jsx`; both fed by the same opts now. **Client refresh**: `BcaSubmitCard` calls `router.refresh()` after a successful submit so the server-rendered `hasActiveBcaSubmission` re-evaluates and "Mark completed" unblocks without a manual reload. 4 new unit tests cover the gate matrix (off / on-no-submission / on-with-submission / ordering vs other gaps); full suite 1705/1705 green. `BCA.1` is now operationally complete: CCFA cars can't transition `pending → completed` without an active BCA submission, with the same check in both the UI and the API. |
| 150 | BCA.1 Phase 2 — submit endpoint + merge/compress + history UI | The submit pipeline goes live. New deps: `pdf-lib` (^1.17) for PDF construction, `sharp` (^0.34) for image compression (both run on Vercel's Node runtime — sharp ships precompiled binaries). New `src/lib/bca-merge.js` exports `mergeAndCompressBcaPack(sources)` → merged PDF Buffer: PDFs are copied page-for-page into the merged doc (`PDFDocument.copyPages`); JPG/PNG/WebP are pre-compressed via sharp (rotate-EXIF then resize-fit max 2000px then JPEG Q80 mozjpeg, EXIF stripped) then embedded as A4 pages with a small slot-label header (`{slug.toUpperCase()} — {label}` in 9pt Helvetica grey at the top, image aspect-fit-centred in the remaining area). 10 unit tests build real fixtures via sharp+pdf-lib in memory (no external assets), cover empty/mixed/big-image/corrupt/encrypted-PDF cases. **New endpoint `POST /api/cars/[id]/bca/submit`:** validates car_processing perm + location, validates `send_from`/`send_to` are set in config (422 with config-page hint if not), lists staging, validates one file per configured slot (422 with missing_slugs[] if not), mints a `submissionId` UUID for the storage prefix, downloads + copies each staged file to `{location_id}/{car_id}/{submission_id}/{slug}.{ext}` (frozen audit copies, never overwritten), runs the merge, **enforces the 10 MB Postmark attachment cap** post-merge with a per-slot size breakdown when over, uploads the merged PDF to `{prefix}/merged.pdf`, renders subject + body templates against the car row, INSERTs the submission row with `documents` JSONB snapshot + `merged_pdf_path` + `merged_pdf_size`, calls Postmark `/email` with `Tag: 'bca-submit'` + `Cc: config.cc` (when set) + single PDF attachment named `BCA_<reg-or-vin>_<short-id>.pdf`, on success stamps `postmark_message_id` + supersedes any previous active (non-superseded, non-error) submission for the same car in a single update, on failure stamps `postmark_error_code` + `postmark_error_msg` and returns 502 with the Postmark error message (the row stays for audit — the merged PDF in storage is still a valid artefact). The `cc` field is currently appended to the `email_body` snapshot column rather than a dedicated column — JSONB-light shape for v1; add an `email_cc` column later if we end up querying it. **GET `/api/cars/[id]/bca` now returns real submissions** (was Phase 1 placeholder), ordered newest-first, each with a short-lived signed URL for the merged PDF. **`BcaSubmitCard.jsx`** wires Submit live: confirm-dialog → spinner → success banner with attachment name + size + message-id → submissions accordion auto-opens. New status pills per submission row (Active / Superseded / Failed / Pending). Resubmit reuses the same Submit button labelled "Resubmit to BCA" once an active submission exists. Existing CCFA bounce/spam-complaint webhooks tagged `bca-submit` flow through the existing process-postmark-webhooks queue + handler with no special handling — `.update().eq()` matches 0 rows (no email_sends / campaign_recipients with the bca-submit message_id) and the tagged events are recorded in Postmark's own dashboard. Future Phase 2.1 can extend the webhook processor to recognise `Tag === 'bca-submit'` and update the submission row's status. **Phase 3 (next)** wires `completionGaps()` to refuse `Mark completed` until an active non-error submission exists. Tests: 1701/1701 green (+10 in `bca-merge.test.js`) in UTC + Dublin + LA + Tokyo; lint + parity clean. Lesson at the bottom about the merge-PDF-attach pattern. |
| 149 | BCA.1 Phase 1.1 — CC field + variable doc count in BCA settings | Two settings refinements ahead of Phase 2. **(1)** Added optional `cc` field to the per-location `bca_config` for cases where the Postmark send-from is a send-only sender (no inbox) — CC copy lands in a human-monitorable mailbox so the operator can confirm BCA received the pack. Empty string = no CC line. Validated alongside send_from/send_to in `validateBcaConfig`; merged with empty default in `getBcaConfig`. Wired into the BCA card subtitle on the car detail page. **(2)** Relaxed the documents array from "exactly 10" to "1..20" via new `MIN_BCA_DOCUMENTS`/`MAX_BCA_DOCUMENTS` constants — operator can now add or remove slots in settings (× per row, + Add document slot button below the list) without a deploy. New `nextBcaSlotSlug(currentDocuments)` helper allocates slugs deterministically — walks doc_01..doc_99 and returns the first unused; removing a slot from the middle and re-adding gives back the same slug (so any orphaned staged file in storage is recoverable). `BcaSubmitCard` on car detail now reads `totalSlots = config.documents.length` instead of hard-coding 10 (status pill, copy strings, Submit tooltip all dynamic). No migration needed — existing CCFA seed already has 10 slots, JSONB column accepts any shape. 14 new unit tests; full suite 1691/1691 green in UTC + Dublin + LA + Tokyo. |
| 148 | BCA.1 Phase 1 — CCFA BCA submit feature (schema + staging UI + settings) | Per-location feature for CCF Autos to file the 10-document UK VAT claim pack to BCA from inside each car's profile. Mig 163: `car_bca_submissions` table (immutable audit row per submission with `superseded_by` resubmission chain + Postmark-outcome columns + `merged_pdf_path`/`merged_pdf_size` reserved for Phase 2), `locations.bca_config` JSONB column, `bca-documents` private storage bucket (paths: `{location_id}/{car_id}/_staging/{slug}.{ext}` for staging + `{location_id}/{car_id}/{submission_id}/...` for submission-final), RLS (read at location for authenticated, all writes via service-role only), `features.bca_submit = true` flipped on for CCFA with default 10-slot placeholder config + subject/body templates seeded. New `src/lib/bca.js` exports `getBcaConfig(location)` (merges-with-defaults, returns null when flag off; opt-in default differs from `isFeatureEnabledAtLocation`'s opt-out), `validateBcaConfig()` (server- and client-side validator with field-level errors), `renderBcaTemplate()` (`{{uk_reg}}` / `{{vin}}` / `{{make}}` / `{{model}}` / `{{buyer_name}}` / `{{xero_invoice_number}}` merge tags), `BCA_STORAGE` path helpers, `DEFAULT_BCA_CONFIG` / `DEFAULT_BCA_DOCUMENTS` / `BCA_MERGE_TAGS`. Endpoints: GET/PUT `/api/locations/[id]/bca-config` (read for any user at location, write master-only via `canEditLocationFeatures`), GET `/api/cars/[id]/bca` (config + staged uploads + submission history — Phase 1 returns `[]` for the latter), POST/DELETE `/api/cars/[id]/bca/uploads/[slug]` (multipart upload to staging, 20 MB cap, PDF/JPG/PNG/WebP allowed, upsert overwrites previous file in same slot regardless of extension). UI: new `BcaSubmitCard.jsx` on car detail (renders only when `bcaEnabled` prop is true; 2-col grid of 10 slots with drag-drop + preview/replace/remove per slot, status pill (Not submitted / Ready to submit / Submitted — awaiting refund / Refunded reading from existing `uk_vat_refund_received`), Submit button disabled with "coming in Phase 2" tooltip — UX is in place so Phase 2 wiring is mechanical), new `BcaSubmitSettings.jsx` at `/settings/locations/[id]/bca` (master-only, edits send_from/send_to/subject/body + 10 doc labels with reset-per-row button, live-preview using most recent pending car at location or synthetic fallback). Card dynamic-imported so the chunk only ships when the location has the feature on. 30 new unit tests in `bca.test.js`; full suite 1677/1677 green, lint + mobile-parity clean. **Phase 2** adds `pdf-lib` + `sharp` for merge-and-compress to a single attached PDF, submit endpoint, submission history accordion, Postmark webhook tap for `bca-submit` tag. **Phase 3** wires `completionGaps()` to refuse `Mark completed` until an active non-error submission exists. Full spec at `docs/BCA_SUBMIT_spec.md`. |
| 147 | PERF.1 — Supabase perf advisor cleanup (mig 162) | Four high-impact categories in one transaction. **(1)** Wrapped `auth.uid()` in 8 RLS policies — `glofox_invoices_select`, `glofox_push_events_select`, `glofox_sync_runs_select`, `landing_page_settings_master_owner_write`, `pipeline_classification_runs_select`, `profile_compensation_insert/select/update`. Each replaces raw `auth.uid()` with `(SELECT auth.uid())` so PG evaluates it as an InitPlan once per query instead of per row — same security, materially less CPU on any select that scans more than a handful of rows. **(2)** Added 11 FK covering indexes (`activities.assignee_id`, `contact_achievements.source_session_id`, `glofox_push_events.reviewed_by`, `landing_page_settings.updated_by`, `password_overrides_audit.{location_id,target_contact_id,target_profile_id}`, `pipeline_classification_runs.created_by`, `profile_compensation.updated_by`, `strap_assignments.booking_id`, `tv_content.pushed_by`) — partial WHERE NOT NULL on the nullable ones so the index is tight. All affected tables tiny today (largest = activities at 9.5k rows / 2 MB) so plain `CREATE INDEX` ran inside the txn — no `CONCURRENTLY` needed. **(3)** Dropped 6 redundant policies: `cron_heartbeats_no_anon` + `cron_heartbeats_no_authenticated` (both PERMISSIVE with `qual=false` — functionally identical to having no policy at all since RLS denies by default; service_role bypasses), and `"Service role full access"` on `event_type_reminders` / `rosters` / `shift_assignments` / `shift_blocks` (each had `qual=true` + `roles=public` — silently granting full access to anon and authenticated on top of the in-location policies, both a security smell and a per-query perf hit). **(4)** Dropped 13 duplicate indexes (advisor flagged 19; on review 6 were genuinely different partials serving separate queries — kept those): `idx_cars_deposit_token_lookup`, `idx_company_settings_location`, `idx_contact_prefs_contact`, `idx_contact_prefs_token`, `idx_contacts_email`, `idx_contacts_glofox_id`, `idx_event_types_slug`, `idx_location_holidays_location_date`, `idx_orders_source`, `idx_race_waves_event`, `idx_tv_displays_token` (all non-unique twins of unique constraints we kept), plus `sequence_enrollments_unique_active` (full unique on (sequence_id, contact_id) already enforces single-row, partial unique on status='active' was redundant) and `sequence_enrollments_due_idx` (strict subset of `idx_enrollments_next_step`, extra NOT NULL clause is implicit in any range query on next_step_at). Skipped the 237 "unused indexes" advisor flag for a separate audit pass — "no scans since stats reset" ≠ "safe to drop". Lesson at the bottom about the auth.uid()-wrap InitPlan pattern. |
| 146 | AUTH.1 — admin password override for staff + members | Operator: "have an option to manually override the user password and reset it on their behalf." Existing flow already had a "Send password reset email" button (`/api/staff/[id]/send-password-reset` → Supabase recovery link via email) — this layers a DIRECT override on top for cases where the user is in front of you and can't access their email, or you need to lock them out immediately. Mig 161: `password_overrides_audit` table (target_user_id, target_type, target_profile_id, target_contact_id, performed_by, performed_at, location_id, reason, ip_address) — never stores the password itself, only the fact of the override. RLS: master/owner can read; service-role writes. New endpoint `POST /api/admin/password-override` (master/owner only) resolves target → `auth.users.id` (profiles.id is 1:1 with auth.users.id for staff; contacts.user_id for members — 1 of 8,146 contacts currently has one, the rest won't see the button), calls `auth.admin.updateUserById` with the new password, then `auth.admin.signOut(userId, 'global')` to kill every active session, then inserts the audit row. Random-password generator uses crypto.getRandomValues over a 16-char alphabet that drops visually-confusable pairs (0/O, 1/l/I) and shell-special chars. Returns the new password to the caller ONCE — never logged, never persisted. Shared `PasswordOverrideModal` component: two-stage flow (form → result), result screen has copy button + "I've copied it — close" as the only dismiss path; closing wipes state and the password is gone from memory. Wired into `StaffForm` (master gate, sits below the existing reset-email button) + contact detail page (master/owner gate AND `contact.user_id IS NOT NULL`). Manual passwords ≥12 chars or generator is forced — refused otherwise. **Lesson at the bottom about the auth.admin pattern.** |
| 145 | TV.1 — UC Cast Pro TV display + manual push (Phase 1) | Mig 160: `tv_displays` (one row per TV, UUID `token` is the public URL slug), `tv_content` (one row per TV with current content; UPSERT on push, DELETE on clear). Public-read `tv-content` storage bucket for uploaded images (UUID-prefixed filenames so enumeration's infeasible). RLS location-scoped on both tables. Page at `/tv/cast/[token]` (moved from `/tv/[token]` — collided with existing `/tv/[locationId]` HR live board; Next.js App Router rejects two different dynamic-segment names at the same depth). Fullscreen, no chrome, server-renders initial content + client polls `/api/public/tv/[token]/content` every 3s, swaps `<img src>` only when `pushed_at` changes (cache-busts via `?t=` so re-uploads to the same storage path refresh). Idle state (no `tv_content` row) renders UN1T mark + live wall clock + today's date — pure client-side, no API calls. Admin at `/admin/tv-displays` (master/owner/manager) registers TVs, copies the URL into UC Cast Pro's Web URL content source once, pushes images (storage upload OR external URL with optional label), clears (deletes the row → back to idle), or deletes the TV. Phase 2 (generators via `@vercel/og` — leaderboard / class poster / member welcome) + Phase 3 (schedule editor + rotation playlists driven by a cron) sit on top of this primitive — not built yet. **Why this path:** investigated UniFi Connect's API for direct content push — undocumented, no public surface, gave up. UC Cast Pro adds a Web URL content source that the basic UC Cast lacks, which unlocks the page-on-TV approach entirely. Lesson at the bottom about UC Cast Pro vs basic + the slug-collision build failure. |
| 144 | TASKS.1 — extend Tasks tab into a lightweight PM tool | Mig 159: adds `assignee_id` (FK profiles), `priority` (low/med/high/urgent), `status` (todo/in_progress/done/cancelled), `project` (free-text tag), `completed_at` to `activities`. Trigger `sync_activity_done_status` keeps the legacy `done` boolean and the new `status` enum aligned both directions so existing `ActivityToggle` + the contact-detail Add-activity form keep working unchanged (they only write `done`; trigger derives `status`). Backfill no-op (0 kind='task' rows existed). UI replaced — new `TasksPage.jsx` with view switcher (Board kanban default / List), 4 columns (To do / In progress / Done / Cancelled) with drag-drop via `@dnd-kit`, filters (assignee / project / priority), New-task modal (subject, notes, assignee, priority, due date+time, project tag with autocomplete from existing rows). Direct Supabase writes (RLS already location-scoped). `/api/tasks` + `/api/tasks/[id]` thin layer for n8n/Slack integration (`x-api-key` auth, same pattern as `/api/contacts`); writes guarded on `kind='task'` so external callers can't mutate event rows by passing their UUID. Diagnosis was the interesting part — the tab was fully built, just nobody had created a task because the only entry point was the contact-detail Add-Activity form (the page's own comment said "Phase 2 will add an Add task button"; this is that phase). Pulled from 9,536 kind='event' rows / 0 kind='task' rows. |
| 143 | UNSUB.4 — Postmark suppression backfill (one-off, then removed) | Temp admin endpoint `POST /api/admin/postmark-suppression-backfill`. Pulls the broadcast-stream suppression list from Postmark (`/message-streams/broadcast/suppressions/dump`, paged 500/call), matches by lowercase email to `contacts` where `email_marketing=true`, flips each via `applyMarketingPreferencesBulk` with source='postmark_suppression_backfill'. Idempotent (the bulk helper no-ops if already opted-out). Ran once: 36 Postmark suppressions, 23 matched contacts still opted-in, 23 flipped (the UNSUB.1→UNSUB.3 unsub-gap recovery), 0 ClassPass-skipped, 0 errors. 13 of the 36 were already opted-out on our side (UNSUB.2's hard-bounce auto-unsub) or not in contacts at all. Endpoint removed in a follow-up commit. **Lesson:** for any new "we record state X about an external system" flow, sketch a backfill / reconciliation endpoint up front — you'll need one when the integration's wrong for a while. Postmark's `/suppressions/dump` is the right source for email-side; same pattern works for Twilio (`opt_out_status`), WhatsApp Business (`subscription_status`), etc. |
| 142 | UNSUB.3 — fix `List-Unsubscribe` header pointing at the wrong URL | `sendEmail` + `sendBatch` were setting `List-Unsubscribe: <https://crm.un1t.ie/unsubscribe/TOKEN>` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. The URL pointed at `/unsubscribe/[token]/page.js` — a Next.js page route, GET-only. Gmail / Outlook / Apple Mail's built-in Unsubscribe button POSTs to that URL per RFC 8058's One-Click flow; the page route returned 405 silently. Postmark recorded the unsub on its broadcast suppression list (so subsequent sends to that address from us would be blocked at the ESP level) but our CRM never got the signal — `contact_preferences.email_marketing` stayed true, audience builder kept counting them. `/api/unsubscribe/[token]/route.js` has had a working POST handler all along: parses optional `{channels:[...]}` body, defaults to `['email_marketing']` on empty body (exactly what email-client one-click sends), flips prefs + logs to `consent_log` source='one_click_unsubscribe'. **Fix:** new helper `toListUnsubscribeUrl(pageUrl)` in `postmark.js` swaps `/unsubscribe/` → `/api/unsubscribe/`. `sendEmail` + `sendBatch` use it for the header. Body-visible auto-footer (UNSUB.1) + `{{unsubscribe_url}}` merge tag still use the friendly page URL so manual clicks land on the channel-picker page. Lesson at the bottom about `List-Unsubscribe-Post` requiring a POST-able URL — a page route won't do. |
| 141 | CAMPAIGN.13 — webhook queue + cron-paced send + schedule + cancel + delete + progress bar | Mig 158: `postmark_webhook_queue` table, `campaigns.cancel_requested_at` column, composite indexes for the new query paths, two seeded `cron_heartbeats` rows. Five operator-facing features in one ship because the architecture is shared. **(1) Webhook queue:** `/api/webhooks/postmark` slimmed to auth + dedup + 1 INSERT + return — under 50ms. Previous 3-5 sequential DB writes per event blew Vercel's lambda-concurrency limit when Postmark fired ~5000 webhooks in 20s after the "15 mins?" send ("Massive burst, 8x faster failures, no error logs, platform/validation level" Vercel alert). Drain happens in `/api/cron/process-postmark-webhooks` (every minute, 100/tick, MAX_ATTEMPTS=5). Processing logic extracted to `src/lib/postmark-webhook-processor.js` (Delivery / Open / Click / Bounce / SpamComplaint / SubscriptionChange — same semantics as UNSUB.2 + CAMPAIGN.12 inline handlers, just isolated). **(2) Cron-paced send:** `/api/campaigns/[id]/send` now flips `status='queued'` and returns; `/api/cron/run-campaigns` (every minute, max 3 campaigns/tick) ticks each queued/sending campaign through `src/lib/campaign-sender.js` `tickCampaignSend`. First tick after queue pre-populates `campaign_recipients` from the paginated audience (CAMPAIGN.11 pattern, 1000/page), flips to 'sending'. Subsequent ticks SELECT first 500 'queued' recipients, send via Postmark batch, update statuses, log email_sends, run `recalculate_campaign_stats` (mig 157) to keep the rollup correct. Final tick (no more queued) flips to 'sent'. Throughput: 500/min/campaign × 3 campaigns = 1.5k sends/min site-wide; webhook firing spreads across the window instead of bursting, queue drain at 100/min stays well under Vercel's request rate. **(3) Schedule send:** UI date+time picker writes `scheduled_at` + `status='scheduled'`; the same cron's promote-step `UPDATE WHERE status='scheduled' AND scheduled_at<=now()` picks them up. **(4) Delete + cancel:** for draft/scheduled/queued statuses, direct Supabase delete (RLS already allows operator). For sending, UI sets `cancel_requested_at`; the send cron checks the flag between chunks, transitions status='cancelled' + flips remaining queued recipients to cancelled too. **(5) Live progress bar:** `CampaignEditor.jsx` adds a `useEffect` that polls the campaign row directly via Supabase every 3s while status is queued/sending, renders `Sending X / Y` next to a Cancel button, stops polling when status leaves the sending set. Status-aware button row replaces the old single "Send Campaign" button — draft shows Schedule + Send + Delete, scheduled shows Unschedule + Delete, queued/sending shows live progress + Cancel, sent/cancelled shows read-only summary. Removed the old monolithic `sendCampaign` function in `postmark.js` (160 LOC; all callers migrated to the cron path). |
| 140 | CAMPAIGN.12 — fix campaign rollup counters (opens / clicks / bounces stuck at 0) | Mig 157: `increment_campaign_metric(p_campaign_id UUID, p_field TEXT)` (atomic `UPDATE col = COALESCE(col,0)+1` with column-name whitelist guarding against EXECUTE injection), `recalculate_campaign_stats(p_campaign_id UUID)` (single UPDATE that recomputes every counter from `email_sends` + `campaign_recipients`). Two bugs in the webhook handler had been compounding for months: **(1)** The Delivery handler called `db.rpc('increment_campaign_metric', ...)` but the RPC didn't exist; `.catch()` fired a fallback that used `db.raw('total_delivered + 1')` — `db.raw` isn't a supabase-js method (knex idiom), so `total_delivered` never moved. **(2)** Open/Click/Bounce/SpamComplaint handlers used `await db.from('campaigns').select(...).single().then(({data}) => { db.from('campaigns').update(...) })` — the **inner `.update().eq()` is never awaited**. supabase-js's filter builder only dispatches an HTTP request when its thenable is consumed, so the update never went out. `recalculate_campaign_stats` re-ran against "15 mins?" via Supabase MCP brought UI numbers in line: 2,984 sent / 170 delivered / 135 opened / 35 clicked / 14 bounced. `sendCampaign` finalize step now calls `recalculate_campaign_stats` too so totals are consistent even if individual webhooks fired out-of-order. Lesson at the bottom about both bugs. |
| 139 | UNSUB.2 — auto-unsubscribe contacts on Postmark hard bounce + spam complaint | Operator request: "implement an automation to unsubscribe everybody who returns bounced." Webhook handler at `/api/webhooks/postmark` previously set `contacts.email_status='bounced'` on hard bounce — campaign prefilter already excluded those, but `contact_preferences.email_marketing` stayed true (audience builder kept counting, and any future code path filtering only on `email_marketing` would still target them). **HardBounce:** in addition to the status flip, now calls `applyMarketingPreferencesBulk` (from `marketing-consent.js`) with source='postmark_hard_bounce' — upserts the prefs row, writes `consent_log` action='opt_out', skips ClassPass PAYG contacts (managed by the auto-unsubscribe-classpass cron from mig 151), respects the email_status reputation guard so the just-set 'bounced' value doesn't get clobbered. **SpamComplaint:** refactored from the inline implementation (which had two pre-existing bugs: `.update()` instead of `.upsert()` silently dropped contacts without a prefs row, and wrote `'opted_out'` to `consent_log.action` instead of the canonical `'opt_out'`) to use the same `applyMarketingPreferencesBulk` helper with source='postmark_spam_complaint'. Soft + transient bounces stay log-only — retryable failures don't burn opt-in. Verified 0 contacts in the inconsistent (email_status IN ('bounced','complained') AND email_marketing=true) state at apply time. |
| 138 | CAMPAIGN.11-RECOVERY — one-off resend to recipients missed by the 1000-cap | Temp `POST /api/admin/campaigns/[id]/resend-missing` (master/owner). Paginated the audience query (no 1k cap), paginated the `campaign_recipients` lookup (also bounded by 1k cap — got it too), excluded contacts already sent, dispatched via the same Postmark broadcast stream + tag as the original send, inserted recipient rows + email_sends log per success, bumped `campaigns.total_recipients`. Idempotent — re-runs skip contacts already in `campaign_recipients`. Ran successfully for "15 mins?": 1,000 originally → 3,003 total recipients (2,003 recovery sends + 14 bounces from the new batch), 2,998 email_sends rows (full audience). Endpoint removed in a follow-up commit once verified. **Pattern worth keeping:** for any send-loop that fails partway, a recovery endpoint that does "load the audience again, filter to those not yet in the recipients table, send to the diff" is a tractable shape. Will probably recur — TASKS bulk import, sequence-step backfill, etc. |
| 137 | CAMPAIGN.11 — paginate audience fetch (1000-row send cap) | Operator's first real campaign ("15 mins?") sent to 1,000 contacts when 2,998 should have received it. `sendCampaign` awaited the audience select in one shot, hitting Supabase/PostgREST's default 1,000-row max-rows cap. Downstream code (emailBatch, recipient inserts, sendBatch) only ever saw the first 1,000; the other ~2k silently fell off the floor. **Fix:** page through with `.range(from, from+999)`, looping until a short page comes back. Each iteration rebuilds the query because PostgrestFilterBuilder instances are single-use (awaiting once consumes the thenable). Tag-filter resolution re-runs per page — cheap, audiences rarely have many pages. Lesson at the bottom about Supabase's default 1000-row cap. |
| 136 | UNSUB.1 — auto-append 7pt Unsubscribe footer to every marketing email | Operator: "every marketing email gets the option to unsubscribe at the bottom of the mail by default in size 7, I don't want anybody having to remember to add it." New helpers `buildUnsubscribeUrl(contact, baseUrl)` (derives `/unsubscribe/<token>` from `contact_preferences.unsubscribe_token`, falls back to `contact.id`) + `appendUnsubscribeFooter(html, url)` (inline-styled table footer, 7pt color #888, inserted before the last `</body>` if present else appended). Wired into both marketing send paths: `sendCampaign` and `sendEmailStep` in `sequences/steps.js`. NOT wired into `sendTransactionalEmail` (booking confirmations, password reset, deposit receipts, post-class HR email, contracts, race confirmations stay footer-free). Operator spec was "always append" so the helper doesn't bother detecting an operator-placed inline `{{unsubscribe_url}}` — both render, both point at the same URL, no harm. 10 new tests cover the footer + URL-builder edge cases. |
| 135 | CAMPAIGN.10 — fix audience-count returning 0 (postgrest-js select-overload trap) | The campaign editor's "0 contacts will receive this campaign" banner has been lying since CAMPAIGN.5 first shipped — every saved filter returned 0 regardless of how many contacts actually matched. CAMPAIGN.6/7/8/9 each chased a real-but-adjacent bug (embedded-resource filter losing its binding under count-only selects); CLASSIFY.1's denormalisation removed the embedded resource entirely, and only then was the underlying trap observable. **Root cause:** postgrest-js v2 has two `.select()` overloads. `PostgrestQueryBuilder.select(columns, options)` (the FIRST select after `.from()`) reads `options.head` + `options.count`, switches method to HEAD, and adds the `Prefer: count=exact` header. `PostgrestTransformBuilder.select(columns)` (any select chained AFTER a filter like `.eq` / `.not`) accepts ONLY columns; a second argument is silently ignored — JS doesn't enforce arity. `buildAudienceQueryAsync` did `.select('*')` first, set up the filters, then `computeCount` chained `.select('id', { count:'exact', head:true })` AFTER. The options vanished, the request stayed GET, no count Prefer was sent, supabase-js parsed `count` as `null`, and `count \|\| 0` rendered 0. **Fix:** `buildAudienceQuery` + `buildAudienceQueryAsync` now accept `{ columns, selectOpts }` so callers that want a count request it on the FIRST select. `computeCount` uses `{ columns: 'id', selectOpts: { count: 'exact', head: true } }`; everything else (`sendCampaign`, etc.) defaults to `('*', undefined)` and gets rows unchanged. **Diagnostic path:** the bug looked like a RLS / service-role-key issue because direct SQL as service_role returned 3,207 but the deployed API returned 0. Verified the key was correct via jwt.io (`role: "service_role"`), then via a one-off `/api/debug-supabase` endpoint that ran the exact prefilter with a single `.select('id', { count, head })` and returned 3,207 from the same `createServerClient()`. Diff between debug endpoint (works) and `computeCount` (broken) isolated the double-select pattern. Lesson: when supabase-js returns 0 from a count query but you expect rows, check whether you're chaining `.select()` twice — only the first call reads options. |
| 134 | CLASSIFY.3 — drop `contacts.lead_status` column | Mig 156 single-transaction migration applied to prod: (1) `UPDATE email_sequences SET trigger_type='pipeline_stage_change' WHERE trigger_type='status_change'` (1 row), (2) idempotent JSONB field-name guards across `campaigns.audience_filter` / `email_sequences.audience_filter` / `whatsapp_broadcasts.audience_filter` / `sms_broadcasts.audience_filter` / `sequence_steps.config` (all 0 hits in prod — AudienceBuilder UI had already defaulted to `pipeline_stage_slug` from CLASSIFY.1 and sequence step validation rejected `lead_status` in CLASSIFY.2), (3) rewrite stale `goal_config.type='lead_status'` → `'pipeline_stage'` (0 hits), (4) `DROP INDEX idx_contacts_lead_status, idx_contacts_location_lead_status`, (5) `DROP COLUMN contacts.lead_status`. Code side: 5 mobile/ files + `shared/dashboard-data.js` swapped from `lead_status` to `pipeline_stage_slug` reads (PR #4). Pre-flight verified via `DO $$ ... RAISE EXCEPTION` rollback on prod — column gone post-drop, indexes gone, trigger row renamed, all JSONB guards no-op. 8,131 contact rows unchanged. Glofox-facing files (`glofox-sync.js`, `glofox-push.js`, `glofox.js`, `glofox` API routes, `webhooks/glofox`) intentionally retain their `lead_status` references — those read the Glofox API payload's `lead_status` field (uppercase enum: LEAD/COLD/TRIAL/MEMBER), a completely separate taxonomy from the dropped local column. |
| 133 | CLASSIFY.2 — remove every lead_status read+write from app code | Commit `2d9c966`. 50-file change. Removed `lead_status` from API schemas (ContactCreate/Update, WA add-contact, assistant create_contact), every app-code INSERT/UPDATE (contacts route, contact-import-runner, race-contact-linking, assistant chat), every read replaced with `pipeline_stage_slug` (member-validation gate now checks `'active_member'`, contact-merge survivor list, ContactMergeModal preview, SMS query selects, WA conversation queries, send-test contact lookup, /contacts ?status=, ContactsView client filter). Sequence triggers re-wired: `status_change` → `pipeline_stage_change`; `triggerSequencesForStatusChange` → `triggerSequencesForPipelineStageChange`. Scheduler `isGoalMet` accepts new `pipeline_stage` goal type with deprecated `lead_status` alias (emits `console.warn`). All 5 built-in sequence templates rewritten to PIPELINE5 slugs. UI badges (ContactsTable, DealCard, contact detail page, WAInbox header, ContactMergeModal preview) switched to `pipeline_stage_slug`. Form pickers removed: ContactForm dropdown (hint that stage is auto-derived), WAInbox Add-Contact modal select, SequenceEditor's `update_field` whitelist restricted to safe fields, WABroadcastEditor merge-var picker. `{{lead_status}}` merge tag kept as deprecated alias resolving to `pipeline_stage_slug` so existing campaign HTML still renders. **NOT touched** (intentional): Glofox-side `lead_status` field anywhere it's read FROM Glofox (`glofox-sync.js`, `glofox-push.js`, `glofox.js`, list-members + bulk-sync routes, `GlofoxImportClient`, `glofox-sync.test.js`); historical migrations + CLAUDE.md narrative; n8n workflows. **Still to do before column drop (CLASSIFY.3):** `mobile/` (5 files), `shared/dashboard-data.js`, SQL one-shot `UPDATE email_sequences SET trigger_type='pipeline_stage_change' WHERE trigger_type='status_change'`, JSONB rewrites for any production `audience_filter`/`goal_config` blobs still referencing `lead_status`, then mig 156 `DROP COLUMN`. **1634/1634 tests pass, lint clean.** |
| 132 | CLASSIFY.1 — denormalise pipeline_stage_slug + email_marketing onto contacts | Mig 155 + commit `6459592`. Adds `contacts.pipeline_stage_slug TEXT` (synced from `deals.stage_id → pipeline_stages.slug` for the most-recent open deal via `AFTER INSERT OR UPDATE OR DELETE ON deals` trigger) and `contacts.email_marketing BOOLEAN NOT NULL DEFAULT TRUE` (synced from `contact_preferences.email_marketing` via `AFTER INSERT OR UPDATE OF email_marketing ON contact_preferences` trigger). Both backfilled. Partial index on `email_marketing=true` since audiences always require opt-in. `buildAudienceQuery` + `buildAudienceQueryAsync` rewritten to filter `contacts` as a single-table query — no inner-join, no embed, no PostgREST gymnastics. Preview endpoint's `computeCount` collapses from 60 LOC of pre-fetch + .in()-pagination + URL-length-worry to 8 LOC. `AudienceBuilder` gets a "Stage" filter (9 PIPELINE5 slugs) as the primary funnel filter; lead_status removed from the UI; Glofox Status relabeled "Glofox Raw Status (advanced)". The one existing draft campaign at Stillorgan ("15 mins?") migrated in DB from `lead_status=member` to `pipeline_stage_slug=active_member` (212 emailable). Verification numbers at Stillorgan: 8,130/8,130 classified, 3,207 opted-in, 212 active_member + emailable. **The whole CAMPAIGN.6→.9 saga is structurally obsolete after this.** New "Audience classification model" section in CLAUDE.md documents the design. |
| 131 | BOOKING.1+2 — copy event.location_id on booking insert + fix UTC TZ bug in confirmation | Commit `13452dc` + mig 154. Two bugs reported on 2026-05-13. **BOOKING.1:** `/api/public/book/route.js` loaded `event.location_id` at the top of the handler (for downstream consent + Glofox push) but never copied it onto the booking insert payload. /bookings is location-scoped → Sarah's consultation invisible to the operator. One-line fix in the insert; mig 154 backfilled existing rows. **BOOKING.2:** `src/lib/booking-confirmations.js` `fmtBookingTime` did `new Date(\`${dateStr}T${timeStr}Z\`)` forcing UTC parse, then formatted in Europe/Dublin which adds +1h in BST. 17:00 booking → SMS said 18:00. Fix: don't go through Date for the clock value — derive only weekday/date label from a noon-UTC anchor (safe across timezones) and append `start_time` verbatim. Affects both SMS and email confirmation paths. Documented in Lessons learned. |
| 130 | CAMPAIGN.1→.9 — campaign editor saga | Long chain of fixes on the campaign editor and audience-count plumbing. **CAMPAIGN.1** (`f8633df`) added a "Send test" button to the editor (POST `/api/campaigns/[id]/send-test` — single-recipient render with `[TEST]` subject prefix, master/owner gate, uses the operator's own contact for personalisation with sample fallback, no campaign_recipients/email_sends rows written so test sends don't pollute metrics) and a prominent recipient-count banner on the Audience tab. **CAMPAIGN.2** (`c516aad`) fixed tab-switch wiping the Unlayer design — `exportFromUnlayer()` was assigning to local vars, never calling `setHtmlContent`/`setDesignJson`, so React state stayed at the initially-loaded value and the next mount re-loaded the iframe with stale state. Added `stashUnlayerToState()` helper called from both `handleSave` and a new `switchTab()` wrapper. Plus a visible green "Saved HH:MM" indicator (auto-clears 3s) so operators see the save register. **CAMPAIGN.3** (`2551436`) fixed Save + Send-test spinning forever from non-Design tabs — `window.unlayer.exportHtml()` callback never fires when the Unlayer iframe is unmounted (Design panel is conditionally rendered). `stashUnlayerToState` now gates on `tab === 'design'`; `exportFromUnlayer` got a 2.5s safety timeout. **CAMPAIGN.4** (`a6a4111`) fixed draft campaigns rendering as a blank page — `page.js` rendered `<CampaignDetail>` for drafts which tried to `router.replace('?edit=1')` to itself, but nothing in the codebase read `?edit=1` to mount the editor. Now `page.js` imports `CampaignEditor` and renders it directly when `status='draft'` OR `searchParams.edit==='1'`. **CAMPAIGN.5** (`ec8016c`) made the audience count POST the in-flight filter (was GET, only saw the saved filter, swallowed errors via `console.error`) and surface errors visibly with four banner states (idle/loading/ready/error). **CAMPAIGN.6** (`941d08d`) attempted to preserve the `contact_preferences!inner` join in the count select to fix PostgREST's "not an embedded resource" 400. **CAMPAIGN.7** (`d1d0f21`/`ae2da83`) added diagnostic logging then `_debug` block in the response — confirmed in-flight filter was POSTing correctly; the symptom was real (saved filter `lead_status='member'` returned 0 because no contact has that value at Stillorgan). **CAMPAIGN.8** (`cf40126`) tried preserving the full `*, contact_preferences!inner(*)` embed shape in the count select — still returned 0. **CAMPAIGN.9** (`01c9587`) bypassed embeds entirely with pre-fetch + `.in()` — hit URL-length 400s with 3k UUIDs. **All of these are obsoleted by CLASSIFY.1** which denormalised the columns so the count is a trivial single-table query. The intermediate fixes remain in the history as the trail of how we got there. |
| 127 | un1t-sentinel monitoring agent (Phase 1+2) | New separate repo at [github.com/ivers9307-cyber/un1t-sentinel](https://github.com/ivers9307-cyber/un1t-sentinel) running on a separate Supabase project (`tpttqakxmyxrwnqjepfm`). Phase 1: deterministic watchers (cron health, Vercel deployments, Supabase advisor, Twilio/Postmark/Revolut integration health) on GitHub Actions cron with email alerts via Postmark. Phase 2: Claude Sonnet 4.6 investigates every `error` + `critical` signal using a strictly-read-only toolset (Vercel runtime logs, deployments, GitHub commits, repo file read, Supabase whitelisted-table queries, cron heartbeats), writes one `incidents` row per investigation with structured output (summary, root_cause, evidence, suggested_action, confidence, urgency) plus a token-cost audit, sends an enriched email replacing the raw watcher email. **`warn` is intentionally NOT investigated for now** — kept off to bound token spend during rollout; flip back on by editing `SEVERITIES_INVESTIGATED` in `src/lib/investigator.js` when the cost envelope is well understood. Fingerprint dedupe (4h) means a flapping cron alert costs $0.05–$0.15 once, not 12× per hour. Phase 3 (auto-remediation safe-list) is planned, not shipped. The new "Sentinel monitoring agent" section above documents the operational interface from the un1t-crm side. |
| 126 | Per-location buyer-facing branding | `pay.ccfautos.com/deposit/<token>` now follows the car's location for branding instead of inheriting the global UN1T favicon. CCF Autos cars surface CCF Autos logo + favicon + tab title; UN1T cars (rare today, but possible) keep UN1T's. `BrandingSettings.jsx` now accepts an explicit `locationId` prop (falls back to `user.activeLocation.id`); `/settings/locations/[id]` mounts a Branding section under each location's edit page so a master can upload CCF branding from a UN1T-active session without it clobbering their own tab favicon — the live browser-favicon update is gated on the prop matching the active location. `/api/public/deposit/[token]` joins through `cars → locations → company_settings` and returns `branding: { logo_url, company_name }`; `CarDepositPage.jsx` renders the logo above the heading and prefixes the H1 with the company name. The deposit page route gets a server-side `generateMetadata({ params })` doing the same lookup so favicon + tab title render correctly on first paint with no client-side flash. Falls through to the root layout's UN1T metadata on any DB error. The same hostname can technically serve any location's car so we DON'T branch on Host header — branch on the source row's `location_id`. Pattern documented in Lessons learned. |
| 125 | Deposit links: 72h expiry + Supabase fetch cache fix | Three changes shipped together because they all surfaced from the same broken-link report. (1) Default expiry 24h → 72h in `issue-deposit-link/route.js`. Buyers get the weekend to think + sleep + sort funds without the link dying. (2) **Critical infra fix:** `createServerClient()` in `src/lib/supabase.js` now passes `{ global: { fetch: noStoreFetch } }` because Next 14 caches third-party fetch responses inside its data cache even on `force-dynamic` routes — the Supabase JS client opens its own internal fetch instance that doesn't inherit the route-level no-store default. Without this wrapper, an UPDATE in Postgres can be invisible to the next read on the same deployment until cache eviction. We hit this exactly on 2026-05-05 when extending a deposit token's expiry — DB said valid for 3 more days, API kept returning `TOKEN_EXPIRED` from a stale cached fetch. The wrapper applies centrally to every public route that uses `createServerClient()` (orders, race signups, race timing — all of them). Documented in Lessons learned. (3) Buyer-facing copy refreshed: 'This deposit link has expired. Please ask the dealer to send you a new one.' → 'This payment link has expired. Please contact the dealer to reissue a new link.' Page heading + API error message both updated. Dropped the literal '24 hours' reference from the page so the policy can change without copy edits. |
| 124 | race-timing-events cron heartbeat fix | The route was firing every 15 min as scheduled and returning 200 in Vercel logs, but **never actually called `stampHeartbeat()`** — meaning the `cron_heartbeats` row hadn't refreshed since mig 097 seeded it. Health-check rightly flagged the cron as stale ~10h after seeding. Fix: import + call `stampHeartbeat('race-timing-events', stats)` after the loop, with a `.catch(() => {})` so a transient heartbeat write blip doesn't fail an otherwise-successful tick. Pattern now matches the other 5 crons. Also documented in Lessons learned: every cron that has a heartbeat row MUST stamp it in the route handler — `grep -L stampHeartbeat src/app/api/cron/*/route.js` should return only `health-check/route.js`. |
| 123 | Sidebar logo +70% larger | `Sidebar.jsx`: logo class `h-8 max-w-[140px]` → `h-[54px] max-w-full`. Header section grows 22px to accommodate the taller logo. `object-contain` keeps aspect ratio so wider logos auto-scale down without overflow or distortion. |
| 122 | Favicon: emit on every page (root metadata) | Before: favicon only appeared on authenticated CRM pages because `Sidebar.jsx:74-94` imperatively injected `<link rel='icon'>` client-side after the user landed. Public pages (deposit on pay.ccfautos.com, race signups, /login, /reset-password) had no favicon at all. Repo had no static favicon either. Fix: set `metadata.icons` in `src/app/layout.js` pointing at the public Supabase Storage URL of the existing favicon. Next emits `<link rel='icon'>` in every page's `<head>` automatically. Sidebar's imperative override stays as a live-update path for CRM users when the favicon changes without redeploying. Same icon used for `shortcut` + `apple-touch-icon`. Superseded for the deposit page in entry #126 above (per-location branding). |
| 121 | RaceSignupWidget: compact pill grid for wave picker | The stacked full-width buttons sprawled vertically once a race had more than ~4 waves (a Hyrox-sim with 11 5-min waves filled the viewport). Switched to a responsive grid (3/4/5 columns by breakpoint) of small chips showing just the start time, with the optional wave label as a sub-line and a strikethrough + "Full" indicator when a wave is full. Selected wave uses a solid dark fill instead of just a border so it pops against the chip grid. Shrinks 11 waves from one viewport-height vertical column to ~3 rows of 5. |
| 119 | Drop pg_cron / pg_net entirely (mig 097) | Cleaned up two leftover pg_cron jobs (`process-contact-imports`, `race-timing-events`) that had been failing on every tick since mig 066 dropped `private.app_config` — they were dead duplicates of the Vercel Cron jobs that were doing the actual work the whole time. Mig 097 unschedules both, drops the unused `fire_deal_webhooks()` trigger + `webhook_subscriptions` table (last consumer of `pg_net`, 0 rows in prod), then drops both `pg_net` and `pg_cron` extensions. Refreshes `cron_heartbeats.notes` to label everything as Vercel cron + adds heartbeat rows for the three crons that were missing entries (`run-sms-broadcasts`, `race-timing-events`, `process-contact-imports`). Net effect: every scheduled job now runs from `vercel.json` and nothing else. Single source of truth, no `CRON_SECRET` drift surface, no spam in `cron.job_run_details`. Also deleted the obsolete `/api/webhooks` route that was the only n8n-facing consumer of `webhook_subscriptions`. |
| 118 | Import v2c — async background commit (mig 096) | Big imports used to be capped at 5,000 rows because the inline commit risked a Vercel function timeout. Now the cap is **50,000** rows: anything over **1,000 rows** auto-routes to a queue + cron worker that drains it in the background. Mig 096 widens `contact_imports.status` to add `'pending'` + `'processing'`, adds a `payload` JSONB column (full job — mapping + rows + resolutions + batch tag — populated when status=pending, cleared once the worker completes), and `started_processing_at` + `error_message` for stuck-job recovery. New `src/lib/contact-import-runner.js` extracts the write logic so both the inline path AND the cron worker call the same code. New `/api/cron/process-contact-imports` (master-secret bearer auth) drains one job per tick — picks the oldest `pending`, marks it `processing`, runs `runImportCommit()`, marks `completed`/`failed`. Stuck-job recovery: any row in `processing` for >5 min gets reset to `pending` on the next pass (function timeout / mid-deploy crash). Wizard: client-side row cap lifted to 50k; commit response now carries `async: true`/`false`. New `processing` stage in the modal with a spinner + "you can close this window" + a polling loop that watches `/api/contacts/imports/[id]` every 3s for 30 min until the batch flips to `completed` or `failed`. `done` stage handles the failed-batch case with the error message. The cron is wired in `vercel.json` (`* * * * *`); the original commit landed with a duplicate pg_cron job that was retired in mig 097. **659/659 still passing.** |
| 117 | Import v2a/b — multi-location + glofox match + conflict UI | Three v2 enhancements layered on top of mig 095. **(a) Target location dropdown** on Step 1 (only when caller has >1 location) — master picks which studio the batch lands at; defaults to active. Both `/preview` and `/commit` accept `location_id`. **(b) Glofox ID secondary match** — match priority is now `glofox_member_id` first (when present on both incoming and existing), email fallback. Within-file dupes detected for both keys independently. Same dedup happens per-location. **(c) Conflict UI** in the Review step — preview now reports per-row `conflicts: [{field, existing, incoming}]` for any update where the existing value is non-empty AND differs from the incoming one. Wizard renders a "Conflicts" section: per-row dropdown (Row wins / Preserve existing / Skip) + bulk buttons to set all conflicts at once. Commit accepts `resolutions: { [row_number]: 'row_wins' \| 'preserve_existing' \| 'skip' }` and applies them. `preserve_existing` only fills empty fields; `skip` doesn't touch the contact at all (logged as `skipped` with a clear reason); `row_wins` is the default. Tags always merge regardless of resolution — operators expect a batch tag to ADD, never clobber. |
| 116 | Contacts CSV import wizard (mig 095) | Mig 095 + new `src/lib/contact-import.js` + 4-step wizard modal + import-history pages + rollback. **Master-only**. Operator drops a CSV (≤5,000 rows), parses client-side via `parseCsv()`, picks fields in the **Map** step (auto-mapped from common spellings — Email Address / First Name / Mobile / Surname / etc.), runs a server-side **dry-run** (POST `/api/contacts/import/preview`) that classifies every row as create/update/skipped/errored against existing contacts (case-insensitive email match at the location), then commits via POST `/api/contacts/import/commit` which writes the contacts + a `contact_imports` row + per-row `contact_import_rows`. Optional **batch tag** input on step 1 stamps a tag on every imported contact (useful for "this is the lead-magnet list, segment it later"). UPDATE rows merge tags rather than replace. Created contacts get `contacts.created_via_import_id` stamped (new column) for **rollback**. New `/contacts/imports` history page (manager+ read) + `/contacts/imports/[id]` drill-in with per-row outcomes and an **error CSV download** that includes a `import_error` column. **Rollback** (master-only, `POST /api/contacts/imports/[id]/rollback`): deletes contacts created by the batch via the existing GDPR-safe path (`redactWhatsAppForContact()` then DELETE), restores updated contacts from `before_snapshot` (per-row JSONB scoped to the fields the import touched). Two new tables (`contact_imports` + `contact_import_rows`) under RLS — read for location members + master, write only via the master-gated routes. 25 new unit tests in `contact-import.test.js` lock the parser (RFC-4180 ish — quoted fields, escaped quotes, CRLF), the auto-mapper, the row validator (email lower-casing, batch tag merging, lead_status enum, empty-cell drops), and the template generator (asserts every template header round-trips through autoMapHeaders so adding a field to IMPORT_FIELDS without updating AUTO_MAP fails the test). **659/659 passing.** v1 limits: 5k rows/batch (split bigger files); single-location only (master switches via the active location). |
| 115 | GDPR right-to-erasure: contact delete with WhatsApp history | Mig 094. Contact delete used to refuse on `whatsapp_*` rows because the FKs were `ON DELETE NO ACTION` — operators were stuck merging into a placeholder before they could erase a customer, which doesn't satisfy GDPR. Now the contact's PII is scrubbed (`wa_phone`, `wa_profile_name`, message body, media URL, template variables → NULL or `'[redacted]'`) BEFORE the contact row is deleted, and the FK rules let the link drop automatically: `whatsapp_conversations.contact_id` and `whatsapp_messages.contact_id` are now `ON DELETE SET NULL`; `whatsapp_broadcast_recipients.contact_id` is `ON DELETE CASCADE` (its column is NOT NULL, so SET NULL isn't an option — the per-recipient send-status row goes with the contact). `wa_phone` had its NOT NULL dropped on `whatsapp_conversations` and the unique index `(location_id, wa_phone)` is now partial (`WHERE wa_phone IS NOT NULL`) so redacted rows don't collide. New `redactWhatsAppForContact(db, contactId)` in `src/lib/contact-merge.js` does the scrub; idempotent + best-effort (each UPDATE is independent, a partial scrub is better than no scrub). Wired into both `DELETE /api/contacts/[id]` and the bulk-delete handler. New impact-preview category — **"Will be redacted"** — so the operator sees what's about to happen before they confirm. The conversation thread + audit timestamps are preserved (operator-side compliance record), but no field that could re-identify the customer remains. **634/634 still passing.** |
| 114 | Contacts bulk delete + widen role gate | Per-contact delete and the new bulk delete are now both available to **head_coach / manager / owner / master** (= `MANAGER_ROLES`). Was owner+ only. The cascade rules are unchanged — this is purely a permission widening because a wrongly-deleted contact reconstructs from email + revenue history just as easily as a wrongly-edited one. **Bulk delete** lives in the Contacts table's existing bulk action bar (next to Add to sequence and Merge). New `<ContactBulkDeleteModal>` shows: list of selected names (capped at 12 with "…and N more"), the same 3-section impact summary the per-contact dialog uses, type **DELETE** to confirm. After firing, the modal stays open with a per-row breakdown — `deleted` / `blocked` (whatsapp history) / `forbidden` (wrong location) / `missing` — so the operator gets a complete audit instead of a "succeeded / failed" boolean. New `POST /api/contacts/bulk-delete` (cap 200 per request) returns the breakdown shape; doesn't fail the whole batch on a per-row error so a single whatsapp-history block doesn't strand 199 successful deletes. **Merge stays owner+** — folding two contacts is irreversible (loser row is gone) and a higher bar than removing a row that can be re-created. **634/634 still passing.** |
| 113 | Lint warning cleanup | `next lint` was reporting one `no-unused-vars` warning on a stale destructure parameter (`registrationUpdates`) in `src/lib/race-payments.test.js`. CI didn't fail (warnings are non-fatal) but the warning had been there for a while. Dropped the unused parameter; lint now reports zero warnings, zero errors. |
| 112 | Mobile-parity CI fix (covered five red Web-CI runs) | `studio_management` (mig 093) wasn't on the cross-platform allow-list in `scripts/check-mobile-parity.mjs`, AND `races` + `orders` from mig 092 had no `webEquivalent` mobile entry and weren't on `WEB_ONLY_OK`. Result: every Web-CI run from `8823a59` (mig 092 ship) through `fe5ec5b` (mig 093 ship) failed with "no mobile counterpart" drift — five red runs in a row, all the same root cause. Fix: introduced new `CROSS_PLATFORM_KEYS` export in `shared/permissions.js` (kept legacy `CROSS_PLATFORM_DASHBOARD_KEYS` as a back-compat re-export so the mobile bundle's existing import doesn't break) that includes the dashboard keys + `studio_management`, pointed the linter at the broader list, AND added `races` + `orders` to `WEB_ONLY_OK` with reason strings. Subsequent runs green. **Lesson learned (now documented in the "Before pushing" section above):** always run `npm test && npm run lint && npm run check:mobile-parity` locally on any commit that touches `shared/permissions.js`, `Sidebar.jsx`, or the `WEB_PERMISSIONS` / `MOBILE_PERMISSIONS` arrays. The parity check catches the class of bug that lint + tests can't see (it's an inter-file invariant, not a within-file one). |
| 111 | Studio Management: rename + web UI | Mig 093. Renamed the mobile-only `door_unlock` permission key to `studio_management` and promoted it to a cross-platform key (lives on `permissions.studio_management` top-level, same shape as `dashboard_*`). Both web sidebar AND mobile read it from a single place — one toggle in StaffForm controls both. SQL migration moves existing `permissions.mobile.door_unlock` values to the new key on `profile_locations.permissions` AND legacy `profiles.permissions`. New web surface: sidebar entry **Studio Management** + `/studio-management` page + `<StudioManagementPanel>` client component. UI is a tap-twice-to-confirm grid of door tiles (one per door at the active location's UniFi controller); per-door spinner during the request, "Unlocked" badge fades after 5s, auto-disarm if the operator pauses for 3s without confirming. New API: GET `/api/studio-management/doors` (lists doors via UniFi `/doors`), POST `/api/studio-management/unlock` (calls UniFi `/doors/<id>/remote_unlock` and writes a `kind='event'` activity row for the CRM-side audit). Two new helpers in `unifi-access.js`: `listDoors(cfg)` and `remoteUnlockDoor(cfg, doorId, { actorEmail })`. Both gated on `hasPermission(user, 'studio_management')` so the per-location feature flag honours master-disabled. Role defaults: master/owner/manager on, head_coach/staff off (explicit opt-in). Mobile bundle has no code reference today — only the shared registry — so the rename auto-propagates on next mobile rebuild. 5 new unit tests in shared-permissions.test.js lock the rename + cross-platform contract. **634/634 passing.** |
| 110 | Permissions audit fixes: persistence + ownership + features | Three issues reported by users, all in the staff/location settings surface. **(1) Persistence bug**: per-user permission overrides were being SAVED correctly but NEVER READ — `/settings/staff/[id]/page.js` line 15 narrowed its SELECT on `profile_locations` to `(location_id, role, unifi_door_access, unifi_user_id, is_default)`, omitting the `permissions` JSONB. The form fell back to role defaults, then on save POSTed those role-default values back, making every per-user override appear to "reset on refresh". Fix: add `permissions` to the SELECT + extract the row→assignment mapping into `mapProfileLocationToAssignment()` (`@/lib/staff-access`) so a future SELECT change can't silently re-introduce the bug. **(2) Owner self-edit / peer-owner edit**: owners could edit their own permissions via `/settings/staff/<own_id>` and could edit other owners' permissions. Per the new policy, owner permissions are master-only. New `canEditStaffMember(caller, target)` helper enforces: master can edit anyone (incl. self); owner CAN'T edit themselves OR another owner; non-owner / non-master can't use the editor. Wired into both the page-level redirect AND the PUT `/api/staff/[id]` route handler (defence-in-depth — a hand-crafted PUT can't bypass the page guard). Settings → Staff list now renders "Locked" instead of "Edit" for rows the caller can't touch. **(3) Per-location feature toggles owner-editable**: `<LocationFeatures>` and `<AdminFeatureMatrix>` both wrote `locations.features` directly via the browser Supabase client — RLS allows owners to update locations, so any owner could disable features at their location. Now master-only via new `canEditLocationFeatures()` + new server route `PUT /api/locations/[id]/features`. Both UI components switched to call the route. Owners no longer see the "Features" section on the location edit page. 12 new unit tests in `staff-access.test.js` lock all three contracts. **629/629 passing.** |
| 109 | Contacts: manual create / edit / delete / merge | Manager+ can create + edit, owner+ can delete + merge. New `<ContactForm>` (used by /contacts/new and /contacts/[id]/edit). New "+ New contact" button on /contacts. Edit + Delete buttons on the contact profile page. Merge button in the bulk-action bar (visible when exactly 2 rows selected). New `src/lib/contact-merge.js` exports `getContactImpact()` (counts of dependent rows split by FK delete-rule), `pickMergedFields()` (survivor wins, loser fills empty), `mergeTagArrays()` (union, dedupe, trim), and `mergeContacts()` (the orchestration). New `requireApiKeyOrManager()` in api-auth.js so the existing `/api/contacts` POST + PUT routes accept cookie auth from the web UI in addition to the existing n8n bearer-token path. New routes: GET `/api/contacts/[id]/impact` (manager+, returns the impact shape), DELETE `/api/contacts/[id]` (owner+, returns 409 with `code:has_protected_history` when WhatsApp rows block the delete), POST `/api/contacts/merge` (owner+). Delete + merge dialogs both render a 3-section impact preview: "Blocking" (WhatsApp NO ACTION FKs that refuse the delete), "Will be deleted" (CASCADE rows), "Will stay (unlinked)" (SET NULL rows). Merge logic re-points every FK from loser → survivor before deleting the loser; pre-update dedupes the three known UNIQUE constraint conflicts (`contact_preferences.contact_id`, `sequence_enrollments(sequence_id, contact_id)`, partial UNIQUE `contact_tags(contact_id, tag) WHERE removed_at IS NULL`). Survivor's `created_at` rolls back to the older of the two so lead-age math survives merge. Bonus fix: `competition_competitor` was used by mig 086 race-contact-linking but missing from the canonical `leadStatusSchema` enum — added so the new edit form can write that status. 15 new unit tests in contact-merge.test.js cover the field-resolution + tag-union edge cases (numeric zero NOT empty, whitespace IS empty, case-sensitive tag dedupe, survivor-first ordering, older created_at wins). **617/617 passing.** |
| 108 | Hide car-only settings when feature off | Three settings sections were always rendered regardless of whether the location actually does Car Processing — clutter for gym-only locations. Now gated on the per-location `car_processing` feature flag (mig 032 / `isFeatureEnabledAtLocation`): (1) `<CarDepositSettings>` on `/settings/locations/[id]` only renders when that location has Car Processing on; (2) the Integrations card on `/settings` only renders when at least one of the user's locations has Car Processing on; (3) `/settings/integrations` filters its locations list to only those with Car Processing on, with a helpful empty-state pointing at the location feature toggle. Toggling Car Processing back on in `<LocationFeatures>` calls `router.refresh()` so the gated sections reappear without a manual reload. **602/602 still passing.** |
| 107 | Permissions audit: orders + races split out | Audit of the per-location feature matrix and per-user permissions matrix vs the routes that have shipped over the last few sessions. Two new keys added to `WEB_PERMISSIONS` in `shared/permissions.js`: **`orders`** (was inheriting `events|car_processing` via OR in the sidebar; routes guarded only on MANAGER_ROLES) and **`races`** (was riding on the `events` key). Both keys auto-appear in the location feature toggle UI (`<LocationFeatures>`) and in the per-user permission matrix (`<StaffForm>`) since both iterate the same canonical array. Role defaults: orders → owner/manager true, head_coach/staff false (financial views opt-in); races → all roles true (race-day starts/finishes are a front-of-house duty). Routes updated to honour the new keys: `/orders`, `/orders/[id]`, `/api/orders`, `/api/orders/[id]`, `/api/orders/[id]/refund`, `/races`, `/races/new`, `/races/[id]/edit`, `/races/[id]/teams`, `/races/[id]/control`, `/api/races`, `/api/races/[id]`, `/api/races/[id]/teams`, `/api/races/[id]/control-board`, `/api/races/[id]/logo`. Sidebar updated. Permissions list re-ordered into logical groups (dashboards → CRM → calendly+races → comms → ops → revenue → infra) so the matrix scans top-to-bottom. 4 new tests in shared-permissions.test.js lock the contract: orders/races role defaults, location can disable Races without losing Events, location can disable Orders independently of Events + Cars. **602/602 passing.** Mobile registry untouched (audit was web-only by design — mobile revisited later). |
| 106 | Race TV display: header logos | Mig 092. New `race_events.tv_logos JSONB DEFAULT '[]'` (CHECK array, max 6 entries; UI caps at 3). Operators upload logos from RaceEventForm via new `POST /api/races/[id]/logo` (manager+, multipart, PNG/JPEG/WebP/SVG, ≤2MB) which writes to the existing `branding` Supabase Storage bucket at `race-logos/<race_id>/<slot>.<ext>` and returns the public URL. New `DELETE /api/races/[id]/logo?slot=N` clears a slot's bytes; the operator still needs to PUT the race to persist the new tv_logos array (so a half-finished edit doesn't leave a dangling URL). New `<LogoSlot>` UI element in RaceEventForm — three slots in a 3-column grid, dashed dropzone for empty, image preview + remove for filled. Slot section is hidden until first save (the upload route needs a race id to namespace the storage path). Public `/api/public/races/[slug]/display` exposes the URLs (filtered, capped at 3) and `<RaceDisplayBoard>` renders them in a `grid-cols-[1fr_auto_1fr]` header so the centre stays dead-centre regardless of the side-block widths. Cache-busting query param on the URL means re-uploads to the same slot surface within ~2s on the TV. |
| 105 | Race-day TV display | Public TV-friendly board at `/race/[slug]/display` for the studio screens. Auto-rotates between two screens every 20s: **On course** (active teams ranked by elapsed time, longest on top — most likely to finish next) and **Finished** (today's completers ranked by finish time, top-3 podium-coloured). Polls `/api/public/races/[slug]/display` every 2s for fresh state. Live elapsed timer (500ms tick) anchored to the API's `server_now` so the board stays honest even if the TV's clock drifts. Tap-to-skip rotation. Empty states for both panels. New public API `/api/public/races/[slug]/display` returns a deliberately narrow shape — team name, wave label, start/finish ISO timestamps — no member emails, no contact IDs, no phones; the URL is unauthenticated so anything more would leak. New `<RaceDisplayBoard>` client component does the polling + rotation + clock-sync logic. Operators get a "Open TV view" link from `/races/[id]/control` so they can pop the URL straight onto the studio TV. 598/598 tests still passing. |
| 104 | Sequences Tier 3E — branching sequences | Mig 091 (comment-only — `step_type` was already a free TEXT column). New step_type `'branch'`: doesn't send anything, evaluates a predicate against the contact, jumps the enrolment cursor to one of two configured continuation step orders. Predicate types in v1: `has_tag`, `field_equals`, `field_in`. Predicate fields are whitelisted (`lead_status`, `label`, `email_status`, `sms_status`, `marketing_opt_in`) so a malicious config can't probe arbitrary contact columns. New `evaluateBranchPredicate(db, { contact, predicate })` and `processBranchStep(db, { step, contact })` exported from `src/lib/sequences.js`. Runner extended: when `step.step_type === 'branch'` it calls processBranchStep, gets a target step_order, and lands the enrolment cursor at `target - 1` so the next tick fires the chosen step. Pointer defaults: missing `then_step_order` → `step_order + 1` (proceed), missing `else_step_order` → `step_order + 2` (skip 1 step). Loop guard: target must be > the branch's own step_order so an operator can't accidentally build an infinite loop. SequenceEditor adds a "Branch (if / else)" channel option with predicate type/args + then/else step number inputs, plus an inline summary in the collapsed step header. API schemas for create + bulk-update + single-update step routes all extended to accept the new step_type and the branch's `config` payload. 18 new unit tests in `sequences-branch.test.js` covering each predicate type, whitelist enforcement, then/else routing, default pointers, and the backwards-jump guard. **598/598 passing.** |
| 103 | Sequences Tier 3C — re-enrolment with cooldown | Mig 090. New `email_sequences.re_enrolment_cooldown_days INT` (NULL or 0 = single-enrolment-per-contact, the legacy mig 037 behaviour; >0 = same contact may re-enrol after their previous run ended that long ago). `enrolContacts()` rewritten: existing active-enrolment dedup unchanged; new step pulls completed/exited history for the candidate set, picks the MOST RECENT terminal end-time per contact (`last_processed_at` falling back to `created_at`), and only blocks if it's inside the cooldown window. Without a cooldown the function still blocks any contact who has EVER been enrolled, so existing sequences keep their semantics. UI: new "Re-enrolment" card in SequenceEditor (numeric days input, 0–3650, empty = legacy). Anniversary template gets `re_enrolment_cooldown_days: 350` baked in so it actually fires every year. API schemas extended on both POST `/api/sequences` and PUT `/api/sequences/[id]`; create-route also now persists `goal_config` and `send_window` which were previously dropped on direct creates (templates already wrote them via the from-template route). 8 new unit tests in `sequences-cooldown.test.js` covering: legacy NULL/0 blocks all, cooldown blocks recent terminal enrolment, cooldown lets old enrolments through, MOST RECENT picked when contact has multiple history rows, `created_at` fallback when `last_processed_at` is null, independent contacts, empty-history no-op. 580/580 tests passing. |
| 102 | Sequences Tier 3B — sequence templates library | New `src/lib/sequence-templates.js` registry of 9 ready-made recipes across 5 categories (Races, Welcome, Recovery, Internal, Anniversary). Each template carries `name`, `description`, `category`, `trigger_type`, `trigger_config`, optional `goal_config`/`send_window`/`audience_filter`/`re_enrolment_cooldown_days`, and a `steps[]` array. New `POST /api/sequences/from-template` clones a template into a draft sequence + sequence_steps in one call (rolls back the sequence if step insert fails). `GET /api/sequences/from-template` returns the picker metadata (no DB hit). New `<SequenceTemplatePicker>` modal triggered from a "Use template" button on `/communications/sequences` next to "New Sequence" — fetches the catalogue lazily, groups by category, navigates to the editor for the freshly-cloned draft. `triggerLabels` map on the list page extended to cover all 12 Tier 1A trigger types so the new templates render with proper labels. |
| 101 | Sequences Tier 3A — per-step open/click stats | New `GET /api/sequences/[id]/stats` aggregates per-step open/click rates from `email_sends` (joined to `sequence_runs` so we attribute correctly across multiple sends per step) plus enrolment funnel counts (active/completed/exited + exit-reason breakdown for goal_met vs other). `<SequenceEditor>` adds a Performance card under the Send Window block (visible once `enrolments.total > 0`) showing the funnel. Each collapsed step header now carries inline open/click badges + send count. Stats refresh after the operator hits "Send test" so QA loops show the new send. |
| 100 | Sequences Tier 1 + Tier 2 expansion | Migs 087 + 088 + 089. Tier 1A: 7 new `trigger_type` values (race_registered, race_finished, order_completed, order_failed, order_abandoned, anniversary, inactivity) with their cron-driven event handlers in `src/lib/sequences.js`. Tier 1B: new step types (`apply_tag`, `update_field`, `internal_task`, `webhook`) — apply_tag composes with the Tag Added trigger so sequences can hand contacts off to each other. Tier 1C: per-sequence goal tracking (`email_sequences.goal_config` JSONB; runner exits enrolment with `exit_reason='goal_met'` when the configured goal predicate matches) + test mode (set `metadata.accelerated_delay_seconds=60` on enrolment, runner clamps every step delay to that value so a multi-day sequence runs through in ~minutes). Tier 2A: `inactivity` trigger (cron-fired against contacts whose last activity timestamp crossed N days) + `anniversary` trigger (fires when `from_field` value crosses today minus `days_after`). Tier 2B: send window (`email_sequences.send_window` JSONB with `start_hour`, `end_hour`, `skip_days[]`) — message-step fires push forward to land within the local-time window using Europe/Dublin as the reference TZ; non-message steps (apply_tag, update_field, internal_task, webhook) ignore the window. Tier 2C: `webhook` step type signs an HMAC-SHA256 outbound payload using the location's webhook secret so receivers can verify provenance. SequenceEditor extended with all of the above (trigger picker, step-type picker, goal config block, send-window block, test button, per-step stats). |
| 99 | Order detail page + retry chain visualisation | New `/orders/[id]` server page → `<OrderDetail>` client component. New `GET /api/orders/[id]` returns: full order row, retry chain (orders sharing email + source_type within ±30 days, capped 20), event timeline (contact_events for the same source, newest-first, capped 50), and a source summary (race+wave+team OR car make/model/reg). Each retry-chain row links to its own detail page so operators can trace the full history. Orders table rows are now clickable — click anywhere outside a button navigates to the detail. Lint clean. 559/559 tests still passing (no test added — UI surface tested via integration). |
| 98 | Refund flow (orders → Revolut) | New `POST /api/orders/[id]/refund` (manager+ at order's location). Gates on `status='completed'` AND `payment_provider='revolut'`. Calls `refundOrder()` from `src/lib/revolut.js`. Updates `orders.status='refunded'` + `refunded_at` + `refunded_amount_cents`. Cascades to source row (`race_payments.status='refunded'` + matching timestamps OR `cars.deposit_status='refunded'`). Emits `ORDER_REFUNDED` contact_event + reapplies tag rules. Stores `refund_reason`, `refund_actor_id`, `refund_revolut_id` on `orders.metadata`. UI: per-row Refund button on `<OrdersTable>` with two-step confirm so operators can't single-click into a refund. Disabled / hidden for non-Revolut + non-completed orders. Inline error state. Partial refunds: API accepts `amount_cents` but UI sends full only for v1. 559/559 passing. Lint clean. |
| 97 | Tag-aware AudienceBuilder (Phase 3) | Adds `tag` as a virtual field on the audience-filter allowlist (mig 085 retargeting). Tag clauses are pre-resolved to a `contacts.id IN (…)` constraint via new `resolveTagFilters()` async helper before scalar filters apply. Multiple positive tags AND together; negatives exclude via NOT IN. Tag-only filter with no matching contacts forces an unsatisfiable predicate (`id = '00000000-…'` sentinel) so audience count is 0 rather than silently matching all. New exports: `resolveTagFilters({ db, query, filter, locationId })` + `applyAudienceFilterAsync(...)`. `postmark.js` adds `buildAudienceQueryAsync()` (sync version retained for back-compat). `/api/contacts/search`, `/api/campaigns/[id]/preview`, `sequences.js`, `postmark.sendCampaign` updated to call the async path. AudienceBuilder UI: new "Segment tag" field with `tag-select` type — options loaded from `/api/segments` at first use. Operations: `eq` ("has tag") / `neq` ("does not have tag"). Tests: 8 new in audience-filter.test.js (skip behaviour for tag in sync filter, op allowlist, async function shape, null/empty handling). DB-backed tag-resolution tests intentionally kept at integration layer — vitest's PromiseLike chain mocking proved flaky for this case. 559 tests passing. Lint clean. |
| 96 | Orders + events + tags spine (Phase 2) | Mig 085. Three new tables: `orders` (polymorphic source: race_registration / car_deposit, status enum incl. `recovered`, retry pointers), `contact_events` (append-only event log), `contact_tags` (machine-derived retargeting tags with soft-delete via `removed_at`). Backfilled cars deposits + race_payments → orders at migration time (~30 min ago in production). Retry detection: lead-buyer email only (Q2), 7-day window (Q3), automatic on every order completion via `src/lib/orders.js` `detectRetryRecovery()`. NO events backfill (Q4) — events fire forward-only. New `src/lib/contact-events.js` exposes `EVENT_TYPES`, `emitEvent()`, `applyTagRules()`, `TAG_RULES` registry (race_completed, repeat_racer, race_registered_no_payment, lapsed_payer, race_starts_soon, race_recently_completed). Wired into `race-payments.js` (createRacePayment + markRacePaymentStatus), cars Revolut webhook, and the issue-deposit-link route. New `/api/orders` (manager+, paginated, filtered, with per-status counts) drives `/orders` page with tabs strip (Completed/Pending/Failed/Abandoned/Recovered/Refunded) + email/source/date filters. New `/api/segments` returns each tag with active count; `/segments` page renders a card grid with broadcast/contacts links. New `/api/cron/race-timing-events` emits time-anchored events (`race.starts_in_24h`/`_1h`/`completed_24h_ago`); fires every 15min via Vercel Cron (the original mig 085 also installed a duplicate pg_cron job, retired in mig 097). Idempotency baked in: contact_events partial UNIQUE on `(source_type, source_id, event_type)` for the time-anchored events; contact_tags partial UNIQUE on `(contact_id, tag) WHERE removed_at IS NULL`. Sidebar gets two new entries (Orders, Segments) gated on existing permissions. 20 new tests (orders 6 + contact-events 14). 552/552 passing. Lint clean. Mig 085 introduces zero new advisor warnings. |
| 95 | Race members + per-head pricing + payments (Phase 1) | Mig 084. New `race_payments` standalone table — DELIBERATELY separate from `cars.deposit_*` since UN1T (gym + races) and CCF Autos (cars) are different businesses. Schema additions: `race_events.member_pricing_enabled` + `member_fee_cents` + `non_member_fee_cents` + `members_only` + `payment_currency`; `team_members.is_member` + `member_validation_status` + `member_contact_id` + `member_validated_at`; `race_registrations.team_composition` + `active_payment_id` + `pending_payment` status. Per-head pricing — 2 members + 2 non-members = `2×member_fee + 2×non_member_fee`. Member match by email-only against `contacts` where `lead_status='member'` at the race's location. Public form gets a prominent "use the email on your UN1T account" notice + per-email debounced live validation badge + live total preview. members_only races refuse signup with any unverified member. New `src/lib/member-validation.js` (pure pricing logic, fully unit-tested), `src/lib/race-payments.js` (free entry skips Revolut entirely; paid entry uses `registration.id` as idempotency key), `src/lib/race-confirmations.js` (UN1T-branded, NOT sharing templates with booking/deposit confirmations). New `/api/public/races/[slug]/check-member` (rate-limited 60/min, leak-resistant — same response whether email is unknown or known-non-member). New `/api/public/race-payments/[id]` (status read with live Revolut refresh fallback) + `/api/public/race-registrations/[id]` (post-payment confirmation page). New `/api/webhooks/revolut/race-payments` — SECOND webhook URL in the Revolut dashboard; verifies its own signature; the cars handler stays cars-only. New public pages `/race-pay/[paymentId]` (embedded Revolut Checkout) + `/race/[slug]/confirmed` (success + roster + member badges). RaceEventForm: pricing section with member toggle + dual fee inputs + members-only switch. RaceSignupWidget: email notice banner, per-email badge, live total updates as members verify, redirects to embedded checkout (or confirmed page if free). RaceControlPanel: composition filter chip (All/Members/Mixed/Non-members) + per-row member tag + per-name verified-badge. 20 new tests (member-validation, race-payments). 525/525 passing. Lint clean. Mig 084 introduces zero new advisor warnings. |
| 94 | Hide race capacity numbers from public signup | `/api/public/races/[slug]` no longer exposes race-level `capacity` or per-wave `remaining_capacity`. Each wave gets a `is_full: boolean` instead. The race-level deprecated capacity field is also stripped from the response. `<RaceSignupWidget>` reads `is_full` instead of computing from numbers; renders "Full" next to a wave card when full, nothing otherwise (clickability implies availability). Auto-pick logic for single-available-wave races also uses `is_full`. Operator surfaces (`/races` index with "X / Y teams", `<RaceEventForm>` numeric inputs) unchanged — they go through the auth-gated `/api/races` endpoints which keep raw capacity. Public sees "can I book this wave"; operators see "how many spots left." |
| 93 | Race waves — multiple start times per race | Mig 083. New `race_waves` table (per race, UNIQUE on `(race_event_id, start_time)`) carries per-wave `start_time, capacity, label, display_order`. `race_registrations.wave_id` added with FK + index; race-event-delete cascades set-null. Backfill creates one default wave per existing race using its legacy `start_time + capacity`. `race_events.start_time` and `race_events.capacity` deprecated in column comments. Races API (`/api/races` POST + `/api/races/[id]` PUT) accepts `waves[]` with create/update/delete diff-and-apply semantics. Public race endpoint returns waves with per-wave `remaining_capacity`; "race full" derived as "every capped wave full." Public register endpoint requires `wave_id`, validates ownership + per-wave capacity. Operator `<RaceEventForm>` gets a wave manager (add/remove rows, time + capacity + label, must have at least one wave). Public `<RaceSignupWidget>` gets a wave picker (cards showing time + label + remaining capacity, full waves disabled, single available wave auto-selected). `<RaceControlPanel>` shows a wave badge on each registration row + secondary-sorts Next Up by wave start_time so the next wave's teams cluster together. 505 tests passing; build clean; mig 083 introduces zero new advisor warnings. **Mid-flight schema fix:** mig 082's docstring claimed `race_registrations.wave_id` was already a placeholder column, but the table create didn't include it. The applied mig 083 SQL has an `ADD COLUMN IF NOT EXISTS wave_id UUID` step before the FK constraint to handle this. The migration file on disk has been updated to match. |
| 92 | Standalone race events (unmerge from booking flow) | Mig 082. Same-day pivot from #91 — the merged race-tracking-on-bookings approach was structurally wrong (Calendly slot abstraction doesn't fit "race on Saturday, capacity 12, teams register"). New `race_events` + `race_registrations` tables fully independent of event_types/bookings. New URL space: operator at `/races` (index, new, [id]/edit, [id]/control), public at `/race/[slug]` for team-first signup. New API space at `/api/races/*` + `/api/registrations/[id]/race-{start,finish,reset}` + `/api/public/races/[slug]/{,register}`. New `<RaceEventForm>`, `<RaceSignupWidget>` (standalone — no calendar, no slot picking, just team capture), and repurposed `<RaceControlPanel>` sourcing race_registrations. Sidebar gets a "Races" entry under the events permission. The mig 081 columns (event_types.is_timed_event, bookings.team_id/race_started_at/race_finished_at) stay on disk per the deprecated-columns convention but are comment-marked DEPRECATED — drop in a follow-up cleanup migration. BookingWidget + EventForm + /api/public/book all stripped of the merged race UI. The `/events/[id]/race` page and `/api/bookings/[id]/race-*` routes deleted. teams + team_members tables stay (still the right abstraction; race_registrations.team_id references them). 505 tests still passing. CLAUDE.md gets a fresh "Teams + race events" architectural section reflecting the new shape; the redundant mig-081-era prose was deleted. |
| 91 | Teams + race tracking (Hyrox sims) | Mig 081. New `teams` table (per-location, persistent across events, UNIQUE(location_id, name) for return-team auto-link) + `team_members` (captain has contact_id; others captured by name+email at signup). New columns: `bookings.team_id`, `bookings.race_started_at`, `bookings.race_finished_at`, `event_types.is_timed_event`, `event_types.allowed_team_sizes` (INT[]). New `src/lib/race-control.js` with pure helpers (formatElapsed, classifyBookingState, elapsedSecondsBetween) + `ensureTeamForBooking` back-stop (find-or-create team by name, link booking, seed captain as team_member). Three race API routes: `POST /api/bookings/[id]/race-{start,finish,reset}` (manager+ at event's location). New `GET /api/events/[id]/race-board?date=YYYY-MM-DD` returns the polling shape — bookings with team + members joined, sorted by scheduled start. New `/events/[id]/race` server page + `<RaceControlPanel>` client component: three sections (On Course / Next Up / Completed) with big tap targets, live elapsed timer ticking every 500ms, polls every 2s for multi-operator sync. EventForm gets the timed-event toggle + size-multi-select. BookingWidget extended: when event is_timed_event, after standard fields show team name input, size radio (only allowed sizes), and N−1 dynamic name+email pairs. Public book API validates against allowed_team_sizes server-side and creates the team + members in the same transaction as the booking. 19 new unit tests in race-control.test.js. CLAUDE.md gets a full new "Teams + race tracking" section. v1 is fully shippable as the operator UX it needs to be; v2 ideas (email results, leaderboard page, returning-team badge, realtime sync, member→contact promotion) are listed in the section. |
| 90 | Invite-by-email onboarding + admin password reset | Admins no longer enter passwords on behalf of new users. `POST /api/staff` switched from `auth.admin.createUser({email,password})` to `auth.admin.inviteUserByEmail(email, { data: { full_name }, redirectTo: $APP_URL/reset-password })`. StaffForm drops the password field on create and shows an explanatory note ("invitation email will be sent…"). New `POST /api/staff/[id]/send-password-reset` (master/admin only) calls `auth.resetPasswordForEmail()` against an existing staff member's email — handles both the "user missed the original invite" case and the "user forgot their password" case. New "Send password reset email" button on StaffForm in edit mode with inline confirmation prompt + success/error states (`<SendPasswordResetButton>`). `/reset-password` page enhanced to detect invite vs recovery via URL hash (`#type=invite|recovery`) and show appropriate copy ("Welcome — set your password" vs "Set a new password"). Already-existing-email case on create returns 409 with a clean message suggesting the password-reset flow. **Cleaner posture:** admin never sees plaintext passwords; the credential is owned by the user from the moment it's set. |
| 89 | Location-gate test coverage | Closes a real gap — `assertLocationAccess` and `getUserLocationIds` had zero direct unit tests before this PR (the backlog item's claim of "20 tests" was incorrect, probably misremembering the schemas test file). Added 12 tests to `src/lib/auth.test.js` covering every branch: null user → 401, no locationId → null pass-through, allowed → null, denied → 403 (the IDOR case), empty/missing locations array → 403, master with all-locations populated passes naturally, defensive id-less entries treated as non-match. Plus one representative route-level test pattern at `src/app/api/contacts/segments/[id]/route.test.js` demonstrating the `vi.mock('@/lib/auth')` + `vi.mock('@/lib/supabase')` + direct-handler-call approach — copy this shape for any future route that wants route-level coverage of its auth/authz path. The pattern handles the chainable Supabase mock (lookup → guard → mutation) and shows assertions for both happy-path and IDOR-attempt branches across PUT and DELETE handlers. |
| 88 | Preview enrolments before committing | `POST /api/sequences/[id]/enrol` extended with `dry_run: true` that runs all the same validation + filtering + already-enrolled lookup but skips the actual `enrolContacts` call. Returns `{ dry_run, sequence, total_requested, would_enrol, already_active, ignored_invalid, sample }` where `sample[]` is up to 20 contact rows weighted ~70% eligible / 20% already-active / 20% wrong-location. SequencePicker is now a two-step flow with a `step` state: `picking` (sequence list, same as before) → `preview` (PreviewPanel sub-component with stat cards + sample list + Confirm / Back) → `done` (success summary, same shape as before). Confirm button is disabled when `would_enrol === 0` so the operator can't accidentally fire a no-op. Back button returns to picker. Single API contract handles both modes via the `dry_run` flag — same auth, same validation, same filtering — so the preview is a faithful representation of what the real call would do. |
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
- ~~API-route-level test for the location gate (not just the helper). The helper has 20 tests; the routes that consume it are still trusted by inspection.~~ — **shipped** (#89). Helper itself now has 12 dedicated tests in `src/lib/auth.test.js` (assertLocationAccess + getUserLocationIds, every branch). One representative route-level test pattern at `src/app/api/contacts/segments/[id]/route.test.js` demonstrates the `vi.mock('@/lib/auth')` + `vi.mock('@/lib/supabase')` + direct-PUT/DELETE-call approach for any future route that wants the same coverage. Original claim about "20 tests" was incorrect — the helper actually had zero direct tests before this work.
- ~~Master admin matrix v2 — make the access matrix at `/admin/matrix` editable inline. Per-cell role dropdown (none / staff / head_coach / manager / owner), add-user-to-location action, master toggle (promote/demote). Today the matrix is read-only and links into `/settings/staff/[id]` for edits.~~ — **shipped** (#86, mig 080) with bulk operations included. Side panel editor instead of per-cell dropdown (felt safer for destructive ops); bulk action bar with multi-select for the onboarding flow; audit log table + viewer at `/admin/audit-log`; at-least-one-master invariant enforced by both app-layer guards and a DB trigger.
- ~~"Add organization" UI on `/admin/matrix`. Today new organizations have to be inserted via SQL~~ — **shipped** (#87). Name + auto-slug modal; LocationForm extended to pick the org for new locations. Full org-onboarding wizard (initial owner, default features) is still a follow-up if/when the third tenant arrives.
- Extend `MOBILE_PERMISSION_KEYS` iteration in `hasAnyMobileFeature` to also evaluate cross-platform `dashboard_*` keys so the empty-state Home tab on mobile is correct for master at a partial-features location.

**Sequences / segments**
- New trigger: `segment_added` / `segment_removed` so saved segments can drive sequence enrolment alongside the existing `status_change` + `tag_added` triggers.
- ~~"Preview enrolments" before committing a sequence — show the candidate contact list so an operator can spot-check before turning the runner loose.~~ — **shipped** (#88). `POST /api/sequences/[id]/enrol` now supports `dry_run: true` returning `{ would_enrol, already_active, ignored_invalid, sample[] }`. SequencePicker is a two-step flow: click sequence → preview screen with counts + sample → Confirm or Back.

**Performance / infrastructure**
- ~~Cron consolidation strategy when we cross 2 crons (Vercel Hobby cap)~~ — **resolved by upgrading to Pro**. All crons live in `vercel.json` now; `pg_cron` + `pg_net` extensions dropped in mig 097 along with the dead `webhook_subscriptions` table that was the last `pg_net` consumer.
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
