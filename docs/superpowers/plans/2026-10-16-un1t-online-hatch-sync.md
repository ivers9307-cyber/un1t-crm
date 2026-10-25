# un1t.online → CRM sync (Hatch Street) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull Hatch Street's clients, subscriptions, transactions, invoices, products, events and bookings from `api.un1t.online` into the CRM every 15 minutes, read-only, so Hatch members exist as contacts with their platform state stored alongside.

**Architecture:** A GET-only HTTP client (`un1t-online.js`) feeds pure mappers (`un1t-online-map.js`), an org-scoped contact resolver (`un1t-online-contacts.js`) and a sync engine (`un1t-online-sync.js`) that upserts parallel `un1t_*` tables and never deletes. The per-location credential lives in `channel_connections` (`platform = 'un1t_online'`); locations opt in through `locations.membership_source = 'un1t_online'`, discovered by the existing `locationsWithSource` seam. A cron route runs it; a settings tab connects, disconnects and runs it on demand.

**Tech Stack:** Next.js 16 App Router route handlers, Supabase (service-role `createServerClient()`), Zod (`validateBody`), Vitest, React (settings tab).

**Spec:** `docs/superpowers/specs/2026-09-01-un1t-online-hatch-integration-design.md`; **§0 (live findings, 2026-10-16) supersedes** §3.1, §3.3, §4 (auth) and §5.

## Global Constraints

- Base URL `https://api.un1t.online`; auth header `Authorization: Bearer <un1t_… token>`. No sign-in, no refresh: a 401/403 is final for the run.
- The client issues **GET only**. No POST/PATCH/PUT/DELETE helper exists anywhere in the module (a test pins it).
- Rate limit **60 requests / 60 s**; headers `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` (seconds). Paging `?page=N&pageSize=M`, **`pageSize` max 100**; `limit` and `updated_since` are ignored by the API, so every run is a full pull.
- Money from the API is **integer cents**; store as `*_cents integer`.
- Never store or log `reset_password_token`, `reset_password_expire`, `next_of_kin`, `guest_name`, `guest_email`, `guest_phone`, `invoice_url`, or embedded `user` objects (`{id,name,email}`).
- **Never delete** a `un1t_*` row or a contact because it is absent from a pull. Subscriptions absent from a pull end their `contact_memberships` row (status `ended`), never delete it.
- Contact identity is **per organisation**: `contacts_email_org_unique (organization_id, email)`, case-sensitive. Hatch and Stillorgan share the UN1T Group org, so one person is one contact.
- On an existing contact the sync writes **only** `un1t_user_id`, `un1t_synced_at`, and fills `first_name`/`last_name`/`phone` when they are null. It never writes `location_id`, `email`, any `glofox_*` column, or any consent/preference field.
- Hatch classes are **not** written to `class_occurrences` or `class_bookings` in this plan (operator decision 2026-10-16: audit their ~20 readers first, in a follow-up plan).
- New membership-source key is **`un1t_online`**, label **`un1t.online`**; `'un1t'` stays reserved for built-in memberships. Provider capabilities are **all `false`** in this plan, so no Glofox-shaped surface lights up for Hatch with empty data.
- Every new table: RLS enabled, no policy, `REVOKE ALL … FROM anon, authenticated` (CLAUDE.md table-default rule).
- Next migration number is **726** (725 is the latest on `origin/main` as of 2026-10-16; re-check with `ls supabase/migrations | sort -V | tail -3` before writing).
- Cron schedule `*/15 * * * *`; heartbeat name `un1t-online-sync`, `expected_interval_seconds 900`, `grace_seconds 1800`.

## Review Focus

1. **Same person, different case.** A Stillorgan contact `Jane@x.ie` joins Hatch as `jane@x.ie`: the sync must attach to the existing contact, not insert (which the org-unique index would not even catch, being case-sensitive) and not fail. Two org contacts differing only in case → `ambiguous_email`, no write. Test in Task 4.
2. **Token revoked or expired.** A 401 must mark the connection `action_needed` with a readable `last_error`, record the run as `error`, write nothing else, and still let the cron stamp its heartbeat (the cron is healthy; the location is not). Tests in Tasks 6 and 8.
3. **Rate limit mid-walk.** A 429 or `remaining: 0` part-way through a list waits for `x-ratelimit-reset` and resumes; a run that gives up returns an error and writes nothing (lists are pulled completely before the first write). Tests in Tasks 2 and 6.
4. **Wrong studio.** The token's studio (`GET /api-token`) differs from the stored `external_account_id`, or a row's `studio_id` differs from it: the whole run refuses with `studio_mismatch`; nothing is written. Test in Task 6.
5. **A subscription disappears or cancels.** Its `contact_memberships` row becomes `ended` with `ended_at`, never deleted; reappearing re-activates the same row. Test in Task 6.

---

### Task 1: Schema (migration 726)

**Files:**
- Create: `supabase/migrations/726_un1t_online_sync.sql`
- Modify: `tests/audience-view-columns-guard.test.js` (exclude the two new contacts columns, reason: "sync bookkeeping for un1t.online, not an audience field")
- Test: existing guards (`tests/table-default-acl-guard.test.js`, `tests/audience-view-columns-guard.test.js`, `tests/function-execute-guard.test.js`) plus `npm run check:select-columns`

**Interfaces:**
- Produces (tables/columns later tasks write):
  - `contacts.un1t_user_id text`, `contacts.un1t_synced_at timestamptz`; unique partial index `contacts_un1t_user_id_unique (un1t_user_id) WHERE un1t_user_id IS NOT NULL`.
  - `un1t_clients (id uuid pk default gen_random_uuid(), location_id uuid not null → locations on delete cascade, un1t_user_id text not null, contact_id uuid → contacts on delete set null, status text, credit_balance integer, credit_unlimited boolean, last_attended_at timestamptz, bookings_30d_attended integer, bookings_30d_no_show integer, ltv_cents integer, remote_created_at timestamptz, remote_updated_at timestamptz, synced_at timestamptz not null default now(), unique (location_id, un1t_user_id))`. No `raw` (client rows are PII).
  - `un1t_products (… un1t_id text not null, title, type, status, visibility, price_cents integer, currency, billing_interval, billing_interval_count integer, credits_per_period integer, raw jsonb, synced_at, unique (location_id, un1t_id))`
  - `un1t_subscriptions (… un1t_id, un1t_user_id, contact_id → contacts set null, product_id text, product_title, status, price_cents, currency, billing_interval, billing_interval_count, credits_per_period, current_period_start, current_period_end, cancel_at_period_end boolean, trial_end, paused_at, paused_until, past_due_at, remote_created_at, remote_updated_at, raw jsonb, synced_at, unique (location_id, un1t_id))`
  - `un1t_transactions (… un1t_id, un1t_user_id, contact_id, product_id, product_title, invoice_id text, type, product_type, amount_cents integer, currency, refunded boolean, refund_status, remote_created_at, raw jsonb, synced_at, unique (location_id, un1t_id))`
  - `un1t_invoices (… un1t_id, un1t_user_id, contact_id, subscription_id text, status, amount_cents, currency, remote_created_at, raw jsonb, synced_at, unique (location_id, un1t_id))`
  - `un1t_events (… un1t_id, title, status, access_mode, is_free boolean, starts_at timestamptz, ends_at timestamptz, capacity integer, bookings_count integer, series_id text, raw jsonb, synced_at, unique (location_id, un1t_id))`
  - `un1t_bookings (… un1t_id, un1t_user_id, contact_id, event_id text, status, source, credit_charged boolean, has_guest boolean, external_member_ref text, external_booking_ref text, remote_created_at, remote_updated_at, raw jsonb, synced_at, unique (location_id, un1t_id))`
  - `un1t_sync_runs (id uuid pk, location_id not null, started_at timestamptz not null default now(), finished_at, duration_ms integer, status text not null check (status in ('running','ok','error')), counts jsonb not null default '{}', first_error text)`; index `(location_id, started_at desc)`.
  - Index `(location_id, contact_id)` on every table with `contact_id`.
  - `channel_connections_platform_check`: drop and re-add with the mig 418 list **plus `'un1t_online'`**.
  - `locations_membership_source_check`: drop and re-add as `IN ('none','glofox','un1t','un1t_online')`.
  - `contact_memberships` source CHECK: drop and re-add as `IN ('un1t_online_export','un1t_online_api')`.

- [ ] **Step 1:** Write the migration in one `BEGIN … COMMIT` with `SET LOCAL lock_timeout = '5s'` (the `locations` CHECK swap takes ACCESS EXCLUSIVE, as mig 717 notes). Each new table: `ENABLE ROW LEVEL SECURITY`, `REVOKE ALL ON public.<t> FROM anon, authenticated`, and a `COMMENT ON TABLE` naming this plan. End with a `DO $$` self-check that reads the catalog: the 8 tables exist with `relrowsecurity`, `has_table_privilege('authenticated', …, 'SELECT')` is false for each, and the three CHECKs admit their new value (follow mig 722's self-check shape).
- [ ] **Step 2:** Add the two contacts columns to the exclusion list in `tests/audience-view-columns-guard.test.js`.
- [ ] **Step 3:** Run `npx vitest run tests/table-default-acl-guard.test.js tests/audience-view-columns-guard.test.js tests/function-execute-guard.test.js && npm run check:rls-restrictive && npm run check:select-columns`. Expected: all pass.
- [ ] **Step 4:** Commit: `git add supabase/migrations/726_un1t_online_sync.sql tests/audience-view-columns-guard.test.js && git commit -m "UN1TSYNC.1 — un1t_* tables, contacts.un1t_user_id, un1t_online source keys (mig 726)"`

Apply to prod (Supabase MCP `apply_migration`, project `iyvtbjjxdggiadzwwvdj`) **before** the PR merges, then `get_advisors` type=security. If no MCP is available in the session, flag it loudly in the PR body as unapplied.

---

### Task 2: GET-only HTTP client

**Files:**
- Create: `src/lib/un1t-online.js`
- Test: `src/lib/un1t-online.test.js`

**Interfaces:**
- Produces:
  - `export class Un1tAuthError extends Error { status }` (401/403)
  - `export class Un1tApiError extends Error { status, code }` (any other non-2xx after retries, a `success:false` body, or unreadable JSON)
  - `export function createUn1tClient({ token, baseUrl = 'https://api.un1t.online', fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), maxPages = 50 })` → `{ getSelf(): Promise<ApiTokenSelf>, listAll(path: string): Promise<{ rows: object[], total: number, truncated: boolean }>, stats(): { requests: number, waitedMs: number, retries: number } }`
  - `ApiTokenSelf` = the `data` of `GET /api-token`: `{ id, name, studio: { id, title, timezone, currency }, permissions: string[], allowed_origins: string[], expires_at: string }`

- [ ] **Step 1: Write the failing tests** (fake `fetchImpl` returning `{ status, headers: new Headers({...}), json: async () => body }`; fake `sleep` records its argument):
  - `issues only GET` — after `getSelf()` and `listAll('/bookings')`, every recorded call has `method: 'GET'`; and `Object.keys(createUn1tClient({token:'t'}))` equals `['getSelf','listAll','stats']`.
  - `sends the bearer token` — header `Authorization` is `Bearer t`.
  - `walks every page at pageSize 100` — page 1 returns `pagination: { total: 182, page: 1, pages: 2, pageSize: 100 }` with 100 rows, page 2 returns 82; result `rows.length === 182`, `total === 182`, `truncated === false`; URLs end `?page=1&pageSize=100` and `?page=2&pageSize=100`.
  - `dedupes rows by id across pages` — page 2 repeats one id from page 1 (an insert shifted the window); `rows.length` counts it once.
  - `stops at maxPages and flags truncated` — `maxPages: 2`, API reports `pages: 5`; returns `truncated: true` after exactly 2 requests.
  - `waits for the window when remaining hits 0` — a response with `x-ratelimit-remaining: 0`, `x-ratelimit-reset: 7` makes the next request wait; `sleep` called with `8000` (reset + 1 s).
  - `retries a 429 after the reset` — 429 then 200; `sleep` called with `(reset+1)*1000`; result ok; `stats().retries === 1`.
  - `gives up after 3 retries on 429 or 5xx` — four 503s → throws `Un1tApiError` with `status 503`.
  - `401 is Un1tAuthError with no retry` — exactly one request made.
  - `success:false body is Un1tApiError` — status 200, body `{ success:false, error:{ status:400, message:'x' } }` → throws with `code` from the body.
- [ ] **Step 2:** Run `npx vitest run src/lib/un1t-online.test.js` — FAIL (module not found).
- [ ] **Step 3:** Implement. Rate-limit handling reads the headers on every response; 5xx and 429 back off `(reset+1)*1000` when `x-ratelimit-reset` is present, else `1000 * 2^attempt`. Never log the token. No write helpers.
- [ ] **Step 4:** Run the test — PASS.
- [ ] **Step 5:** Commit `UN1TSYNC.2 — GET-only un1t.online client with rate-limit and paging`.

---

### Task 3: Pure mappers

**Files:**
- Create: `src/lib/un1t-online-map.js`
- Create: `tests/fixtures/un1t-online/{client,subscription,transaction,invoice,product,event,booking}.json` — one synthetic row each, field names and types exactly as recorded in spec §0 (e.g. client includes `reset_password_token: "abc"`, `next_of_kin: {…}`, `credit_ledger: { balance: 3, is_unlimited: false }`, `bookings_30d: { attended: 4, no_show: 1 }`, `ltv: 18900`, `studio: { id, title }`). **Invented values only**; never real Hatch data.
- Test: `src/lib/un1t-online-map.test.js`

**Interfaces:**
- Produces (each takes the API row plus `{ locationId, now }`, returns the DB row for its table **without** `contact_id`; returns `null` for a row missing `id`):
  - `mapClient(row, ctx)` → `un1t_clients` row; `contactFieldsFromClient(row)` → `{ email, first_name, last_name, phone }` (email via `normalizeEmail` from `src/lib/email-inbox.js`, phone via `normalizePhone` from `src/lib/glofox-sync.js`)
  - `mapProduct`, `mapSubscription`, `mapTransaction`, `mapInvoice`, `mapEvent`, `mapBooking`
  - `rowStudioId(kind, row)` → the row's studio id (`row.studio?.id` for clients, `row.studio_id` otherwise; `null` if absent)
  - `MEMBERSHIP_ACTIVE_STATUSES = Object.freeze(['active','trialing','past_due'])`

- [ ] **Step 1: Write the failing tests:**
  - `mapClient never carries reset or next-of-kin fields` — `JSON.stringify(mapClient(fixture, ctx))` contains none of `reset_password`, `next_of_kin`, the fixture's token value `"abc"`.
  - `mapClient flattens ledger, 30-day counts and ltv` — `credit_balance 3`, `credit_unlimited false`, `bookings_30d_attended 4`, `bookings_30d_no_show 1`, `ltv_cents 18900`.
  - `raw never holds an embedded user, guest PII or invoice_url` — for subscription/transaction/invoice/booking, `raw.user`, `raw.guest_name`, `raw.guest_email`, `raw.guest_phone`, `raw.invoice_url` are all undefined; `un1t_user_id` is still set from `user_id`.
  - `mapBooking sets has_guest` — true when any guest field is non-empty in the input, false otherwise.
  - `money stays integer cents` — transaction `amount 18900` → `amount_cents 18900`; subscription `product.price_amount 8900` → `price_cents 8900`, `product_title` from `product.title`.
  - `mapEvent maps capacity and times` — `clients_limit 12` → `capacity 12`; `start_time`/`end_time` → `starts_at`/`ends_at`.
  - `contactFieldsFromClient lowercases and trims email` — `'  Jane@X.ie '` → `'jane@x.ie'`; empty email → `null`.
- [ ] **Step 2:** Run `npx vitest run src/lib/un1t-online-map.test.js` — FAIL.
- [ ] **Step 3:** Implement as pure functions (no imports beyond the two normalisers).
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `UN1TSYNC.3 — un1t.online row mappers (PII-stripped)`.

---

### Task 4: Org-scoped contact resolver

**Files:**
- Create: `src/lib/un1t-online-contacts.js`
- Test: `src/lib/un1t-online-contacts.test.js` (supabase mock in the style of `src/lib/glofox-sync.test.js`; use `ilikeMatches` from `src/lib/like-escape.test-helpers.js` so `.ilike` behaves like Postgres, not like `===`)

**Interfaces:**
- Consumes: `contactFieldsFromClient` (Task 3).
- Produces: `export async function resolveUn1tContacts(db, { locationId, organizationId, clients, now }) → { contactIdByUserId: Map<string,string>, counts: { linked: number, attached_by_email: number, created: number, ambiguous_email: number, conflict: number, no_email: number, failed: number }, errors: Array<{ un1t_user_id, reason }> }`

Rules, in order, per client:
1. A contact with this `un1t_user_id` exists (loaded in `.in('un1t_user_id', chunk)` chunks of 200) → `linked`; fill null `first_name`/`last_name`/`phone` only; set `un1t_synced_at`.
2. Else, if email present: `.from('contacts').select('id, un1t_user_id, first_name, last_name, phone').eq('organization_id', organizationId).ilike('email', escapeLikePattern(email)).limit(2)`.
   - 2 rows → `ambiguous_email`, no write.
   - 1 row with a different non-null `un1t_user_id` → `conflict`, no write.
   - 1 row → `attached_by_email`: set `un1t_user_id`, `un1t_synced_at`, fill nulls. Never touch `location_id`, `email`, `glofox_*`.
3. Else insert `{ location_id: locationId, source: 'un1t_online', email, first_name, last_name, phone, un1t_user_id, un1t_synced_at }` → `created`. A client with no email and no existing link → `no_email`, still inserted (name-only contacts are allowed; `email` null).
Every update/insert destructures `error` and checks rows touched (`.select('id')`); a failed write is `failed` with the reason, and the loop continues.

- [ ] **Step 1: Write the failing tests:**
  - `links by un1t_user_id first` — existing contact with that id → `linked: 1`, no email query made.
  - `attaches to a Stillorgan contact across studios by email, case-insensitively` — org contact `{ email: 'Jane@x.ie', location_id: STILLORGAN }`, client email `jane@x.ie` → `attached_by_email: 1`; the update payload has `un1t_user_id` and **no** `location_id`/`email` key.
  - `does not overwrite an existing name or phone` — contact has `phone '+353…'`, client has a different phone → update payload has no `phone`.
  - `two org contacts differing only in case is ambiguous_email` — no update, no insert.
  - `a contact already linked to another un1t user is a conflict` — no write.
  - `email lookup is scoped to the organisation` — the email query chain includes `.eq('organization_id', ORG)` and no `.eq('location_id', …)`.
  - `escapes LIKE wildcards` — client email `a_b@x.ie` does not match org contact `axb@x.ie` → `created: 1`.
  - `creates with source un1t_online and no consent fields` — insert payload keys are exactly `location_id, source, email, first_name, last_name, phone, un1t_user_id, un1t_synced_at`.
  - `a failed write is counted and the loop continues` — first insert returns `{ error }`, second succeeds → `failed: 1, created: 1`.
- [ ] **Step 2:** Run `npx vitest run src/lib/un1t-online-contacts.test.js` — FAIL.
- [ ] **Step 3:** Implement `resolveUn1tContacts`.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Add `src/lib/un1t-online-contacts.js` to the armed `files` list for `no-unchecked-supabase-write` in `eslint.guardrails.config.mjs`; run `npm run check:guardrails` — PASS.
- [ ] **Step 6:** Commit `UN1TSYNC.4 — org-scoped un1t.online contact resolution`.

---

### Task 5: Registry, membership source, health and hub

**Files:**
- Modify: `src/lib/connection-registry.js` (add `PROVIDERS.un1t_online`, registry-only: `legacySelect: 'id'`, `rowFromLegacy: () => null`, `applyRow: loc => loc`; do **not** add it to `DUAL_READ_PLATFORMS`)
- Create: `src/lib/membership/sources/un1t-online.js` — `un1tOnlineSource = Object.freeze({ key: 'un1t_online', label: 'un1t.online', capabilities: { memberships: false, bookings: false, credits: false, invoices: false, schedule: false }, isConfigured(db, locationId) })`; configured = active registry row with `access_token` and `external_account_id`; a read error → `{ configured: false, readError }`; missing → `missing: ['api_token']` and/or `['studio']`.
- Modify: `src/lib/membership/source.js` (`MEMBERSHIP_SOURCES` gains `un1t_online`; `MEMBERSHIP_SOURCE_KEYS` = `['none','glofox','un1t','un1t_online']`)
- Modify: `src/lib/membership/choices.js` (new choice `{ key: 'un1t_online', label: 'un1t.online', hint: 'Members, subscriptions, payments and bookings are read from un1t.online every 15 minutes. Connect it on the un1t.online tab.', registered: true }`, placed after `un1t` to keep CHECK order)
- Modify: `src/lib/contact-memberships.js` (`MEMBERSHIP_SOURCE_LABELS.un1t_online_api = 'un1t.online'`)
- Modify: `src/lib/integration-health.js` (row `{ key: 'un1t_online', name: 'un1t.online' }` via `readConnection` + `registryHealth`, shown only when the location's `membership_source` is `un1t_online` or an active row exists; detail `Connected · <studio title from config.studio_title> · token expires <date>`; status forced to `warn` when `token_expires_at` is within 30 days; `REMEDIES.un1t_online = { text: 'Paste a new un1t.online token in Settings → Integrations.', href: '/settings/integrations-hub' }`)
- Modify: `src/lib/integrations-hub.js` (`REGISTRY_PLATFORMS` + `'un1t_online'`, `CARD_LABELS`, a card block shaped like Glofox's with `{ locationId, status, studioTitle, tokenExpiresAt, lastOkAt, lastError, href: locationTabHref(loc.id, 'un1t-online') }`, and an attention input with `tokenExpiresAt`). Never put `access_token` on the card.
- Tests: extend `src/lib/membership/source.test.js`, `src/lib/integration-health.test.js`, `src/lib/integrations-hub.test.js`, `src/lib/connection-registry.test.js`

**Interfaces:**
- Produces: `readConnection(db, id, 'un1t_online')` → normalised conn (`accessToken`, `externalAccountId`, `config`, `status`, `tokenExpiresAt`, `lastOkAt`, `lastError`); `un1tOnlineSource`; card key `un1t_online`; tab key `'un1t-online'`.

- [ ] **Step 1: Write the failing tests:**
  - `readConnection serves un1t_online from the registry and answers not_connected with no row` (no legacy read of `settings`).
  - `un1t_online provider is registered with every capability false` and `choices mirror the registry` (the existing mirror test covers it once `registered: true`).
  - `membershipSourceState answers unconfigured with missing api_token when no row`.
  - `integration health warns 30 days before token expiry` (`token_expires_at` = now + 10 days → `warn`).
  - `hub card never carries the token` — `JSON.stringify(card)` lacks the fixture token.
- [ ] **Step 2:** Run those four test files — FAIL.
- [ ] **Step 3:** Implement the six modifications and the new provider.
- [ ] **Step 4:** Run — PASS; then `npm run check:mobile-parity` (no new permission key is expected; confirm it stays green).
- [ ] **Step 5:** Commit `UN1TSYNC.5 — un1t_online membership source, registry, health and hub card`.

---

### Task 6: Sync engine

**Files:**
- Create: `src/lib/un1t-online-sync.js`
- Test: `src/lib/un1t-online-sync.test.js`

**Interfaces:**
- Consumes: `createUn1tClient`, `Un1tAuthError`, `Un1tApiError` (Task 2); mappers and `rowStudioId`, `MEMBERSHIP_ACTIVE_STATUSES` (Task 3); `resolveUn1tContacts` (Task 4); `readConnection(db, locationId, 'un1t_online')` (Task 5, which returns `{ conn: { accessToken, externalAccountId, status, … }, error }`).
- Produces: `export async function runUn1tSync(db, locationId, { clientFactory = createUn1tClient, now = () => new Date() } = {}) → { ok: boolean, reason?: 'not_connected'|'auth'|'studio_mismatch'|'api'|'truncated'|'db', counts: object, runId: string|null }`
- `export const UN1T_LISTS = Object.freeze(['/products','/events','/users/clients','/subscriptions','/transactions','/invoices','/bookings'])`

Order of a run:
1. Insert `un1t_sync_runs` `{ status: 'running' }`.
2. Read the connection; no active row or no token → `not_connected` (run row `error`, connection untouched).
3. `getSelf()`. `self.studio.id !== conn.externalAccountId` → `studio_mismatch`. Record `token_expires_at = self.expires_at` on the connection.
4. `listAll` every path in `UN1T_LISTS` **before any table write**. Any `truncated` → `truncated`. Any row whose `rowStudioId` is non-null and ≠ the studio → `studio_mismatch`.
5. Read the location's `organization_id`; `resolveUn1tContacts`.
6. Upsert, chunks of 200, `onConflict: 'location_id,un1t_id'` (`'location_id,un1t_user_id'` for clients), `contact_id` filled from the resolver map: products, events, clients, subscriptions, transactions, invoices, bookings. Every upsert destructures `error`; the first failure → `db` (later tables are not written in that run).
7. Reconcile `contact_memberships` for `source = 'un1t_online_api'` at this location: for each contact with a subscription whose `status ∈ MEMBERSHIP_ACTIVE_STATUSES`, upsert `{ organization_id, location_id, contact_id, source, plan_name: product_title || 'Membership', status: 'active', ended_at: null, last_seen_at: now }` on `(contact_id, location_id, source)` (set `first_seen_at` only on insert); every existing `active` row for this source/location whose contact has no such subscription → `status 'ended', ended_at: now`. Leave `un1t_online_export` rows untouched.
8. Connection: success → `status 'connected', last_ok_at: now, last_error: null`; `auth` → `status 'action_needed', last_error: 'un1t.online token rejected (revoked or expired). Paste a new token in Settings → Integrations → un1t.online.'`; `studio_mismatch` → `status 'error'` with the two studio ids in `last_error`; `api`/`db`/`truncated` → `status 'error'`, `last_error` names the step.
9. Finish the run row: `finished_at`, `duration_ms`, `status`, `counts` (rows per table, resolver counts, `client.stats()`), `first_error`.

- [ ] **Step 1: Write the failing tests** (fake client from `clientFactory`; mock db records writes):
  - `happy path writes every table and marks the connection connected` — counts per table equal the fixture list lengths; `contact_memberships` upsert has `source 'un1t_online_api'`.
  - `401 marks action_needed and writes no table` — only `un1t_sync_runs` and `channel_connections` are written.
  - `token studio differs from stored studio → studio_mismatch, no table writes`.
  - `a row from another studio → studio_mismatch, no table writes`.
  - `a list that fails mid-walk writes nothing` — third list throws `Un1tApiError` → `reason 'api'`, zero upserts.
  - `truncated list refuses the run`.
  - `a subscription gone from the pull ends its membership` — existing active row for contact C, pull has no active subscription for C → update `{ status: 'ended', ended_at }`; no delete call anywhere in the run.
  - `a cancelled subscription ends the membership; a reactivated one re-activates the same row` (upsert on the same conflict key, `ended_at: null`).
  - `export-source membership rows are untouched`.
  - `first upsert failure stops later tables and reports db`.
  - `records token_expires_at from /api-token`.
- [ ] **Step 2:** Run `npx vitest run src/lib/un1t-online-sync.test.js` — FAIL.
- [ ] **Step 3:** Implement `runUn1tSync`.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Arm `src/lib/un1t-online-sync.js` in `eslint.guardrails.config.mjs` (`no-unchecked-supabase-write`); `npm run check:guardrails && npm run check:select-columns` — PASS.
- [ ] **Step 6:** Commit `UN1TSYNC.6 — un1t.online sync engine (full pull, never deletes)`.

---

### Task 7: Connect, disconnect and sync-now routes + settings tab

**Files:**
- Create: `src/app/api/locations/[id]/un1t-online/route.js` — `GET` (masked status: studio title, token name, permissions count, `has_write_permissions`, `expires_at`, last run summary from `un1t_sync_runs`), `PUT { token }` (connect/replace), `DELETE` (disconnect)
- Create: `src/app/api/locations/[id]/un1t-online/sync/route.js` — `POST` runs `runUn1tSync` for that location, returns its result (`maxDuration = 120`)
- Create: `src/components/settings/integrations/Un1tOnlineIntegrationTab.jsx`
- Modify: `src/components/settings/LocationIntegrations.jsx` (tab `{ key: 'un1t-online', label: 'un1t.online', … }`, status dot from `membershipSource` the way `glofoxTabStatus` does)
- Modify: `src/lib/openapi.js` (register the three operations and the `Un1tOnlineConnectSchema`)
- Modify: `src/lib/schemas.js` (`Un1tOnlineConnectSchema = z.object({ token: z.string().trim().regex(/^un1t_[A-Za-z0-9_-]{20,}$/) })`)
- Tests: `src/app/api/locations/[id]/un1t-online/route.test.js`, `.../sync/route.test.js`, `src/components/settings/integrations/Un1tOnlineIntegrationTab.test.jsx`

Gate on every method (the membership-source route's order): `getCurrentUser` → `assertLocationAccessOr404` → `guardMasterOrOwner` at `params.id`. `PUT`: validate, call `createUn1tClient({ token }).getSelf()`; refuse 400 `token_rejected` on `Un1tAuthError`; refuse 400 `browser_token` if `allowed_origins.length > 0`; upsert the active `channel_connections` row `{ platform: 'un1t_online', access_token: token, external_account_id: self.studio.id, display_name: self.studio.title, token_expires_at: self.expires_at, status: 'connected', config: { token_id: self.id, token_name: self.name, studio_title: self.studio.title, permissions: self.permissions } }`; if `locations.membership_source` is `'none'`, set it to `'un1t_online'` and call `resetMembershipStateCache()` + `logMembershipSourceChange` as the membership-source route does. Response includes `warning: 'write_permissions'` when any permission ends `:create|:update|:delete`. `DELETE`: set the row `is_active false, access_token null, status 'not_connected'`; never touches `membership_source` (that is the Membership source card's job). Responses never include the token.

Tab UI: shows connected studio, token name, expiry (amber within 30 days), last sync time/status/counts and `last_error`; a password-type input + **Connect** (`type="submit"` in its form; every other button `type="button"`); **Sync now**; **Disconnect** (confirm dialog). When `has_write_permissions`, an amber note: "This token can change data on un1t.online. The CRM only reads, so a read-only token is safer: create one with the Read-only preset and paste it here." Copy uses `-700` text on light chips.

- [ ] **Step 1: Write the failing tests:**
  - `PUT stores the token, studio and expiry and never echoes the token` — response JSON lacks the token string.
  - `PUT refuses a rejected token with 400 token_rejected and writes nothing`.
  - `PUT refuses a token with allowed origins (400 browser_token)`.
  - `PUT warns write_permissions for the full-preset permission list`.
  - `PUT flips membership_source from none to un1t_online, and leaves glofox alone`.
  - `a manager gets 403; a stranger gets 404` (all three methods; reuse `_role-gate-cases.js`).
  - `DELETE nulls the token and deactivates the row; membership_source unchanged`.
  - `POST sync returns the runUn1tSync result and is owner/master only`.
  - Tab: `renders expiry warning within 30 days`, `shows the write-permission note`, `Connect posts the token and clears the field`.
- [ ] **Step 2:** Run the three test files — FAIL.
- [ ] **Step 3:** Implement routes, schema, openapi entries and the tab.
- [ ] **Step 4:** Run — PASS; then `npm run check:route-guards && npm run check:location-scoping && npm run check:guardrails && npm run lint`.
- [ ] **Step 5:** Commit `UN1TSYNC.7 — un1t.online connect/disconnect/sync-now and settings tab`.

---

### Task 8: Cron, schedule and heartbeat

**Files:**
- Create: `src/app/api/cron/un1t-online-sync/route.js`
- Create: `supabase/migrations/727_un1t_online_sync_heartbeat.sql` (seed `cron_heartbeats ('un1t-online-sync', 900, 1800, now(), 'UN1TSYNC.8 (mig 727) — un1t.online → CRM pull, every 15 min')` with the mig 713 `on conflict … do update` shape and a self-check)
- Modify: `vercel.json` (`{ "path": "/api/cron/un1t-online-sync", "schedule": "*/15 * * * *" }`)
- Test: `src/app/api/cron/un1t-online-sync/route.test.js`

**Interfaces:**
- Consumes: `locationsWithSource(db, 'un1t_online', { module: 'un1t-online-sync' })` (`src/lib/membership/locations-for-source.js`), `runUn1tSync` (Task 6), `stampHeartbeat` (`src/lib/cron-heartbeat.js`), `stampTenantHeartbeat` (`src/lib/tenant-heartbeat.js`).

Route skeleton copies `src/app/api/cron/glofox-sync/route.js`: `runtime 'nodejs'`, `dynamic 'force-dynamic'`, `maxDuration 300`; 401 unless `Bearer ${CRON_SECRET}`; discovery error → 500 and no stamp; locations run sequentially; per location `ok` → `stampTenantHeartbeat('un1t-online-sync', id)`; finally `stampHeartbeat('un1t-online-sync', { locations_processed, failed_locations, skipped })` — a location-level failure (auth, studio mismatch) is counted, not fatal, so the heartbeat still stamps; only a discovery failure or a thrown exception withholds it.

- [ ] **Step 1: Write the failing tests:** `401 without CRON_SECRET`; `500 and no heartbeat when discovery fails`; `runs each eligible location and stamps the heartbeat with counts`; `an auth failure at one location still stamps, with failed_locations 1`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement the route, migration and `vercel.json` entry.
- [ ] **Step 4:** Run — PASS; `grep -L stampHeartbeat src/app/api/cron/*/route.js` still lists only `health-check` and `ad-insights-backfill`; `npm run check:route-guards`.
- [ ] **Step 5:** Commit `UN1TSYNC.8 — un1t-online-sync cron every 15 minutes (mig 727 heartbeat)`.

Apply mig 727 **after** the deploy that ships the route (CLAUDE.md cron rule).

---

### Task 9: Verify, document, ship

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-un1t-online-hatch-integration-design.md` (status line: "implemented in UN1TSYNC.1–.8"; note the `class_occurrences` deferral and capabilities-false decision)
- Create: `docs/changelog/entries/<PR>.md` (after `gh pr create`)
- Modify: `CLAUDE.md` Invariants, one line under Glofox: "**Hatch Street's membership source is un1t.online, not Glofox** (`membership_source = 'un1t_online'`, registry row `platform='un1t_online'`, cron `un1t-online-sync`). The sync is GET-only and never deletes; its token expires (warned 30 days out in integration health). Hatch classes are NOT in `class_occurrences` yet."

- [ ] **Step 1:** Run the full CI mirror from CLAUDE.md (all thirteen commands) — all pass.
- [ ] **Step 2:** `npm run build` — succeeds.
- [ ] **Step 3:** Dry run against production with the operator's go-ahead: after mig 726 is applied and the branch is on a Vercel preview, connect Hatch in the preview's settings tab with the token, press **Sync now**, and report only counts (expected order of magnitude from spec §0: clients ~182, bookings ~301, events ~138, subscriptions ~25, transactions ~96, invoices ~36, products ~17) plus resolver counts (`created`, `attached_by_email`, `ambiguous_email`, `conflict`). Verify the tab in a real browser, not only jsdom.
- [ ] **Step 4:** Commit docs; push; `gh pr create --base main --fill`; add the changelog entry file; push again.

---

## Follow-up plans (out of scope here)

1. **Hatch into the shared class spine:** audit each `class_occurrences` / `class_bookings` reader (TV board, class climate, Shelly reconcile, Hyrox reminders/publish, credit-attendance, HR sessions, schedule desired-state, booking reminders), then project `un1t_events`/`un1t_bookings` with a `source_platform` column.
2. **Surfaces:** flip provider capabilities one by one as KPI scorecard, churn radar, arrears and Mia account tools learn to read `un1t_*`.
3. **Aggregator placeholder accounts:** once the first ClassPass/Wellhub rows appear (booking `source` ≠ `direct` or an external ref), point the person-linking layer at Hatch.
4. **Retire `un1t_online_export` membership rows** once the API rows are trusted.
