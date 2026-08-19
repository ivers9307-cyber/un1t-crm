# un1t-crm — architecture reference

> Deep reference extracted from the root `CLAUDE.md` (2026-06-25) to keep the always-loaded brief lean. Read on demand when working in the relevant area. Linked from the CLAUDE.md "Deep reference" index.

### Key Architectural Patterns

**Multi-tenancy via location + organization scoping** — Every data query filters by `location_id`. Locations now also belong to an `organization` (mig 079) which is the tenant grouping above locations. Today there are two organizations — **UN1T Group** (gym studios) and **CCF Autos** (cars business) — both run by the same operator under one master account, but the schema is shaped so adding a third tenant business is a row in the `organizations` table plus locations under it; existing per-location RLS continues to enforce tenant isolation transitively (a non-member of any of org X's locations can't read its data). Users belong to locations via `profile_locations` junction table, **each row carrying its own role** (mig 051). The same user can be `owner` at Hatch Street and `head_coach` at Stillorgan with independent rights at each. Active location resolved from cookie (`un1t_active_location`) → `is_default` flag → first location. `getCurrentUser()` returns `rolesByLocation: { [loc_id]: role }`, `organizationsById: { [org_id]: org row }` (mig 079 — every org reachable by the caller), `activeOrganization` (mirrors `activeLocation`), plus `user.role` (the role at the *active* location, or `'master'` for platform admins). The original global value is still on `user.profileRole` for the rare caller that wants the canonical/highest role without location context.

**Two Supabase clients** — `createBrowserClient()` uses anon key + SSR cookies (client components). `createServerClient()` uses service role key, bypasses RLS (API routes, cron). Both in `src/lib/supabase.js`.

**Auth flow** — `src/proxy.js` enforces auth on all routes except public paths (`/login`, `/reset-password`, `/book/`, `/api/public/`, `/api/webhooks/`, `/api/cron/`). External integrations (n8n) authenticate with `Authorization: Bearer <CRM_API_KEY>`; the middleware validates this constant-time with a pure-JS XOR-accumulate (Edge runtime can't import `node:crypto`). Sessions are validated against Supabase auth cookies for everything else. There is no `x-api-key` bypass anymore — anything not on the public-paths list and without a valid Bearer or session redirects to `/login`. `getCurrentUser()` in `src/lib/auth.js` returns profile + locations + activeLocation; `assertLocationAccess(user, locationId)` returns null or a 403 NextResponse for IDOR-prone routes; `getUserLocationIds(user)` returns the caller's location array.

**Input validation** — POST/PUT routes validate request bodies via `validateBody(request, schema)` from `src/lib/validate.js` against Zod schemas. Returns 400 with `{ success: false, error, issues }` on rejection. Shared schema building blocks live in `src/lib/schemas.js` (`uuidLike`, `isoDate`, `timeOfDay`, `email`, `phone`, `money`, `hours`, `days`, role/status enums, `MANAGER_ROLES`, `ADMIN_ROLES`, `DEFAULT_COLOR`, `passwordSchema`).

**Password policy** — `passwordSchema` in `src/lib/schemas.js` enforces 8+ characters with at least one lowercase letter, one uppercase letter, one digit, and one symbol. This **mirrors the password-strength settings configured in the Supabase Auth dashboard** — keeping both in sync means we surface a clear inline error before round-tripping to Supabase, instead of getting a generic `weak_password` rejection back from `auth.updateUser`. The same module exports `passwordRequirements` (an array of `{ id, label, test }`) and `validatePasswordComplexity(pw)` (returns the first failing rule's message, or `null`). `app/reset-password/page.js` renders a live ✓/✗ checklist using these exports for both initial-set (invite acceptance) and reset (recovery) flows — when changing password rules, update the dashboard *and* the schema together so the two never drift apart.

**Onboarding via invitation, not admin-set password.** Staff create no longer accepts a password from the admin. Instead, `POST /api/staff` calls `auth.admin.inviteUserByEmail(email, { data: { full_name }, redirectTo: $APP_URL/reset-password })`. Supabase sends an invite email; the new user clicks the link, lands on `/reset-password` with `#type=invite` in the URL hash, and sets their own initial password. The admin never handles the credential. If the email is already registered, the route returns 409 with a clean message suggesting "Send password reset" on the existing profile instead. The Supabase invite email template is configured in the Supabase dashboard (Auth → Email Templates → Invite User); customising the copy or branding is dashboard-only — no code change required. Future enhancement: swap to a Postmark-sent invite via `auth.admin.generateLink({ type: 'invite' })` for full template control if the dashboard template doesn't fit. **Admin-initiated password reset:** `POST /api/staff/[id]/send-password-reset` (master/admin only) calls `auth.resetPasswordForEmail()` with the same `/reset-password` redirect. Same primitive the login page's "Forgot password?" link uses, just initiated by an admin against another user. Surfaced as a "Send password reset email" button on `<StaffForm>` in edit mode with a small inline confirmation prompt.

**Role-based access (4 roles)** — `owner`, `manager`, `head_coach`, `staff`. Stored in `profiles.role`. Enforced at three layers: sidebar nav filtering (UI hint, not security), assistant tool filtering (server-side `TOOL_PERMISSIONS` table), and per-route guards (`if (!MANAGER_ROLES.includes(user.role)) return 403`). RLS additionally enforces role checks for `pipeline_stages`. Use the constants `MANAGER_ROLES = ['owner', 'manager', 'head_coach']` and `ADMIN_ROLES = ['owner', 'manager']` from `src/lib/schemas.js` rather than inlining role lists.

**Permissions JSONB (per-location, mig 058)** — Separate from `role`. Lives on `profile_locations.permissions`, not on `profiles.permissions` — moved per-location in mig 058 so an owner at one studio + staff at another doesn't get owner-level toggles leaked to the staff studio. `hasPermission(user, key)` reads from `user.activeAssignment.permissions` at tier 2; falls through to role default at tier 3. `profiles.permissions` is no longer read by hasPermission (kept on disk for one-version rollback safety). When an assignment's role changes via StaffForm, that assignment's permissions reset to the role defaults from `defaultPermissionsByRole` — other assignments are untouched. StaffForm UI has a per-location tab strip above the toggle list so admins edit one assignment at a time. `getCurrentUser()` exposes `assignmentsByLocation` and `activeAssignment` so server callers can read either the active or any assigned location's blob.

**Assistant bot** — `src/lib/assistant-prompt.js` defines the system prompt with CRM knowledge. `src/app/api/assistant/chat/route.js` implements tool use with permission levels per tool (`all`, `manager`, `admin`). Tools filtered before sending to Claude API based on user role. **Important:** the route derives `role`, `userId`, and `locationId` from the server session (`getCurrentUser()`), never from the client-supplied `userContext`. The client can only contribute display hints like `currentPage`.

**Audience filter whitelist** — `buildAudienceQuery()` (postmark) and `buildWhatsAppAudience()` (whatsapp) both delegate to `applyAudienceFilter()` in `src/lib/audience-filter.js`, which only allows the (field, op) combinations registered in `AUDIENCE_FIELDS`. Prevents campaign authors from filtering on arbitrary columns or smuggling PostgREST traversal paths like `profiles.role`.

**Light theme, intent-named tokens** — The `un1t` palette in `tailwind.config.js` (and `mobile/tailwind.config.js`, kept in step): `un1t-bg` = #FFFFFF (page background), `un1t-surface` = #F7F8FA (cards / raised), `un1t-border` = #E2E5E9 (hairlines), `un1t-muted` = #94A3B8 (secondary text), `un1t-subtle` = #64748B (tertiary text), `un1t-text` = #111827 (primary text), `un1t-accent` = #1E293B (button hover). All components use these tokens. Use literal `text-white` only on coloured backgrounds (bg-blue-*, bg-green-*).

The names were **inverted** until UI-FOUND.1 (`un1t-black` held #FFFFFF), and mobile followed in MOB-UI.1 — the old names are **deleted, not aliased**. This paragraph documented them as current for weeks afterwards, which is how 198 dead references were still being *written* into new features long after the rename: Tailwind emits no css for an unknown token, so a stale `bg-un1t-dark` is not a wrong colour but no colour at all, and the element silently inherits. It surfaced when an operator asked what was meant to be inside the black box on `/offer-sales` — the "Mark fulfilled" label was `text-un1t-black`. `check:guardrails` (`no-dead-un1t-token`) now blocks the old names repo-wide, on web and mobile, and `--fix` performs the rename.

**Report generation** — Shared logic in `src/lib/report-generator.js` used by both manual API route and Vercel cron (`/api/cron/run-scheduled-reports`, daily 7 AM UTC in `vercel.json`). Report types: `staff_hours`, `staff_cost`, `time_off_summary`, `roster_coverage`, `utilisation`. Period boundaries are computed in UTC; if the cron schedule is ever moved earlier than 01:00 UTC, revisit `calculatePeriodForSchedule` so "yesterday" still aligns with Dublin local time.

**Overtime / payroll math** — `src/lib/payroll.js` exposes pure functions used by both the schedule UI (capacity warning) and the `staff_cost` report (cost breakdown). Overtime is a Mon-Sun weekly concept: hours up to `profiles.contracted_hours_per_week` are regular, hours above pay at `profiles.overtime_rate` (or the implicit regular rate if `overtime_rate` is NULL — no premium). FTE-only; contractors are paid `hourly_rate` regardless of total hours. The schedule calendar shows an amber warning panel listing FTE staff at or above their contracted hours for the visible week.

**Bank holidays** — `src/lib/bank-holidays.js` holds country-keyed static public holiday data covering Ireland, UK, Germany, Australia, Kuwait, Malta, Egypt and Cyprus through 2030. The registry (`HOLIDAYS_BY_COUNTRY`) is structured so new countries are a one-line addition. Each `locations` row carries an ISO 3166-1 alpha-2 `country` code (migration 018) which drives the lookup. The schedule calendar fetches `/api/locations/[id]/holidays` which reads the location's country, merges the matching static list with custom per-location entries from `location_holidays` (migration 017), and returns them. Holidays show as amber-tinted day headers with a national or custom prefix; tooltip on hover shows the name. Admins manage custom holidays at `/settings/holidays`. Same-date custom entries override the static name (e.g. relabel St Patrick's Day → "Closed all day"). Islamic dates (KW, EG) follow the Hijri lunar calendar so dates may shift +/- 1 day from official moonsighting; managers can override with custom holidays. The `annotate()` helper de-dupes by date — rare collisions (e.g. EG 2029-04-25 = Eid al-Adha Day 2 + Sinai Liberation Day) render as a single combined entry. Visual only — no impact on cost calc.

**Mobile app (iOS, React Native via Expo)** — Lives in `mobile/` as a sibling to `src/`. Talks to the same Supabase project via `@supabase/supabase-js` + `expo-secure-store` for session persistence. Most CRUD goes direct to Supabase (RLS handles per-location scoping); orchestration calls (Postmark sends, WhatsApp broadcasts, UniFi toggles, the assistant chat, push fanout) hit the existing `/api/*` routes with `Authorization: Bearer <supabase_access_token>`. The middleware (`src/proxy.js`) recognises three Bearer-token shapes: `CRM_API_KEY` (n8n), Supabase JWT (mobile), or no Bearer + cookies (web). `getCurrentUser()` mirrors this — it tries the Bearer header first, then falls back to cookies, so existing route handlers work unchanged from mobile. Mobile's active-location override comes from an `x-active-location` request header (validated against the user's assignments — same IDOR protection as the cookie path). Mobile feature flags live under `permissions.mobile.*` on `profiles` (no schema change — JSONB allows it; defaults per role in `defaultMobilePermissionsByRole` in `StaffForm.jsx`); the iOS app reads them on login via `/api/mobile/me`. **A missing key on mobile is treated as "off"** — adding a new feature here doesn't auto-enable it for existing users. Push notifications use Expo Push Service via `src/lib/push.js`; tokens registered through `POST /api/mobile/device-tokens` (migration 023), pruned automatically when Expo reports `DeviceNotRegistered`. Per-user push preferences honour both the master `permissions.mobile.push_notifications` switch AND per-category `notify_<category>` flags (`time_off`, `schedule`, `swap`, `lead`, `whatsapp`).

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
| `event-reminders.js` | Per-event single-shot reminder runner — `runEventReminderSends()`. Reads `event_type_reminders` rows (the legacy single-shot `event_types.reminder_*` columns were dropped in mig 241), finds bookings ~N min away, sends via email (Postmark transactional) or WhatsApp UTILITY template. Respects `email_administrative` / `whatsapp_administrative` consent flags (NOT marketing flags — reminders are transactional). Stamps `bookings.reminder_sent_at` for dedup. |
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

310 migrations (numbered to 313) in `supabase/migrations/`. Key tables:

**Core:** `locations`, `profiles`, `profile_locations` (junction; `profiles.role` holds the role, NOT this junction), `contacts`, `deals` (linked to contacts + stages), `pipeline_stages`, `activities`, `notes`.

**Events:** `event_types`, `bookings`, `blocked_times`.

**Email:** `campaigns`, `campaign_recipients`, `email_templates`, `email_sequences`, `sequence_steps`, `sequence_enrollments`, `email_sends`, `contact_preferences` (consent + unsubscribe tokens), `consent_log`.

**WhatsApp:** `whatsapp_conversations`, `whatsapp_messages`, `whatsapp_templates`, `whatsapp_broadcasts`, `whatsapp_broadcast_recipients`.

**Scheduling (Roster v2):** `shift_templates` (demand windows) → `shift_blocks` (per-date instances) → `shift_assignments` (n:m coaches), `rosters` (draft/published), `shift_swap_requests` (FK → `shift_assignments`), `time_off_requests`, `staff_allowances`, `schedule_notifications`. The legacy `public.shifts` mirror was dropped in mig 238 (RETIRE-SHIFTS-MIRROR.6) — `shift_blocks` + `shift_assignments` are the sole source of truth.

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

**`rls_enabled_no_policy` advisories are the documented posture, not a backlog item (AUDIT.7, 2026-08-16).** The security advisor's INFO-level `rls_enabled_no_policy` lint currently flags **44 tables** (`ac_devices`, `ac_external_starts`, `agent_decisions`, `api_keys`, `app_claim_tokens`, `car_enquiries`, `card_receipts`, `checklist_instances`, `checklist_templates`, `claim_link_requests`, `class_booking_requests`, `equipment`, `equipment_inspections`, `equipment_settings`, `equipment_types`, `error_events`, `event_hosts`, `event_reminder_sends`, `glofox_invoices_quarantine`, `glofox_note_pushes`, `glofox_services`, `host_campaign_sends`, `host_campaigns`, `host_contacts`, `host_email_suppressions`, `host_impersonation_log`, `host_users`, `hyrox_class_reminders`, `inbody_backfill_requests`, `inbody_webhook_events`, `instagram_feed_posts`, `issue_attachments`, `issues`, `location_role_permissions`, `location_trusted_ips`, `membership_snapshots`, `membership_transitions`, `pin_login_attempts`, `promo_codes`, `review_login_attempts`, `studio_devices`, `unsubscribe_refusals`, `usage_events`, `usage_rollups_daily` — the exact list drifts as tables are added, re-check `get_advisors` before treating a count as current). Every one of them is reached **exclusively** through service-role `/api` routes (`createServerClient()`, which bypasses RLS per the "Service role... bypasses RLS" bullet above) — none of them is ever queried from the browser-side `createBrowserClient()` (anon/authenticated) path. **RLS enabled with zero policies is deny-all for `authenticated` and `anon`** — Postgres's default when a table has `ENABLE ROW LEVEL SECURITY` and no policy exists is that no row is visible or writable to any non-owner role, full stop. That is fail-closed by construction: if a bug ever routed one of these 44 tables through the browser client instead of an `/api` route, RLS would silently return zero rows rather than leak them, exactly like the `check:rls-restrictive` deny-all pattern documented in `CLAUDE.md`, just achieved by omission instead of an explicit restrictive policy. The actual enforcement layer for these tables is app-code scoping in the `/api` route handlers — `assertLocationAccess()` / an org-membership filter / owner-recipient-master checks, gated by `check:location-scoping` in the CI mirror (see `CLAUDE.md` invariant: *"Service-role routes get NO RLS... Enforce access in app code"*). **Do not "fix" this advisory line with a noise policy** (e.g. a `USING (false)` restrictive covering these tables, or a permissive policy nobody's browser client will ever hit) — it adds surface area without adding protection, since the service-role path it actually matters for bypasses RLS regardless. The 44-table (INFO) advisory count is expected to stay non-zero indefinitely; treat a **new WARN or ERROR-level** advisory on one of these tables as the actual signal to act on, not this INFO line.

**SECURITY DEFINER function audit (AUDIT.7, 2026-08-16).** The advisor's three `authenticated_security_definer_function_executable` WARNs (`public.is_owner`, `public.list_enabled_integrations`, `public.scan_straps_for_contact`) were audited for real callers against both `un1t-crm` and `champ-app` source plus live prod grants/policies. Outcomes (full evidence + rationale in `supabase/migrations/549_security_definer_audit.sql`):
  - **`list_enabled_integrations()` and `scan_straps_for_contact()` — KEEP.** Both are actively called by authenticated champ-app clients (`supabase.rpc(...)`, native + legacy web) and are internally self-scoping (no secrets returned; `scan_straps_for_contact` raises on an unauthenticated caller via `private.auth_contact_id()`). This acceptance predates AUDIT.7 — already recorded across migrations 166, 168, 216, 221 — mig 549 just folds it into one audit record.
  - **`is_owner()` — moved from `public` to `private` schema**, not revoked. It has no client caller anywhere (unlike the other two) but IS used by three live `storage.objects` RLS policies on the `branding` bucket (created by migration 013 with a different inline check; redefined against `is_owner()` out-of-band in prod with no corresponding migration in this repo — a drift, not remediated here). A straight `REVOKE EXECUTE FROM authenticated` was tested transaction-scoped against prod and **does break those policies** (`permission denied for function is_owner`, 42501) — RLS predicates run under the querying role's own EXECUTE privilege, there's no "runs as table owner" exemption for the function call itself. Moving schema instead (mirroring migration 022's identical fix for `auth_is_owner`/`auth_is_owner_or_manager`) removes the `/rest/v1/rpc/is_owner` PostgREST exposure while leaving the `authenticated` EXECUTE grant that RLS needs untouched.


## Audience classification model (CLASSIFY.1+2+3, May–Jun 2026)

The canonical "where is this contact in the funnel" field is `contacts.pipeline_stage_slug`. It's a denormalised mirror of `deals.stage_id → pipeline_stages.slug` for the contact's most recent open deal, kept in sync by an `AFTER INSERT OR UPDATE OR DELETE ON deals` trigger from mig 155. **Operators never write to this column directly** — pipeline assignment flows from Glofox sync (`applyMemberSync` → `ensureDealForContact`) plus the nightly classifier cron (`pipeline-reclassify`); there is no manual stage-move affordance anywhere (web drag-drop, mobile tap-to-move, and the assistant `move_deal` tool were all removed in FUNNEL.1 — a manual write was silently reverted by the next classify pass).

**FUNNEL.1 (2026-07-02, mig 350) replaced the 9 PIPELINE5 slugs with a 5-column acquisition funnel + 3 off-funnel buckets** (`src/lib/pipeline-classifier.js`):

  - **On funnel** (the visible board, `display_order` 301-305): `new_lead` (joined ≤60d, 0 classes attended — keyed on `joined_at`, NOT `lead_created_at`, which is import-poisoned), `first_class` (1 attended), `second_class` (2 attended), `trial_done` (3+ attended, not yet converted — the decision point), `converted` (became member/credit_member ≤60d ago, keyed on `contacts.converted_at`).
  - **Off funnel** (`is_dormant = true`, hidden from the default board view behind the Funnel/Off-funnel tab switcher): `member` (converted >60d ago, or a pre-existing member), `pack_member` — label **"Class Pack"** (FUNNEL.3, mig 356: bought a UN1T credit pack of 4+ classes; sticky via write-once `contacts.pack_customer_at` because a pack purchase IS a conversion — they never re-enter the funnel; membership status outranks it; NOT the same as ClassPass), `classpass` (classpass_payg, always — the third-party aggregator, a distinct motion from the lead funnel), `cold_lead` — label **"Cold"** (FUNNEL.4, mig 391: operator marked "not worth selling to / not interested" via the Cold button on the deal card / contact header → `POST /api/contacts/[id]/pipeline-status {cold}` sets/clears `contacts.pipeline_dismissed_at`; the classifier returns cold_lead while dismissed AND no attendance has landed since, so a class attendance after the dismissal auto-revives them into the funnel; membership/pack/classpass outrank it), `dormant` (aged-out leads, ex-members, ghosts). **The Cold button is the one manual pipeline control** — every other placement is classifier-derived.

  `contacts.converted_at` is write-once, stamped by `applyMemberSync` (`src/lib/glofox-sync.js`) the moment `glofox_membership_status` transitions into `member`/`credit_member` — webhook path is near-instant; the nightly sync is the catch-all. It is **not backfillable** for historical conversions (Glofox never recorded the moment), so mig 350 seeded it from `joined_at` only for members who joined within 60 days of the migration (the launch cohort) — older members simply read as `member` (off-funnel) with no `converted_at`, which is correct, just not retroactively precise.

  The 7 retired PIPELINE5 stages (`active_trial`, `hot_conversion`, `active_member`, `at_risk_member`, `classpass_active`, `lapsed`, `dormant_classpass`) are archived by mig 351, which must run AFTER a post-deploy reclassify commit has moved every open deal off them (the migration's guard clause refuses otherwise). Member lifecycle nuance (at-risk / lapsed) that the old taxonomy tried to express on the pipeline is now the Churn Radar's job, keyed on Glofox status directly — it never read pipeline slugs, so the funnel simplification doesn't affect it.

**`contacts.email_marketing`** (also added in mig 155) is a denormalised mirror of `contact_preferences.email_marketing`, synced by an `AFTER INSERT OR UPDATE OF email_marketing ON contact_preferences` trigger. Audience queries filter directly on the contacts column — no inner-join on `contact_preferences` needed. Treat `contact_preferences` as the source of truth and write to it directly (the trigger propagates); the contacts mirror is read-only as far as app code is concerned.

**Field hierarchy in the AudienceBuilder UI:**

  1. **Stage** (`pipeline_stage_slug`) — primary. The 9 PIPELINE5 slugs. This is what operators reach for intuitively.
  2. **Glofox Raw Status (advanced)** (`glofox_membership_status`) — the Glofox-side status that *feeds* the pipeline classifier. Power-user filter for targeting credit_member upsells or classpass_payg cohorts specifically. Don't reach for this by default.
  3. **Email Status, Lead Source, Has Phone, etc.** — orthogonal axes.

**`contacts.lead_status` has been removed (CLASSIFY.3, mig 156, applied 2026-05-13).** It was the legacy "where in the funnel" field but was never maintained — 99.9% of Stillorgan contacts had the import default `'active_trial'` and no code reliably wrote `'member'` or other meaningful values back. CLASSIFY.2 (commit `2d9c966`) removed every read+write from app code; CLASSIFY.3 finished the pass (`mobile/` + `shared/dashboard-data.js`, the `email_sequences.trigger_type='status_change'` → `'pipeline_stage_change'` rename, and JSONB guards on any production audience filters referencing `lead_status`) and `156_classify_3_drop_lead_status.sql` did the `DROP COLUMN` plus dropped the two old indexes (`idx_contacts_lead_status`, `idx_contacts_location_lead_status`). The remaining `lead_status` strings in `src/` are all legitimate: code comments documenting the decommission, the Glofox-payload field (see next paragraph), and back-compat aliases that resolve to `pipeline_stage_slug` — the `?lead_status=` query param on `/api/contacts`, the `{{lead_status}}` merge tag, the `goal.type === 'lead_status'` sequence alias, and a sequence-template `id` string.

**Glofox-side `lead_status` is a different field.** The Glofox `/2.0/members` API has its own `lead_status` field (uppercase enum: `LEAD`/`COLD`/`TRIAL`/`MEMBER` etc.) — completely separate taxonomy. Glofox-facing code (`src/lib/glofox-sync.js`, `src/lib/glofox-push.js`, `src/lib/glofox.js`, `src/app/api/glofox/*`) still reads and writes this. **Don't confuse the two** — anything that reads from a Glofox payload is OK; anything that reads from a local `contacts` row is the column being removed.

**Sequence trigger rename.** CLASSIFY.2 renamed the sequence trigger type `'status_change'` to `'pipeline_stage_change'` and the trigger function `triggerSequencesForStatusChange` to `triggerSequencesForPipelineStageChange`. The trigger now diffs on `contacts.pipeline_stage_slug` instead of `contacts.lead_status`. The one-shot `UPDATE email_sequences SET trigger_type='pipeline_stage_change' WHERE trigger_type='status_change'` ran as step 1 of mig 156 (0 stale rows remain in prod), so operator-created sequences on the old trigger type keep firing.

**Sequence goal `lead_status` type is deprecated but aliased.** `scheduler.isGoalMet` still accepts `goal.type === 'lead_status'` for back-compat but reads `pipeline_stage_slug` under the hood and emits a `console.warn`. New sequences should use `goal.type === 'pipeline_stage'`.


## Glofox interactions sync — member notes/calls/emails (GLOFOX-NOTES, 2026-07)

Glofox's `/2.1/branches/{branchId}/leads/{userId}/interactions` endpoint is the only surface for member-facing notes/calls/emails, and it's narrow: **create + list only** — no update, no delete, no webhook event for interactions. Descriptions are capped at **500 chars** and carry **no author field**. Every design choice below follows from those three constraints.

**Inbound (pre-existing, extended with a provenance chip).** The member-sync poll (`applyMemberSync` in `src/lib/glofox-sync.js`) pulls each member's interactions and `syncGlofoxInteractions` upserts them into `activities` (`onConflict: 'glofox_interaction_id'`, via `mapGlofoxInteraction`) — there's no realtime path, so a front-desk-logged Glofox note lands on the next sync tick, not instantly. The contact Activity/Notes timeline (`src/app/contacts/[id]/page.js`) now tags rows with `item.source === 'glofox'` with a small "Glofox" chip so staff can distinguish a front-desk-logged note from one written in the CRM.

**Outbound (new): notes only, fire-and-forget, create-only.** When a staffer adds a note via the session-authed `POST /api/contacts/[id]/notes` (`ContactActions.jsx` uses this route, not a direct `notes` insert), the route inserts the CRM row and then — un-awaited — calls `pushNoteToGlofox` (`src/lib/glofox-note-push.js`), which:
  1. Loads the contact's `location_id` + `glofox_member_id`; no-ops (not an error) if the contact isn't Glofox-linked or the location has no Glofox creds.
  2. Builds the description via `buildInteractionDescription` (`src/lib/glofox-notes.js`): prefixes `[UN1T CRM · <staff name>] ` (there's no author field on the Glofox side, so attribution has to live in the text) and truncates to 500 chars with an ellipsis marker.
  3. POSTs via `createGlofoxInteraction` (`src/lib/glofox.js`) — `type: 'NOTE'`.
  4. Records the push in `glofox_note_pushes` regardless of success/failure (`status: 'sent'|'failed'`), for audit and for step 5 below.

Because the endpoint is create-only, an edit or delete of the CRM note is **never propagated** — there is no Glofox call that could do it. And because it's the session route (not the API-key `/api/notes` bulk-import path) that carries the author name and fires the push, the import path deliberately does **not** push, to avoid mass-spamming Glofox with thousands of imported historical notes on a bulk import.

**Echo suppression — `glofox_note_pushes` ledger (mig 390, applied).** `createGlofoxInteraction`'s response carries no id to key off, so there's no way to mark "this is ours" at push time. Instead, every push writes a row to `glofox_note_pushes` (`contact_id`, `type`, `description`, `pushed_at`, `glofox_interaction_id` initially NULL, `status`). On the next inbound sync, `syncGlofoxInteractions` loads the contact's unreconciled (`glofox_interaction_id IS NULL`) push rows and fingerprint-matches each incoming interaction against them via `matchesPush` (`src/lib/glofox-notes.js`): exact `description` + `type` + same contact, and the interaction's Glofox `created` (unix seconds) within a 2-hour window of `pushed_at`. On a match, the sync UPDATEs the ledger row (`glofox_interaction_id`, `status: 'reconciled'`) instead of upserting into `activities` — so the pushed note appears exactly once in the timeline. Already-claimed `glofox_interaction_id`s are checked first and skipped on every later sync run (`uq_glofox_note_pushes_interaction`). The claim UPDATE's `{error}` is checked explicitly (supabase-js *resolves* with an error object on an RLS/constraint failure rather than throwing) so a silently-failed claim doesn't fall through to a duplicate upsert.

**Scope (operator-approved, Richard 2026-07-04): notes only.** Call/email touchpoints are **not** mirrored outbound — the CRM's call/email `activities` are to-do tasks (things staff plan to do), not completed-touchpoint logs, so pushing one to Glofox as a member-facing comment would misrepresent it. Only Glofox-linked contacts (`glofox_member_id` set) push; contacts without a Glofox link, or at a non-Glofox location (CCF Autos, SourceIt), silently no-op.


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


## Multi-vendor comms architecture

> **Unified send surface (Pillar 2, 2026-06, PRs #355–#358).** One-off "message off the cuff" sends now go through **one audience-first surface at `/communications/send`** (`UnifiedSendComposer.jsx`): pick audience (`AudienceBuilder` + live `/api/communications/audience-count`) → pick channel (SMS / WhatsApp / Email) → compose → send-now or schedule (SMS). It's a **facade**: on send it creates the *existing* per-channel record (`sms_broadcasts` / `whatsapp_broadcasts` / `campaigns`) and fires the *existing* send routes + crons — **the send libs + crons in the tables below are untouched.** Email collects audience+subject then hands off to the proven Unlayer editor (`/email/campaigns/[id]?edit=1`) — Unlayer was NOT re-hosted (it's a `window.unlayer` global; a fresh embed is risky). Unified history at `/communications/sent`. **As of PRUNE.1 (2026-08), every old per-channel page — list, "new", and detail `[id]` alike (campaigns / WA-broadcasts / SMS-broadcasts / sequences) — is deleted, not kept.** URL back-compat is config-level, not filesystem: `legacy-redirects.js` (wired into `next.config.js`) 307-redirects each old path to its unified-surface equivalent, including `/email/campaigns/[id]?edit=1` → `/communications/sent/email/[id]?edit=1` for links already delivered in past notification emails. The 4 still-live template editors (email/WhatsApp, new + `[id]`) aren't part of that retirement — they were moved verbatim into the canonical tree at `/communications/templates/{email,whatsapp}/{new,[id]}`, inside the `(editors)` route group (full-screen, no hub chrome) alongside `(hub)` (`CommsShell` + tabs) under a shared gate-only root layout. Don't add new compose UI to the retired paths — extend `UnifiedSendComposer`. Design + decisions: `docs/PILLAR2_UNIFIED_SEND_2026-06.md`.

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
| `membership_state_change` | `triggerSequencesForMembershipStateChange(contactId, oldState, newState)` from `glofox-sync.js applyMemberSync` | `from_state?`, `to_state?` (active/paused/locked) | `'<old>→<new>'` |

All triggers respect the sequence's `audience_filter` via `contactMatchesSequenceAudience(contactId, filter)` — single-row reachability check using `applyAudienceFilter` so the same field/op allowlist as campaigns + broadcasts applies. All triggers are best-effort (errors swallowed + logged) so they can never fail the upstream user mutation.

**Sequence enrolment UI.** `SequencePicker.jsx` is a shared component used in three places: contact detail page (popover, next to + Note / + Activity), pipeline deal cards (3-dots menu → centred modal), and contact list (bulk select with sticky action bar → centred modal). Lists every active sequence at the location with trigger-type chips so operators can pick a manual or automated sequence ad-hoc.

**Saved contact segments (mig 043).** Operator builds an advanced filter on `/contacts` page using the existing `AudienceBuilder`, then saves as a named segment. Stored in `contact_segments` with the same JSON shape as `campaigns.audience_filter` — easy to promote a segment into a campaign / sequence audience later. CRUD via `POST /api/contacts/segments`, `PUT/DELETE /api/contacts/segments/[id]`. UI in `ContactsView.jsx` renders saved segments as chips above the AudienceBuilder; clicking applies the filter, hovering shows a delete X.


## Performance posture

Audit ran in May 2026 captured several wins worth knowing about:

- **`getCurrentUser()` is wrapped in React.cache()** (`src/lib/auth.js`) so multiple server components in one request share a single auth lookup. Falls back to identity in the test environment (where react/server build isn't loaded).
- **Auth queries parallelised** — profile fetch + impersonation cookie load + (master only) all-locations fetch run concurrently. Saves a roundtrip per page load on every authenticated route.
- **`report-generator.js` queries parallelised** via `Promise.all` for staff_cost / roster_coverage / utilisation. Roughly halved the heaviest cron.
- **`bookings(location_id, booking_date DESC)` index** (mig 041) — every bookings query filters by location, the original mig 002 only indexed contact/event/date/status. Was a full-scan that worsened with table size.
- **`contacts(location_id, pipeline_stage_slug)`** partial index for the pipeline (replaced the old `(location_id, lead_status) WHERE lead_status IS NOT NULL` index — mig 155 added the new one; CLASSIFY.3 / mig 156 dropped the old one + the column).
- **Public pages statically rendered** — `/book/[slug]`, `/preferences/[token]`, `/unsubscribe/[token]`, `/deposit/[token]` all dropped reflexive `force-dynamic`. Vercel serves a CDN-cached HTML shell instead of running a server render every load.
- **`CarDetail.jsx` code-split** — `XeroCard`, `DocumentsCard`, `DepositCard`, `NotesCard` are dynamic-imported and only rendered for cars in pending/completed status. New-status car detail loads don't ship that JS.
- **`WAInbox` uses Supabase Realtime, not polling** (mig 042 publishes `whatsapp_conversations` + `whatsapp_messages`). 60s heartbeat poll kept as a safety net for missed events. Was previously 10s polling = ~432k requests/day at 50 active users.
- **OpenAPI spec cached via `unstable_cache`** with 24h revalidate so cold-started lambdas don't rebuild the spec from scratch. Module-level `cachedSpec` still handles within-lambda hits. Falls back to direct generation in Vitest where there's no Next runtime.

Things to watch but NOT act on without measurement:

- **WAInbox 60s heartbeat** — wait a few weeks of real Realtime data before deciding whether to drop the heartbeat. If nothing's missed, push to 5min or remove.
- **`'use client'` audit** — 172 components marked client; some likely don't need it. Modest bundle wins, low ROI, no measurement yet. (The `recharts` charting lib is now lazy-loaded via `next/dynamic` in `MembershipTrendChart.jsx` — TECH-DEBT.1 — so it's no longer in the main dashboard bundle.)


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

**Adding new organizations.** "Add organization" button at the top-right of `/admin/matrix` opens a modal with name + slug fields (slug auto-derived from name as the operator types, editable for custom values). POSTs to `/api/admin/organizations` (master only, validates slug uniqueness with a clean 409 message on conflict). After creation the matrix refreshes; since both matrices are location-driven they skip orgs with zero locations, so a freshly created org surfaces as an amber "no locations yet" notice at the top of /admin/matrix (EMPTY-ORG.1) linking to the location create form, rather than as a matrix section. Operator's next step is `/settings/locations/new` to create the first location under the new org — the location create form picks the org from a dropdown (master sees all active orgs). For existing locations the org is shown read-only because moving a location between orgs is rare and would change RLS visibility for every member at the destination org; do that via SQL with intent if ever needed.

**Why it exists:** with two organizations and a handful of locations, clicking through `/settings/locations/[id]` for each one to flip a feature is fine. With three+ tenant businesses on the platform, the per-location flow becomes friction. The matrix lets a master see and modify the entire platform's posture from one screen, which is also the right shape for the eventual "tenant onboarding" flow (provisioning a new org → bulk-toggle features for all its locations → add their team in bulk via the bulk action bar).





---

# Appendix — long-form of sections condensed in CLAUDE.md

_Companion projects + customer-auth model, full coding conventions, the deployment/cron inventory, and the extending checklists. The lean CLAUDE.md carries the summary; this is the full text._

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

In-class TV display + the HR bridge service for live heart-rate aggregation:
  - **TV display**: a public route in *this* CRM (matches the existing `/race/[slug]/tv` pattern) — no auth, reads aggregated session state for a single location.
  - **HR bridge**: separate `champ-bridge` repo (Node.js, runs on a Pi at each gym). Reads chest straps over **ANT+** (primary — connectionless, one USB stick covers a whole 15-20 person class) and **BLE** (fallback for BLE-only straps). Batches samples and POSTs them to `/api/bridge/*` in *this* CRM over HTTPS. Bridges authenticate with admin-issued bearer tokens stored sha256-hashed in `ble_bridges.api_token_hash`; register + rotate them at `/admin/bridges` (master-only).

Straps are identified by a protocol-aware **`device_key`** — `ant:<deviceNumber>` or `ble:<MAC>` (mig 193). One `text` column carries it everywhere: `contact_devices.identifier`, `strap_assignments.strap_identifier`, `heart_rate_sessions.device_identifier`. Protocol is encoded in the key so it can't drift and ANT+/BLE ids can't collide. The helpers (`makeDeviceKey` / `parseDeviceKey` / `canonicaliseDeviceKey`) live in `src/lib/bridge-samples.js` and are duplicated verbatim into champ-bridge (`device-key.js`) and champ-app (`heart-rate-devices.js`).

Schema for the heart-rate work (mig 110 + `contact_devices` in mig 112, made protocol-aware by mig 193): `heart_rate_sessions`, `hr_samples`, `hr_provider_connections` (OAuth tokens), `ble_bridges`, `strap_assignments`, `contact_devices`, plus `contacts.user_id` and `contacts.max_hr_override`. RLS on all new tables — staff at the location can read, customers can read their own, writes are service-role only (the bridge + sync workers).

### Tech Stack

React 19 + Next.js 16, Tailwind CSS 3.4, Supabase Auth (SSR cookies), Postmark (email), WhatsApp Cloud API (Meta v21.0), Zod (input validation), `@asteasolutions/zod-to-openapi` (spec generation), Vitest (testing), `@dnd-kit` (pipeline kanban), lucide-react icons, clsx.


## Coding conventions

These patterns are enforced across the codebase; follow them when adding routes or features.

**UI primitives (UI-FOUND.2+).** Shared presentational primitives live in `src/components/ui/` — `Button`, `Modal`, `Card`, `Field`, `Table` — exported from `@/components/ui`. New components compose these instead of re-implementing buttons/modals/cards/tables/labelled-fields by hand. Variant/size/aria logic lives in `src/components/ui/styles.js` (pure, unit-tested in `styles.test.js`); the `.jsx` files stay thin. Icon-only buttons use `<Button variant="ghost" size="icon" icon={…} />`. Modals that must force an explicit acknowledgement before closing pass `dismissable={false}`. Adoption is opportunistic — when you open an existing component for a feature/bugfix, migrate its ad-hoc buttons/modals to the primitives while you're there. Colours come from the intent-named `un1t-*` tokens (`bg/surface/border/muted/subtle/text/accent`) — never the old inverted names, and avoid new raw hex literals in `className`.

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

Reference implementation: `src/lib/pipeline-reclassify.js` (contacts + deals). Don't re-roll — copy from there.

**Light theme palette — text on light cards.** The codebase migrated to a light theme; `un1t-surface` (#F7F8FA) is a near-white card background — it was called `un1t-dark` until UI-FOUND.1, which is the confusion the rename removed. Status text on these cards needs the **-700 ramp**, not -300. The dark-theme-tuned values (`text-amber-300`, `text-red-300`, `text-blue-100`) look washed-out and unreadable against the light surface.

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

Why: a single migration that drops + replaces is irreversible; a two-stage migration lets us roll back the code change without DB-side action if the new path proves wrong. Examples of the convention working end-to-end: `event_types.reminder_*` (mig 076 deprecated → **dropped in mig 241** after verifying zero readers + no fn/view/trigger refs + zero live data), `public.shifts` (mig 067 deprecated in favour of `shift_blocks` + `shift_assignments`; mig 068 + 069 kept it trigger-mirrored during cutover; **fully dropped in mig 238**). **Not yet droppable** (incomplete cutover — still dual-written/read): the `profiles` comp columns (`annual_salary`/`hourly_rate`/`overtime_rate`/`contracted_hours_per_week`/`annual_leave_entitlement`) migrated to `profile_compensation` but the read path still hits `profiles` in `assistant/chat`, `contracts`, `invoices` + `staff` dual-writes both — cut the reads over before dropping.


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

**New approval surface (APPROVALS.1 registry):** the `/approvals` dashboard aggregates everything awaiting operator review behind a single sidebar entry. Adding a new approvable surface (e.g. customer dispute reviews, contract revision requests, refund authorisations) is one new file plus one line:

1. Create `src/lib/approvals/providers/<key>.js` exporting a provider object — `{ key, label, reviewBase, fetchPending(db, user), countPending(db, user) }`. Look at `providers/contractor-invoices.js` as the canonical template — same select-shape + role-scoping (master sees all, owner sees their locations, manager/head_coach get schedule items via `scheduleApproverLocationIds`). Return `ApprovalItem`s with the standard `{ id, title, subtitle, meta, submittedAt, amount, currency, reviewUrl }` shape so the inbox UI renders without modification.
2. Register it in `src/lib/approvals/registry.js`'s `APPROVALS_PROVIDERS` array.
3. Make sure the underlying table's `?focus=<id>` URL param actually highlights the row on the source page — that's the drill-in target from the inbox.

The sidebar badge, browser tab title, count endpoint, and `/approvals` tab all pick up the new provider automatically. **No new permission, no new sidebar entry, no new API route.** Existing tests in `src/lib/approvals/registry.test.js` exercise the registry shape contract; a new provider only needs unit coverage for its own scoping logic if it does anything non-standard.

**New cron job:** API route at `src/app/api/cron/[name]/route.js` (auth via `Authorization: Bearer ${CRON_SECRET}`) + entry in `vercel.json` `crons` array.

**New role or role-list change:** Update `roleSchema`, `ADMIN_ROLES`, `MANAGER_ROLES` in `src/lib/schemas.js` (single source of truth) and the `defaultPermissionsByRole` map in `src/components/StaffForm.jsx`. The `private.auth_is_owner_or_manager()` / `private.auth_role()` helpers (originally migration 014, moved to `private` schema in 022) may also need a follow-up migration if the new role has elevated DB-level write access.

**New audience filter field:** Add to `AUDIENCE_FIELDS` in `src/lib/audience-filter.js` AND to `FIELD_OPTIONS` in `src/components/AudienceBuilder.jsx`. The whitelist is server-enforced, so missing it on the server side will silently drop the filter.


