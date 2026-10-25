# un1t.online (Hatch Street) platform integration — design

**Date:** 2026-09-01 (live findings added 2026-10-16)
**Status:** implemented in UN1TSYNC.1–.8 on branch `un1t-online-hatch-sync` (credentials received 2026-10-16). Not yet shipped: migrations 726 (schema; edited in place during review to add the per-organisation `contacts_un1t_user_id_unique (organization_id, un1t_user_id)` and `channel_connections_un1t_online_studio_unique`) and 727 (heartbeat row) are NOT yet applied, and the production dry run is held for the operator.

**Implementation notes and deferrals (2026-10-16):**
- **Hatch classes are deferred from `class_occurrences`** (operator decision 2026-10-16). Events and bookings are stored in `un1t_events` / `un1t_bookings` only; every reader of the shared class spine is unchanged until the follow-up audit.
- **Provider capabilities are all `false`** in the integration registry row (`platform='un1t_online'`), so no KPI, churn, arrears or Mia surface reads `un1t_*` yet. They are flipped one by one as each surface learns the new tables.
- **Stale-write guard:** a sync run writes only while the connection's `config->>token_fingerprint` (a truncated SHA-256 of the token, written at connect; rotation keeps `token_id`, so the id cannot tell a rotated secret apart) still matches the token it started with, so a reconnect with a new token supersedes an in-flight run.
- **Membership endings fail closed:** an ending that cannot be attributed to a resolved contact (an unattributable resolver error) is spared, never inferred; the sync never deletes.

**Scope:** full CRM parity for UN1T Hatch Street, whose booking platform is `un1t.online` rather than Glofox

---

## 0. Live findings, 2026-10-16 (supersede the sections they contradict)

Measured with the issued credential using GET requests only (one `GET /api-token`, then 17 + ~45 list reads). Counts and field names only were recorded; no personal values.

**The credential is an owner-generated studio API token, not a login.** The spec now declares an `api-token` security scheme ("Owner-generated API token (`un1t_…`)"), sent as `Authorization: Bearer un1t_…`. `GET /api-token` self-describes it: name `Repset CRM`, studio `bd608fa2-e0e7-4edf-9615-d558a782356d` (UN1T Hatch Street, Europe/Dublin, EUR; the same id as 2026-09-01), `allowed_origins: []`, expires **2027-10-16**. This settles §5: there is no password and no refresh token. We store one long-lived token, warn ahead of `expires_at`, and a human rotates it (`POST /studios/{studioId}/api-tokens/{tokenId}/rotate` exists, owner-only). §4's sign-in/refresh logic is dropped; a 401 is `Un1tAuthError` (revoked or expired) with no retry.

**The token is near-full access (63 permissions)**, including create/update/delete on events, schedules, bookings, credits, products, discounts, purchases, transactions, `studios:update`, `integrations:update`, `legal_documents:update`. No `users:delete` or `studios:delete`. The issuer offers a `read_only` preset; the recommendation stands to reissue as `read_only` and revoke this one. The client stays GET-only by construction regardless (§4).

**Rate limit: 60 requests per 60 s** (`x-ratelimit-limit/remaining/reset`, reset in seconds). No `Retry-After` seen.

**Paging: `?page=N&pageSize=M` works, `pageSize` is capped at 100** (asking for more silently returns 100). `limit` is ignored. `updated_since` / `updatedSince` are ignored (same rows, same total). So every sync is a full pull, which is cheap at current volume.

**Volumes (whole studio):** clients 182, bookings 301, events 138, subscriptions 25, transactions 96, invoices 36, products 17. A complete sync is ~9 requests at `pageSize=100`.

**Ordering:** clients and bookings come back `created_at` descending; events are unordered. Inserts during a walk shift pages, so the walker dedupes by id and the sync never treats "absent from this pull" as "deleted".

**History window, unexplained:** clients date from 2026-08-19, but bookings only from 2026-09-27 and events only span 2026-09-28 to 2026-10-31. Either Hatch's schedule started late September, or `/bookings` and `/events` are a rolling window. Until known, the local tables accumulate (upsert, never prune), so history older than the window is kept once seen.

**History window, re-checked 2026-10-17 (UN1THARD.2):** after 83 runs, every stored booking (330, oldest 2026-09-27), event (138, oldest 2026-09-28), transaction and invoice (oldest 2026-08-19) was still in the latest pull: nothing has dropped out of the API yet. Transactions and invoices reaching back to 19 Aug while bookings start on 27 Sep points to Hatch's classes starting in late September, not a short window, but only time settles it. So the sync now measures it on every run instead of a dated manual check: `un1t_sync_runs.counts.history.un1t_bookings` / `.un1t_events` carry `absent_from_pull` (rows the mirror holds that this pull did not return) and `oldest_pulled`, and a non-zero count is logged. The day `absent_from_pull` goes above 0 for bookings, `/bookings` is a rolling window (or deletes) and the mirror is the only full history; it never prunes, so nothing is lost either way.

**Shapes vs the published spec:**
- Clients carry no `memberships` key at all. `subscription` is set on 25 (matches the 25 active subscriptions), `ltv` on 26, `last_attended_at` on 86. All 182 are `role: client`, `status: active`; 182 unique emails; 5 on a UN1T domain (staff or test accounts).
- **Client rows include `reset_password_token` and `reset_password_expire` keys** (null on all 182 today). When a member requests a reset, any holder of `users:read` would see a live reset token, which is account takeover. Reported to the franchise; the mapper drops both keys before anything is stored or logged, and a test pins it.
- Money is **integer minor units** (cents): max transaction 18900 = €189.00.
- Bookings carry `source` (all `direct` today), `guest_name/email/phone`, `external_member_ref`, `external_booking_ref`, `credit_charged`, `created_by`. Statuses: attended 206, booked 27, cancelled 58, no_show 10.
- Events: `status` scheduled/completed, `access_mode` open/community, `is_free`, `series_id`, `timeslot_id`, `workout_id`, `clients_limit`, `bookings_count`; **no coach field** in the list row (the spec's `coaches[]` is not present), so `class_occurrences.instructor` stays null from the list read.
- Subscriptions embed `user{id,name,email}` and `product{title, price_amount, billing_interval…}`; transactions embed `user` and `product`; invoices embed `user` and `subscription.product`.

**Live statuses, 18 Oct 2026 (HATCHPIPE.2):** `un1t_invoices.status` holds only `paid` (37 rows, all studios) and `un1t_subscriptions.status` only `active` (26 rows). The other spellings in `normaliseUn1tInvoiceStatus` and `UN1T_ENDED_SUB_STATUSES` (`reads/un1t-online-shape.js`) are defensive, not observed.

**Aggregators (§7.1):** the operator confirms ClassPass/Wellhub members arrive as **separate placeholder accounts**, as on Glofox. None exist yet (0 aggregator email domains, 0 non-`direct` bookings, 0 guest or external refs), and the partner configs (`/integrations/partners`, `/webhooks/wellhub`) are new. The sync therefore records `source`, guest fields and external refs from day one, and the person-linking layer is wired to Hatch as a follow-up once the first aggregator rows appear.

**Still no outbound webhooks to us**, so polling stands (§3).

---

## 1. Problem

Stillorgan runs on Glofox and every CRM surface is fed from it. Hatch Street went live ~14 Aug 2026 on `un1t.online`, a custom platform built by the franchise, and the CRM has **no data source for it at all**.

Current state, verified against the live database on 2026-09-01:

| Location | CRM `locations.id` | Contacts | Platform data |
| --- | --- | --- | --- |
| UN1T Stillorgan | `a0000000-0000-0000-0000-000000000001` | 8,573 | Glofox, fully synced |
| UN1T Hatch Street | `28c78d6b-f7b3-4edf-8c7c-840bd047b3f4` | 89 | none |

**Those 89 Hatch contacts are leads and manual entries, not synced members** — they came from public lead forms and the August Hatch Street announcement campaign. They have no membership, attendance, billing or arrears state. So the first sync will immediately land on the email-collision path in §6 rather than into an empty table, and that path is exercised on day one rather than eventually. Mia cannot answer billing or booking questions for Hatch, sequences cannot enrol on membership state, and the churn radar sees nothing.

Goal: Hatch members, bookings, subscriptions and payments flow into the CRM so that existing surfaces work for Hatch the same way they work for Stillorgan.

Non-goals for this spec:
- Writing back to `un1t.online` (booking, cancelling, granting credits from the CRM). Their API supports it; we deliberately build read-only first so a bug cannot damage franchise production data.
- An MCP server wrapping their API. Useful for ops later, orthogonal to product parity.
- Migrating Stillorgan off Glofox.

---

## 2. What their API is

Re-pulled from the live public spec on 2026-09-01. Snapshot kept at `un1t-openapi.json` in the session scratchpad; re-pull anytime from `https://api.un1t.online/docs/swagger-ui-init.js`.

- **UN1T API 2.0.** Base `https://api.un1t.online`. 117 paths, 160 operations, 121 schemas.
- Node/Express on Railway (London), fronted by Cloudflare. Internal codename appears to be "Hikari" (`x-hikari-trace` response header). Dev twin at `api-dev.un1t.online`.
- **Auth: JWT bearer, obtained by user login.** `POST /auth/signin` with `{email, password}` returns `{accessToken, refreshToken, user}`. `POST /auth/refresh` with `{refreshToken}` returns a new pair. There are no API keys, no service-account concept and no scopes.
- **150 of 160 operations are bearer-gated** (counted from the spec, not estimated). The 10 public ones are `POST /auth/{signup,signin,signout,refresh,forgot-password}`, `GET /health`, `GET /tvs/{display,info}`, `POST /tvs/ping` and `POST /webhooks/stripe`.
- **No outbound webhooks.** The only webhook is their own inbound Stripe receiver. Nothing will ever push to us.
- **List endpoints return a pagination envelope but document no query parameters.** `GET /users/clients`, `/bookings`, `/events`, `/subscriptions`, `/transactions` all respond `{success, data[], pagination{total, page, pages, pageSize}}` while declaring zero `page`, `limit`, `studioId` or `updated_since` params. Either undocumented or absent. See §7.
- **No rate-limit headers.** `GET /health` returned no `RateLimit-*` or `Retry-After`.

### 2.1 The studio ID is not stable

`GET /studios/public` on 2026-09-01 returns a single studio:

```json
{"success":true,"data":[{"id":"bd608fa2-e0e7-4edf-9615-d558a782356d","title":"UN1T Hatch Street"}]}
```

Our 14 Aug 2026 recon recorded the Hatch studio id as `2c50213a-143a-4811-b59b-3e6b534054e4`. **It changed.** Design consequence: never hard-code a studio id. Resolve it at connect time from `/studios/public` by title, persist it, and re-verify on every sync run. If the persisted id no longer resolves, fail loudly rather than syncing nothing silently.

This also raises an unanswered question about whether user, booking and subscription ids are stable, which every local mapping depends on. Tracked in §7.

### 2.2 The data we actually get is richer than Glofox

`ClientListRowResponseDto` (from `GET /users/clients`) already carries everything the CRM contact spine needs, plus derived fields Glofox makes us compute:

`id`, `role`, `status` (`active|inactive|blocked`), `name`, `first_name`, `last_name`, `email`, `phone`, `birthday`, `gender`, `country`, `city`, `postcode`, `next_of_kin`, `accepted_terms`, `accepted_liability_waiver`, `avatar`, `created_at`, `updated_at`, `memberships[]`, `studio`, `subscription`, `credit_ledger`, `last_attended_at`, `bookings_30d`, `ltv`.

Other shapes we consume:

| DTO | Key fields |
| --- | --- |
| `SubscriptionResponseDto` | `status`, `current_period_start/end`, `cancel_at_period_end`, `credits_per_period`, `trial_end`, `paused_at`, `paused_until`, `past_due_at`, `stripe_subscription_id` |
| `TransactionResponseDto` | `type`, `amount` (integer minor units), `currency`, `refunded`, `refund_status`, `product_type`, `stripe_payment_intent_id`, `invoice_id` |
| `BookingResponseDto` | `user_id`, `studio_id`, `event_id`, `status`, `credit_charged` |
| `EventResponseDto` | `title`, `status`, `clients_limit`, `access_mode`, `bookings_count`, `start_time`, `end_time`, `coaches[]` |
| `MemberAnalyticsResponseDto` | `active_members`, `first_time_visitors`, `new_members`, `expiring_subscriptions`, `frozen_subscriptions` |
| `FinancialAnalyticsResponseDto` | `total_revenue`, `mrr`, `revenue_per_active_member`, `revenue_per_event`, `currency` |
| `AttendanceAnalyticsResponseDto` | `total_events`, `total_bookings`, `capacity_filled`, `attendance_per_event` |

`past_due_at` on subscriptions is the arrears signal, and it is a direct field rather than something reconstructed from invoice state. That avoids the whole class of Glofox arrears traps documented in `glofox-arrears-reconciliation` and `churn-overdue-vs-profile-arrears`.

**Capacity fields are staff-only.** `clients_limit`, `bookings_count` and `capacity_filled` must never reach customer-facing surfaces, per the standing rule that class capacity is never shown to customers. Time and class name only.

---

## 3. Architecture

Parallel provider tables plus a shared person spine, matching the pattern the CRM already uses for Glofox (`glofox_invoices`, `glofox_memberships`, `glofox_services` are existing parallel tables).

```
api.un1t.online
      │  poll (no webhooks exist)
      ▼
/api/cron/un1t-sync ──► src/lib/un1t-sync.js ──► src/lib/un1t-online.js (HTTP client)
      │
      ├──► contacts                 (shared person spine, +un1t_user_id)
      ├──► un1t_subscriptions       ┐
      ├──► un1t_transactions        │ parallel provider tables
      ├──► un1t_invoices            │ mirroring their DTOs
      ├──► un1t_products            │
      ├──► un1t_bookings            ┘
      └──► class_occurrences        (shared studio spine, source_platform tagged)
                   │
                   ▼
            union views ──► arrears / churn / attendance / KPI surfaces
```

### 3.1 Why `contacts` stays shared and is not forked

Every identity-dependent system in the estate keys off `contacts`: Mia, sequences, the unified inbox, mail, the contact drawer, the person-account router. A Hatch member who is not a contact is invisible to all of it, which fails the parity goal outright.

`contacts_email_unique` is a **global** unique index, so the same person training at both locations is already one row by construction. We add `un1t_user_id` and `un1t_synced_at` alongside the existing `glofox_member_id` and `glofox_synced_at`, exactly mirroring that precedent. A dual-location member ends up as one contact carrying both external ids, which is correct and is what the person-account router already expects.

### 3.2 Why platform data goes in parallel tables

`contacts` already carries **19** `glofox_*` columns (verified against the live database), from `glofox_membership_status` and `glofox_billing_interval` through to `glofox_passcode` and `glofox_signup_answers`. Writing Hatch subscription and payment state into columns named `glofox_*` would be actively misleading, and would poison every Glofox-specific cron, arrears reconciliation and health check that reads them. Parallel `un1t_*` tables keep the two platforms from contaminating each other and follow the pattern already established by `glofox_invoices`, `glofox_memberships` and `glofox_services`.

Of those 19, only `glofox_member_id` and `glofox_synced_at` are structural rather than Glofox-specific data. Those two are exactly what `un1t_user_id` and `un1t_synced_at` mirror.

### 3.3 The `class_occurrences` exception

`class_occurrences` is the shared studio schedule spine (migration 284). TV displays, class climate control, HR sessions, attendance crediting and automations all read it. If Hatch classes do not land here, none of the Hatch studio automation works.

Its external key column is named `glofox_event_id` (`NOT NULL`, unique with `location_id`) and is referenced by 52 files under `src/`. It is already functioning as an opaque external event id; only the name is wrong. Its live columns are `id`, `location_id`, `glofox_event_id`, `name`, `program`, `starts_at`, `ends_at`, `capacity`, `instructor`, `raw`, `synced_at`, `created_at`, `cancelled_at`.

Their `EventResponseDto` maps onto it cleanly: `title` to `name`, `start_time`/`end_time` to `starts_at`/`ends_at`, `clients_limit` to `capacity`, `coaches[]` to `instructor`, the whole DTO to `raw`, and `status` to `cancelled_at` where the event is cancelled.

**Decision:** write Hatch event ids into that column as-is and add a `source_platform` column beside it to disambiguate. Do not rename now. A 52-file rename touching TV, climate and attendance-crediting paths is disproportionate risk for a naming fix, and those paths include several documented traps. Logged as debt in §8.

---

## 4. Components

Each unit has one job and can be understood without reading the others.

### `src/lib/un1t-online.js` — HTTP client

The only file that knows their wire format. Everything above it sees plain objects.

- `signIn(email, password)` and `refresh(refreshToken)` against `/auth/*`.
- Automatic re-auth: on `401`, refresh once and retry once. If refresh also fails, sign in again. If that fails, throw a typed `Un1tAuthError` so health reporting can distinguish "credentials dead" from "API down".
- `listAll(path, opts)` walks `pagination.pages`, with a hard page cap and a logged warning if the cap is hit, so a runaway never silently truncates.
- Backoff on `429` and `5xx`, honouring `Retry-After` when present and using exponential backoff when absent (they expose no rate-limit headers today).
- **Read-only by construction.** The client exposes no `POST`, `PATCH` or `DELETE` helpers for member, studio or booking resources. Adding writes is a deliberate later change, not an accident.

### `src/lib/un1t-sync.js` — sync engine

Their DTOs to our tables. Pure mapping functions, unit-testable without network.

- `syncClients` upserts `contacts` on `un1t_user_id`, with the email-collision path in §6.
- `syncSubscriptions`, `syncTransactions`, `syncInvoices`, `syncProducts`, `syncBookings` upsert the `un1t_*` tables on their external ids.
- `syncEvents` upserts `class_occurrences` with `source_platform = 'un1t_online'`.
- `resolveStudioId` re-verifies the persisted studio id against `/studios/public` every run and fails loudly on mismatch (§2.1).

### `/api/cron/un1t-sync` — the poller

Because nothing pushes to us. Cadence set once we know their rate limits. Writes a `cron_health` heartbeat so the existing staleness detection covers it.

### Registry and health

Add `un1t_online` to the `channel_connections` platform CHECK and to `REGISTRY_PLATFORMS` in `integrations-hub.js`, and add a row to `integration-health.js`. The live constraint today is:

```sql
CHECK (platform = ANY (ARRAY['instagram','messenger','glofox','unifi',
  'sensibo','thinq','twilio_sender','bca','postmark_domain']))
```

so the migration drops and recreates it with `'un1t_online'` appended. The sibling `channel_connections_status_check` already allows `connected | action_needed | error | not_connected`, which is the vocabulary `integration-health` maps from, so no change is needed there. Hatch then gets the same red/amber/green treatment as every other integration and cannot fail silently, which is the specific failure mode the integration-health pane exists to prevent.

### Settings surface

A connect/disconnect tab at `/settings` for the Hatch location, same shape as the Glofox tab. Stores the connection and shows last-sync state.

### Union views

For the cross-location surfaces only (arrears, attendance, KPI scorecard). Surfaces that already filter by `location_id` and read `contacts` need no change, because Hatch members are contacts.

---

## 5. Credential storage

This is the awkward part and it needs a decision before the connect flow is built.

There is no API key. Staying signed in long-term means either:

- **(a)** Store the owner-role **password** in `channel_connections`, and re-sign-in whenever the refresh token dies. Simple, always recoverable, but it puts a production password at rest in our database.
- **(b)** Store only the `refreshToken`. No password at rest. Requires that their refresh tokens are long-lived, and a dead token means a human re-connects through the settings UI.

**Preference: (b), conditional on their answer about refresh-token lifetime and rotation** (§7, question 1). If refresh tokens are short-lived, (b) means constant manual reconnection and we fall back to (a) with the credential encrypted at rest and the account scoped as narrowly as their roles allow.

Either way the account must be a **dedicated service user**, never Richard's personal login, so it can be rotated and revoked independently.

---

## 6. Identity and dedupe

`contacts_email_unique` is global. A Hatch client whose email already exists as a contact must not create a second row and must not fail the sync.

This is not hypothetical. Hatch already holds 89 lead and manual contacts (§1), and Stillorgan holds 8,573. Anyone who enquired at Hatch through a lead form and then joined on `un1t.online` is already a contact here, and the very first sync run will find them.

Resolution order on each client:

1. Match on `un1t_user_id`. Update in place.
2. Else match on normalised email. **Attach** `un1t_user_id` to the existing contact rather than inserting. Do not overwrite `location_id`, `glofox_member_id` or any `glofox_*` field. This person now legitimately exists at both locations.
3. Else insert a new contact with `location_id` = Hatch and `source` marking its origin.

Case 2 is the interesting one and needs explicit test coverage, because getting it wrong either duplicates people or silently rebinds a Stillorgan member to Hatch. Both are worse than a failed sync.

Records with a null or blank email cannot participate in step 2 and are matched on `un1t_user_id` only.

**If the franchise ships ClassPass and Gympass with Glofox-style shadow users** (§7.1), step 2 stops being sufficient on its own: shadows share a placeholder email domain and phone, so they collide with each other rather than with the real person. That is precisely the case the existing `person-match.js` name-matching path handles, and the fix is to run Hatch through the established person-linking layer rather than to complicate the resolution order here. Decide once their answer lands; do not pre-build it.

---

## 7. Open questions for the franchise (blocking)

**Framing: the franchise is already building ClassPass and Gympass support.** Those integrations need the same plumbing we do (partner credentials, change notification, rate limits), so the ask is deliberately small and scoped to "treat the CRM as one more consumer of that work" rather than requesting anything bespoke. Kept to three items. Draft email held outside this public repo as correspondence.

1. **Service account.** A dedicated login for the CRM rather than a personal one. If the aggregator work introduces API keys or partner credentials, we take those instead and ask for nothing custom. Either way we need the `accessToken` and `refreshToken` lifetimes, and whether refresh rotates (this decides §5).
2. **Filtering and change notification.** Are `page`, `limit` and above all `updated_since` supported but undocumented? And if outbound webhooks are being added for ClassPass and Gympass, the same four events cover us: member created/updated, booking created/cancelled, subscription status change, payment succeeded/failed. Plus whatever rate limits they want us under.
3. **A design request on the aggregator work itself**, covered in §7.1. Not blocking, but the highest-leverage thing in the email.

Deliberately dropped from the ask to keep it small: studio/record id stability (already handled defensively in §2.1 by resolving on every run), separate dev credentials (nice to have, we can build against fixtures), the undocumented `GET /users/clients/export` response type, and four platform hardening observations. None block delivery. The hardening items are not enumerated in this public repository.

### 7.1 The aggregator design request

Worth stating carefully because it is the one place our experience saves the franchise real work, and it directly determines how much identity machinery Hatch needs.

Glofox makes two choices with aggregator users that cost us continuously at Stillorgan:

- **A new shadow user per ClassPass signup** rather than one user per person, all sharing a placeholder phone and an `@members.classpass.com` email. Roughly 1,560 of ~8,264 Stillorgan contacts are these shadows, about 19% of the contact base. Phone and email are both useless as match keys, so linking falls back to **name**. That is the entire reason `person_groups`, `person_group_members`, `person_match.js`, `person-detect.js`, the duplicates review queue and migrations 270, 271 and 334 exist.
- **The aggregator member id lives in a metadata blob**, not a field, and the obvious `origin` field is unreliable: a full-price member who also uses Gympass has no `origin` key at all. The robust marker turned out to be `member.metadata.gympass.id` / `member.metadata.classpass._id`.

The request to the franchise is simply: **one user per person, and expose the aggregator id as a first-class nullable field** (`classpass_id`, `gympass_id`) on the user record.

**Design consequence for us either way.** If `un1t.online` mirrors the Glofox shadow-user pattern, Hatch will import aggregator shadows into `contacts` and will need the existing person-linking layer pointed at it. That layer is already built and location-scoped, so this is wiring rather than new construction, but it is not free and it is why the answer matters before we size the work. If they take the request, Hatch needs none of it.

---

## 8. Risks and debt

| Risk | Mitigation |
| --- | --- |
| Studio id churn breaks sync silently | Re-verify against `/studios/public` every run, fail loudly on mismatch |
| No `updated_since` forces full pulls | Blocked on Q2. If unavailable, full pull on a slow cadence plus a page cap, and revisit when they add filtering |
| Service account has full owner power including `DELETE /users/{id}` and `DELETE /studios/{id}` | Client exposes no destructive methods at all; read-only by construction |
| Owner password at rest | Prefer refresh-token-only storage, see §5 |
| Dual-location member duplicated or rebound | Explicit resolution order in §6 with dedicated tests |
| Hatch imports aggregator shadow users, as Glofox does (~19% of Stillorgan contacts) | Blocked on §7.1. If they mirror the Glofox pattern, point the existing person-linking layer at Hatch. Sizing depends on their answer |
| Polling means stale data for Mia | Blocked on Q4. Until webhooks exist, cadence is the only lever |
| `class_occurrences.glofox_event_id` holds un1t ids | Accepted debt. `source_platform` disambiguates. Rename when something else forces those 52 files open |
| Capacity fields leak to customers | `clients_limit`, `bookings_count`, `capacity_filled` are staff-only; never mapped onto customer-facing surfaces |

---

## 9. Testing

- **Mapping functions:** pure unit tests over recorded DTO fixtures taken from their spec. No network.
- **Identity resolution:** the three cases in §6, including the dual-location attach, plus null-email rows.
- **Client behaviour:** 401-then-refresh-then-retry, refresh failure escalating to `Un1tAuthError`, 429 backoff, pagination walk, and the page-cap warning.
- **Studio id mismatch:** sync fails loudly rather than writing nothing.
- **Health:** connection states map to the correct red/amber/green in `integration-health`.

Per the standing rule from `jsdom-cannot-see-layout`, any settings UI added here is verified in a real browser against a Vercel preview, not only in jsdom.

---

## 10. Sequencing

1. Send the builder questions. Everything downstream depends on Q1 and Q2.
2. While waiting: migration, HTTP client, and mapping functions against recorded fixtures. All of it is testable with no credentials.
3. On credentials: wire the cron and do a read-only live run. We are no longer asking for separate dev credentials, so the safety margin comes from the client being read-only by construction (§4) rather than from a sandbox. If they volunteer `api-dev` access, use it first.
4. Union views and the KPI scorecard wiring.
5. Registry, health and the settings tab.
6. Write-back actions and an ops MCP are separate later specs, deliberately out of scope here.
