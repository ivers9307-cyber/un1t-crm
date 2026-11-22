# CLAUDE.md

Guidance for Claude Code working in **un1t-crm**: the staff and admin CRM (Next.js 16 App Router + Supabase) for UN1T gyms and CCF Autos, deployed to `crm.un1tdublin.com` (and `pay.ccfautos.com`).

> **This is the always-loaded brief: one line per rule.** Each section links to a file in `docs/rules/` that holds the full rule, its reason and its guard. **Open that file before you change code in its area.** When you learn a durable rule, add it to the rules file and a one-liner here; the story goes in `docs/LESSONS.md`, what shipped in `docs/changelog/entries/`.

---

## Invariants

**Data access and security**: full text in [`docs/rules/data-access.md`](docs/rules/data-access.md).
- Every `/api` route runs on the service role, so **RLS does nothing for it**: scope every query in code (`assertLocationAccess`, org filters, owner checks), and detail routes answer 404, never 403.
- Integrations authenticate only with a per-organisation `unitk_` API key; never add a shared or global key.
- A GRANT/REVOKE binds only browser and phone sessions. Name your columns on any read that reaches a client component, use `redactLocationSecrets` on a `locations` row, and give every new column on a column-granted table an explicit grant decision.
- An OAuth token (a JWT with `client_id`) opens `/api/mcp` only. Every MCP tool lives in `src/lib/agent-tools/`, declares a gate and a studio, and scopes its own queries.
- MCP email tools prepare campaigns and never release one; release is only through the signed-in approve page (`releaseCampaign`).
- Tool bodies have two doors (MCP's `runTool`, the assistant's `tool-bridge.js`): take the studio and contact reach from `ctx`, keep `mcp_tool_calls` MCP-only, and never let a door widen access.
- A new `public` function is executable by `service_role` only; grant `authenticated` explicitly when a client calls it.
- A new `public` table, view or sequence is closed to every client session; grant named privileges to `authenticated` only when a client reads it.
- `getCurrentUser()` carries only `USER_PROFILE_COLUMNS` and `CLIENT_LOCATION_COLUMNS`; read anything else fresh by id.
- `contacts` and many other tables are read-only for client sessions; every write goes through a service-role route. Never write a policy that tests only membership (`auth_is_in_location`), `auth_is_owner()` or `auth_role()`.
- `enabled=true` + `test_mode=true` is **live for everyone**; a test allowlist needs `enabled=false`.
- A studio with no WhatsApp number switched on cannot send WhatsApp (`WhatsAppNumberMissingError`); numbers belong to an organisation and are switched on per studio.
- Migrations are forward-only, applied with Supabase MCP to project `iyvtbjjxdggiadzwwvdj` before the code deploys; run the security advisor after DDL.
- User metadata never decides access: `invited_for: 'staff'` mints an inactive, role-less profile, and project sign-ups stay off.
- A staff profile and its auth user are **never deleted**; use `tombstone_staff_profile()`, and list profiles through `excludeTombstones()`.
- Views use `WITH (security_invoker = on)`; policies wrap `auth.uid()` as `(SELECT auth.uid())`.
- Phone-direct RLS uses the `(SELECT …)::uuid[]` permission form, never a per-row function call.
- A restrictive `FOR ALL` policy denies SELECT too; deny writes per command. Keep one permissive policy per table and command.

**supabase-js and PostgREST traps** (they fail silently): full text in [`docs/rules/supabase-traps.md`](docs/rules/supabase-traps.md).
- Builders are thenables with no `.catch`; a write must be awaited; `auth.signOut()` deletes the PKCE verifier.
- A select returns at most 1,000 rows: paginate with `.range()` and an `.order()`. A backfill cursor advances on every attempt.
- Disambiguate `contacts!contact_id(...)` on tables with two FKs to contacts; embedded filters and late `.select()` options break count queries.
- `.ilike()` is a pattern match: wrap an equality value in `escapeLikePattern()`.
- Destructure `error` from every `.single()` and every write, or run the write through `checkedWrite()` (`src/lib/checked-write.js`); a zero-row update is not an error.
- **Never trade a rare wrong value for a certain lost customer message**: log loudly, accept a duplicate or retry, and fail closed only when proceeding is harmful and irreversible.
- A column in a `.select()` and a name in `.rpc()` are claims about the schema: `check:select-columns` and `check:rpc-names` verify them.

**Glofox, Xero and un1t.online**: full text in [`docs/rules/integrations.md`](docs/rules/integrations.md).
- Glofox answers 200 with a failure body on bookings, member reads, registration and purchases: judge with the `interpret*Result()` helpers in `src/lib/glofox.js`.
- A failed Glofox credits or membership read is "unknown", never "no packs".
- `glofoxFetch` never blind-retries a write; every write call declares a `retry:` policy.
- Class bookings reach Glofox one at a time: publish a `class_booking_requests` row only through `publishClassBookingJob`.
- `glofox_webhook_events.event_id` is the entity id (one row per booking); per-delivery history is `glofox_webhook_attempts`.
- Glofox mints a new `invoice_id` per payment attempt, and `glofox_invoices` is stale: never compute amounts owed from it.
- **One location = one Xero organisation**, enforced by a unique index; changing the org invalidates every cached Xero id.
- Only Stillorgan is on Glofox; Hatch Street's members come from un1t.online.
- A Glofox lookup is per studio but a contact's email is unique per organisation: resolve misses with `findGlofoxCrossoverContact`.
- The CRM never reminds, rewards or pushes for un1t.online bookings (`crmMayActOnClassBooking`).
- `/offers` sells through one rule, `offerRail()`; un1t.online purchases are recorded only by `sweepUn1tOfferPurchases`.
- un1t.online writes live only in `un1t-online-write.js` and `un1t-online-write-ops.js`, with a fixed, guarded set of credit and charge functions; never a refund.
- A Glofox member's password is never stored.

**Web and mobile boundary**: full text in [`docs/rules/mobile.md`](docs/rules/mobile.md).
- Mobile cannot import `src/lib`; `shared/` is the seam (`import … from 'shared/…'`).
- The emailed login code is 8 digits (`EMAIL_OTP_LENGTH`); never hard-code a length.
- Never embed `profiles` in a phone-direct select; mobile API calls build headers with `authHeaders()`/`api()`.
- A new `WEB_PERMISSIONS` key needs a mobile decision (`check:mobile-parity`).
- A push to `main` touching a bundle path publishes an OTA to every phone at 100%; an un-ramped staged rollout blocks the next publish.
- Install mobile dependencies with a plain `npm ci`, never `--legacy-peer-deps`.

**Timezones, routing and forms**: full text in [`docs/rules/time-routing-forms.md`](docs/rules/time-routing-forms.md).
- A studio's clock is `locations.timezone`: do zone maths only through `@/lib/location-time` or `shared/zoned-time`, never with a `'Europe/Dublin'` literal.
- A public page lives outside auth-gated segments and goes on **four** allowlists (proxy, AppShell, brands, tenant domains), for its whole flow.
- `?edit=1` on `/welcome` is a staff preview; hand blocks to a client only through `clientSafeBlocks()`.
- Every non-submit `<button>` in a `<form>` has `type="button"`.

**Scheduled jobs and webhooks**: full text in [`docs/rules/crons-webhooks.md`](docs/rules/crons-webhooks.md).
- A new cron is `export const GET = defineCron({ heartbeat }, run)` with its own `maxDuration`, a `vercel.json` entry and a `cron_heartbeats` row; it stamps only a run that did not fail.
- Webhooks are idempotent and answer 200 for unknown events; high-volume ones queue.
- A new Revolut payment table needs a reconcile domain in `src/lib/revolut-reconcile.js`.
- A queued webhook event is never marked processed when it recorded nothing.
- A webhook that claims a dedup key before it writes must release it on failure and store idempotently, so a retry can finish the job.

**Conventions that bite**: full text in [`docs/rules/conventions.md`](docs/rules/conventions.md).
- No silent env fallbacks, no `x-api-key`; responses are `{ success, data?, error?, issues? }`.
- Consent has two families (`_administrative`, `_marketing`); every change goes through a route that writes `consent_log`, and per-studio changes through `applyStudioPreferenceChange`.
- An unregistered `sendPush` category fails closed; pass the bare category name.
- Stillorgan's and Hatch's pipeline boards are placed by one router, `routeContact()`; a paid trial is never a pack.
- `contacts.wa_phone` is derived by one rule in two twins; an inbound WhatsApp message may carry no phone number (use `inboundSender()`, `conversationAddress()`).
- Abandoned `/trial` checkouts have one sweep; funded class bookings never grant a trial; a buyer's IP leaves `attribution` in the same write that settles the row.
- Customer-facing copy is operator-editable.
- Uploads over ~4.5 MB go direct to Storage; bucket limits and their route constants change together.
- Branding lives on `company_settings`, read with `getLocationBranding()`.
- Background watchers never `git checkout` or `pull`.
- Tests: move a fake clock inside `act()`, await every async assertion, use `createFakeDb` for a database, and add a `role-access` case for a table a client reads.
- Mia stays on the Anthropic Messages API; no OpenAI anywhere.

---

## Build, test and ship

Full detail, including what each check catches: [`docs/rules/build-and-ship.md`](docs/rules/build-and-ship.md).

```bash
npm run dev          # localhost:3000
npm run build        # the only check for import resolution and Turbopack
npm test             # vitest
npm run lint         # eslint for src/
```

**CI mirror, run before pushing:**
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:rpc-names && npm run check:schema-snapshot && npm run check:types && npm run check:bundle-sql && npm run check:ota-paths
```

- `main` is protected: a PR is required, **Test & lint** and **Next build** must pass, and the branch must be up to date.
- Every change branches off a fresh `origin/main`, never a local `main`; a follow-up after a merge is a new branch.
- Each PR adds one changelog file, `docs/changelog/entries/<PR>.md`.
- Run `npm run build` locally for a change that adds an import, route or page. `check:mobile-lint` lints `mobile/`; `npm run lint` does not.
- `check:dependency-audit` runs on its own workflow, not in the mirror.

```bash
git fetch origin main && git checkout -b descriptive-kebab-branch origin/main
git commit -am "TICKET.X — summary"
git push -u origin HEAD
gh pr create --base main --fill
```

---

## Architecture (overview)

**Companion deployments sharing the same Supabase project** (`iyvtbjjxdggiadzwwvdj`):
- **un1t-crm** (this repo): the staff, admin and operator surface.
- **champ-app** (`~/code/champ-app`): the customer portal (`app.champfitness.ie`). Its shared modules are mirrored here: see [`docs/rules/champ-app-sync.md`](docs/rules/champ-app-sync.md) before editing `shared/`.
- **champ-bridge** (`~/code/champ-bridge`): a Node service on a Pi per gym that posts heart-rate straps to `/api/bridge/*`.
- **un1t-platform** (older admin dashboard) and **un1t-sentinel** (monitoring).

**Key patterns** (detail in [`docs/architecture/REFERENCE.md`](docs/architecture/REFERENCE.md)):
- Multi-tenant by `location_id`, with `organizations` above locations. Roles are per location on `profile_locations`.
- Two Supabase clients (`src/lib/supabase.js`): the browser's (RLS-bound) and the server's (service role).
- Auth in `src/proxy.js`. **A new route uses `withAuth`** (`src/lib/with-auth.js`; `location: 'param'` for a studio in the URL, judged at that studio); `tests/route-wrapper-guard.test.js` requires it.
- Roles `owner`/`manager`/`head_coach`/`staff` (`MANAGER_ROLES`, `ADMIN_ROLES` in `src/lib/schemas.js`); per-location permissions via `hasPermission()`.
- Input validation with `validateBody()` and the Zod schemas in `src/lib/schemas.js`; use `uuidLike`, never `z.string().uuid()`.
- Every send goes through `applyAudienceFilter()`.

## Coding and extending

Full list in [`docs/rules/conventions.md`](docs/rules/conventions.md).
- UI primitives come from `@/components/ui`, coloured with the light-theme `un1t-*` tokens; status chips are `bg-<c>-500/10 text-<c>-700`.
- No new `console.log` in production paths; fire-and-forget side effects never fail the main response.
- Deprecated columns stay on disk until a later migration drops them.
- Quote bracketed paths (`[id]`) in zsh.
- New module, route, cron, credential, approval surface, role or audience field: follow the checklist in the conventions file.

## Deep reference (read on demand)

| Doc | When to open |
|---|---|
| [`docs/rules/`](docs/rules/) | The full rules behind every line above |
| [`docs/architecture/REFERENCE.md`](docs/architecture/REFERENCE.md) | Module map, helper catalogue, schema and RLS, email/WhatsApp/audience internals, RBAC, orgs |
| [`docs/architecture/INTEGRATIONS.md`](docs/architecture/INTEGRATIONS.md) | Env vars, Xero, Revolut, Pay subdomain, Cars deposit, the MCP server |
| [`docs/glofox-api-reference.md`](docs/glofox-api-reference.md) | Every Glofox call and how its answer is judged |
| [`docs/architecture/MOBILE.md`](docs/architecture/MOBILE.md) | The Expo app in `mobile/` |
| [`docs/LESSONS.md`](docs/LESSONS.md) | The war stories behind the rules |
| [`docs/BACKLOG.md`](docs/BACKLOG.md) | Do-not-build decisions and design-doc pointers |
| [`docs/changelog/entries/`](docs/changelog/entries/README.md) + [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | What shipped; `npm run changelog` prints both |

The OpenAPI spec is generated from the Zod schemas (`src/lib/openapi.js`) at `/api/openapi.json` and `/api-docs`; register new routes there.
