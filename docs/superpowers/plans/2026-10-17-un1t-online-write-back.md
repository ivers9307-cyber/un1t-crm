# un1t.online write-back (Hatch Street) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the CRM book, cancel, create accounts, grant the free trial and mint checkout links on un1t.online for Hatch Street, with Glofox-grade write safety, an immediate mirror update, a staff booking card, a new-person funnel, and a gated `bookings` flip.

**Architecture:** The read client (`un1t-online.js`) gains only `getOne` and a per-request hook. Every write lives in a fenced sibling, `un1t-online-write.js`, which owns the transport (`send`), a pure body judge, a write-ahead ledger (`un1t_write_events`), a fail-closed permission check, a per-request rate budget shared with the sync, and the primitives. After a `done` verdict, `un1t-online-mirror-write.js` updates `un1t_*` (protected from the next sync by `crm_written_at` + a rank-first trigger) and `class_bookings` (through C's mapper). Staff routes, the funnel processor and the approval executor are thin callers of those primitives. Two per-location switches (`writes_enabled`, `funnel_enabled`) keep everything dark until proven.

**Tech Stack:** Next.js 16 App Router routes and pages, Supabase service-role client, Zod (`validateBody`), Vitest (+ PGlite for migrations, RTL for components), TypeScript parser for static guards, WhatsApp Flow JSON v7.3.

**Spec:** `docs/superpowers/specs/2026-10-17-un1t-online-write-back-design.md` (spec D). API DTOs: the 16 Oct OpenAPI snapshot (`…/scratchpad/un1t/un1t-openapi.json`). Siblings: A `2026-10-17-hatch-pipeline-and-invoices-design.md`, C `2026-10-17-hatch-bookings-projection-design.md`, E `2026-10-17-mia-at-hatch-design.md`, and their plans under `docs/superpowers/plans/2026-10-17-*.md`.

## Global Constraints

- **No task calls the live un1t.online API.** Every test uses a fake `fetchImpl` (and a fake `sleep`). The live run is only the final "Live verification" section, done by the controller and Richard.
- **Implementers have no Supabase MCP.** Every migration step reads: *controller applies via Supabase MCP `apply_migration` on project `iyvtbjjxdggiadzwwvdj`, then `get_advisors` type `security`*, before the PR that needs it merges. Migration number `NNN` = the next free number on `origin/main` **and** in `list_migrations` at build time (siblings may take 736+).
- **Per PR:** fresh branch off fresh `origin/main` (`git fetch origin main && git checkout -b <branch> origin/main`); the 13-command CI mirror from CLAUDE.md; `npm run build` when a route, page or import is added; `git push -u origin HEAD`; `gh pr create --base main --fill`; then one file `docs/changelog/entries/<PR>.md` with one row `| #<PR> | UN1TWRITE.<n> — … | 2026-MM-DD. … |`, committed and pushed. Commit messages end `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; PR bodies end `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **OTA:** a task touching `shared/` or `mobile/` publishes an OTA to every phone at 100% on merge. Only Task 8 touches `shared/` (`approval-cards.js` + `approvals-next-steps.js`, flagged there). No task touches `mobile/`.
- **Endpoints the CRM may write, and nothing else:** `POST /bookings`, `PATCH /bookings/{id}/cancel`, `POST /users/clients`, `POST /auth/forgot-password`, `POST /purchases/charge` (inside `grantTrial` only), `POST /purchases/checkout`. Never `/credits/grant`, `/refunds*`, `/purchases/charge-custom`, `/purchases/payment-sheet`, `/bookings/{id}/mark-attendance`, `PATCH`/`DELETE /users/*`, `/users/{id}/reset-password`. Never a body key `bypassCredit` or `forceRefund`. No promo code is ever sent.
- **Body shapes (snapshot):** book `{ eventId, userId }`; cancel body `{}`; create `{ email, password, studioId, name, first_name, last_name, phone, accepted_terms: true, accepted_liability_waiver: true }`; forgot `{ email }`; charge `{ userId, productId }` + header `idempotency-key`; checkout `{ productId, successUrl, cancelUrl, userId }` + header `idempotency-key`.
- **Password:** `randomBytes(24).toString('base64url')` held in a local variable only; never stored, logged, returned, shown, or put in an error or `error_events` row. The create response (`UserResponseDto`) carries `reset_password_token`, email and phone: none of it leaves the write module except the id.
- **Permissions (fail closed, from `GET /api-token` `permissions[]`, cached 5 min per token fingerprint, re-read after any 403):** book `bookings:create`+`bookings:read`; cancel `bookings:update`+`bookings:read`; create `users:create`+`users:read`; trial `purchases:create`+`products:read`+`credits:read`; checkout `purchases:create`+`products:read`; forgot-password none. `studio.id` must equal the connection's `external_account_id`. Missing → `UN1T_PERMISSION_MISSING`, nothing sent, text exactly: "The un1t.online token for {studio} is missing the '{permission}' permission, so nothing was sent. Add it to the token in the un1t.online owner console, or issue a new token and paste it in Settings, Integrations, un1t.online."
- **Rate budget:** every HTTP request the write side makes takes one slot of `checkRateLimit(db, 'un1t-write:<locationId>', { max: 30, windowMs: 60_000 })` first. Spent before a write → nothing sent, `UN1T_RATE_BUDGET`, retryable. Spent between a write and its dedupe read → wait for the window (≤ 60 s), never skip the read.
- **Switches:** every primitive refuses `UN1T_WRITES_OFF` unless `locations.settings.un1t_online.writes_enabled === true`. `funnel_enabled` counts only when `writes_enabled` is also true. Both master-only, default off.
- **Ledger keys (also the `idempotency-key` header on purchase calls):** `create:<loc>:<contact>`, `trial:<loc>:<un1tUser>:<product>:<method>`, `book:<loc>:<un1tUser>:<event>`, `cancel:<loc>:<booking>`, `pw:<loc>:<un1tUser>`, checkout = the caller's key.
- **error_events:** `route_type 'un1t_write'`, `name un1t_write_5xx|un1t_write_429|un1t_write_no_reply|un1t_write_unclear|un1t_write_auth|un1t_write_refused`, `route_path 'un1t:<METHOD> <path with :id>'`, ≤ 5 rows a minute per instance + one summary warn; none when the dedupe read found it landed; none for known business refusals.
- **Logs:** module `un1t-online-write`, fields `{ locationId, op, origin, ledgerId, status, verdict, code, recovered, attempt, waitMs }` only. Never the token, an email, a name, a phone, the password or a checkout URL.
- **Customer copy:** operator-editable on the class_funnel block with a default; rendered with `renderCopy` (strips em-dashes); no em-dash in any default; never a capacity figure (PUBCAP.1). Defaults are quoted verbatim in Tasks 18 and 21.
- **Staff copy (verbatim):** unknown "un1t.online did not answer clearly. Check the class in un1t.online before trying again."; no account "This contact has no un1t.online account at {studio}. They can book through the website."; already booked "Already booked in un1t.online".
- **Ids:** a booked queue row gets `glofox_booking_id = 'un1t:<booking id>'`; `class_bookings` rows are built only with C's `mapUn1tBookingToClassBooking`.
- **Cards** filed for un1t.online work carry `details.provider = 'un1t_online'`.
- **Ticket key** `UN1TWRITE.<n>`; CLAUDE.md gains one invariant, UN1TWRITE.1 (Task 8).

## Review Focus

1. **The create response echoes secrets.** `POST /users/clients` returns `UserResponseDto` with `reset_password_token`, email and phone. Expect none of it in the ledger `message`, any log line, any `error_events` row, the returned result or a thrown error; only `data.id` survives. Test in Task 6 (`createClient never lets the response body out`).
2. **Two submits race to create one account.** The same person submits the website form for two classes a few seconds apart; two queue rows process concurrently. Expect exactly one `POST /users/clients`: the second hits the open-row unique index on `create:<loc>:<contact>`, gets `UN1T_ATTEMPT_IN_FLIGHT`, throws (queue retry), and on retry finds the account linked. Test in Task 22.
3. **Email case and look-alikes.** un1t.online holds `Jane@X.ie`, the contact holds ` jane@x.ie`, a third client holds `jane_x@x.ie`. Expect a single match on trimmed, lower-cased exact equality (API walk compares strings; the mirror sibling lookup uses `escapeLikePattern`), never a pattern match. Test in Task 20.
4. **The class starts while the request waits.** `un1t_events.status` stays `scheduled` after the start time. Expect preflight to refuse `class_unavailable` when `starts_at <= now`, and the approval route's past-start guard to expire an executing card. Test in Tasks 22 and 23.
5. **A 2xx that describes something else.** `POST /bookings` answers 201 with a booking for a different `event_id`, `user_id` or `studio_id` (a proxy bug, a stale cache). Expect verdict `unknown` (then the dedupe read), never `done`. Test in Task 3.

---

## PR 1 — Write core, ledger, guards (shipped dark)

Branch `un1t-write-core`. **Waits for:** A's PR 2 merged (Task 9 feeds this PR's ledger into A's `ledgerTrials` inputs). Nothing on C. Migration `NNN`.

### Task 1: Migration NNN — ledger, mirror trigger, terms columns, refund kind

**Files:**
- Create: `supabase/migrations/NNN_un1t_write_back.sql`
- Test: `tests/migration-NNN-un1t-write-back.test.js` (PGlite, shape of `tests/migration-735-un1t-sync-runs-one-running.test.js`: create minimal `locations`, `contacts`, `un1t_bookings`/`un1t_clients`/`un1t_transactions` as mig 726 made them, `class_booking_requests` as mig 335 + later columns, `agent_membership_requests` with mig 711's CHECK; then run the real file)

**Interfaces:**
- Produces:
  - `un1t_write_events` with the spec 6.2 columns: `id uuid pk default gen_random_uuid()`, `location_id uuid not null → locations on delete cascade`, `contact_id uuid → contacts on delete set null`, `un1t_user_id text`, `op text not null check in ('create_client','forgot_password','trial','book','cancel','checkout')`, `origin text not null check in ('staff','funnel','approval','mia','test_account')`, `origin_ref text`, `actor_user_id uuid`, `idempotency_key text not null`, `target text`, `stage text not null check in ('sent','done','refused','unknown')`, `method text check (method in ('charge','free_checkout'))` with `check ((op = 'trial') = (method is not null))`, `un1t_ref text`, `terms_accepted_at timestamptz`, `terms_source text`, `checkout_url text`, `http_status int`, `code text`, `message text check (char_length(message) <= 500)`, `recovered text`, `created_at timestamptz not null default now()`, `finished_at timestamptz`.
  - Indexes: `un1t_write_events_one_open UNIQUE (idempotency_key) WHERE stage IN ('sent','unknown')`; `un1t_write_events_one_done UNIQUE (idempotency_key) WHERE stage = 'done' AND op IN ('create_client','trial','forgot_password')`; `un1t_write_events_one_trial UNIQUE (location_id, un1t_user_id, target) WHERE op = 'trial' AND stage = 'done'`; `un1t_write_events_contact_op (location_id, contact_id, op, created_at DESC)`.
  - `crm_written_at timestamptz` on `un1t_bookings`, `un1t_clients`, `un1t_transactions` (`-- column-grant: n/a, service_role-only tables (mig 726)`).
  - `public.un1t_mirror_keep_crm_write()` trigger function + `BEFORE UPDATE … FOR EACH ROW` trigger on each of the three tables.
  - `class_booking_requests.terms_accepted_at timestamptz`, `terms_source text check in ('website','whatsapp_flow','test_account')`, `terms_version text`, plus `check ((terms_accepted_at is null) = (terms_source is null))`; and `un1t_steps jsonb` (the funnel's per-step record: `{ explanation_email, forgot_password, booking_confirmation, skips: string[] }`, Task 22).
  - `agent_membership_requests_kind_check` re-created with every kind the live constraint lists plus `'refund_request'`.

- [ ] **Step 1: Write the failing PGlite test** with these cases:
  - `builds and passes its own self-check`
  - `a second open (sent/unknown) row for one key is refused 23505`
  - `a second done create_client, trial or forgot_password row for one key is refused`
  - `a done trial by charge then a done trial by free_checkout for the same user and product is refused`
  - `two done book rows for one key are allowed (rebook after cancel)`
  - `trial row without method, or a book row with method, is refused`
  - `sync upsert pulled before the CRM write keeps every CRM column and takes the new synced_at` — insert `un1t_bookings` row `status 'booked', crm_written_at = T`, then `INSERT … ON CONFLICT DO UPDATE` with `synced_at = T - 1 min, status 'booked', event_id 'other'`: row keeps `event_id`, `synced_at = T - 1 min`.
  - `sync terminal status beats a CRM booked whatever the times` — OLD `booked`/`crm_written_at T`, NEW `attended`/`synced_at T - 5 min` → `attended`.
  - `sync booked from an older pull does not undo a CRM cancelled` — OLD `cancelled`/`T`, NEW `booked`/`T - 1 min` → `cancelled`.
  - `sync pulled after the CRM write wins` — NEW `synced_at T + 1 min` → NEW columns.
  - `the CRM's own next write passes` — NEW with a new `crm_written_at` → NEW columns.
  - `the time rule applies on un1t_clients and un1t_transactions; the rank rule only on un1t_bookings`
  - `refund_request is an allowed kind and every kind from mig 711 still is`
  - `terms_source outside the three values is refused; terms_accepted_at without terms_source is refused`
  - `anon and authenticated hold no privilege on un1t_write_events and cannot execute the trigger function`
- [ ] **Step 2: Run** `npx vitest run tests/migration-NNN-un1t-write-back.test.js` — Expected: FAIL (file missing).
- [ ] **Step 3: Write the migration** in one `BEGIN … COMMIT` with `SET LOCAL lock_timeout = '5s'`, a header comment (WHY / WHAT / grants) naming this plan. Table: `ENABLE ROW LEVEL SECURITY`, no policy, `REVOKE ALL ON public.un1t_write_events FROM anon, authenticated`, `GRANT … TO service_role`, `COMMENT ON TABLE`. Trigger function `LANGUAGE plpgsql SET search_path = public`, then `REVOKE EXECUTE ON FUNCTION … FROM PUBLIC, anon, authenticated`. Its rule, in this order:
  1. If `OLD.crm_written_at IS NULL` or `NEW.crm_written_at IS DISTINCT FROM OLD.crm_written_at` → `RETURN NEW` (not a sync overwrite of a CRM write).
  2. If `TG_TABLE_NAME = 'un1t_bookings'`: rank(`booked`) = 0, rank(`attended`,`no_show`,`cancelled`) = 1. rank(NEW) > rank(OLD) → `RETURN NEW`; otherwise fall through to the time rule.
  3. If `NEW.synced_at >= OLD.crm_written_at` → `RETURN NEW`.
  4. Keep OLD: return OLD with `synced_at := NEW.synced_at`.
  The kind CHECK: drop if exists, re-add with mig 711's nine kinds plus `refund_request` (the controller replaces the list with the live `pg_get_constraintdef` list plus `refund_request` if a sibling widened it first). End with a `DO $$` self-check against the catalog: table + RLS, the four indexes with their predicates, the three `crm_written_at` columns, the three triggers, `has_table_privilege('authenticated', 'public.un1t_write_events', 'SELECT') = false`, `has_function_privilege('anon', …, 'EXECUTE') = false`, the kind CHECK admits `refund_request`.
- [ ] **Step 4: Run** the PGlite test plus `npx vitest run tests/table-default-acl-guard.test.js tests/function-execute-guard.test.js && npm run check:rls-restrictive && npm run check:select-columns` — Expected: all PASS.
- [ ] **Step 5: Commit** `git add supabase/migrations/NNN_un1t_write_back.sql tests/migration-NNN-un1t-write-back.test.js && git commit -m "UN1TWRITE.1 — un1t_write_events ledger, crm_written_at rank-first trigger, terms columns, refund_request kind (mig NNN)"`
- [ ] **Step 6 (controller):** applies via Supabase MCP `apply_migration` on `iyvtbjjxdggiadzwwvdj`, then `get_advisors` security; confirms `select count(*) from un1t_write_events` = 0 and that `class_booking_requests` has no column-level grants (`information_schema.column_privileges`), before PR 1 merges.

---

### Task 2: Read client — `getOne` and a per-request hook

**Files:**
- Modify: `src/lib/un1t-online.js` (`createUn1tClient` options and return; export `headerNumber`, `resetWaitMs`)
- Test: `src/lib/un1t-online.test.js`

**Interfaces:**
- Produces: `createUn1tClient({ token, baseUrl, fetchImpl, sleep, maxPages, beforeRequest = async () => {} })` → `{ getSelf, listAll, getOne(path: string): Promise<object /* body.data */>, stats }`; `export function headerNumber(headers, name): number|null`; `export function resetWaitMs(headers): number|null`. If `getOne` already exists on `origin/main` (E slice 1 may add it), keep it and add only `beforeRequest` and the exports.

- [ ] **Step 1: Write the failing tests:** `getOne returns body.data of one GET and never pages` (one call, URL has no `page=`); `beforeRequest runs once before every HTTP request, retries included` (503 then 200 → hook called 2 times); `a beforeRequest that throws stops the request and surfaces the error` (no fetch made). Update the `Object.keys(client)` assertion to `['getSelf','listAll','getOne','stats']`. The existing verb pin (`has no write helper anywhere in the module`) stays byte-identical.
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online.test.js` — Expected: FAIL on the three new cases.
- [ ] **Step 3: Implement** `getOne` through the existing `get()`; call `await beforeRequest()` immediately before each `fetchImpl` in `get()`.
- [ ] **Step 4: Run** the same test — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.2 — read client: getOne and a per-request hook`.

---

### Task 3: Pure write judge and policy table

**Files:**
- Create: `src/lib/un1t-online-write-judge.js` (no imports with I/O)
- Test: `src/lib/un1t-online-write-judge.test.js`

**Interfaces:**
- Produces:
  - `UN1T_WRITE_OPS = ['create_client','forgot_password','trial','book','cancel','checkout']`
  - `REQUIRED_PERMISSIONS: Record<op, string[]>` (Global Constraints values); `missingPermissions(op, permissions: string[]): string[]`
  - `permissionMissingMessage(studioName: string, permission: string): string` (exact text)
  - `judgeUn1tWrite(op, { status: number|null, body: any, expect: { eventId?, userId?, studioId?, bookingId? } }) → { verdict: 'done'|'refused'|'unknown', id: string|null, code: string|null, message: string|null, alreadyBooked: boolean }`
  - `UN1T_REFUSAL_CODES: Readonly<Record<string /* un1t.online error.code */, Un1tRefusalKind>>`, `type Un1tRefusalKind = 'no_credits'|'class_full'|'already_booked'|'trial_used'|'email_in_use'|'late_cancel'`; `Object.freeze({})` until PR 6 fills it. **E reads refusals only through `classifyRefusal`**, never the raw table, so PR 6 changes no caller.
  - `CUSTOMER_ANSWERABLE_REFUSALS = new Set(['class_full','already_booked','late_cancel'])` (E relays these; every other kind or `null` is a staff card).
  - `classifyRefusal({ code, message }) → kind|null` — the table first; until it is filled, only `already_booked` (code or message matches `/already\s*booked/i`) and `email_in_use` (`/email.*(in use|exists|taken|already)/i`) are matched by words. `trial_used` is never guessed (an unmapped trial refusal must reach staff, not tell a customer their trial was used).
  - `KNOWN_BUSINESS_REFUSALS = new Set(['no_credits','class_full','already_booked','trial_used','email_in_use','late_cancel'])` (no `error_events` row)
  - `scrubMessage(text: string, secrets: string[]): string` — removes each secret, cuts to 500 chars
  - `un1tRoutePathLabel(method, path) → 'un1t:<METHOD> <path>'` with uuid / 16+hex / 6+digit segments as `:id`, query dropped
  - `un1tWriteFailureEvent({ method, path, status, reason: '5xx'|'429'|'no_reply'|'unclear'|'auth'|'refused', attempts }) → error_events row` (shape of `glofoxWriteFailureEvent`, `route_type 'un1t_write'`)

- [ ] **Step 1: Write the failing tests:**
  - `book 201 with data.id and matching event, user and studio is done with that id`
  - `book 201 whose data.event_id, user_id or studio_id differs from the request is unknown` (RF5; three sub-cases)
  - `2xx with success:false is refused with error.code and error.message`
  - `a 4xx is refused with the body's code and words`
  - `2xx with no id is unknown, never refused`
  - `already booked by code or by words is done with alreadyBooked true and id null`
  - `cancel 200 with no body schema is done with id = the requested booking id; success:false is refused`
  - `create 201 with data.id is done and the id is the only field returned`
  - `charge 201 with data.transactionId is done`
  - `checkout 201 with an https checkoutUrl is done; http, relative or missing is unknown`
  - `forgot-password 200 success:true is done`
  - `classifyRefusal never guesses trial_used from words`
  - `missingPermissions per op matches the table; forgot_password needs none`
  - `permissionMissingMessage is the exact sentence`
  - `scrubMessage removes every secret and caps at 500`
  - `un1tRoutePathLabel replaces ids and drops the query` (`PATCH /bookings/3f2a…/cancel` → `un1t:PATCH /bookings/:id/cancel`)
  - `un1tWriteFailureEvent builds the id-free row for each reason`
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online-write-judge.test.js` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the pure functions with the signatures above.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.3 — pure un1t.online write judge, permission table, error_events row`.

---

### Task 4: Ledger helpers and write settings reader

**Files:**
- Create: `src/lib/un1t-online-write-ledger.js`, `src/lib/un1t-online-settings.js`
- Test: `src/lib/un1t-online-write-ledger.test.js`, `src/lib/un1t-online-settings.test.js`

**Interfaces:**
- Produces (ledger):
  - `ledgerKey = { create(loc, contactId), trial(loc, un1tUserId, productId, method), book(loc, un1tUserId, eventId), cancel(loc, bookingId), pw(loc, un1tUserId) }` → strings in the Global Constraints shapes
  - `UN1T_IN_FLIGHT_MS = 180_000`
  - `beginAttempt(db, { locationId, contactId, un1tUserId, op, origin, originRef, actorUserId, key, target, method, termsAcceptedAt, termsSource }) → { row } | { open: row, inFlight: boolean }` — inserts a `sent` row; on 23505 reads the open row; `inFlight` = a `sent` row younger than `UN1T_IN_FLIGHT_MS`. Throws on any other DB error (nothing has been sent).
  - `finishAttempt(db, id, { stage, un1tRef, httpStatus, code, message, recovered, checkoutUrl }) → void` — judged write (`.select('id')`, zero rows logs `logError`); never throws past the caller's verdict.
  - `findDone(db, { key }) → row|null`; `listAttempts(db, { locationId, contactId, op }) → rows` (for the processor's resume)
- Produces (settings):
  - `un1tWriteSettingsFrom(settings: object) → { writesEnabled, funnelEnabled, trialProductId, hiddenClassKeywords: string[], sendsWelcome, welcomeSetsPassword, sendsBookingConfirmation }` (pure; `funnelEnabled` false unless `writesEnabled`; booleans are `=== true`)
  - `readUn1tWriteSettings(db, locationId) → Promise<{ membershipSource, studioName, organizationId, settings: <the above> }>`; throws `Un1tSettingsReadError` on a DB error or missing row.

- [ ] **Step 1: Write the failing tests:** `ledgerKey shapes`; `beginAttempt inserts a sent row with every field`; `beginAttempt on 23505 returns the open row and inFlight true when it is younger than 3 minutes`; `… inFlight false for an older sent row or an unknown row`; `beginAttempt throws on any other DB error`; `finishAttempt writes the stage and logs a zero-row update`; `un1tWriteSettingsFrom: writes off forces funnel off; only literal true counts`; `readUn1tWriteSettings throws Un1tSettingsReadError on a read error`.
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online-write-ledger.test.js src/lib/un1t-online-settings.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.4 — write ledger helpers and per-location write settings`.

---

### Task 5: Transport — `createUn1tWriter`

**Files:**
- Create: `src/lib/un1t-online-write.js` (transport section; primitives arrive in Tasks 6 and 10)
- Test: `src/lib/un1t-online-write.transport.test.js`

**Interfaces:**
- Consumes: `createUn1tClient` (`beforeRequest`, `getOne`, `getSelf`, `listAll`), `readConnection(db, locationId, 'un1t_online')`, `tokenFingerprint`, `checkRateLimit`, `recordErrorEvent`, Task 3 judge, Task 4 settings.
- Produces:
  - Error codes: `UN1T_WRITES_OFF`, `UN1T_PERMISSION_MISSING`, `UN1T_RATE_BUDGET`, `UN1T_RATE_LIMITED`, `UN1T_ATTEMPT_IN_FLIGHT`, `UN1T_STUDIO_MISMATCH`, `UN1T_AUTH`, `UN1T_NOT_CONNECTED`.
  - `class Un1tWriteRefused extends Error { code, message }`, `class Un1tWriteUnknown extends Error { code, message }` (the rejections of `createCheckoutLink`).
  - `type Un1tWriteResult = { verdict: 'done'|'refused'|'unknown', sent: boolean, id: string|null, code: string|null, message: string|null, alreadyBooked: boolean, recovered: string|null, retryable: boolean, ledgerId: string|null, data: object|null }`
  - `createUn1tWriter(db, locationId, { fetchImpl = fetch, sleep, now = () => new Date(), clientFactory = createUn1tClient } = {}) → Promise<Writer>` where `Writer = { locationId, studioId, studioName, ensureOp(op): Promise<void /* throws a refusal result */>, send(method: 'POST'|'PATCH', path: string, { body, policy: 'verify'|'never'|'idempotent', idempotencyKey?, verify?: () => Promise<'landed'|'absent'|'unknown'|{ state, id }>, op, expect }): Promise<Un1tWriteResult-without-ledgerId>, read(path): Promise<object>, readAll(path): Promise<object[]> }`
  - `_resetUn1tWriteStateForTests()` (permission cache + error_events cap)

  Behaviour `send` must have (the policy table of spec 6.1): one HTTP request per attempt; 429 → wait reset (or `Retry-After`, or `1000 * 2^attempt`), up to 3 retries, exhausted → `refused`, `UN1T_RATE_LIMITED`, `retryable`, `sent:false`; 401/403 → `refused`, `UN1T_AUTH`, permission cache dropped; 5xx / network fault / judge `unknown` → `verify` runs `verify()` once (budget slot taken with wait) and re-sends once only on `'absent'`, `never` returns `unknown`, `idempotent` re-sends once with the same `idempotency-key`; a landed first attempt reports `recovered: 'landed_after_5xx'`. `ensureOp(op)` checks writes on, then the token's studio, then permissions (5-min cache per fingerprint).

- [ ] **Step 1: Write the failing tests** (fake `fetchImpl`, fake `sleep`, supabase mock for `readConnection`/`rate_limit_hit`/`error_events`/`locations`):
  - `writes off refuses UN1T_WRITES_OFF and sends nothing`
  - `missing permission refuses with the exact message and sends nothing`
  - `token studio different from external_account_id refuses UN1T_STUDIO_MISMATCH`
  - `permissions are cached 5 minutes per token fingerprint and re-read after a 403`
  - `a rotated token (new fingerprint) re-reads permissions`
  - `verify: 5xx then landed reports done with recovered landed_after_5xx and no error_events row`
  - `verify: 5xx then absent re-sends once; a second 5xx is unknown`
  - `verify: 5xx then unknown is unknown and leaves one un1t_write_5xx row`
  - `never: a 5xx is unknown with exactly one request` (and `a 2xx with no id under never is unknown`)
  - `idempotent: a 5xx re-sends once with the same idempotency-key header`
  - `429 is retried after the reset for every policy; exhausted is refused retryable with sent false`
  - `401 and 403 are final: one request, UN1T_AUTH, cache dropped, one un1t_write_auth row`
  - `every HTTP request takes one budget slot, dedupe and permission reads included`
  - `a spent slot before the write sends nothing (UN1T_RATE_BUDGET, retryable)`
  - `a spent slot between the write and its dedupe read waits for the window and still reads`
  - `error_events rows are capped at 5 a minute with one summary warn`
  - `a known business refusal leaves no error_events row; an unmapped 4xx leaves un1t_write_refused`
  - `a 64-character token never appears in a result, error, log line or error_events row` (spy on `logWarn`/`logError`/`recordErrorEvent`)
  - `log lines carry only the allowed fields`
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online-write.transport.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the transport. The write `send` uses `fetchImpl` directly (not the read client's retrying `get`); reads go through a read client built with `beforeRequest` = take one slot (wait when a write is pending its dedupe read).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.5 — un1t.online write transport: policies, permissions, shared budget, error_events`.

---

### Task 6: Primitives `book`, `cancel`, `createClient`, `forgotPassword`, `createCheckoutLink` + un1t_* mirror

**Files:**
- Modify: `src/lib/un1t-online-write.js` (primitives + dedupe reads)
- Create: `src/lib/un1t-online-mirror-write.js`
- Test: `src/lib/un1t-online-write.primitives.test.js`, `src/lib/un1t-online-mirror-write.test.js`

**Interfaces:**
- Consumes: Task 4 ledger, Task 5 writer, `mapBooking`, `mapClient` from `un1t-online-map.js`, `resolveCustomerBaseUrl` from `tenant-host.js`.
- Produces (all `deps = { writerFactory = createUn1tWriter, now }` as last arg):
  - `book(db, args: { locationId: string, contactId: string|null, un1tUserId: string, eventId: string /* bare un1t.online uuid, no 'un1t:' prefix */, origin: 'staff'|'funnel'|'approval'|'mia'|'test_account', originRef?: string|null, actor?: { id: string }|null }) → Promise<Un1tWriteResult>`. On `done`: `id` = un1t.online booking id (null when `alreadyBooked`), `data` = the `mapBooking` row. On `refused`: `code` = un1t.online `error.code` or one of the `UN1T_*` codes, `message` = un1t.online's words, `retryable` true only for `UN1T_RATE_BUDGET`/`UN1T_RATE_LIMITED`/`UN1T_ATTEMPT_IN_FLIGHT`. On `unknown`: the dedupe read already ran. `ledgerId` is the `un1t_write_events` row (E stamps it as `details.un1t_write_id`).
  - `cancel(db, args: { locationId, contactId, un1tUserId, bookingId: string /* bare uuid */, origin, originRef?, actor? }) → Promise<Un1tWriteResult>`; `attended`/`no_show` → `refused`, `code 'already_happened'`.
  - **Throw contract (all six primitives except `createCheckoutLink`):** every un1t.online outcome, every switch / permission / budget refusal resolves as a `Un1tWriteResult`; the promise rejects only with `Un1tSettingsReadError` or a ledger DB error raised **before** anything was sent (safe to retry).
  - `createClient(db, { locationId, contact: { id, email, first_name, last_name, name, phone }, terms: { acceptedAt, source, version }, origin, originRef, actor }) → Un1tWriteResult` (`id` = un1t user id; `data` null; refuses `terms_not_accepted` with nothing sent when `terms.acceptedAt` is missing)
  - `forgotPassword(db, { locationId, contactId, un1tUserId, email, origin, originRef, actor }) → Un1tWriteResult` (policy `never`)
  - `createCheckoutLink(db, { locationId, userId, productId, successUrl, cancelUrl, idempotencyKey, origin = 'mia', originRef = null, actor = null }) → Promise<{ checkoutUrl: string, free: boolean }>`; rejects `Un1tWriteRefused` (incl. `free_product_not_via_checkout`, `not_a_customer_url`, `no_client_at_studio`, `product_not_sellable`, every `UN1T_*` refusal) or `Un1tWriteUnknown`. Optional `origin`/`originRef` are E's.
  - `findLandedBooking(writer, { un1tUserId, eventId, sentAt }) → 'landed'|'absent'|'unknown'` + id; `findCancelState(writer, { bookingId }) → 'landed'|'absent'|'already_happened'|'unknown'`; `findClientByEmail(writer, email) → { matches: string[] } | throws` (full walk of `GET /users/clients`, trimmed lower-case exact).
  - `applyUn1tWriteToMirror(db, { op: 'book'|'cancel'|'create_client'|'trial', locationId, contactId, un1tUserId, studioId, data, requestedAt, product? }, { read }) → { ok: boolean, conflict?: 'un1t_link_conflict' }` — book/cancel: upsert `un1t_bookings` via `mapBooking` with `contact_id`, `crm_written_at = now` (a cancel first re-reads `GET /bookings/{id}`), then one `GET /credits/ledgers/{userId}/{studioId}` → `un1t_clients.credit_balance`/`credit_unlimited`/`crm_written_at`; create: insert `un1t_clients` via `mapClient`, set `contacts.un1t_user_id` only `.is('un1t_user_id', null)`, a 23505 → `conflict`; trial: Task 10; checkout: nothing; never `contact_memberships`. A failed mirror write is `logError` with ids and `ok:false`; the caller's verdict never changes. (The `class_bookings` step is added in Task 11.)

  Every primitive: `writer.ensureOp(op)` → `beginAttempt` (an open in-flight row → `UN1T_ATTEMPT_IN_FLIGHT`, retryable, nothing sent; an older open row → run that op's dedupe read first and finish the old row from it, or for `never` ops return `unknown`) → `send` → `finishAttempt` → mirror on done.

- [ ] **Step 1: Write the failing tests** (fake fetch + supabase mock):
  - `book sends exactly { eventId, userId } and never bypassCredit`
  - `book done upserts un1t_bookings with crm_written_at, refreshes credits and returns the mapped row`
  - `book already booked is done with alreadyBooked true and a done ledger row`
  - `book 5xx: the dedupe read counts a booked row for this event created since the send, or an older booked one, as landed; only cancelled rows as absent; anything else as unknown`
  - `cancel sends an empty body (never forceRefund) and re-reads the booking for the mirror`
  - `cancel dedupe: cancelled landed, booked absent, attended or no_show refused already_happened`
  - `createClient sends accepted_terms and accepted_liability_waiver true and a 32-character password` (assert `password.length === 32`, base64url alphabet)
  - `createClient without a recorded acceptance refuses terms_not_accepted and sends nothing`
  - `createClient never lets the response body out` (RF1: response carries `reset_password_token: 'RPT-SECRET'`, email, phone; none of `RPT-SECRET`, the password, the email or the phone appears in the ledger row, logs, error_events, the result or a thrown error)
  - `createClient 5xx: one email match is landed with the id recovered; none re-sends once; several or a failed walk is unknown`
  - `createClient done links contacts.un1t_user_id only where null; a 23505 returns conflict un1t_link_conflict and overwrites nothing`
  - `forgotPassword is never re-sent: a 5xx is unknown after one request`
  - `forgotPassword with a done pw row for this user sends nothing and returns done`
  - `a second book while the first sent row is under 3 minutes old is UN1T_ATTEMPT_IN_FLIGHT and sends nothing`
  - `an older unknown book row is resolved by the dedupe read before any new send`
  - `createCheckoutLink: signature and return { checkoutUrl, free }`
  - `createCheckoutLink refuses a €0 product (free_product_not_via_checkout), a product not active at the studio, and a userId with no un1t_clients row here`
  - `createCheckoutLink refuses non-https and foreign-host URLs` (host must equal `resolveCustomerBaseUrl(db, locationId)`'s host)
  - `createCheckoutLink sends the key as idempotency-key, stores it and the URL on the ledger, never logs the URL`
  - `createCheckoutLink 5xx retries once with the same key`
  - `createCheckoutLink never calls /purchases/charge`
  - `a mirror write failure leaves the verdict done and logs ids only`
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online-write.primitives.test.js src/lib/un1t-online-mirror-write.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the primitives and the mirror module with the signatures above. The password is generated inside `createClient` only and passed straight into the request body; `scrubMessage(message, [password])` before any ledger write.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.6 — book, cancel, createClient, forgotPassword, createCheckoutLink and the un1t_* mirror`.

---

### Task 7: Static guards — the sync cannot write, the write side cannot misbehave

**Files:**
- Create: `tests/un1t-online-write-guard.test.js` (TypeScript-parser AST, like `tests/glofox-write-retry-guard.test.js`)

**Interfaces:**
- Consumes: the file set. Sync side = `src/lib/un1t-online-sync.js`, `-map.js`, `-contacts.js`, `-occurrences.js`, `-studio-preferences.js`, `src/lib/un1t-online-bookings.js` (C's projection, when present), `src/app/api/cron/un1t-online-sync/route.js`, `src/app/api/locations/[id]/un1t-online/sync/route.js`.

- [ ] **Step 1: Write the guard tests:**
  - `no sync-side module imports un1t-online-write, -write-ledger or -mirror-write, transitively` (walk each sync-side file's relative and `@/` imports to a fixed point)
  - `every send( call in src/ passes a policy that is the literal 'verify', 'never' or 'idempotent'`
  - `every send( call's method and path template is one of the six allowed writes`
  - `/purchases/charge appears only inside the function grantTrial` (PR 1: nowhere; Task 10 adds the one site)
  - `/credits/grant, /refunds, charge-custom, payment-sheet, mark-attendance and reset-password appear nowhere in src/ outside tests`
  - `no object literal in src/ outside tests has a key bypassCredit or forceRefund`
  - `src/lib/un1t-online-write*.js contain no 'PUT' or 'DELETE' verb literal`
  - `src/lib/un1t-online.js still has no write verb` (re-reads the file; the existing pin in `un1t-online.test.js` is unchanged)
- [ ] **Step 2: Run** `npx vitest run tests/un1t-online-write-guard.test.js` — Expected: PASS against Tasks 5-6 (if one fails, the code is wrong, not the guard).
- [ ] **Step 3: Prove each guard bites:** temporarily add `import '@/lib/un1t-online-write'` to `un1t-online-occurrences.js`, and `{ forceRefund: true }` to a body; run; Expected: FAIL naming the file. Revert both.
- [ ] **Step 4: Commit** `UN1TWRITE.7 — static guards: sync import fence, write policies, banned endpoints and keys`.

---

### Task 8: `fileRefundCard`, record-only `refund_request`, invariant  ⚠ OTA (touches `shared/`)

**Files:**
- Create: `src/lib/un1t-online-approval.js` (refund part; Task 23 adds the executor)
- Modify: `src/app/api/agent/membership-requests/[id]/route.js` (a `refund_request` branch), `src/lib/approvals/providers/agent-requests.js` (`KIND_LABELS.refund_request = 'Refund request'`, subtitle), `shared/approval-cards.js` (`APPROVAL_KIND_LABELS.refund_request = 'Refund request'`), `shared/approvals-next-steps.js` (`refund_request` next steps: approved → "Recorded. The refund itself is done by hand in the un1t.online owner console."; declined → no customer draft, since Mia's `refund_request_text` already answered) — **⚠ `shared/` = OTA to every phone on merge (labels and copy only)**, `CLAUDE.md` (one invariant under Glofox/un1t)
- Test: `src/lib/un1t-online-approval.refund.test.js`, `src/app/api/agent/membership-requests/[id]/route.refund.test.js`, `src/lib/approvals/providers/agent-requests.test.js`, `shared/approvals-next-steps.test.js`

**Interfaces:**
- Produces: `fileRefundCard(db, args: { locationId: string, contactId: string|null, un1tUserId: string|null, reason: 'double_payment'|'member_request'|'late_cancel'|string, bookingId?: string|null, transactionIds?: string[], amountCents?: number|null, currency?: string|null, origin: 'staff'|'funnel'|'approval'|'mia'|'test_account', originRef?: string|null, conversationId?: string|null, channel?: 'whatsapp'|'instagram'|null }) → Promise<{ approvalId: string|null }>`; `approvalId` null = the insert failed (logged with ids; never throws, so a Mia turn or a settle path cannot crash on it). Dedupes on a pending `refund_request` with the same `(contact_id, details.reason, details.origin_ref)` and returns that card's id. — inserts `agent_membership_requests` `kind 'refund_request'`, `status 'pending'`, `details: { provider: 'un1t_online', un1t_user_id, reason, booking_id, transaction_ids, amount_cents, currency, origin, origin_ref, record_only: true }`; notifies approvers like `routeToReview`; never imports the write module.

- [ ] **Step 1: Write the failing tests:** `fileRefundCard files a pending record-only refund_request card with provider un1t_online and every field`; `fileRefundCard makes no un1t.online request` (fetch spy untouched); `approving a refund_request records actioned with result { ok: true, record_only: true } and calls nothing in un1t.online or Glofox`; `the approvals list labels refund_request 'Refund request'`; `a second fileRefundCard with the same contact, reason and originRef returns the pending card's id`; `a failed insert resolves { approvalId: null } and logs`; `getNextSteps('refund_request', 'approved') says the refund is done by hand in un1t.online`.
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online-approval.refund.test.js 'src/app/api/agent/membership-requests/[id]/route.refund.test.js' src/lib/approvals/providers/agent-requests.test.js shared/approvals-next-steps.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `fileRefundCard`; in the PATCH route, an `executing && row.kind === 'refund_request'` branch that sets `finalStatus 'actioned'` and `details.result = { ok: true, record_only: true }` before any Glofox branch; the two labels. Add the CLAUDE.md invariant **UN1TWRITE.1** (one bullet): un1t.online writes live only in `un1t-online-write.js` (fenced from the sync by `tests/un1t-online-write-guard.test.js`), are judged on the body, never blind-retried, budgeted at 30/min per studio, ledgered in `un1t_write_events` (service-role only), gated by `settings.un1t_online.writes_enabled`; never `bypassCredit`/`forceRefund`, refunds or `/credits/grant`; `/purchases/charge` only in `grantTrial` for a live €0 product; the generated password is never stored or shown.
- [ ] **Step 4: Run** the tests plus `npx vitest run tests/ota-trigger-paths.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.8 — fileRefundCard and record-only refund_request; UN1TWRITE.1 invariant`.

### Task 9: Feed the ledger's trial rows into A's seam (`ledgerTrials`)

**Files:**
- Modify: `src/lib/membership/reads/un1t-online.js` (add `listLedgerTrials`, as A's plan Task 7 reserves; replace the two `ledgerTrials: []` call sites for `trialEligibility` and `pipelineInputs`)
- Test: `src/lib/membership/reads/un1t-online.test.js` (A's file; add cases)

**Interfaces:**
- Consumes: A's `shapeTrialEligibility({ …, ledgerTrials })` and `shapePipelineSnapshot({ …, ledgerTrials })`, where `ledgerTrials = [{ at, product_id }]` (A's plan).
- Produces: `listLedgerTrials(db, locationId, { stages = ['done','sent','unknown'], un1tUserIds } = {}) → Promise<{ ok: true, byUser: Map<un1tUserId, Array<{ at /* created_at */, product_id /* target */, stage }>> } | { ok: false, error }>` — `op = 'trial'`, named columns (`un1t_user_id, target, stage, created_at`), `.range()`-paged with `.order('created_at')`, ids chunked ≤ 150 per `.in()`. Wiring: **eligibility** gets every row (done, sent and unknown all count as "trial used"); **the board** (`pipelineInputs`) gets only `stage === 'done'` rows. A failed read is A's failed read: `trialEligibility` answers `{ success: false, error }` (never eligible) and `pipelineInputs` skips the run as A's plan does for any failed adapter read. The row shape is fixed from here on (A reads it; E's plan must not change it).

- [ ] **Step 1: Write the failing tests:** `reads only op trial rows in done, sent or unknown, paged past 1,000`; `trialEligibility counts a sent or unknown ledger row as trial_used`; `pipelineInputs counts only done ledger rows as a trial`; `a failed ledger read makes trialEligibility success:false and never eligible`.
- [ ] **Step 2: Run** `npx vitest run src/lib/membership/reads/un1t-online.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the reader and replace A's two `[]` literals with it (filtered for the board).
- [ ] **Step 4: Run** plus `npm run check:select-columns` — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.9 — un1t_write_events trial rows feed A's trialEligibility (done/sent/unknown) and board (done)`.

**PR 1 ship:** Task 1 Step 6 done by the controller; CI mirror; `npm run build`; PR body states "dark: no caller yet; `shared/approval-cards.js` + `shared/approvals-next-steps.js` publish an OTA (labels and copy only)"; changelog entry.

---

## PR 2 — Trial grant, class_bookings write-through, write settings, test-account route

Branch `un1t-write-trial`. **Waits for:** A's PR 2 merged (`un1tOnlineReads.trialEligibility`); C's PR 1 merged with its migration applied (`class_bookings.source_platform`, namespace CHECK); C's PR 2 merged (`mapUn1tBookingToClassBooking` in `src/lib/un1t-online-bookings.js`); PR 1 merged.

### Task 10: `grantTrial`

**Files:**
- Modify: `src/lib/un1t-online-write.js`, `src/lib/un1t-online-mirror-write.js` (trial branch)
- Test: `src/lib/un1t-online-write.trial.test.js`

**Interfaces:**
- Consumes: `un1tOnlineReads.trialEligibility(db, locationId, { un1tUserId, contactId }) → { success, data: { eligible, reasons: string[] } } | { success: false, error }` from `@/lib/membership/reads/un1t-online` (A).
- Produces: `grantTrial(db, args: { locationId: string, un1tUserId: string, contactId: string|null, origin: 'funnel'|'approval'|'mia'|'test_account', originRef?: string|null, actor?: { id: string }|null, skipEligibility?: boolean }) → Promise<{ outcome: 'granted', method: 'charge'|'free_checkout', ledgerId } | { outcome: 'ineligible', reason: 'trial_used'|'membership_history'|'paid_pack' } | { outcome: 'needs_staff', reason: 'un1t_trial_failed:<code>'|'un1t_trial_unverified'|'trial_not_configured'|'trial_product_not_free' } | { outcome: 'retry', code }>`. `skipEligibility` throws unless `origin === 'test_account'`. `grantTrial` files no card itself: callers file the card (`needs_staff.reason` is the card reason). `retry` = eligibility read failed, budget spent, or in flight (the queue retries; Mia hands off). Rejects only as the primitives' throw contract (Task 6) says. Eligibility counts the ledger's `done`, `sent` and `unknown` trial rows as used (through Task 9's reader inside A's `trialEligibility`).
  Mirror: a done trial with a `transactionId` inserts `un1t_transactions` `{ un1t_id: transactionId, un1t_user_id, contact_id, product_id, product_title (from un1t_products), amount_cents: 0, currency, type: 'one_time', product_type: <product type>, raw: { source: 'crm_write' }, crm_written_at: now }`; both methods refresh credits.

  Order (spec 6.6): eligibility (A) → a prior `sent`/`unknown` trial row for `(loc, user, product)` → no new attempt (book only if credits show: return `needs_staff un1t_trial_unverified` unless the credits read shows balance ≥ 1 or unlimited, then `granted`) → `settings.un1t_online.trial_product_id` set (else `trial_not_configured`) → live `GET /products/{id}`: active and `price_amount === 0` (else `trial_product_not_free`, nothing sent) → charge (`never`, key `trial:…:charge`) → done → granted; limit refusal (`trial_used`) → ineligible; other refusal → one free checkout (`never`, key `trial:…:free_checkout`, `successUrl`/`cancelUrl` = customer base URL root) done only if `free === true` AND a credits read straight after shows the credits; a non-free checkout → `un1t_trial_failed:<code>`, its URL never stored or returned; unknown at either call → credits read decides (`granted` or `un1t_trial_unverified`), and the free checkout is never tried after an unknown charge.

- [ ] **Step 1: Write the failing tests** (A's read stubbed):
  - `not eligible sends nothing and returns ineligible with A's first reason`
  - `a failed eligibility read returns retry and sends nothing`
  - `eligible: a €0 active product is charged once with idempotency-key trial:<loc>:<user>:<product>:charge → granted, un1t_transactions row with crm_written_at, credits refreshed`
  - `a product priced above 0 or inactive returns trial_product_not_free and sends nothing`
  - `trial_product_id unset returns trial_not_configured`
  - `charge refused (not limit) → free checkout free:true + credits show → granted by free_checkout`
  - `a free checkout that answers free:false is un1t_trial_failed and its URL is in no result, ledger row or log`
  - `limit refusal at either call → ineligible trial_used` (with `UN1T_REFUSAL_CODES` stubbed to map a code to `trial_used`)
  - `an unmapped charge refusal goes to the free checkout, never to ineligible`
  - `charge unknown: credits show → granted; credits do not show → un1t_trial_unverified; the free checkout is never attempted`
  - `a prior sent or unknown trial row: no new send; books only if credits show`
  - `skipEligibility from any origin but test_account throws`
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online-write.trial.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `grantTrial` (the only function containing `/purchases/charge`).
- [ ] **Step 4: Run** it plus `npx vitest run tests/un1t-online-write-guard.test.js` — Expected: PASS (the charge guard now finds exactly one site, inside `grantTrial`).
- [ ] **Step 5: Commit** `UN1TWRITE.10 — grantTrial: A's eligibility first, €0 charge, server-completed free checkout`.

---

### Task 11: `class_bookings` write-through

**Files:**
- Modify: `src/lib/un1t-online-mirror-write.js` (book/cancel branch)
- Modify: `tests/class-bookings-readers-guard.test.js` (C's guard: list `src/lib/un1t-online-mirror-write.js` as `data-writing`)
- Test: `src/lib/un1t-online-mirror-write.test.js`

**Interfaces:**
- Consumes: C's `mapUn1tBookingToClassBooking(bookingRow /* the mapBooking row, contact_id set */, { locationId, event /* un1t_events row: title, starts_at */, memberName /* contacts.name */, nowIso, writtenBy: 'crm' }) → row | null` from `@/lib/un1t-online-bookings` (null → skip, log). C sets `raw.un1t.updated_at = bookingRow.remote_updated_at ?? null`; D's `bookingRow.remote_updated_at` comes from the response's `updated_at` through `mapBooking`, so D adds nothing of its own clock.
- Produces: after the `un1t_bookings` upsert, one `class_bookings` upsert `onConflict: 'location_id,glofox_booking_id'` of C's mapped row, with `source_platform 'un1t_online'`, `raw.un1t.written_by: 'crm'`, `raw.un1t.updated_at` = the API response's `updated_at`, or `NULL` when the response has none: **never the request time** (our clock is never compared with un1t.online's, C §7). C's tie-break then lets a terminal sync status beat this CRM-written `BOOKED`, and a row with no un1t.online timestamp loses to the next sync pull. The `un1t_bookings` row keeps `mapBooking`'s raw (the response) and is protected only by `crm_written_at` vs our own `synced_at` (Task 1 trigger).

- [ ] **Step 1: Write the failing tests:** `book done writes one class_bookings row through C's mapper with ids un1t:<booking> / un1t:<event> and source_platform un1t_online`; `raw.un1t.written_by is crm`; `raw.un1t.updated_at is the response's updated_at; a response without updated_at writes null, never the request time` (fake clock set far from the response time, assert neither appears unless it is the response's); `cancel done upserts the same key with CANCELLED`; `a class_bookings failure is logged and the verdict stays done`.
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online-mirror-write.test.js tests/class-bookings-readers-guard.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.11 — book and cancel write through to class_bookings with C's mapper`.

---

### Task 12: Write settings on the un1t.online tab (writes switch, trial picker, permissions line)

**Files:**
- Modify: `src/app/api/locations/[id]/un1t-online/route.js` (GET adds `write`; new `PATCH`), `src/components/settings/integrations/Un1tOnlineIntegrationTab.jsx` (copy at line 11 "The CRM only READS…" updated; new "Writes" section), `src/lib/openapi.js`
- Test: `src/app/api/locations/[id]/un1t-online/route.write-settings.test.js`, `src/components/settings/integrations/Un1tOnlineIntegrationTab.test.jsx`

**Interfaces:**
- Consumes: `mergeLocationSettings`, `un1tWriteSettingsFrom`, writer permission read (Task 5).
- Produces:
  - `GET` response adds `write: { writes_enabled, trial_product_id, trial_products: [{ un1t_id, title }], permissions: { all_present: boolean, missing: string[] } | { unreadable: true } }` — `trial_products` = `un1t_products` at the studio, status active, `type` one-time pack, `price_cents = 0`, sorted by title. The private "1) The UN1T Trial" is listed only if it qualifies; the picker default is unset.
  - `PATCH /api/locations/[id]/un1t-online` (master only: `user.profileRole === 'master'`, else 403) body `{ writes_enabled?: boolean, trial_product_id?: string|null }`; `trial_product_id` must be in `trial_products` (400 otherwise); writes `settings.un1t_online.*` through `mergeLocationSettings`; a read failure → 503, nothing written.
  - Tab: "Writes" section (masters only): switch "Allow the CRM to write to un1t.online", trial product picker, "Write permissions: all present" or "Write permissions missing: a, b".

- [ ] **Step 1: Write the failing tests:** route — `PATCH refuses a non-master 403`; `PATCH sets writes_enabled through mergeLocationSettings and keeps every other settings key`; `PATCH refuses a trial product that is not an active €0 one-time product at this studio`; `GET reports missing write permissions from the cached token read`; component — `the Writes section shows only to masters`; `the permissions line lists missing permissions`; `toggling the switch PATCHes writes_enabled`.
- [ ] **Step 2: Run** `npx vitest run 'src/app/api/locations/[id]/un1t-online/route.write-settings.test.js' src/components/settings/integrations/Un1tOnlineIntegrationTab.test.jsx` — Expected: FAIL.
- [ ] **Step 3: Implement.** Register the PATCH in `openapi.js`.
- [ ] **Step 4: Run** plus `npm run check:route-guards && npm run check:location-scoping` — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.12 — un1t.online tab: writes switch, trial product picker, write permissions line`.

---

### Task 13: Test-account route (MIA TEST only)

**Files:**
- Create: `src/app/api/admin/un1t-online/test-account/route.js`
- Modify: `src/lib/openapi.js`
- Test: `src/app/api/admin/un1t-online/test-account/route.test.js`

**Interfaces:**
- Consumes: `createClient`, `forgotPassword`, `grantTrial`, `book`, `cancel`, `createCheckoutLink`.
- Produces: `POST /api/admin/un1t-online/test-account` (master only) body `{ op: 'create'|'forgot_password'|'trial'|'trial_skip_eligibility'|'book'|'cancel'|'checkout', location_id, contact_id, event_id?, booking_id?, product_id?, success_url?, cancel_url?, idempotency_key?, terms_confirmed? }` → `{ success, data: { verdict|outcome, code, message, un1t_user_id?, booking_id?, checkout_url?, free?, ledger_id } }`. Every call `origin 'test_account'`, actor = the master. Contact must be in the location's organisation (404 otherwise) and `String(contact.name).toLowerCase() === 'mia test'` (403 otherwise). `create` requires `terms_confirmed: true` and passes `terms = { acceptedAt: now, source: 'test_account', version: <legal docs version or null> }`.

- [ ] **Step 1: Write the failing tests:** `refuses a non-master 403`; `refuses a contact named anything but MIA TEST (case-insensitive): 'MIA TEST 2', 'Mia Tester'`; `accepts 'mia test'`; `refuses a contact in another organisation 404`; `create without terms_confirmed is 400 and sends nothing`; `create records terms_source test_account on the ledger`; `trial_skip_eligibility calls grantTrial with skipEligibility true; trial does not`; `no response ever contains a password or the create response body`; `checkout returns the URL to the master and nothing logs it`.
- [ ] **Step 2: Run** `npx vitest run src/app/api/admin/un1t-online/test-account/route.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** (`export const maxDuration = 120`: a write plus a dedupe read can wait one budget window).
- [ ] **Step 4: Run** plus `npm run check:route-guards` — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.13 — master-only MIA TEST route over the write primitives`.

**PR 2 ship:** no migration; CI mirror; `npm run build`; changelog entry.

---

## PR 3 — Staff book and cancel from the contact page

Branch `un1t-staff-booking`. **Waits for:** PR 2 merged.

### Task 14: Staff routes

**Files:**
- Create: `src/app/api/un1t-online/classes/route.js`, `src/app/api/un1t-online/classes/book/route.js`, `src/app/api/un1t-online/classes/cancel/route.js`, `src/lib/un1t-staff-booking.js` (shared gate)
- Modify: `src/lib/openapi.js`
- Test: `src/lib/un1t-staff-booking.test.js`, `src/app/api/un1t-online/classes/route.test.js`, `…/book/route.test.js`, `…/cancel/route.test.js`

**Interfaces:**
- Consumes: `getCurrentUser`, `assertLocationAccess`, `readUn1tWriteSettings`, `book`, `cancel`.
- Produces:
  - `gateUn1tStaffBooking(db, user, { locationId, contactId }) → { ok: true, contact, un1tUserId, studioName } | { ok: false, status: 400|403|404, error }` — `assertLocationAccess(user, locationId)` on the **booking studio**; `membership_source === 'un1t_online'` and `writesEnabled` (else 400 "un1t.online booking is off at {studio}."); contact in the studio's organisation (404 otherwise); `contacts.un1t_user_id` set and a `un1t_clients` row `(location_id, un1t_user_id)` (else 400 with the no-account copy).
  - `GET /api/un1t-online/classes?location_id=&contact_id=` → `{ success, data: { classes: [{ id, name, starts_at, day, time, spots_left: number|null, community: boolean }], credits: { balance: number|null, unlimited: boolean, as_of }, upcoming: [{ booking_id, event_id, name, starts_at }], spots_note: 'as of last sync' } }` — `un1t_events` at the studio, `status 'scheduled'`, `starts_at` in (now, now + 14 days], ascending; `spots_left = capacity - bookings_count` when capacity is set; `community = access_mode === 'community'`; upcoming = `un1t_bookings ⨝ un1t_events`, booked and future. Staff only: this route is never public.
  - `POST …/book` `{ contact_id, location_id, event_id }` → `{ success: true, data: { un1t_booking_id, already_booked } }`; refused → `{ success: false, error: <un1t.online words>, code }` 409; unknown → 502 with the unknown copy; `UN1T_RATE_BUDGET` → 429 "un1t.online is busy. Try again in a minute."; permission missing → 409 with the exact permission text.
  - `POST …/cancel` `{ contact_id, location_id, booking_id }` (the booking must be the contact's at that studio in `un1t_bookings`, else 404) → same shapes.
  - `export const maxDuration = 120` on book and cancel.

- [ ] **Step 1: Write the failing tests:** `access is judged on the booking studio, not the contact's studio` (contact at Stillorgan, viewer Hatch-only → allowed at Hatch; Stillorgan-only viewer → 403 at Hatch); `no un1t_user_id or no un1t_clients row at the studio → 400 with the exact copy`; `contact in another organisation → 404`; `writes off → 400`; `classes lists only scheduled future events in 14 days, labels community, shows spots to staff`; `credits line reads balance / unlimited / as_of (crm_written_at else synced_at)`; `book passes origin staff and the actor; already booked is success`; `book unknown answers the unknown copy`; `cancel of a booking that is not this contact's → 404`.
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-staff-booking.test.js src/app/api/un1t-online/classes` — Expected: FAIL.
- [ ] **Step 3: Implement**, register in `openapi.js`.
- [ ] **Step 4: Run** plus `npm run check:route-guards && npm run check:location-scoping && npm run check:select-columns` — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.14 — staff un1t.online class list, book and cancel routes`.

---

### Task 15: Card, BookPanel provider, contact-page mount

**Files:**
- Create: `src/components/Un1tClassBookingCard.jsx`, `src/lib/un1t-class-book-result.js`
- Modify: `src/components/BookPanel.jsx` (`classProvider` prop), `src/lib/contact-page-gates.js` (`un1tBookingStudios`), `src/app/(sales)/contacts/[id]/page.js` (mount after `ContactBookingCard`)
- Test: `src/components/Un1tClassBookingCard.test.jsx`, `src/components/BookPanel.test.jsx` (provider cases), `src/lib/un1t-class-book-result.test.js`, `src/lib/contact-page-gates.test.js`

**Interfaces:**
- Produces:
  - `BookPanel` prop `classProvider: 'glofox'|'un1t_online' = 'glofox'`; `CLASS_PROVIDER_ENDPOINTS = { glofox: { list: '/api/glofox/classes', book: '/api/glofox/classes/book', cancel: '/api/glofox/classes/cancel' }, un1t_online: { list: '/api/un1t-online/classes', book: '/api/un1t-online/classes/book', cancel: '/api/un1t-online/classes/cancel' } }`; un1t requests also send `location_id`. Consultations untouched; `'glofox'` behaviour byte-identical.
  - `un1tClassBookResultView(data, className) → { ok, message, sendChat, bookingId }` (same shape as `classBookResultView`): success "Booked into {class}."; already booked "Already booked in un1t.online"; refusal = un1t.online's words; unknown = the unknown copy.
  - `Un1tClassBookingCard({ contactId, locationId, studioName, waConversationId, waWindowOpen })` — BookPanel with `classProvider 'un1t_online'`, credits line ("Credits: N" / "Unlimited" / "No credits: un1t.online will refuse unless they hold a membership", with as-of), "Upcoming at {studio}" list with Cancel, Undo after a booking.
  - `un1tBookingStudios({ user, clientRows: [{ location_id }], locations: [{ id, name, membership_source, writes_enabled }] }) → [{ locationId, studioName }]` — un1t.online studios with writes on where the contact has a client row and `isMemberOfContactStudio(user, id)`; independent of `work.canBook`.

- [ ] **Step 1: Write the failing tests:** `BookPanel with classProvider un1t_online calls the un1t endpoints with location_id`; `BookPanel default still calls /api/glofox/classes` (snapshot of the request list); `un1tClassBookResultView: success, already booked, refusal words, unknown copy`; `the card shows the credits line, the upcoming list and Cancel`; `un1tBookingStudios: a dual-studio contact gives Hatch only to Hatch members; a Stillorgan-only viewer gets none; writes off gives none`.
- [ ] **Step 2: Run** `npx vitest run src/components/Un1tClassBookingCard.test.jsx src/components/BookPanel.test.jsx src/lib/un1t-class-book-result.test.js src/lib/contact-page-gates.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.** The page reads `un1t_clients` by `contact_id` (named columns) and the studios' `membership_source` + `settings->un1t_online->writes_enabled` server-side (never `settings` whole to the client: pass only the boolean).
- [ ] **Step 4: Run** plus `npm run check:guardrails && npm run check:location-scoping` — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.15 — un1t.online booking card on the contact page, per booking studio`.

**PR 3 ship:** CI mirror; `npm run build`; changelog entry. After deploy, Live Phase 1 can run.

---

## PR 4 — Public listing, terms tick, legal page, editor guard (dark behind `funnel_enabled`)

Branch `un1t-funnel-front`. **Waits for:** PR 1 merged (columns + settings reader). Independent of PR 3.

### Task 16: `readPublicClasses` un1t.online branch

> **Already partly shipped (HATCHSTART.1, 2026-10-18), ahead of this plan:** at any `membership_source = 'un1t_online'` studio `readPublicClasses` now lists `un1t_events` (scheduled, `access_mode 'open'`, after the class_funnel block's minimum notice, not full, `settings.un1t_online.hidden_class_keywords` applied) **whatever `funnel_enabled` says**, with `event_id = 'un1t:' + un1t_id`, not the bare uuid. `isHandBookedEventId` (manual-timetable.js) sends those ids to the `manual_booking` staff card, exactly like `manual-…` ids. When this task and Task 22 land: strip the `un1t:` prefix before the write primitives, and dispatch a `un1t:` id with the funnel off to today's `manual_booking` card (not `un1t_funnel_off`), so a request filed before the switch still books by hand.

**Files:**
- Modify: `src/lib/public-classes.js`, `src/app/api/public/classes/route.js` (response adds `terms`, Task 18)
- Test: `src/lib/public-classes.un1t.test.js`

**Interfaces:**
- Consumes: `readUn1tWriteSettings`, `manualTimetableConfigFromBlocks` (min notice: `minNoticeHours`), `parseHiddenKeywords`, `isClassHidden`, `PUBLIC_CLASS_KEYS`.
- Produces: in `readPublicClasses`, before the Glofox credentials read: `membershipSource === 'un1t_online' && funnelEnabled` → `un1t_events` at the studio, `status 'scheduled'`, `access_mode 'open'`, `starts_at > now + minNoticeHours`, not full (`capacity > 0 && bookings_count >= capacity` dropped server-side), name not hidden by `settings.un1t_online.hidden_class_keywords`, shaped to exactly `PUBLIC_CLASS_KEYS` with `event_id` = the un1t.online uuid, rendered in the studio zone. Settings unreadable → `{ classes: [], error: 'un1t_settings_unreadable' }`; events unreadable → `'un1t_events_unreadable'`. Funnel off → today's path exactly.

- [ ] **Step 1: Write the failing tests:** `funnel on lists only open scheduled future classes after the minimum notice`; `full and community classes are left out`; `the deny-list hides by keyword`; `every class has exactly PUBLIC_CLASS_KEYS (no capacity, no full flag)`; `funnel off or writes off is byte-identical to the manual timetable`; `a Glofox studio is unchanged`; `unreadable settings or events return the error, never classes`.
- [ ] **Step 2: Run** `npx vitest run src/lib/public-classes.un1t.test.js src/lib/public-classes.test.js` — Expected: FAIL (new file).
- [ ] **Step 3: Implement** `readUn1tPublicClasses(db, locationId, days, settings)` and the branch.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.16 — public class list from un1t_events at a un1t.online funnel studio`.

---

### Task 17: Legal documents reader and `/legal/un1t/[slug]/[doc]`

**Files:**
- Create: `src/lib/un1t-online-legal.js`, `src/app/legal/un1t/[slug]/[doc]/page.js`
- Modify: `src/public-compliance-paths.test.jsx` (assert `/legal/un1t/hatch-street/terms` is public in all four allowlists; `/legal/` already is, so no allowlist changes)
- Test: `src/lib/un1t-online-legal.test.js`, `src/app/legal/un1t/[slug]/[doc]/page.test.jsx`

**Interfaces:**
- Produces:
  - `readUn1tLegalDocs(db, locationId, deps) → Promise<{ terms: { content, updatedAt } | null, waiver: { content, updatedAt } | null, version: string|null }>` — `GET /studios/{studioId}/legal/terms-and-conditions` and `/legal/liability-waiver` via `getOne` with the studio's token, cached 1 hour per location per instance; never throws (a failed read → that doc null, logged); `version = 'terms:<updatedAt>|waiver:<updatedAt>'` when both read, else null. These are reads, so no writes switch is needed; they still take budget slots.
  - `legalDocPathFor(publicPath, doc: 'terms'|'waiver') → '/legal/un1t/<publicPath>/<doc>'`
  - Page: resolves `landing_page_settings` by `public_path = slug` → location; 404 unless `membership_source === 'un1t_online'`; renders the studio name, the document as **text** (`white-space: pre-wrap`, never `dangerouslySetInnerHTML`), a link to the other document; failed read → the class_funnel field `legal_unavailable_message` (default in Task 18: "This document could not be loaded right now. Please try again shortly.").

- [ ] **Step 1: Write the failing tests:** `reads both documents once per hour per location`; `version joins both updated_at values; null when either failed`; `a failed read returns null and never throws`; `page renders the text without HTML injection` (content `<script>x</script>` appears as text); `page 404s for an unknown slug or a non-un1t studio`; `/legal/un1t/hatch-street/terms is public in proxy, AppShell, brands and tenant-domains-edge`.
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online-legal.test.js 'src/app/legal/un1t/[slug]/[doc]/page.test.jsx' src/public-compliance-paths.test.jsx` — Expected: FAIL.
- [ ] **Step 3: Implement.** If `check:location-scoping` flags the page's by-`public_path` read, add an `EXEMPT` entry with reason "public legal page resolved by public_path; renders only the studio's published legal text".
- [ ] **Step 4: Run** plus `npm run check:location-scoping` — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.17 — public un1t.online terms and waiver page`.

---

### Task 18: Website terms tick, price guard, editor fields

**Files:**
- Create: `src/lib/un1t-online-funnel-copy.js` (pure: defaults + `un1tFunnelCopyFromBlocks`; no server imports, the editor reads it)
- Modify: `src/app/api/public/class-booking/route.js`, `src/app/api/public/classes/route.js`, `src/components/ClassFunnel.jsx`, `src/app/api/landing-page-settings/route.js`, `src/components/LandingPageSettingsForm.jsx`, `src/lib/openapi.js`
- Test: `src/lib/un1t-online-funnel-copy.test.js`, `src/app/api/public/class-booking/route.un1t-terms.test.js`, `src/app/api/landing-page-settings/route.un1t-price.test.js`, `src/components/ClassFunnel.test.jsx`

**Interfaces:**
- Produces:
  - `DEFAULT_UN1T_FUNNEL_COPY = { terms_label: "I accept {studio_name}'s {terms} and {waiver}", terms_link_label: 'terms and conditions', waiver_link_label: 'liability waiver', terms_required_message: 'Please tick to accept the terms and waiver.', legal_unavailable_message: 'This document could not be loaded right now. Please try again shortly.', account_email_subject, account_email_body, trial_used_email_subject, trial_used_email_body }` (the four email defaults are Task 21's, quoted there) and `un1tFunnelCopyFromBlocks(blocks) → same keys` (blank field → default). `{terms}`/`{waiver}` render as the two links; a label missing one gets that link appended after it.
  - `/api/public/classes` response adds `data.terms = { required: boolean, label, terms_url, waiver_url }` (`required` = un1t studio with funnel on).
  - Booking route: Zod `terms_accepted: z.boolean().optional()`; when the page's studio is un1t.online with funnel on, `terms_accepted !== true` → 400 with `issues.terms_accepted = terms_required_message`; the enqueue writes `terms_accepted_at: now`, `terms_source: 'website'`, `terms_version` (Task 17's `version`, null if unread); a stored class_funnel `price_cents > 0` at a un1t.online studio is ignored (free path) with `logError` once per request (`'class_funnel price ignored at a un1t.online studio'`). Glofox and manual studios unchanged.
  - Landing editor PUT: at a un1t.online studio, a class_funnel block with `price_cents > 0` → 400 "Paid intros are not available at a un1t.online studio: anything paid goes through un1t.online checkout."
  - Editor: class_funnel fields `terms_label`, `terms_required_message`, `legal_unavailable_message` (plus Task 21's four email fields, added there).

- [ ] **Step 1: Write the failing tests:** `defaults carry no em-dash and no capacity word`; `blank fields fall back to defaults`; `funnel on: no tick → 400 with the operator's message; tick → queue row with terms_accepted_at, terms_source website and terms_version`; `funnel off or a Glofox studio: no tick needed and no terms columns written`; `a stored price at a un1t studio books free and logs once`; `editor PUT refuses a price at a un1t studio and accepts it at a Glofox studio`; `ClassFunnel renders the required tick with both links when data.terms.required, and not otherwise`.
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online-funnel-copy.test.js src/app/api/public/class-booking/route.un1t-terms.test.js src/app/api/landing-page-settings/route.un1t-price.test.js src/components/ClassFunnel.test.jsx` — Expected: FAIL.
- [ ] **Step 3: Implement.** Placement on the board (`placeWaitlistEntry`), dedupe, CAPI and rate limit stay as they are.
- [ ] **Step 4: Run** plus the existing `src/app/api/public/class-booking/*.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.18 — website terms and waiver tick, recorded on the request; paid intro refused at un1t studios`.

---

### Task 19: WhatsApp Flow terms OptIn

**Files:**
- Modify: `src/lib/whatsapp-flow/screens.js`, `src/lib/whatsapp-flow/handler.js`, `src/lib/whatsapp-flow/completion.js`
- Test: `src/lib/whatsapp-flow/screens.test.js`, `handler.test.js`, `completion.test.js`

**Interfaces:**
- Produces:
  - `detailsScreen(prefill, carry, terms = { required: false, label: '', url: '' })` → data adds `terms_required`, `terms_label`, `terms_url`, `terms_accepted: false`, `terms_error: ''`.
  - `FLOW_JSON` DETAILS: an `OptIn` `name: 'terms_accepted'`, `label: '${data.terms_label}'`, `visible: '${data.terms_required}'`, `required: '${data.terms_required}'`, `on-click-action: { name: 'open_url', url: '${data.terms_url}' }`, and a `TextCaption` `'${data.terms_error}'`; every DETAILS→CONFIRM→complete payload and the CONFIRM `selection` schema carry `terms_accepted`.
  - Handler DETAILS: terms required and not accepted → DETAILS again with `terms_error = terms_required_message`. `terms.label` = rendered `terms_label` as plain text (Flow labels carry no links), `terms.url` = the terms page (it links the waiver).
  - `parseFlowCompletion` returns `contactFields.terms_accepted: boolean`; completion writes `terms_accepted_at`, `terms_source: 'whatsapp_flow'`, `terms_version` when accepted at a un1t funnel studio. A Stillorgan Flow is unchanged.

- [ ] **Step 1: Write the failing tests:** `FLOW_JSON DETAILS has the bound OptIn and every payload forwards terms_accepted`; `detailsScreen defaults leave the OptIn hidden`; `handler at a un1t funnel studio returns DETAILS with the error until ticked`; `handler at Stillorgan never asks`; `completion records time, source whatsapp_flow and version on the queue row`; `completion without a tick at a un1t studio queues the row with no acceptance` (the processor then cards `terms_not_accepted` for a new person).
- [ ] **Step 2: Run** `npx vitest run src/lib/whatsapp-flow` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** plus `node scripts/build-flow-json.mjs` (Expected: writes the asset without error) — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.19 — WhatsApp Flow terms and waiver OptIn, recorded on the queue row`.

**Rollout note (controller):** the Flow JSON change takes effect only after a new Flow version is published in Meta's Flow Builder. Before Live Phase 2, the controller builds the asset, Richard pastes it into Flow Builder; if Builder rejects the dynamic `required`, drop that one property (the handler's DETAILS check still enforces it) and rebuild.

**PR 4 ship:** CI mirror; `npm run build`; changelog entry.

---

## PR 5 — Funnel processor, account path, emails, approvals, funnel settings

Branch `un1t-funnel-processor`. **Waits for:** PR 2 and PR 4 merged.

### Task 20: Account find / link / create and the set-password step

**Files:**
- Create: `src/lib/un1t-online-account.js`
- Test: `src/lib/un1t-online-account.test.js`

**Interfaces:**
- Consumes: `createClient`, `forgotPassword`, `findClientByEmail`, `listAttempts`, `escapeLikePattern`, Task 21's `sendUn1tAccountEmail`.
- Produces:
  - `findUn1tAccount(db, { locationId, organizationId, contact }, deps) → { kind: 'linked', un1tUserId, executingContactId } | { kind: 'none' } | { kind: 'ambiguous' }` — (a) the contact's own `un1t_user_id` with a client row here; (b) another org contact with the same trimmed, lower-cased email (`.ilike('email', escapeLikePattern(email))` then exact compare in JS) linked to a client here → `executingContactId` = that contact (never a phone-only match); (c) API email walk: one → link the funnel contact (`applyUn1tWriteToMirror` create branch semantics, `.is('un1t_user_id', null)`) and upsert `un1t_clients`; several → `ambiguous`; failed walk → throws.
  - `ensureUn1tAccount(db, { locationId, organizationId, contact, request, origin, originRef, actor }, deps) → { kind: 'existing'|'created', un1tUserId, executingContactId } | { kind: 'card', reason: 'account_ambiguous'|'terms_not_accepted'|'un1t_email_in_use_elsewhere'|'un1t_create_failed:<code>'|'un1t_outcome_unknown'|'un1t_link_conflict' } | { kind: 'retry', code }` — no recorded acceptance on the request → `terms_not_accepted` (never creates); email-in-use refusal → walk again: one → link as existing; none → `un1t_email_in_use_elsewhere`.
  - `runSetPasswordStep(db, { locationId, contact, un1tUserId, request, settings, origin }) → { explanation: 'sent'|'skipped_flag'|<send failure reason>, forgotPassword: 'done'|'refused'|'unknown'|'skipped_flag'|'skipped_not_created'|'skipped_already_done' }` — only when this person's ledger has a `done` `create_client` and no `done` forgot-password for that user; explanation first (skipped when `sendsWelcome`), then `forgotPassword` (skipped when `sendsWelcome && welcomeSetsPassword`); our email failing never blocks the call.

- [ ] **Step 1: Write the failing tests:** `own link first`; `sibling with the same email becomes the executing contact; a phone-only sibling is never used`; `email match is trimmed and case-insensitive exact; jane_x@x.ie never matches jane@x.ie` (RF3); `API walk: one links, several is account_ambiguous, a failed walk throws`; `no acceptance never creates and returns terms_not_accepted`; `email in use: walk again links one, else un1t_email_in_use_elsewhere`; `set-password: explanation then forgot-password, in that order`; `existing accounts get no set-password step`; `a done forgot-password is never repeated`; `sendsWelcome skips our email; sendsWelcome + welcomeSetsPassword skips the call too; each skip is reported`.
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online-account.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.20 — un1t.online account find, link, create and set-password step`.

---

### Task 21: Customer emails (account explanation, trial used) and the E seam

**Files:**
- Create: `src/lib/un1t-online-funnel-emails.js`, `src/lib/un1t-online-trial-used.js`
- Modify: `src/lib/un1t-online-funnel-copy.js` (email defaults), `src/components/LandingPageSettingsForm.jsx` (four fields beside the confirmation email)
- Test: `src/lib/un1t-online-funnel-emails.test.js`, `src/lib/un1t-online-trial-used.test.js`

**Interfaces:**
- Produces:
  - Defaults (verbatim from spec 6.5): `account_email_subject` "You are booked in at {studio_name}"; `account_email_body` "Hi {first_name}, you are booked in for {class_name} on {class_time} at {studio_name}. {address} We have set up your account on the un1t.online app so you can see and manage your bookings. In a minute you will get an email from un1t.online with a code to set your password. Use it to sign in to the app. Arrive about 10 minutes early and a coach will meet you. See you then, {studio_name}"; `trial_used_email_subject` "About your class at {studio_name}"; `trial_used_email_body` "Hi {first_name}, thanks for choosing {class_name} on {class_time}. Our records show you have already had the free trial at {studio_name}, so we have not booked this class yet. To book it you can pick one of these: {options} Just reply to this email with the one you want and we will send you a secure payment link. Once you have paid, we will book you in. See you soon, {studio_name}". Empty offer list → `{options}` = "a class pack or a membership".
  - `sendUn1tAccountEmail(db, { locationId, contact, className, startsAt, blocks, studioName, address, zone }) → { sent, channel: 'email', reason? }` — same consent gate and sender as `sendManualBookingConfirmEmail`.
  - `sendUn1tTrialUsedEmail(db, { locationId, contact, className, startsAt, blocks, studioName, zone }) → { sent, channel, reason? }` — Reply-To `getLocationInboxReplyTo(db, locationId)`; `{options}` from `trialUsedOptionsText`; no payment link ever.
  - Seam for E (E's plan replaces both bodies; D ships the defaults): `trialUsedHandoff(db, { request, contact, locationId }) → Promise<{ handled: boolean }>` (default `{ handled: false }`); `trialUsedOptionsText(db, locationId) → Promise<string|null>` (default `null`).

- [ ] **Step 1: Write the failing tests:** `defaults carry no em-dash and no capacity`; `account email renders every placeholder and goes through the transactional consent gate`; `trial-used email sets the studio inbox Reply-To and contains no URL`; `an empty offer list renders 'a class pack or a membership'`; `operator copy from the block overrides each default`; `the seam defaults hand off nothing and list no options`.
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online-funnel-emails.test.js src/lib/un1t-online-trial-used.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.21 — account explanation and trial-used emails, operator-editable; E hand-off seam`.

---

### Task 22: `processUn1tClassBookingRequest`, dispatch, queue stamp

**Files:**
- Create: `src/lib/un1t-online-booking-processor.js`
- Modify: `src/lib/class-booking-processor.js` (dispatch at the top of `processClassBookingRequest`; `routeToReview` options `provider`, `rowStatus`, `rowLastError`), `src/lib/class-booking-queue.js` (cap card stamped with the provider)
- Test: `src/lib/un1t-online-booking-processor.test.js`, `src/lib/class-booking-processor.dispatch.test.js`, `src/lib/class-booking-queue.test.js`

**Interfaces:**
- Consumes: `readUn1tWriteSettings`, `ensureUn1tAccount`, `grantTrial`, `book`, `runSetPasswordStep`, `sendManualBookingConfirmEmail`, `sendUn1tTrialUsedEmail`, `trialUsedHandoff`, `routeToReview`, `sendCtwaConversion`, `sendWebsiteConversion`.
- Produces:
  - `routeToReview(db, request, reason, { …existing, provider = null, rowStatus = 'needs_review', rowLastError = null })` — `provider` → `details.provider`; `rowStatus` lets a record-only card leave the row `failed` (`trial_used_options_sent`). Existing callers unchanged.
  - Dispatch: `readUn1tWriteSettings` first (a read failure throws, the queue's retry signal); `membershipSource === 'un1t_online'`: a `manual-…` id → `manual_booking` as today; a uuid id with funnel on → `processUn1tClassBookingRequest`; a uuid id with funnel off → card `un1t_funnel_off`. Every other studio → today's path, byte-identical.
  - `processUn1tClassBookingRequest(db, request, { settings }) → { outcome: 'booked'|'needs_review'|'failed', detail }` — steps (spec 6.5, each resumable from the ledger): 1 preflight (event in `un1t_events`, `status 'scheduled'`, `starts_at > now`, else `class_unavailable`; contact email, else `no_email`); 2-3 `ensureUn1tAccount`; 4 credits or membership: ledger read + a live subscription in the mirror (`un1t_subscriptions` status in `MEMBERSHIP_ACTIVE_STATUSES`) → skip the trial; failed read throws; 5 `grantTrial` when none: `granted` → 6; `ineligible` → `trialUsedHandoff` handled → row `failed`/`trial_used_handed_to_mia`, no email; else trial-used email, row `failed`/`trial_used_options_sent`, record-only card `un1t_trial_used` filed with `rowStatus 'failed'`; `needs_staff` → card with its reason; `retry` → throw; 6 `book` (`origin 'funnel'`): done/already booked → row `booked`, `glofox_booking_id 'un1t:<id>'`; refused → `un1t_booking_failed:<code>`; unknown → `un1t_outcome_unknown`; `UN1T_ATTEMPT_IN_FLIGHT`/budget → throw; 7 created account → `runSetPasswordStep`; existing account → booking confirmation (`sendManualBookingConfirmEmail`) unless `sendsBookingConfirmation`; every outcome and every flag skip is written to `class_booking_requests.un1t_steps`; 8 CTWA / website Schedule conversions as the Glofox tail. Every card: `provider: 'un1t_online'`, `executingContactId`.
  - Queue: at the cap, a un1t.online row's `processing_error` card is filed with `provider: 'un1t_online'` (from the thrown error's `reviewOptions.provider`, set by the processor's throws).

- [ ] **Step 1: Write the failing tests:**
  - `happy path new person: create, trial, book, explanation email then forgot-password, in that order`
  - `existing account by own link, by sibling email and by API walk books with no create and no set-password step`
  - `credits or an active subscription skip the trial`
  - `ineligible on the website: trial-used email, row failed trial_used_options_sent, one record-only card, no booking`
  - `ineligible with the hand-off handled: no email, row failed trial_used_handed_to_mia`
  - `trial needs_staff files its reason; trial retry throws`
  - `booking fails after create: card un1t_booking_failed, account kept, no set-password step`
  - `a crash after each sent row resumes without a second create, trial or booking` (fake a throw after `beginAttempt` for each op, re-run, assert one HTTP send per op)
  - `two concurrent requests for one person create one account` (RF2: the second gets `UN1T_ATTEMPT_IN_FLIGHT` and throws)
  - `a class whose start has passed but whose status is still scheduled is class_unavailable` (RF4)
  - `no email → no_email card; no acceptance + new person → terms_not_accepted card; no acceptance + existing account → booked`
  - `sendsBookingConfirmation skips our confirmation and records the skip in un1t_steps`
  - dispatch: `manual ids still go to manual_booking`; `a uuid id with the funnel off files un1t_funnel_off`; `a failed settings read throws`; `a Glofox studio never reads the un1t path` (spy)
  - queue: `a un1t.online row's processing_error card carries details.provider un1t_online`
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online-booking-processor.test.js src/lib/class-booking-processor.dispatch.test.js src/lib/class-booking-queue.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** plus every existing `src/lib/class-booking-processor*.test.js` — Expected: PASS (Glofox paths unchanged).
- [ ] **Step 5: Commit** `UN1TWRITE.22 — un1t.online funnel processor behind funnel_enabled; provider-stamped cards`.

---

### Task 23: `executeUn1tApproval` and the approval route

**Files:**
- Modify: `src/lib/un1t-online-approval.js`, `src/app/api/agent/membership-requests/[id]/route.js`
- Test: `src/lib/un1t-online-approval.test.js`, `src/app/api/agent/membership-requests/[id]/route.un1t.test.js`

**Interfaces:**
- Produces:
  - `UN1T_RECORD_ONLY_REASONS = new Set(['account_ambiguous','un1t_email_in_use_elsewhere','un1t_link_conflict','un1t_trial_used','terms_not_accepted','un1t_funnel_off','class_unavailable','no_email'])`
  - `executeUn1tApproval(db, { row: { id, location_id, kind: 'class_booking'|'class_cancellation', status, details /* provider 'un1t_online', reason, event_id|booking_id, un1t_user_id?, executing_contact_id?, starts_at, source? */, contact_id, channel, conversation_id }, actor: { id: string }, now?: Date }) → Promise<{ finalStatus: 'actioned'|'failed', details: object /* row.details + result */, executed: { ok: boolean, record_only?: true, verdict?: 'done'|'refused'|'unknown', code?: string|null, message?: string|null, un1t_booking_id?: string|null, ledger_id?: string|null }, customerNotified: { sent: boolean, channel: 'email', reason?: string } | null }>`; rejects only on a DB error before any write (the route answers 500, the card stays pending). It does not apply the past-start guard (the route does) and sends no WhatsApp (E sends in-thread). `class_cancellation` rows are executed with `cancel` (E files them; D's tests cover the branch with a fixture row). — record-only reasons execute nothing (`executed = { ok: true, record_only: true }`) and sync the queue row `booked`; `un1t_outcome_unknown` runs the dedupe read first; `un1t_trial_unverified` books only if credits show, never buys; `un1t_trial_failed:*` re-runs eligibility and `grantTrial` once; other reasons re-run the processor steps from the ledger with `origin 'approval'`, actor = approver; a confirmed booking sends the step-7 emails; the funnel queue row is synced as the route does today (`:679-702`). E calls this same function for Mia's cards and adds ACCOUNT_MISMATCH and thread confirmation around it.
  - Route: `const un1tBooking = row.kind === 'class_booking' && row.details?.provider === 'un1t_online'`; excluded from the Glofox `class_booking` branch and from `manualBooking`; the past-start guard applies to executing reasons and skips record-only reasons (like MANUALFUNNEL.1); then `executeUn1tApproval`.

- [ ] **Step 1: Write the failing tests:** `a un1t.online class_booking card never reaches the Glofox executor`; `record-only reasons execute nothing and mark the queue row booked`; `un1t_outcome_unknown reads first and books only on absent`; `un1t_trial_unverified never buys`; `un1t_trial_failed re-runs the grant once`; `an executing card whose class has started expires; a record-only one records`; `approve runs with origin approval and the approver as actor`; `a processing_error card stamped un1t_online resumes from the ledger without a duplicate`.
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online-approval.test.js 'src/app/api/agent/membership-requests/[id]/route.un1t.test.js'` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** plus every existing `src/app/api/agent/membership-requests/[id]/*.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.23 — executeUn1tApproval for un1t.online funnel cards`.

---

### Task 24: Funnel settings on the tab

**Files:**
- Modify: `src/app/api/locations/[id]/un1t-online/route.js` (PATCH schema), `src/components/settings/integrations/Un1tOnlineIntegrationTab.jsx`
- Test: `src/app/api/locations/[id]/un1t-online/route.write-settings.test.js`, `src/components/settings/integrations/Un1tOnlineIntegrationTab.test.jsx`

**Interfaces:**
- Produces: PATCH accepts `funnel_enabled?: boolean`, `hidden_class_keywords?: string`, `un1t_sends_welcome?`, `un1t_welcome_sets_password?`, `un1t_sends_booking_confirmation?: boolean`; `funnel_enabled: true` with writes off → 400 "Turn writes on first."; tab shows the funnel switch (disabled while writes are off), the keyword box, and the three email flags with one-line explanations.

- [ ] **Step 1: Write the failing tests:** `funnel on refused while writes are off`; `keywords stored as typed and parsed by parseHiddenKeywords`; `the three flags round-trip`; `the funnel switch is disabled while writes are off`.
- [ ] **Step 2: Run** the two test files — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.24 — funnel switch, class deny-list and email flags on the un1t.online tab`.

**PR 5 ship:** CI mirror; `npm run build`; changelog entry. Funnel stays off until Live Phase 2.

---

## PR 6 — Refusal-code table from the MIA TEST run

Branch `un1t-refusal-codes`. **Waits for:** Live Phase 1 done (the controller has the recorded codes).

### Task 25: Fill `UN1T_REFUSAL_CODES`

**Files:**
- Modify: `src/lib/un1t-online-write-judge.js`, `src/lib/un1t-online-write-judge.test.js`

**Interfaces:**
- Produces: `UN1T_REFUSAL_CODES` with the codes recorded in Phase 1 for `already_booked`, `trial_used` (from step 1d), `email_in_use` (if observed), and any of `no_credits`, `class_full`, `late_cancel` observed; the word heuristics stay as fallback only for `already_booked` and `email_in_use`.

- [ ] **Step 1: Write the failing tests:** one `classifyRefusal maps <recorded code> to <kind>` per recorded code, with the exact `error.code` strings from the Phase 1 notes.
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online-write-judge.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the table entries.
- [ ] **Step 4: Run** plus `npx vitest run src/lib/un1t-online-write.trial.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.25 — un1t.online refusal codes recorded from the MIA TEST run`.

**PR 6 ship:** CI mirror; changelog entry. Live Phase 2 waits for its deploy.

---

## PR 7 — Flip `bookings` at Hatch (last)

Branch `un1t-bookings-flip`. **Waits for all of:** E slice 2 deployed (every name in `BOOKING_SYSTEM_TOOL_NAMES` dispatches by provider); C's PR 1 hard-off live (`crmMayActOnClassBooking` in reminders and credit-attendance); A's §6.12 step 1 shipped (A's spec: the flip makes `get_my_payment_reminder` reachable at Hatch); Live Phases 1-3 passed; one week of watching (Live section) clean; Richard's go.

### Task 26: The flip

**Files:**
- Modify: `src/lib/membership/sources/un1t-online.js:16` (`bookings: true`), `src/lib/membership/sources/un1t-online.test.js`
- Create: `tests/un1t-bookings-flip.test.js`

**Interfaces:**
- Consumes: E's provider dispatch table for booking-system tools (the name E's plan exports), C's `crmMayActOnClassBooking`.

- [ ] **Step 1: Write the failing tests:**
  - `every name in BOOKING_SYSTEM_TOOL_NAMES has a un1t_online dispatch` (E's table)
  - `credit-attendance with bookings true still skips a un1t.online studio's class_bookings` (C's guard; run the cron handler against a fixture with a Hatch `un1t:` row → `skipped_un1t_online: 1`, no credit)
  - `the customer-agent editor at Hatch renders with bookings true`
  - update the source test: `capabilities.bookings is true; memberships, credits, invoices, schedule unchanged`
- [ ] **Step 2: Run** `npx vitest run tests/un1t-bookings-flip.test.js src/lib/membership/sources/un1t-online.test.js` — Expected: FAIL on the capability assertion.
- [ ] **Step 3: Flip** the one flag.
- [ ] **Step 4: Run** plus the full `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `UN1TWRITE.26 — bookings capability on for un1t.online (E deployed, C hard-off live)`.

**PR 7 ship:** CI mirror; changelog entry. Mia stays OFF at Hatch until Richard switches her on.

---

## Live verification (controller + Richard)

Run in prod with the "MIA TEST" contact. The controller reads with Supabase MCP `execute_sql` (SELECT only) on `iyvtbjjxdggiadzwwvdj` and never prints the test email. Richard does every UI action and every test-account call; the controller may run a call from Richard's signed-in CRM tab console only after he says yes for that step. Calls are `await (await fetch('/api/admin/un1t-online/test-account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, location_id: HATCH, contact_id: MIA, … }) })).json()`. `HATCH` = Hatch Street's location id.

**Phase 0 — after PR 1-3 are deployed** (A PR 2, C PR 1+2 deployed; mig NNN applied, advisors clean).
1. Settings → Integrations → un1t.online at Hatch shows "Write permissions: all present". Missing → Richard adds them to the token in the un1t.online owner console; re-check.
2. Richard creates a contact at Hatch named exactly "MIA TEST" with an email in a mailbox he controls. Controller: `select id from contacts where name = 'MIA TEST' and location_id = HATCH` → one row = `MIA`.
3. Richard ticks "Allow the CRM to write" and picks "The UN1T Trial" (the public one). Controller: `select settings->'un1t_online' from locations where id = HATCH` → `writes_enabled: true`, `trial_product_id` = that product's id, no `funnel_enabled: true`.

**Phase 1 — writes on, funnel off.**
- (a) `op 'create', terms_confirmed: true` → `verdict 'done'`, a `un1t_user_id`, no password field. un1t.online console: client "MIA TEST" at Hatch, terms and waiver accepted. Controller: `contacts.un1t_user_id` set for `MIA`; one `un1t_clients` row; one `un1t_write_events` row `op 'create_client', stage 'done', terms_source 'test_account'`; `select count(*) from un1t_write_events where message ilike '%password%' or message ilike '%reset%'` → 0. **Richard records:** did un1t.online send its own welcome email (→ `un1t_sends_welcome`), and does it let him set a password (→ `un1t_welcome_sets_password`).
- (b) `op 'forgot_password'` → `done`; the reset-code email arrives; Richard sets a password and signs in to the un1t.online app. A second `forgot_password` → `done` with no second email (ledger already done).
- (c) `op 'trial'` → `outcome 'granted'`; record `method` (`charge` or `free_checkout`). un1t.online: a €0 "The UN1T Trial" transaction and 3 credits. Controller: one `un1t_transactions` row `amount_cents 0, raw->>'source' = 'crm_write'`; `un1t_clients.credit_balance = 3`.
- (d) `op 'trial'` again → `outcome 'ineligible', reason 'trial_used'`, and no new `un1t_write_events` row with `op 'trial'`. Then `op 'trial_skip_eligibility'` → expected `ineligible` or an unmapped refusal (`needs_staff un1t_trial_failed:<code>`): **record the exact `code` and message** for PR 6 as `trial_used`. If un1t.online grants a second trial instead, record it for Richard: the CRM check is then the only guard.
- (e) Richard signs in as a staff user who is a member of Hatch only, opens MIA TEST, books a class at least a day out on "Book at UN1T Hatch Street" → "Booked into …"; credits line shows 2 at once. un1t.online shows the booking and 2 credits. Controller: `un1t_bookings` row `status 'booked', crm_written_at` set; `class_bookings` row `glofox_booking_id 'un1t:<id>', source_platform 'un1t_online'`. **Record:** did un1t.online email its own booking confirmation (→ `un1t_sends_booking_confirmation`).
- (f) Book the same class again → "Already booked in un1t.online"; still one booking in un1t.online. **Record the refusal code** if one came back.
- (g) Cancel it from "Upcoming at UN1T Hatch Street" → cancelled in un1t.online; `un1t_bookings.status 'cancelled'`, `class_bookings.status 'CANCELLED'`. **Record** whether the credit came back.
- After the next 15-minute sync: no new contact; no `contact_errors` row for MIA; `un1t_bookings` still `cancelled`; credits right; the run's `counts.history.*.absent_from_pull` unchanged; `select count(*) from error_events where route_type = 'un1t_write'` → 0.
- Richard sets the three email flags on the tab from (a) and (e). The controller hands the recorded codes to PR 6.

**Phase 2 — after PR 4-6 are deployed; funnel on.**
1. Richard publishes the new WhatsApp Flow version (rollout note under Task 19) and checks Hatch's class_funnel copy (done text must not promise a WhatsApp; no paid price set). Then ticks the funnel switch.
2. Website `/start` at Hatch as MIA TEST for another class: the picker lists no community class and no spot counts; the terms tick is required and both links open the studio's documents as readable text. Submit. Expected: found by email, no create, no password email, booked on a remaining credit, the ordinary booking confirmation email (unless the flag says un1t.online sends one), the deal on Hatch's waitlist board as today. Controller: queue row `status 'booked', glofox_booking_id like 'un1t:%', terms_source 'website'`, `terms_version` not null.
3. The same through the WhatsApp Flow for a third class: OptIn shown and required; queue row `terms_source 'whatsapp_flow'`; booked.
4. When MIA TEST has no credits left, one more website booking: the trial-used email arrives (offer list or "a class pack or a membership", Reply-To the Hatch inbox), nothing booked, queue row `failed` / `trial_used_options_sent`, one record-only `un1t_trial_used` card.
5. Anything wrong → Richard turns the funnel off (manual timetable returns; in-flight rows become `un1t_funnel_off` cards).

**Phase 3 — the checkout link (final step).**
- Controller: `select un1t_id from un1t_products where location_id = HATCH and title = '1 Class Credit'`. `op 'checkout'` with that product, `idempotency_key` a fresh uuid, and E's `/pay-done/<token>` URLs if E is deployed, otherwise `https://<Hatch customer host>/` as both URLs → `checkout_url` (https), `free false`. Controller: one `un1t_write_events` row `op 'checkout', stage 'done'`, `idempotency_key` = the key sent, `checkout_url` stored. Richard opens the URL: a un1t.online hosted checkout for €26. **Stop: no payment (G4).** After the next sync: no new `un1t_transactions` row for MIA TEST.

**Then:** watch one week (`un1t_write_events` by stage, cards by reason, `error_events` `route_type 'un1t_write'`, the sync's counts) before PR 7. Cleanup after E's live test: cancel every MIA TEST future booking from the card, Richard sets the account inactive in the un1t.online owner console, marks the contact marketing-off and archives any deal A opened. After go-live Richard pays one checkout link by hand and checks E's book-after-payment.
