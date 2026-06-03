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

Tests live alongside source as `*.test.js` (Vitest). Covers the security-critical lib helpers in `src/lib/` — webhook signatures, audience-filter whitelist, Zod validation, rate limiting, schema invariants — plus the policy contracts that drive permissions, contact merge, sequence cooldowns, branch routing, and so on. **~2950 tests as of mig 242** (now includes route-level idempotency tests for the Revolut money webhooks + deposit pay flow, TEST.1/.2), run in a few seconds, no DB required (lib helpers are pure).

Migrations are run via Supabase MCP from this session, or manually in the Supabase SQL Editor.

### Before pushing — run the full CI mirror locally

The Web CI workflow (`.github/workflows/web-ci.yml`) runs three steps in order: vitest, ESLint, mobile-parity. Push hygiene = run all three before `git push`:

```bash
npm test && npm run lint && npm run check:mobile-parity
```

> **⚠️ The CI mirror does NOT include `next build` — and green vitest+eslint does NOT mean the production build passes.** This has bitten repeatedly. Tests run on mocked imports, so a **missing/renamed export or an unresolvable `import`** (a route importing a function that doesn't exist) sails through vitest + eslint and only fails in Vercel's Turbopack build. Real example (2026-06): an IG inbox send-route imported a non-existent `getDecryptedChannelToken` — 2,800 tests green, lint clean, **Vercel build red**. There is no import-resolution lint rule. **For any change that adds an import or a new route/page, run a real production build before pushing:**
> ```bash
> npm run build    # the only check that catches import-resolution + Turbopack failures
> ```
> In a sandboxed/cloned environment a real `next build` often isn't possible (a symlinked `node_modules` breaks Turbopack; copying it fills the disk) — in that case **the Vercel check on the PR is the real gate, NOT the CI "Test & lint" check**. Never treat a green "Test & lint" as "safe to merge." This is the single biggest reason to do build-heavy work in Claude Code (real local `next build`) rather than a sandbox.

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

### Shipping from the sandbox — branch → push → PR

Every non-trivial change ships as a branch + PR, not a direct push to `main`. The Cowork sandbox can do the whole loop end-to-end including the PR creation. **Stop at the push and the work is not shipped** — the user has to manually open the PR, which is the wrong default. Always open the PR yourself once the push succeeds.

#### Where the GitHub PAT lives

Two equivalent options. **The `.git/config` route is the path of least resistance from the sandbox** — the Cowork harness embeds a scoped PAT into the repo's `origin` remote URL when it mounts the workspace, so the credential is already wired up:

```bash
# Extract the PAT from the remote URL that the harness configured.
TOKEN=$(git config --get remote.origin.url | sed -E 's|.*x-access-token:([^@]+)@.*|\1|')
```

Backup: a longer-lived PAT also lives at `/Users/richardivers/code/.github-pat` (one directory above this repo, mounted into the sandbox at `/sessions/<session>/mnt/code/.github-pat`). Use this when the `.git/config` token has been rotated or is missing:

```bash
TOKEN=$(cat /Users/richardivers/code/.github-pat | tr -d '[:space:]')
```

**Never echo the token into the conversation or commit it to the repo** — GitHub's secret scanner will revoke it the moment a commit lands with a `github_pat_…` literal in it.

#### The canonical ship loop

```bash
# 1. Branch off main (always — even one-line fixes).
cd /sessions/<session>/mnt/code/un1t-crm
git checkout main && git pull origin main
git checkout -b descriptive-kebab-case-branch

# 2. Make changes, then run the full CI mirror locally before pushing.
npm test && npm run lint && npm run check:mobile-parity

# 3. Commit with a structured message — first line = subject, blank line, body.
git add -A
git commit -m "TICKET.X — one-line summary

Longer description: what changed, why, what the user/operator sees.
Cite migrations, file paths, and any non-obvious tradeoffs.

Verified: N tests pass, lint clean, build clean, parity clean."

# 4. Push.
git push -u origin descriptive-kebab-case-branch

# 5. OPEN THE PR. This step is mandatory — pushing is not shipping.
TOKEN=$(git config --get remote.origin.url | sed -E 's|.*x-access-token:([^@]+)@.*|\1|')
curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/ivers9307-cyber/un1t-crm/pulls \
  -d @- <<'JSON' | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('html_url') or r.get('message') or r)"
{
  "title": "TICKET.X — one-line summary",
  "head": "descriptive-kebab-case-branch",
  "base": "main",
  "body": "Markdown body — same structure as the commit message but with **headings**, bullet lists, code blocks, and any verification notes. Cite the affected migrations, files, env vars. End with a 'Verified:' line summarising tests/lint/build/parity."
}
JSON
```

The curl returns the PR's `html_url` (e.g. `https://github.com/ivers9307-cyber/un1t-crm/pull/45`) on success, or the GitHub API error message on failure. Report the URL back to the user.

#### Why every change branches

- **Vercel** auto-deploys every push to `main` so direct commits to `main` ship to production with no review window.
- **CI** (`.github/workflows/web-ci.yml`) runs on `pull_request` too (since #192 CI-FIX.1), so the PR gets a green check before merge.
- **Rollback** is one click on a merged PR vs. surgical revert commits on `main`.

#### Common variations

- **Stacked PRs**: branch off the parent branch (`git checkout -b child-feature parent-feature`) instead of `main`. After the parent merges, GitHub auto-rebases the child onto `main` if there's no conflict. Use sparingly — easier to land independent branches in any order.
- **Doc-only changes**: still branch + PR. The session-state docs and CLAUDE.md updates ride the same workflow as code.
- **Hotfixes** that need to bypass CI: still branch + PR + merge, then deploy. Don't push to `main` directly.

#### Why the sandbox doesn't have `gh`

The `gh` CLI isn't installed in the Cowork sandbox image. The curl-against-`api.github.com` pattern above is the substitute and is functionally identical for opening PRs (and could be extended to comment/review/merge if needed — see the [PRs API docs](https://docs.github.com/en/rest/pulls/pulls)).

## API Reference

OpenAPI 3.1 spec is generated from the Zod schemas in `src/lib/schemas.js` via `src/lib/openapi.js` and exposed at:

- `/api/openapi.json` — raw JSON spec (auth required, same as any API route)
- `/api-docs` — Swagger UI viewer (raw HTML route handler so it bypasses the app's root layout)

When adding a new route or schema, register it in `src/lib/openapi.js` so the spec stays in sync. The cached spec rebuild happens on the first request after deploy; downstream tools (Stoplight, Postman) can re-import freely.

## Architecture

UN1T CRM is a Next.js 16 App Router application with Supabase (PostgreSQL) backend, built for gym lead management and operations across multiple locations.

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

~240 migrations (numbered to 242) in `supabase/migrations/`. Key tables:

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

## Audience classification model (CLASSIFY.1+2+3, May–Jun 2026)

The canonical "where is this contact in the funnel" field is `contacts.pipeline_stage_slug`. It's a denormalised mirror of `deals.stage_id → pipeline_stages.slug` for the contact's most recent open deal, kept in sync by an `AFTER INSERT OR UPDATE OR DELETE ON deals` trigger from mig 155. **Operators never write to this column directly** — pipeline assignment flows from Glofox sync (`applyMemberSync` → `ensureDealForContact`) plus the nightly classifier cron (`pipeline-reclassify`). The 9 PIPELINE5 slugs are:

  `new_lead`, `active_trial`, `hot_conversion`, `active_member`, `at_risk_member`, `classpass_active`, `lapsed`, `dormant`, `dormant_classpass`

**`contacts.email_marketing`** (also added in mig 155) is a denormalised mirror of `contact_preferences.email_marketing`, synced by an `AFTER INSERT OR UPDATE OF email_marketing ON contact_preferences` trigger. Audience queries filter directly on the contacts column — no inner-join on `contact_preferences` needed. Treat `contact_preferences` as the source of truth and write to it directly (the trigger propagates); the contacts mirror is read-only as far as app code is concerned.

**Field hierarchy in the AudienceBuilder UI:**

  1. **Stage** (`pipeline_stage_slug`) — primary. The 9 PIPELINE5 slugs. This is what operators reach for intuitively.
  2. **Glofox Raw Status (advanced)** (`glofox_membership_status`) — the Glofox-side status that *feeds* the pipeline classifier. Power-user filter for targeting credit_member upsells or classpass_payg cohorts specifically. Don't reach for this by default.
  3. **Email Status, Lead Source, Has Phone, etc.** — orthogonal axes.

**`contacts.lead_status` has been removed (CLASSIFY.3, mig 156, applied 2026-05-13).** It was the legacy "where in the funnel" field but was never maintained — 99.9% of Stillorgan contacts had the import default `'active_trial'` and no code reliably wrote `'member'` or other meaningful values back. CLASSIFY.2 (commit `2d9c966`) removed every read+write from app code; CLASSIFY.3 finished the pass (`mobile/` + `shared/dashboard-data.js`, the `email_sequences.trigger_type='status_change'` → `'pipeline_stage_change'` rename, and JSONB guards on any production audience filters referencing `lead_status`) and `156_classify_3_drop_lead_status.sql` did the `DROP COLUMN` plus dropped the two old indexes (`idx_contacts_lead_status`, `idx_contacts_location_lead_status`). The remaining `lead_status` strings in `src/` are all legitimate: code comments documenting the decommission, the Glofox-payload field (see next paragraph), and back-compat aliases that resolve to `pipeline_stage_slug` — the `?lead_status=` query param on `/api/contacts`, the `{{lead_status}}` merge tag, the `goal.type === 'lead_status'` sequence alias, and a sequence-template `id` string.

**Glofox-side `lead_status` is a different field.** The Glofox `/2.0/members` API has its own `lead_status` field (uppercase enum: `LEAD`/`COLD`/`TRIAL`/`MEMBER` etc.) — completely separate taxonomy. Glofox-facing code (`src/lib/glofox-sync.js`, `src/lib/glofox-push.js`, `src/lib/glofox.js`, `src/app/api/glofox/*`) still reads and writes this. **Don't confuse the two** — anything that reads from a Glofox payload is OK; anything that reads from a local `contacts` row is the column being removed.

**Sequence trigger rename.** CLASSIFY.2 renamed the sequence trigger type `'status_change'` to `'pipeline_stage_change'` and the trigger function `triggerSequencesForStatusChange` to `triggerSequencesForPipelineStageChange`. The trigger now diffs on `contacts.pipeline_stage_slug` instead of `contacts.lead_status`. The one-shot `UPDATE email_sequences SET trigger_type='pipeline_stage_change' WHERE trigger_type='status_change'` ran as step 1 of mig 156 (0 stale rows remain in prod), so operator-created sequences on the old trigger type keep firing.

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

Why: a single migration that drops + replaces is irreversible; a two-stage migration lets us roll back the code change without DB-side action if the new path proves wrong. Examples of the convention working end-to-end: `event_types.reminder_*` (mig 076 deprecated → **dropped in mig 241** after verifying zero readers + no fn/view/trigger refs + zero live data), `public.shifts` (mig 067 deprecated in favour of `shift_blocks` + `shift_assignments`; mig 068 + 069 kept it trigger-mirrored during cutover; **fully dropped in mig 238**). **Not yet droppable** (incomplete cutover — still dual-written/read): the `profiles` comp columns (`annual_salary`/`hourly_rate`/`overtime_rate`/`contracted_hours_per_week`/`annual_leave_entitlement`) migrated to `profile_compensation` but the read path still hits `profiles` in `assistant/chat`, `contracts`, `invoices` + `staff` dual-writes both — cut the reads over before dropping.

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

**New approval surface (APPROVALS.1 registry):** the `/approvals` dashboard aggregates everything awaiting operator review behind a single sidebar entry. Adding a new approvable surface (e.g. customer dispute reviews, contract revision requests, refund authorisations) is one new file plus one line:

1. Create `src/lib/approvals/providers/<key>.js` exporting a provider object — `{ key, label, reviewBase, fetchPending(db, user), countPending(db, user) }`. Look at `providers/contractor-invoices.js` as the canonical template — same select-shape + role-scoping (master sees all, owner sees their locations, manager/head_coach get schedule items via `scheduleApproverLocationIds`). Return `ApprovalItem`s with the standard `{ id, title, subtitle, meta, submittedAt, amount, currency, reviewUrl }` shape so the inbox UI renders without modification.
2. Register it in `src/lib/approvals/registry.js`'s `APPROVALS_PROVIDERS` array.
3. Make sure the underlying table's `?focus=<id>` URL param actually highlights the row on the source page — that's the drill-in target from the inbox.

The sidebar badge, browser tab title, count endpoint, and `/approvals` tab all pick up the new provider automatically. **No new permission, no new sidebar entry, no new API route.** Existing tests in `src/lib/approvals/registry.test.js` exercise the registry shape contract; a new provider only needs unit coverage for its own scoping logic if it does anything non-standard.

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
- **`contacts(location_id, pipeline_stage_slug)`** partial index for the pipeline (replaced the old `(location_id, lead_status) WHERE lead_status IS NOT NULL` index — mig 155 added the new one; CLASSIFY.3 / mig 156 dropped the old one + the column).
- **Public pages statically rendered** — `/book/[slug]`, `/preferences/[token]`, `/unsubscribe/[token]`, `/deposit/[token]` all dropped reflexive `force-dynamic`. Vercel serves a CDN-cached HTML shell instead of running a server render every load.
- **`CarDetail.jsx` code-split** — `XeroCard`, `DocumentsCard`, `DepositCard`, `NotesCard` are dynamic-imported and only rendered for cars in pending/completed status. New-status car detail loads don't ship that JS.
- **`WAInbox` uses Supabase Realtime, not polling** (mig 042 publishes `whatsapp_conversations` + `whatsapp_messages`). 60s heartbeat poll kept as a safety net for missed events. Was previously 10s polling = ~432k requests/day at 50 active users.
- **OpenAPI spec cached via `unstable_cache`** with 24h revalidate so cold-started lambdas don't rebuild the spec from scratch. Module-level `cachedSpec` still handles within-lambda hits. Falls back to direct generation in Vitest where there's no Next runtime.

Things to watch but NOT act on without measurement:

- **WAInbox 60s heartbeat** — wait a few weeks of real Realtime data before deciding whether to drop the heartbeat. If nothing's missed, push to 5min or remove.
- **`'use client'` audit** — 172 components marked client; some likely don't need it. Modest bundle wins, low ROI, no measurement yet. (The `recharts` charting lib is now lazy-loaded via `next/dynamic` in `MembershipTrendChart.jsx` — TECH-DEBT.1 — so it's no longer in the main dashboard bundle.)

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

**When a third-party OCR vendor is the accuracy bottleneck, push structured fields instead of pushing the file.** We spent months relying on Xero's email-to-bills + Hubdoc OCR for supplier invoices and it was consistently wrong on UK/IE invoices — supplier names mangled, totals off, account codes missed. The fix wasn't a better OCR tier — it was inverting the flow: do the OCR ourselves with Claude Vision (which the operator was already reviewing), let the bookkeeper pick the exact Xero account + supplier inline from a cached chart-of-accounts + contacts list (Dext's posture), and then push a fully-formed `Type=ACCPAY/Status=DRAFT` invoice via the `/Invoices` API. End state: what the bookkeeper sees in `/invoices` is what arrives in Xero, byte-for-byte. Three-PR series XERO-API.1 → .2 → .3 (mig 186 + 187, PRs #53, #54, #55). The general principle: if a vendor's OCR is the worst link in your pipeline, replace it with structured payloads + a cache of the vendor's reference data, not with a different OCR vendor.

**Stacked PRs on GitHub don't auto-propagate to main — open every PR with `base=main`.** When you open a PR with `base=<feature-branch>` (the stacked-PR pattern), the merge lands the child's content INTO that base branch, NOT into main. If the parent has already merged into main BEFORE the child does, the child's merge becomes a dead-end commit on a stranded feature branch — the work never reaches production. This bit twice in the INVOICES-QUEUE.1 series: PR #47 was `base=invoices-inbox`, PR #49 was `base=invoices-queue-pr1`. Both reported `merged=true` to the API but nothing flowed to `main`. Recovery required a fresh `invoices-queue-pr2 → main` PR (#50) and a manual conflict-resolve merge. **The "cleaner diff" upside of stacked PRs isn't worth the stranding risk.** Default: always `base=main`, even when the new PR depends on an in-flight one. GitHub auto-deduplicates the diff once the parent merges — the child's diff narrows to just its own changes without any action from you.

**Shipping = branch + commit + push + PR. Stopping at the push is not shipping.** Pushing a feature branch without also opening a PR leaves the work in limbo — Vercel doesn't preview branches without a PR, CI doesn't run the `pull_request` workflow until the PR is opened, and the operator has to manually click through GitHub's "create PR" UI. The Cowork sandbox doesn't ship with `gh` but the GitHub REST API + curl is functionally equivalent — see the canonical loop in "Shipping from the sandbox" above. Whenever a change ships, the response to the user should include the PR URL, not just "I pushed it." This bit on the INVOICES.1 ship — the user explicitly asked "why no pr?" because the assistant stopped at `git push`. Now codified.

**Read vendor docs for the version you've pinned.** When integrating a third-party API (Revolut, Twilio, Stripe, etc.), always parse the OpenAPI spec / SDK source for the EXACT version you're targeting before writing client code. Don't work from cached knowledge of an older version. Two specific cases that bit on the Revolut integration: `capture_mode` enum casing (changed from `AUTOMATIC` upper-snake to lowercase `automatic` between versions) and the SDK token field name (`public_id` deprecated, replaced by `token`). Both produced misleading error messages that cost a round-trip with the user to fix. The OpenAPI spec is authoritative — if the docs page is a JS-rendered SPA that doesn't fetch cleanly, get the YAML from the vendor's openapi GitHub repo instead.

**supabase-js builders are thenables, not Promises — they have `.then` but no `.catch`.** The objects returned by `db.from(...)`, `db.rpc(...)`, `db.storage(...)` in @supabase/supabase-js v2 are PostgrestFilterBuilder / similar — they implement a custom `.then` to fire the underlying HTTP request when awaited, but they do NOT have a `.catch` method. The pattern `await db.rpc('foo', {...}).catch(() => {})` throws TypeError `e.rpc(...).catch is not a function` at runtime — `.catch` is invoked on the builder before the await unwraps it, and the builder doesn't have that method. The outer try-block (if any) catches the TypeError; the rpc itself never executes. This is a silent failure: error gets logged, downstream code thinks the rpc completed. **Right pattern**: `try { await db.rpc(...) } catch {}`. **Same caveat applies to**: `.from(...).insert(...)`, `.from(...).update(...)`, `.storage(...)`, anything returning a Postgrest builder. **Safe variants**: `db.from(...).insert(x).then(() => {}, () => {})` works because `.then` IS a method on the builder and returns a real Promise that has `.catch`. So `await db.rpc(...).then(() => {}).catch(() => {})` is also fine. **History**: bit us silently for 4 days (May 13–17 2026) until the pre-onboarding audit caught 728 stuck Postmark Open/Click events. Affected only the open/click webhook handlers + sequence step rpcs — Delivery / Bounce / SpamComplaint code paths used different patterns and were unaffected. Fix in HOTFIX #172 (see [docs/CHANGELOG.md](docs/CHANGELOG.md)). The whole src/ tree was swept; zero instances of the pattern remain.

**iOS auto-back-button only works WITHIN one navigator.** When you push from `(tabs)/X` into a screen under `app/X/[id]`, the destination lives in a different navigator from the tab — expo-router treats them as separate stacks. iOS's automatic back chevron only renders when the *current* navigator has a previous screen; cross-navigator pushes look like a fresh stack to iOS, so the chevron is absent (swipe-back gesture still works, but discoverability is gone). The fix is an explicit `Stack.Screen options={{ headerLeft: () => <BackHeaderLeft .../> }}`. Use the shared `mobile/components/BackHeaderLeft.jsx` — it handles `router.canGoBack()` and a `fallbackHref` for the cold-start push-notification case where the stack is empty. This bit twice already: pipeline + whatsapp (Apr 30, d442a36) and tasks + bookings (NOTIF.2). Whenever you create a new single-screen sub-stack that's reached from a tab, add the BackHeaderLeft.

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

- **Next 14 caches third-party fetch responses inside the data cache, even on `force-dynamic` routes.** **No longer applies under Next 16** — Next 15+ defaults `fetch()` to `cache: 'no-store'`, so the workaround was retired in NEXT.16-CLEANUP (#179). Keeping the lesson here as durable institutional memory; the failure mode was subtle, the recovery path saved real customer-facing incidents. Original write-up: `dynamic = 'force-dynamic'` opts the route into dynamic rendering and sets fetch defaults to no-store FOR fetches issued by the route's own code. The Supabase JS client opens its own internal fetch instance that doesn't inherit those defaults. Symptom: an UPDATE in Postgres is invisible to the next read on the same deployment until the data cache evicts (or you redeploy). Hit this on 2026-05-05 when extending a deposit token's expiry — the DB row was correct, the API kept returning `TOKEN_EXPIRED` from a stale cached fetch, and `x-vercel-cache: MISS` is no help here because the cache lives at the data-cache layer, not the CDN. Original fix landed in `src/lib/supabase.js` — `createServerClient()` passed `{ global: { fetch: noStoreFetch } }` so every read was fresh. The `noStoreFetch` wrapper plus the `fetchCache = 'force-no-store'` and `revalidate = 0` page exports were all removed in NEXT.16-CLEANUP once the framework default flipped. If a similar caching-mystery shows up under Next 16 or later (someone reads stale data right after a write), the suspect class is the same: a third-party SDK doing its own internal fetches that don't honour a route-level `cache: 'no-store'`. Modern fix is either pass `{ cache: 'no-store' }` explicitly on the inner fetch, or wrap the route's call in `unstable_cache` with a tag and bust the tag on writes.

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

- **Every `<button>` inside a `<form>` defaults to `type="submit"`.** Without an explicit `type="button"`, clicking ANY button — a tab pill, a close X, a non-submit secondary action — submits the surrounding form. Hard-to-spot bug: clicking "Generate password" in the password-override modal silently submitted the parent `StaffForm`, which fired its own `router.push('/settings')` post-save handler and bounced the operator out of the modal before the override request even fired. **Rule:** every `<button>` that isn't the form's primary submit needs `type="button"` declared explicitly. Especially watch for this inside reusable modal components — you can't tell from the modal's source whether it'll be rendered inside a form. AUTH.1 hotfix added `type="button"` to all 6 buttons in `PasswordOverrideModal.jsx`. Same pattern bit a few other places in the codebase before — `StaffForm` itself has 14 explicit `type="button"` declarations for exactly this reason. **Quick audit:** `grep -c '<button' src/components/<file>.jsx` and `grep -c 'type="button"' src/components/<file>.jsx` — counts should match for any non-submit-only component.

- **Don't mix local-time Date parsing with UTC ISO formatting.** `new Date('2026-05-04T00:00:00')` (no `Z` suffix) is parsed as LOCAL time; `new Date('2026-05-04T00:00:00Z')` is UTC. Then `d.toISOString().slice(0, 10)` always returns the UTC date. If you build a "week start" Date with local-time parsing and then format successive days via `toISOString().slice(0, 10)`, you'll silently get dates one day earlier in any TZ east of UTC. roster-summary.test.js had this bug in 3 places — passed in CI (UTC) for months, failed on a Dublin BST mac as soon as anyone ran `npm test` locally. **Two safe patterns:** (a) parse with `'Z'` AND use `getUTCDate` / `setUTCDate` for arithmetic; (b) parse local AND format with the production formatter (`getFullYear` / `getMonth` / `getDate` → `YYYY-MM-DD`) — i.e. don't reach for `toISOString().slice(0, 10)` at all unless your Date is genuinely UTC-anchored. Pattern (b) is what the test fix uses — added an `isoDay(base, offset)` helper that imports `formatDate` from `./roster` so the test stays internally consistent with the production code in any timezone. **General rule for date-y test code:** if the assertion compares an ISO date string, run the test under `TZ=Europe/Dublin` AND `TZ=America/Los_Angeles` once before trusting it — `for tz in UTC Europe/Dublin America/Los_Angeles Asia/Tokyo; do TZ=$tz npx vitest run path/to/file.test.js; done` is a one-shot guard.

- **Wrap `auth.uid()` (and `auth.role()` / `auth.jwt()`) inside `(SELECT …)` in every RLS policy.** A raw `auth.uid()` call in a policy's USING / WITH CHECK clause is re-evaluated **per row** during a query — PG treats it as a stable function but doesn't fold the call into an InitPlan when it's not subqueried. Wrapping turns it into `InitPlan 1 (returns $0)` that runs **once per query** and gets cached; the per-row cost drops from "function call + JWT decode" to "fetch $0 from memory". The Supabase advisor calls this `auth_rls_initplan`. Same wrap works for any stable function whose value is constant within a query (`current_setting('jwt.claims.sub')`, `current_user`, custom `auth_is_master()` helpers — wrap those too). PERF.1 (mig 162) rewrapped 8 policies; pattern is `WHERE pl.profile_id = (SELECT auth.uid())` instead of `WHERE pl.profile_id = auth.uid()`. **General audit query:** `SELECT tablename, policyname FROM pg_policies WHERE schemaname='public' AND ((qual ~ '(^|[^.(])auth\\.(uid|role|jwt|email)\\(\\)' AND qual !~ 'SELECT auth\\.') OR (with_check ~ '(^|[^.(])auth\\.(uid|role|jwt|email)\\(\\)' AND with_check !~ 'SELECT auth\\.'))`. Run after any RLS migration. Related advisor flags to fix in the same pass when they surface: `multiple_permissive_policies` (two policies of the same kind on the same role+command — usually a stray `Service role full access` with `qual=true, roles=public` that grants every db role full access, sitting alongside the real in-location policy; service_role bypasses RLS anyway so the wide-open policy is both a security smell and a perf hit), `unindexed_foreign_keys` (every FK column should have a covering index — `WHERE col IS NOT NULL` partial when nullable so the index is tight), and `duplicate_index` (non-unique twin of a unique constraint — drop the non-unique one; watch out for false positives where the "duplicate" has a different partial WHERE serving a separate query). The ~200 `unused_index` flags are a separate question — "no scans since stats reset" doesn't mean "safe to drop", audit those in a dedicated pass. **Update (PERF-ADVISOR.1, mig 242):** the `unindexed_foreign_keys` (9) + `auth_rls_initplan` (6) classes are now cleared. The 61 `multiple_permissive_policies` were investigated and left alone — they turned out to be mostly *legitimate* `FOR ALL` + `FOR SELECT` overlaps (e.g. "Managers can manage X" + "Managers can view X"), NOT the stray-service-role pattern, so consolidating them needs per-table access-semantics review, not a blind pass.

- **`createServerClient()` (service role) gets NO RLS — never write "RLS enforces visibility" on a service-role route.** Every API route uses the service-role client (it must — the RLS helpers like `assertLocationAccess` are application-layer). RLS policies only bind the `authenticated` / `anon` roles, so they **never** filter a service-role query. Several later-added read routes carried a comment like *"visibility is enforced by RLS — we just SELECT"* and shipped with **no access filter at all**, leaking cross-tenant data to any authenticated staff member (SECURITY-IDOR / audit §1, mig-era 2026-06): `/api/contracts` list+detail (every employment contract incl. salary + signatures), `/api/contacts/[id]/consent-log` (any contact's consent + IP history), and the assistant's CRM tools (unscoped reads + writes). **Rule:** on any service-role route that returns or mutates tenant data, enforce access in the app layer — `assertLocationAccess(user, locationId)` for location-scoped rows, an org-membership filter (`getOwnerOrganizationIds(user)`) for org-scoped ones, recipient/owner/master checks for per-user rows — and return **404 not 403** on a detail route so IDs can't be enumerated. The RLS policy is defence-in-depth for the *authenticated browser* client; it does nothing for the route. Reference fix: `src/app/api/invoices/[id]/route.js`. Audit any new read route by asking *"what filters this if I delete the RLS policy?"* — if the answer is "nothing", it's an IDOR.

- **`supabase.auth.admin.updateUserById` + `auth.admin.signOut(userId, 'global')` is the canonical admin password-override pattern.** When an operator needs to set a user's password directly (vs sending a reset-email link), use the **standard `@supabase/supabase-js` client constructed with the SERVICE_ROLE key** — admin APIs aren't exposed through `@supabase/ssr`'s server client. After `updateUserById({ password })` succeeds, call `signOut(userId, 'global')` to invalidate every existing session for that user (browser, mobile, API tokens — any active access tokens become invalid). The 'global' scope is critical: a per-session signOut leaves other devices logged in with stale credentials. Audit the act of override (who, when, against whom, optional reason) — never store the new password. Show it to the admin once in the response payload so they can pass it to the user via WhatsApp / in-person / etc., then it's gone. AUTH.1 in `/api/admin/password-override` is the reference shape; pattern reusable for any "admin acts on behalf of user" auth operation (email change, MFA reset, etc.). Forced minimum is 12 chars when admin types manually; otherwise use a crypto.getRandomValues-sourced generator over an alphabet that excludes visually-confusable chars (0/O, 1/l/I) and shell specials so the password is safe to dictate over a phone call.

- **Next.js 16 renamed the `middleware` file convention to `proxy` — and Vercel's build pipeline hard-fails on the old name.** Next 16 deprecated `src/middleware.js` + `export function middleware` in favour of `src/proxy.js` + `export function proxy`. For a while builds only emitted a deprecation warning; then a Vercel `@vercel/next` builder rollout turned it into a hard failure — every build died at the `Applying modifyConfig from Vercel` step with `TypeError: The "path" argument must be of type string. Received undefined`, *before* Next started compiling, with the whole stack inside Vercel's own code. Fix (Vercel-support-confirmed, tiny): `git mv src/middleware.js src/proxy.js`, rename the exported function `middleware` → `proxy`; `config.matcher` is unchanged. **The wider diagnostic lesson:** when a Vercel build suddenly hard-fails on a commit whose siblings built green minutes earlier — same build cache, same Node, same CLI — it's an environmental/platform change, not your code. Rule out every repo-side variable by experiment before editing code: a cold local `next build`, a build with the cache skipped, a different Node major. All three passed here, which is exactly what isolated it to Vercel's builder. And watch deprecation warnings — a platform can promote one to a hard error with no notice.

- **A commit pushed to a branch whose PR has already merged is stranded — it never reaches `main`.** Close cousin of the stacked-PR lesson above. After PR #102 (`overdue-tab`) merged, a follow-up fix was committed and pushed to that same `overdue-tab` branch. The push succeeded, but the PR was already closed — so the commit just sat on a dead branch, never reached `main`, and the bug it fixed stayed live in production. Recovery was a fresh branch off `main` + a new PR cherry-picking the orphaned commit. **Once a PR merges, its branch is finished — every follow-up needs a new branch off `main` and its own PR.** And "I pushed it" is never proof of shipped: confirm the commit is actually on `origin/main` (`git log origin/main --oneline | grep …`) before calling it done.

- **Glofox API: cancellation is API-supported; pause is undocumented-but-live; neither is wired into our client yet (2026-06).** Investigated against Glofox's real OpenAPI spec + live probing on the Stillorgan branch. **Cancel** = `POST /v3.0/memberships/{userMembershipId}/cancel`, documented, body `{ when:'ON_DATE'|'NOW'|'END_OF_CYCLE', local_date:'YYYY-MM-DD', reason:<enum> }` — only `ON_DATE` works (`NOW`/`END_OF_CYCLE` are spec-annotated "not supported yet"); **requires** the `x-glofox-impersonated-member-id` header (member-initiated). **Pause** = `POST /v3.0/memberships/{userMembershipId}/pause` — NOT in the published spec, but the route is live: probing it returned `IMPERSONATION_NOT_ALLOWED_FOR_THIS_ROUTE` (a route-specific rule only a resolved route can return), and pause is a staff/admin action authed by api-key/token alone (it REJECTS the impersonation header, opposite of cancel). Exact pause body shape is unconfirmed — ask Glofox API support. **Probing gotcha:** our GET-only `/api/glofox/probe` can't test these (they're POST; a GET 404s with `WRONG_URL / V3.0Controller could not be found` regardless), and a fake membership id must be a valid 24-hex ObjectId or Glofox's router rejects the id shape *before* resolving the route (another misleading `WRONG_URL`). The `user_membership_id` lives on `GET /2.0/members/{id}` → `membership.user_membership_id` (distinct from the catalog `membershipId`). **Consequence for the agent:** the pause/cancel approval queue (mig 234) is correctly draft-and-approve with a human actioning Glofox manually — but auto-action-on-approval (Phase 4) IS buildable for cancel today, and likely for pause once the body shape is confirmed. Add `cancelGlofoxMembership()` / `pauseGlofoxMembership()` to `src/lib/glofox.js` then call from the approval route. **Process note: don't conclude "endpoint doesn't exist" from docs you couldn't fully load — say "unverified."** I twice asserted pause wasn't supported (first from the JS-rendered Swagger I couldn't read, then from the spec's omission); the live API had it. Absence of evidence ≠ evidence of absence.

- **WhatsApp coexistence is NOT a paste-credentials flow — it must be initiated from the CRM via Meta Embedded Signup. Our current integration can't do it.** The `whatsapp_numbers` table has `source: 'coexistence'` and the manual add-number form lets you set it, but that only writes a row — it can't *create* a coexistence link, because there's no token for a Business-app user to paste. Coexistence requires: (1) launching Meta's Embedded Signup dialog from our frontend with `extras.featureType: 'whatsapp_business_app_onboarding'` (the FB JS SDK + a Meta `config_id` — neither exists in the codebase), (2) Meta sends a pairing code to the phone's WhatsApp Business app, (3) on completion Meta returns `{ code, waba_id }` to our window, (4) our backend exchanges the `code` at `/oauth/access_token`, reads `phone_number_id` off the WABA, subscribes the app, and **skips `/register`** (the number is already registered). There's a 24h window post-link to start history sync, and three coexistence-only webhooks we don't handle yet (`history`, `smb_app_state_sync`, `smb_message_echoes` — the last is critical: messages the owner sends *from the phone app* must mirror into the inbox or it desyncs). Full findings + phased build plan + Meta-side Phase-0 steps are in `whatsapp-coexistence-*.md` at the repo root (written 2026-06). The manual form stays correct for **pure Cloud API** numbers (where a system-user token genuinely exists). **Display-name aside:** the real reason coexistence kept coming up is that Meta keeps rejecting the Cloud-API display name with no reason — that's a Business-verification + name-matches-public-presence issue, fixable via Meta Developer Support *appeal* (the only way to get the actual reason), not a connection-method problem.

- **Hatch Street was never actually connected to Glofox; only Stillorgan is live.** Verified in prod: Hatch Street's `settings.glofox.branch_id` is the placeholder string `"your-glofox-branch-id"`, no api_token, no webhook_secret, 0 webhook events in 14 days. Stillorgan (`branch_id 6155764859810329ec3826b3`) is the only working integration (~1,600 events/14d). So when Hatch Street moves to its own platform, there's nothing Glofox-side to "turn off" — the per-location crons already skip it (they require branch_id + api_key + api_token). The new platform needs a second inbound webhook adapter + outbound client keyed to a new `settings.<platform>` block, leaving Stillorgan's Glofox path untouched (the integration is fully per-location). Full data-contract + required-endpoints spec in `hatch-street-platform-integration-spec.md` at the repo root.

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

**Adding new organizations.** "Add organization" button at the top-right of `/admin/matrix` opens a modal with name + slug fields (slug auto-derived from name as the operator types, editable for custom values). POSTs to `/api/admin/organizations` (master only, validates slug uniqueness with a clean 409 message on conflict). After creation the matrix refreshes and the new org appears as an empty section in both feature and access matrices. Operator's next step is `/settings/locations/new` to create the first location under the new org — the location create form picks the org from a dropdown (master sees all active orgs). For existing locations the org is shown read-only because moving a location between orgs is rare and would change RLS visibility for every member at the destination org; do that via SQL with intent if ever needed.

**Why it exists:** with two organizations and a handful of locations, clicking through `/settings/locations/[id]` for each one to flip a feature is fine. With three+ tenant businesses on the platform, the per-location flow becomes friction. The matrix lets a master see and modify the entire platform's posture from one screen, which is also the right shape for the eventual "tenant onboarding" flow (provisioning a new org → bulk-toggle features for all its locations → add their team in bulk via the bulk action bar).


## Feature documentation

Deep-dive references for shipped features live under `docs/` so this file stays focused on day-to-day conventions. Open the relevant doc when working on that surface:

- [Roster v2 — shift templates / demand windows](docs/roster-v2.md) — schedule fulfilment model, phases 1–6 (mig 067–072).
- [Staff attendance — UniFi Access + Protect](docs/staff-attendance.md) — zero-touch shift stamping (mig 120, 142).
- [Events — race / workshop / seminar / open_day / masterclass](docs/events.md) — multi-kind events on `race_events` (mig 081/082/122).
- [INVOICES-QUEUE.1 design](docs/invoices-queue-plan.md) — approval-to-Xero restructure (shipped; retained as design record).

Other standing design/reference docs already in `docs/`: `PLATFORM_ROADMAP.md`, `REVOLUT_PAYMENTS_DESIGN.md`, `STUDIO_DEVICES_DESIGN.md`, `STUDIO_AC_THINQ_DESIGN.md`, `BCA_SUBMIT_spec.md`, `EMAIL_DELIVERABILITY.md`, `unifi-access-setup.md`, `unifi-protect-setup.md`.

## Roadmap & backlog

The shipped-work changelog (numbered Done log, #215 → #28) lives in [docs/CHANGELOG.md](docs/CHANGELOG.md) — moved out of this file on 2026-06-01 to keep CLAUDE.md as working reference rather than history. When you ship a task, add its entry there and roll any reusable lesson into the relevant CLAUDE.md section.

### Backlog — picked up when relevant

These are not commitments, just durable notes so we don't re-derive them every session.

**Deposits / payments** (dropped — durable do-not-build decisions, kept to avoid re-deriving)
- ~~Refund UI on the car-detail Deposit section.~~ — **dropped**. CCF Autos deposits are non-refundable and that policy isn't changing, so the operator-facing button would be unused. The `refundOrder()` lib helper in `src/lib/revolut.js` stays — it's the right primitive to reach for if/when the gym side of the business introduces payments (memberships, class packs, retail) where partial/full refunds ARE part of the customer journey. Revisit the UI question then; the lib doesn't need touching now.
- ~~Multi-currency support for deposits (today EUR-only). UK customers buying RHD stock would value GBP.~~ — **dropped**. Not selling to UK customers. Revisit if/when the customer geography changes.
- ~~Surface the buyer-side payment-method icons (cards / Apple Pay / Google Pay / Revolut Pay) on the deposit page above the widget so the buyer knows what to expect before clicking pay.~~ — **dropped**. Not needed; the embedded checkout widget surfaces the icons inline once it mounts.

**Invoice OCR (#180 follow-ups)**
- Enable Anthropic prompt caching on the invoice extraction system prompt. The system prompt in `src/lib/invoice-extraction.js` is identical across every call (~500 tokens), so adding a `cache_control: { type: 'ephemeral' }` block to the system message would knock ~50% off the input cost per extraction. Anthropic caches for 5 min by default; at any realistic invoice cadence the cache stays warm. Implementation is ~10 lines in the Anthropic request body + a `anthropic-beta: prompt-caching-2024-07-31` header. Worth doing once monthly volume crosses ~200 invoices/month (cache savings start outweighing the cognitive cost of the beta header).
- Monthly cost true-up review. After the first month of real extractions, pull actuals from `console.anthropic.com` → Usage and compare against the per-invoice estimates (~$0.017 single-page, ~$0.030 multi-page). If consistently higher: likely operators are re-extracting frequently, or operators are uploading huge raw phone photos that should be downsampled before send. Both are easy fixes; the trigger to investigate is "more than 2× the estimate".

**Performance / infrastructure**
- Move car photos to Supabase Storage signed URLs (today they're public-bucket URLs, fine for inventory but limits the option to gate gallery views).

**Multi-brand / platform**
- Brand-aware AppShell — pull header logo + favicon + theme tokens off the active location so CCF Autos visitors at `crm.un1tdublin.com` see car-brand chrome, not gym chrome, without separate deployments.

**Platform roadmap (whole-platform review, 2026-05-23)**
- A balanced whole-platform review — 19 opportunities across acquisition, retention, member experience, analytics, revenue, ops and platform — lives in `docs/PLATFORM_ROADMAP.md` (also a Cowork artifact, id `un1t-platform-roadmap`). It's a strategic shortlist, not committed work; pull individual items into numbered tasks when picked up. Headline: the platform surfaces who to act on (radars) but doesn't act — wiring one-click templated outreach into the radar "contacted" buttons (#1 in the doc) is the suggested first move. Whole-category gaps confirmed by code search: referral program, member NPS/feedback, reviews/reputation, marketing attribution, an analytics/BI layer.

**Revolut authorised supplier payments (design, 2026-05-26 — under review)**
- Full pre-build design at `docs/REVOLUT_PAYMENTS_DESIGN.md`. Closes the AP loop: ingest → Xero bill → **pay** → paid status synced back. No code yet — design only. **Decision captured**: use Revolut Business API's **payment-draft model** (CRM assembles, a human approves the actual money movement in the Revolut Business app), not direct `POST /pay` — the CRM is never the final authoriser. This also keeps PSD2/SCA inside the bank's app. **It's the Business API, not the Merchant API the repo already has** for inbound — separate cert/OAuth auth (JWT client assertion + X.509), separate credentials, periodic human re-consent. 4-phase sandbox-first build planned. Before any build, settle the §10 open questions in the doc (connection scope per-location vs per-org, who approves, can counterparties be created from the CRM or only selected, re-consent cadence). Resume notes section at the top of the doc — update it as decisions land.

**Studio devices — Mac + iPad in-studio apps (designed 2026-05-27, all decisions locked)**
- Pre-build design doc for Mac (Tauri shell wrapping un1t-crm) + iPad (universal CF Studio) in-studio apps lives in `docs/STUDIO_DEVICES_DESIGN.md`. Four phases: **Phase 0** studio-device PIN auth (4-digit globally-unique PIN, 5-min idle timeout, gated to studio wifi by IP + device pairing, per-device lockout 5 attempts → 15min cooldown), **Phase 1** universal iOS binary + iPad layouts (existing iPads on iOS 26 so deployment target can be generous), **Phase 2** Mac shell with auto-launch on boot + per-user `home_screen_path` setting, **Phase 3** Coach In-Class mode on iPad (v2 offline-first locked, expo-sqlite + sync engine). Phase 4 (self-service kiosk) parked. Every decision locked in the doc's "Locked decisions" subsection. Only remaining open item is Phase 4 kiosk scoping prereqs (member check-in flow). Effort ~17–25 days total across 4–6 PRs. **Phase 0 is foundation — Phase 1 and Phase 2 both consume it.** Start with PR 0 (PIN auth) when this is picked up; A and B can be built in parallel after that.

### Process notes

- Backlog items move to in-progress as a numbered task in Cowork before implementation starts.
- Lessons learned from each shipped task get rolled into the relevant CLAUDE.md section (Coding conventions, Lessons learned, Multi-vendor comms, etc.) — not into this list.
- This list is intentionally not a project plan — no dates, no commitments. It's a durable scratchpad.
