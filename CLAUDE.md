# CLAUDE.md

Guidance for Claude Code working in **un1t-crm** — the staff/admin CRM (Next.js 16 App Router + Supabase) for UN1T gyms and CCF Autos, deployed to `crm.un1tdublin.com` (and `pay.ccfautos.com`).

> **This file is the lean always-loaded brief.** It holds the invariants, commands, and a map. Deep reference (every module, integration, the data model, war-stories) lives in `docs/` and is linked under [Deep reference](#deep-reference-read-on-demand) — open those on demand; don't inline them here. Keep this file lean: when you learn a durable *rule*, add a one-liner to Invariants; put the *story* in `docs/LESSONS.md` and the *what-shipped* in `docs/CHANGELOG.md`.

---

## ⚠️ Invariants — read first

The "if you miss one, you break prod or burn a session" list. Terse on purpose; war-story detail in `docs/LESSONS.md`.

**Data access & security**
- **Service-role routes get NO RLS.** Every `/api` route uses `createServerClient()` (service role, RLS-bypassing). RLS only binds `authenticated`/`anon` — it does **nothing** for a route. Enforce access in app code: `assertLocationAccess(user, locationId)` for location rows, an org-membership filter for org rows, owner/recipient/master checks for per-user rows. Detail routes return **404 not 403** so IDs can't be enumerated. Audit any read route by asking "what filters this if I delete the RLS policy?" — if "nothing", it's an IDOR.
- **`enabled=true` + `test_mode=true` = LIVE FOR EVERYONE** (agent, WhatsApp numbers). A test allowlist needs `enabled=false`. Re-activating a `whatsapp_numbers` row needs a *permanent* System User token (a 24h temp token dying is what silently killed agent sends before).
- **Migrations are forward-only**; apply via Supabase MCP (`apply_migration`) against the **un1t-crm** project (ref `iyvtbjjxdggiadzwwvdj`; confirm via `list_projects` — NOT the sentinel project `tpttqakxmyxrwnqjepfm`). Run `get_advisors` (type=security) after any DDL. Apply the migration *before* the code that depends on it deploys.
- **Supabase views default to SECURITY DEFINER** (bypass RLS). Always `WITH (security_invoker = on)`. The advisor flags it ERROR-level.
- **RLS policies: wrap `auth.uid()` in `(SELECT auth.uid())`** (advisor `auth_rls_initplan` — per-row vs per-query eval).
- **One permissive policy per (table, command).** Don't pair a `FOR ALL` "manage" policy with a separate read policy — the `FOR ALL` overlaps the read on SELECT and trips `multiple_permissive_policies` (counted ×5 grant roles). Instead write the manage side as **explicit `INSERT`/`UPDATE`/`DELETE`** policies and keep a **single `SELECT`** policy whose `USING` is the OR of every population that may read. RLS ORs permissive policies, so `FOR ALL` ≡ the four per-command policies and merging reads is behaviour-preserving. Scope policies `TO authenticated` unless anon genuinely needs them. Reference cleanup: mig 320 (and 167).

**supabase-js / PostgREST traps** (these fail *silently*)
- **Builders are thenables, not Promises** — they have `.then` but no `.catch`. `await db.rpc(...).catch(()=>{})` throws and the rpc never runs. Use `try { await … } catch {}`.
- **`.update()/.insert()` must be `await`ed** or the request never fires (silent no-op).
- **1,000-row select cap.** Every `.select()` returns ≤1000 rows regardless of `.limit()`. Any fan-out (sends, imports, backfills) must `.range()`-paginate with an explicit `.order()`. Copy `src/lib/pipeline-reclassify.js`.
- **Bare `contacts(...)` embeds 300 (`PGRST201`) once a table has ≥2 FKs to contacts** — disambiguate `contacts!contact_id(...)`. ≥2-FK tables today: `whatsapp_conversations`, `instagram_conversations`, `team_members`.
- **Embedded-resource filters break under count-only (`head:true`) selects** → return 0, no error. Don't fight it: denormalise the filtered column onto `contacts` via trigger (that's why `contacts.email_marketing` / `pipeline_stage_slug` exist).
- **`.select()` options (`head`/`count`) are only read on the FIRST `.select()` after `.from()`** — a `.select()` chained after a filter silently ignores them.
- **Check `information_schema` before driving a "dormant" column** — mocked tests + `next build` won't catch a column that doesn't exist in prod (assumed `campaigns.postmark_stream`; it's on `email_sends` → prod 500).

**Glofox**
- **`POST /2.0/bookings` can 200 with a failure body** (`message_code: YOU_HAVE_NO_CREDITS_LEFT` — live 2026-07-27). Booking success = HTTP ok **and** a created-booking id in the body; judge via `interpretBookingResult()` in `src/lib/glofox.js`, never `result.ok` alone.
- **Glofox mints a NEW `invoice_id` per payment *attempt*** (one-off purchases; subscriptions reuse one id) → fail-then-succeed leaves orphans. Same-amount+same-day ≠ dupe.
- **`glofox_invoices` is stale** — never compute "amount owed" from it (only live via `INVOICE_UPDATED` webhooks; PENDING_INTENT frozen).
- **Only Stillorgan is Glofox-connected.** Hatch Street's `branch_id` is a placeholder — nothing to "turn off" there. Integration is fully per-location.

**Web/mobile boundary**
- **Mobile CANNOT import `src/lib`** → `shared/` is the seam, consumed as the `shared` file: package (`import { X } from 'shared/permissions'` — never relative `../shared`, which Metro 0.84+/SDK 57 won't resolve out of the project root), and not everything is re-exported. A mobile import of a non-exported name resolves to `undefined` and only crashes at runtime — `npm run check:mobile-imports` guards it (and `mobile/**` triggers Web CI).
- **Never embed `profiles` from a mobile-direct Supabase select** — the `authenticated` role has no grant on `public.profiles`, so the *whole* select 500s. Route through `/api/*` (service role) for another user's name. `contacts` embeds are fine.
- **Mobile `/api/*` wrappers must build headers via `authHeaders()`/`api()`** — a hand-rolled `Bearer` drops `x-impersonate-target` and breaks "View as user" (reads as a scoping leak).
- **Web parity:** a new `WEB_PERMISSIONS` key must get a mobile counterpart, a `WEB_ONLY_OK` entry (with reason), or `CROSS_PLATFORM_KEYS` — `check:mobile-parity` gates it.

**Timezones, routing, forms**
- **`bookings.booking_date`/`start_time` are Dublin wall-clock, not UTC** — never `new Date(\`${d}T${t}Z\`)` (adds the BST offset). More broadly: never mix local-time `Date` parsing with `toISOString()` formatting; test date code under `TZ=Europe/Dublin` *and* a US TZ. Both that `new Date(\`…Z\`)` form and the UTC-`today` form (`new Date().toISOString().slice/split` — use `dublinTodayStr()` from `@/lib/dublin-time` for a business today) are now lint-enforced via `check:guardrails`.
- **Public pages must live OUTSIDE auth-gated `src/app/<segment>/`** (layout auth gates run first) AND be added to BOTH the middleware/`proxy.js` allowlist AND the `AppShell` publicPaths list.
- **Every `<button>` in a `<form>` defaults to `type="submit"`** — set `type="button"` on every non-submit (tab pills, close X, secondary actions).

**Crons & webhooks**
- **Every cron with a `cron_heartbeats` row MUST call `stampHeartbeat(name)`** on success or it goes "stale" while running fine. `grep -L stampHeartbeat src/app/api/cron/*/route.js` should list only `health-check` and `ad-insights-backfill` (manual-only backfill: no vercel.json entry, no heartbeat row — confirmed by the CRON-HB-AUDIT.1 audit, mig 406).
- **Webhook handlers: idempotent, and return 200 for unrecognised events** (providers auto-disable hooks on non-2xx). High-volume webhooks defer (queue table + drain cron), never inline N writes. Long fan-outs run on cron, not the request thread.

**Conventions that bite**
- **No silent env fallbacks** (`getAppUrl()` throws if unset) and **no `x-api-key`** — Bearer or session only. Standard response shape `{ success, data?, error?, issues? }`.
- **Consent has two families:** `_administrative` (transactional/reminders) vs `_marketing` (broadcasts). Reminders check `_administrative`; MARKETING WhatsApp templates are refused on transactional paths (Meta policy).
- **Customer-facing copy/labels must be operator-editable** (settings field + default fallback), not hard-coded.
- **Branding lives on `company_settings`** (`logo_url`/`favicon_url`/`company_name`, one row per `location_id`) — resolve via `getLocationBranding(db, locationId)`. There is **no `company_branding` table** (just the mig 013 *filename*) and `locations` has no branding columns; either wrong source silently renders no logo (bit both contract + invoice emails).
- **Background watchers must NEVER `git checkout`/`pull`** (shared worktree — raced foreground once). Read-only `git log`/`gh` only.
- **Mia stays on the Anthropic Messages API** (not the Agent SDK); **no OpenAI** anywhere (Richard's call — incl. voice transcription).

---

## Build, test & ship

```bash
npm run dev          # dev server, localhost:3000
npm run build        # production build — THE only check that catches import-resolution + Turbopack failures
npm test             # vitest run (~2950 pure-lib tests, no DB)
npm run lint         # eslint .
```

**CI mirror — run all six before pushing:**
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
```

- **`next build` is NOT in the local CI mirror** (it's slow), but since SAAS4-W0.3 GitHub Actions runs it as a parallel "Next build" job on every PR. Green vitest + eslint alone still does **not** mean the build passes — tests run on mocked imports, so a missing/renamed export or unresolvable import sails through them. For any change adding an import or a new route/page, run `npm run build` locally before pushing rather than discovering it in CI; the Actions build job and the Vercel check on the PR are the enforcing gates.
- **`npx next lint` no longer exists** (removed in Next 16 — the CLI parses `lint` as a directory arg and errors). `npm run lint` (`eslint .`, flat config spreading `eslint-config-next`) is the ONLY lint entry point. Caveat: `@next/next/no-html-link-for-pages` resolves as `error` in the config but is **inert in this app-router-only repo** — it only checks `<a>` hrefs against a `pages/` directory, which doesn't exist (probe-verified 2026-07-04: a raw `<a href="/dashboard">` in an app route lints clean). Keep using `<Link>` for internal links as a convention; no linter enforces it.
- **`check:route-guards`** fails if an `/api` route ships with no auth guard (the #408 class). Session routes need `getCurrentUser`/`withAuth`; webhooks need `verify*()`; cron needs `CRON_SECRET`; genuinely-public token routes go in the script's `EXEMPT` map.
- **If you touched `mobile/package.json`,** re-sync the lock: `cd mobile && npm install --package-lock-only` (EAS `npm ci` refuses a mismatched lock). The lock carries the seam: `"shared": "file:../shared"` reifies as a `link: true` symlink entry — don't hand-edit it away.

**Ship loop** (local, with `gh`). Every change branches — Vercel auto-deploys `main`, so direct commits ship to prod with no review window.
```bash
git fetch origin main && git checkout -b descriptive-kebab-branch origin/main   # always branch off fresh origin/main
# …changes + CI mirror…
git commit -am "TICKET.X — summary"   # subject, blank line, body citing migs/files/tradeoffs
git push -u origin HEAD
gh pr create --base main --fill        # pushing is NOT shipping — open the PR, report its URL
```
Worktrees: `~/code/un1t-crm` is the primary checkout, but no checkout reliably holds `main` — it sits wherever it was last checked out (one of the two-dozen `~/code/un1t-crm-*` feature worktrees, usually stale there). Never build on a local `main`: a stale one caused a real incident — always `git fetch` then branch off `origin/main` from the worktree you're in. Follow-up after a PR merges = a **new** branch off main (pushing to a merged branch strands the commit).

---

## Architecture (overview)

React 19 + Next.js 16 (App Router) · Tailwind 3.4 · Supabase (Postgres + Auth SSR cookies + Storage) · Postmark (email) · WhatsApp Cloud API (Meta v21) · Twilio (SMS) · Revolut Merchant (deposits) · Zod · Vitest.

**Companion deployments sharing the same Supabase project** (`iyvtbjjxdggiadzwwvdj`):
- **un1t-crm** (this repo) — staff/admin/operator surface.
- **champ-app** (`~/code/champ-app`) — customer-facing portal (`app.champfitness.ie`); members see their own HR sessions/reports. No staff features.
- **champ-bridge** (`~/code/champ-bridge`) — Node service on a Pi per gym; reads ANT+/BLE straps → POSTs to `/api/bridge/*`.
- **un1t-platform** — older multi-tenant admin/sentinel dashboard. **un1t-sentinel** — separate monitoring repo (deterministic watchers + email alerts).

**Key patterns** (one-liners — full detail in [`docs/architecture/REFERENCE.md`](docs/architecture/REFERENCE.md)):
- **Multi-tenant** by `location_id`, with `organizations` (mig 079) above locations (UN1T Group + CCF Autos). Roles are per-location on `profile_locations` (mig 051); `getCurrentUser()` returns `rolesByLocation`/`activeLocation`/`activeOrganization`.
- **Two Supabase clients** (`src/lib/supabase.js`): browser (anon + cookies, RLS-bound) vs server (service role, RLS-bypass).
- **Auth** (`src/proxy.js`, formerly middleware): public-path allowlist; Bearer `CRM_API_KEY` (n8n) / Supabase JWT (mobile) / session cookies (web). `getCurrentUser()` + `assertLocationAccess()` in `src/lib/auth.js`.
- **4 roles** (`owner`/`manager`/`head_coach`/`staff`) via `MANAGER_ROLES`/`ADMIN_ROLES` from `src/lib/schemas.js`; per-location permissions JSONB on `profile_locations` (mig 058) via `hasPermission()`.
- **Input validation** via `validateBody(request, schema)` against Zod schemas in `src/lib/schemas.js`.
- **Audience whitelist** — all sends go through `applyAudienceFilter()` (`AUDIENCE_FIELDS` registry); the canonical funnel field is `contacts.pipeline_stage_slug` (denormalised, trigger-maintained — operators never write it).

**Key tables:** `locations`, `organizations`, `profiles`, `profile_locations`, `contacts`, `deals`/`pipeline_stages`, `bookings`/`event_types`, `campaigns`/`email_sequences`/`contact_preferences`, `whatsapp_conversations`/`_messages`/`_templates`, the roster v2 chain (`shift_templates`→`shift_blocks`→`shift_assignments`), `cars`, `cron_heartbeats`. 310 migrations (numbered to 313) in `supabase/migrations/`. **RLS model + full table map: [`docs/architecture/REFERENCE.md`](docs/architecture/REFERENCE.md).**

---

## Coding conventions

Full set in [`docs/architecture/REFERENCE.md`](docs/architecture/REFERENCE.md); the high-frequency ones:

- **UI primitives** live in `src/components/ui/` (`Button`/`Modal`/`Card`/`Field`/`Table` from `@/components/ui`); compose them, don't re-roll. Colours use intent-named `un1t-*` tokens (the palette is a **light theme with inverted token names** — `un1t-black` is white). **Status chips: `bg-<c>-500/10 text-<c>-700`** — text on light cards needs the -700 ramp, never -300/-400, and never the dark-theme recipe (`bg-*-900` + low ramp; the unreadable green-on-green credits pill, operator-reported 2026-07-03). Lint-enforced via `check:guardrails` (`no-low-contrast-chip`); genuinely dark surfaces (TV/present) are path-excluded in `eslint.guardrails.config.mjs`.
- **Mutation route skeleton:** `getCurrentUser()` → role check (403) → `validateBody` → `assertLocationAccess` → `createServerClient()` → work → `{ success, data }`. Register new routes in `src/lib/openapi.js`.
- **Reuse shared Zod blocks** from `@/lib/schemas` (`uuidLike` — Postgres-permissive, NOT `z.string().uuid()`).
- **No new `console.log` in prod paths** (gate on `NODE_ENV` or use `console.error`).
- **Fire-and-forget side effects** (confirmation email/SMS/push after a write) run in their own `try/catch` and never block/fail the primary response; the helper swallows its own errors. Multi-channel sends run channels independently (email-down ≠ SMS-down); partial send counts as `sent`.
- **Deprecated columns stay on disk** — new migration adds + backfills, `COMMENT ... 'DEPRECATED (mig N)'`, code stops reading/writing, a *later* migration drops. Lets code roll back without DB action.
- **zsh + bracketed paths:** `[id]`/`[slug]` are globs — single-quote or `noglob` git commands or staging silently empties. Stale `.git/*.lock` from an IDE: `find .git -name '*.lock' -delete`, then quit the IDE.

---

## Extending

- **New module:** migration → `/api` routes → `src/lib/` service → pages → components → Sidebar nav → assistant prompt → register in `src/lib/openapi.js` → tests → **`WEB_PERMISSIONS` + `DEFAULT_WEB_PERMISSIONS_BY_ROLE`** → **decide the mobile counterpart** (parity linter forces the choice).
- **New API route:** `getCurrentUser()`/`requireApiKey()` → `assertLocationAccess()` → `validateBody()` → `{ success, … }` → register in openapi.js.
- **New cron:** route under `src/app/api/cron/` (Bearer `CRON_SECRET`) + `vercel.json` entry + a `cron_heartbeats` row in the same migration + `stampHeartbeat()` on success.
- **New approval surface:** add `src/lib/approvals/providers/<key>.js` + register in `registry.js` — badge/count/tab pick it up automatically (no new perm/route). Template: `providers/contractor-invoices.js`.
- **New role / audience field:** update `roleSchema`/`ADMIN_ROLES`/`MANAGER_ROLES` in `schemas.js`; audience fields go in BOTH `AUDIENCE_FIELDS` (server whitelist) and `FIELD_OPTIONS` (`AudienceBuilder.jsx`).

---

## Deep reference (read on demand)

| Doc | When to open |
|---|---|
| [`docs/architecture/REFERENCE.md`](docs/architecture/REFERENCE.md) | Module map, lib-helper catalogue, full DB schema + RLS, email/WhatsApp/audience internals, RBAC matrix, orgs, master admin matrix, performance posture |
| [`docs/architecture/INTEGRATIONS.md`](docs/architecture/INTEGRATIONS.md) | Env vars, Xero, Twilio, Revolut, Pay subdomain, Cars deposit |
| [`docs/architecture/MOBILE.md`](docs/architecture/MOBILE.md) | The Expo/RN app in `mobile/` — setup, routing, feature flags, push, EAS deployment |
| [`docs/LESSONS.md`](docs/LESSONS.md) | War stories behind the invariants + per-vendor specifics (+ archived Cowork-sandbox notes) |
| [`docs/BACKLOG.md`](docs/BACKLOG.md) | Durable do-not-build decisions + design-doc pointers |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | What shipped (numbered Done log) — add an entry per task |

Feature deep-dives also in `docs/`: `roster-v2.md`, `events.md`, `staff-attendance.md`, `invoices-queue-plan.md`, `whatsapp-setup.md`, `unifi-access-setup.md`/`unifi-protect-setup.md`, `EMAIL_DELIVERABILITY.md`, `PLATFORM_ROADMAP.md`, and the dated design docs (`*_DESIGN.md`, `*_2026-06.md`).

## API reference

OpenAPI 3.1 generated from the Zod schemas (`src/lib/openapi.js`): `/api/openapi.json` (raw) and `/api-docs` (Swagger UI). Register every new route/schema in `openapi.js` so the spec stays in sync.
