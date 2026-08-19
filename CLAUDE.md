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
- **A restrictive `FOR ALL` policy denies SELECT too.** RLS is (OR of permissive) AND (AND of restrictive), and `FOR ALL` includes SELECT — so the natural-looking `<x>_deny_writes ... AS RESTRICTIVE FOR ALL TO authenticated, anon USING (false)` does not deny *writes*, it denies **everything**, folding the table's own permissive SELECT away (`EXPLAIN` → `One-Time Filter: false`). It fails silently: reads return an **empty set, not an error**, and Supabase realtime — which authorises each `postgres_changes` row through the subscriber's SELECT policy — just never fires. Reached 16 tables and killed the Email/IG/Unified inbox listeners under a 60s poll. Write denial goes per-command (`FOR INSERT` + `FOR UPDATE` + `FOR DELETE`), keeping a `FOR ALL TO anon` backstop if anon must stay shut out. Migs 483, 485; `check:rls-restrictive` now gates it.
- **One permissive policy per (table, command).** Don't pair a `FOR ALL` "manage" policy with a separate read policy — the `FOR ALL` overlaps the read on SELECT and trips `multiple_permissive_policies` (counted ×5 grant roles). Instead write the manage side as **explicit `INSERT`/`UPDATE`/`DELETE`** policies and keep a **single `SELECT`** policy whose `USING` is the OR of every population that may read. RLS ORs permissive policies, so `FOR ALL` ≡ the four per-command policies and merging reads is behaviour-preserving. Scope policies `TO authenticated` unless anon genuinely needs them. Reference cleanup: mig 320 (and 167).

**supabase-js / PostgREST traps** (these fail *silently*)
- **Builders are thenables, not Promises** — they have `.then` but no `.catch`. `await db.rpc(...).catch(()=>{})` throws and the rpc never runs. Use `try { await … } catch {}`.
- **`.update()/.insert()` must be `await`ed** or the request never fires (silent no-op).
- **`auth.signOut()` deletes the PKCE code verifier** (`_removeSession()` drops `${storageKey}`, `-user` AND `-code-verifier`, for every scope but `'others'`, even with no session). Never sign out on the path to `exchangeCodeForSession()` — establish the session first, sign out only on failure. Recovery/invite links go through `src/lib/recovery-link.js`; also parse `error_code` off the callback URL (an expired link is not a malformed one).
- **1,000-row select cap.** Every `.select()` returns ≤1000 rows regardless of `.limit()`. Any fan-out (sends, imports, backfills) must `.range()`-paginate with an explicit `.order()`. Copy `src/lib/pipeline-reclassify.js`.
- **Bare `contacts(...)` embeds 300 (`PGRST201`) once a table has ≥2 FKs to contacts** — disambiguate `contacts!contact_id(...)`. ≥2-FK tables today: `whatsapp_conversations`, `instagram_conversations`, `team_members`.
- **Embedded-resource filters break under count-only (`head:true`) selects** → return 0, no error. Don't fight it: denormalise the filtered column onto `contacts` via trigger (that's why `contacts.email_marketing` / `pipeline_stage_slug` exist).
- **`.select()` options (`head`/`count`) are only read on the FIRST `.select()` after `.from()`** — a `.select()` chained after a filter silently ignores them.
- **`.ilike(col, value)` is a PATTERN match, not a case-insensitive `=`.** `_` and `%` are LIKE wildcards *and* legal email characters that `normalizeEmail` accepts, so `a_b@x.com` also matches `axb@x.com` and `%@x.com` matches the whole domain — on the inbound-email webhook the sender is attacker-controlled, so this let a stranger's mail be filed against a real contact, silently. For an **equality** check wrap the value in `escapeLikePattern()` (`src/lib/like-escape.js`); **not** `.eq()`, since contacts are stored mixed-case. `.maybeSingle()`/`.limit(2)` are not guards — they catch the >1-row case, but a `_` matching exactly one *wrong* row returns it happily. Deliberate substring searches spell their wildcards in the source (`` `%${term}%` ``); `check:guardrails` (`no-unescaped-ilike-pattern`) enforces the split. Beware too that supabase **mocks** model `.ilike` as `lower(a)===lower(b)`, which is why this passed CI for months — use `ilikeMatches` from `like-escape.test-helpers.js`.
- **`const { data } = await …single()` is a silent no-op waiting to happen.** `.single()` errors whenever the row count is anything but *exactly one*, so discarding the error collapses **"no rows", "many rows" and "the query failed"** into the same `data = null`. Live twice on 2026-08-11: `PUT` (#1357) and `POST` (DEALSCOPE.2) `/api/deals` both resolved a stage with `.eq('slug', …).single()` — every core slug exists on **five** locations, so the query matched 5 rows, errored, and the caller got a success with the deal unmoved / created stageless. **Lint-enforced via `check:guardrails` (`no-discarded-single-error`)**, which flags a `.single()` destructured without `error` *unless* the chain pins the **primary key** (`.eq('id', …)`, `.match({ id })`, `.filter('id','eq',…)`) or caps rows with `.limit(1)` — there at-most-one is structural and "not found → null" is the normal intent. `.insert()/.update()` + `.single()` with no id filter **is** flagged: a discarded error there is a silent **failed write**. The raw class is 223 sites; the exemption leaves 193, all pinned by a real pk or `.limit(1)`. Fixes: destructure `error`, or use **`.maybeSingle()`** when 0 rows is a legitimate answer (say it in the source). **The exemption used to accept any `<x>_id`**, and K8 audited that edge against prod's unique indexes: of 209 suppressed sites only 16 rested on it, **half of them pinned by nothing** (`email_sends.postmark_message_id`, `whatsapp_messages.wa_message_id`, `whatsapp_templates.meta_template_id` — de-facto unique, no index) and the other half by **composite** uniques the rule never knew about (`teams(location_id,name)`, `staff_allowances(profile_id,year)`). All 16 are now `.maybeSingle()` and the heuristic is narrowed to `id`. **Blind spot:** one expression only — a chain built across statements/variables, or consumed by `.then(({data}) => …)`, is invisible, and uniqueness lives in the schema an AST rule cannot read, so a composite unique or a unique non-`id` column (`race_events.slug`, mig 451) is an **accepted false positive** — answer it with `.maybeSingle()` plus a comment, never a disable.
- **Check `information_schema` before driving a "dormant" column** — mocked tests + `next build` won't catch a column that doesn't exist in prod (assumed `campaigns.postmark_stream`; it's on `email_sends` → prod 500).

**Glofox**
- **`POST /2.0/bookings` can 200 with a failure body** (`message_code: YOU_HAVE_NO_CREDITS_LEFT` — live 2026-07-27) **and its success body carries no harvestable booking id** (0/9 historical funnel bookings captured one; an id-required rule mislabelled a real booking, live 2026-07-28). Success = HTTP ok AND (no message code OR an id); judge via `interpretBookingResult()` in `src/lib/glofox.js`, never `result.ok` alone and never id-required.
- **Glofox mints a NEW `invoice_id` per payment *attempt*** (one-off purchases; subscriptions reuse one id) → fail-then-succeed leaves orphans. Same-amount+same-day ≠ dupe.
- **`glofox_invoices` is stale** — never compute "amount owed" from it (only live via `INVOICE_UPDATED` webhooks; PENDING_INTENT frozen).
- **Only Stillorgan is Glofox-connected.** Hatch Street's `branch_id` is a placeholder — nothing to "turn off" there. Integration is fully per-location.

**Web/mobile boundary**
- **Mobile CANNOT import `src/lib`** → `shared/` is the seam, consumed as the `shared` file: package (`import { X } from 'shared/permissions'` — never relative `../shared`, which Metro 0.84+/SDK 57 won't resolve out of the project root), and not everything is re-exported. A mobile import of a non-exported name resolves to `undefined` and only crashes at runtime — `npm run check:mobile-imports` guards it (and `mobile/**` triggers Web CI).
- **The emailed login code is `EMAIL_OTP_LENGTH` (8) digits, not supabase's default 6** — Auth → Email → "Email OTP Length" is a dashboard setting on `iyvtbjjxdggiadzwwvdj`, so never hard-code a digit count in a code input, a placeholder or user-facing copy: read `mobile/lib/otp.js`. A short `maxLength` truncates silently and surfaces as "that code didn't work", which reads as a wrong code and points the user at the email. It killed mobile passwordless sign-in from MAGIC-LINK.2 until 2026-08-12, and bit champ-app (same project) a month earlier.
- **Never embed `profiles` from a mobile-direct Supabase select** — the `authenticated` role has no grant on `public.profiles`, so the *whole* select 500s. Route through `/api/*` (service role) for another user's name. `contacts` embeds are fine.
- **Mobile `/api/*` wrappers must build headers via `authHeaders()`/`api()`** — a hand-rolled `Bearer` drops `x-impersonate-target` and breaks "View as user" (reads as a scoping leak).
- **Web parity:** a new `WEB_PERMISSIONS` key must get a mobile counterpart, a `WEB_ONLY_OK` entry (with reason), or `CROSS_PLATFORM_KEYS` — `check:mobile-parity` gates it.
- **A push to `main` touching a bundle path PUBLISHES AN OTA to production phones** (`eas-update.yml`, at 10%, with a 48h ramp-or-rollback obligation — `mobile/docs/ota-rollout.md`). The trigger is an **allowlist**, so adding a new directory under `mobile/` means deciding whether it ships: register it in the trigger *or* in `NON_BUNDLE` (`scripts/check-ota-trigger-paths.mjs`). `check:ota-paths` forces the choice (as a **gate** inline in the publish job; on PRs it is only a signal — `main` has no branch protection). Never "fix" an over-triggering path by adding a `!` negation — that is the denylist this replaced. **`mobile/app.config.js` is a publish path**, so `npm run version:patch` — step 1 of both store-submission flows — makes a commit that publishes on the CURRENT runtime lane (`version` and `runtimeVersion` are separate literals); the script no longer pushes by default. Icon/splash art and test-only changes under `mobile/lib/`+`shared/` also publish no-op groups — accepted over-triggers, pinned in `tests/ota-trigger-paths.test.js`.

**Timezones, routing, forms**
- **`bookings.booking_date`/`start_time` are Dublin wall-clock, not UTC** — never `new Date(\`${d}T${t}Z\`)` (adds the BST offset). More broadly: never mix local-time `Date` parsing with `toISOString()` formatting; test date code under `TZ=Europe/Dublin` *and* a US TZ. Both that `new Date(\`…Z\`)` form and the UTC-`today` form (`new Date().toISOString().slice/split` — use `dublinTodayStr()` from `@/lib/dublin-time` for a business today) are now lint-enforced via `check:guardrails`.
- **Public pages must live OUTSIDE auth-gated `src/app/<segment>/`** (layout auth gates run first) AND be added to **FOUR** allowlists — miss one and the page half-works in a way nobody notices: (1) `src/proxy.js` `publicPaths` (else an anonymous request 307s to `/login`), (2) `AppShell`'s `PUBLIC_PATHS` (else the server renders the page and the client shell then blanks it and redirects — the page "flashes then vanishes"), (3) the `un1t-marketing` `allowedPaths` in `src/lib/brands.js` (else `un1tdublin.com` fallback-rewrites it to `/welcome`), and (4) `DB_BRAND_DEFAULTS.allowedPaths` in `src/lib/tenant-domains-edge.js` (the SAAS-8 tenant-domain tier — same rewrite, for any `tenant_domains` host). This invariant said "BOTH" and named only the first two until PUBPATH.1, which is part of why the class keeps recurring (`/unsubscribe`, `/privacy`, `/preferences`, `/account-deletion`, `/embed`). **Allowlist the whole FLOW, not just the entry page**: a signup page whose paid leg posts on to a checkout needs the checkout listed too (`/event/` without `/event-pay/` takes the registration and then rewrites the payer to `/welcome`). Matcher shapes differ — proxy + brands are raw `startsWith` (so directory entries carry a trailing slash), `AppShell` is segment-aware (`=== p || startsWith(p + '/')`, no trailing slash). Regression guard: `src/public-compliance-paths.test.jsx`.
- **Every `<button>` in a `<form>` defaults to `type="submit"`** — set `type="button"` on every non-submit (tab pills, close X, secondary actions). **Lint-enforced since BTNTYPE.2** via `check:guardrails` (`no-untyped-button-in-form`), which flags an untyped `<button>` only when a `<form>` is genuinely its JSX ancestor. It deliberately stays silent on a `{...spread}` (the type may arrive through it), a dynamic `type={expr}`, and uppercase `<Button>` — precision beats coverage in a rule that runs at ERROR across the repo. **Blind spot:** an AST rule sees one JSX tree, so a button reached across a component boundary (`<form>` renders `<Foo/>`, `<Foo/>` renders the button) is invisible — the rule is a floor, not proof. Baseline was clean when it landed: all 143 in-form buttons already carried a type, and the ~267 untyped ones live outside any form, where the default is inert.

**Crons & webhooks**
- **Every cron with a `cron_heartbeats` row MUST call `stampHeartbeat(name)`** on success or it goes "stale" while running fine. `grep -L stampHeartbeat src/app/api/cron/*/route.js` should list only `health-check` and `ad-insights-backfill` (manual-only backfill: no vercel.json entry, no heartbeat row — confirmed by the CRON-HB-AUDIT.1 audit, mig 406).
- **Webhook handlers: idempotent, and return 200 for unrecognised events** (providers auto-disable hooks on non-2xx). High-volume webhooks defer (queue table + drain cron), never inline N writes. Long fan-outs run on cron, not the request thread.

**Conventions that bite**
- **No silent env fallbacks** (`getAppUrl()` throws if unset) and **no `x-api-key`** — Bearer or session only. Standard response shape `{ success, data?, error?, issues? }`.
- **Consent has two families:** `_administrative` (transactional/reminders) vs `_marketing` (broadcasts). Reminders check `_administrative`; MARKETING WhatsApp templates are refused on transactional paths (Meta policy).
- **An UNREGISTERED `sendPush` category fails CLOSED, not open.** `resolvePermission`'s last tier is `defaults[role][key] === true`, so `notify_<madeUpCategory>` resolves **false** for every role but `master` (which bypasses the tiers) — the push reaches the person who tested it and silently nobody else. Either register the key in `MOBILE_PERMISSIONS` + `DEFAULT_MOBILE_PERMISSIONS_BY_ROLE`, or send **categoryless** (master switch + device permission still gate) and route Android via `data.type`. Categoryless is right for operational notices that aren't a preference. Bit `app_update` (STAFF-DEV.8) and `test` (PUSH-TEST.1) within a day of each other.
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

**CI mirror — run all eleven before pushing:**
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths
```

- **`next build` is NOT in the local CI mirror** (it's slow), but since SAAS4-W0.3 GitHub Actions runs it as a parallel "Next build" job on every PR. Green vitest + eslint alone still does **not** mean the build passes — tests run on mocked imports, so a missing/renamed export or unresolvable import sails through them. For any change adding an import or a new route/page, run `npm run build` locally before pushing rather than discovering it in CI; the Actions build job and the Vercel check on the PR are the enforcing gates.
- **`npx next lint` no longer exists** (removed in Next 16 — the CLI parses `lint` as a directory arg and errors). `npm run lint` (`eslint .`, flat config spreading `eslint-config-next`) is the ONLY lint entry point **for `src/`** — it ignores `mobile/**`, which has its own entry point (next bullet). Caveat: `@next/next/no-html-link-for-pages` resolves as `error` in the config but is **inert in this app-router-only repo** — it only checks `<a>` hrefs against a `pages/` directory, which doesn't exist (probe-verified 2026-07-04: a raw `<a href="/dashboard">` in an app route lints clean). Keep using `<Link>` for internal links as a convention; no linter enforces it.
- **`check:mobile-lint` is the linter for `mobile/**`** (`eslint.mobile.config.mjs`, `--max-warnings 0`). `npm run lint` does **not** cover mobile and never did: the root config ignores `mobile/**`, deferring to `expo lint`, which cannot run here (no eslint dep in `mobile/package.json` → "Cannot find module 'eslint'"). So mobile-only changes used to pass a green `npm run lint` that had inspected **zero** of their files — three shipped that way before MOBILE-LINT.1, and the first real run found a live crash (`expenses/[id].jsx` still calling `setOcrState`/`setOcrConfidence`/`setOcrError` after INVOICES-QUEUE.1 PR 3 deleted them). Rules are ERROR-level, not warn, because `eslint` exits 0 on warnings — that is the whole failure mode this replaced. `no-unused-vars` honours the same `^_` escape hatch as the root; `no-empty` allows the repo's documented `catch {}` swallow but nothing else. Don't add mobile paths to the root config's ignore-adjacent lists expecting coverage — `lint`, `check:mobile-imports` (does an imported name exist) and `check:mobile-lint` (defects inside a file) are deliberately disjoint.
- **`check:rls-restrictive`** fails if a restrictive `USING (false)` policy covering SELECT coexists with a permissive SELECT policy for `authenticated` (the mig 485 class). It computes the *net* policy state by replaying every migration, so it sees drops/recreates. Anon-only restrictives and conditional ones (storage private buckets) are correctly ignored.
- **`check:location-scoping`** fails on a tenant-table query with no location/org filter in the handler — the IDOR class, since service-role routes bypass RLS. Since PAGE-SCOPE.1 it scans app-dir **server pages** (`src/app/**/page.js` that call `createServerClient()`) as well as `/api` routes — the TPL-IDOR.1 template-editor leak shipped precisely because pages were invisible to the /api-only scan; pages without the service-role client are skipped (they query through guarded routes or the RLS-bound browser client). The tenant-table set is derived from `supabase/migrations` at runtime. When the scoping legitimately lives in a shared helper, register that helper in `SCOPING_HELPERS` **after verifying it really applies the filter** — do not reach for `EXEMPT`, which is for genuine residue and demands a reason. This one was missing from the mirror above until 2026-08-06 and cost a CI round trip; it is CI-enforced either way.
- **`check:ota-paths`** guards `.github/workflows/eas-update.yml`'s publish trigger. That trigger is an **allowlist** of paths that genuinely enter the Metro bundle — *not* `mobile/**` with negations, which failed twice in eight days (#1451 docs-only and #1434 `mobile/.audit-allowlist.json`-only each published a no-op update group at 10% on top of a live ramp). The check fails when a new top-level entry under `mobile/` is neither in the trigger nor in the script's `NON_BUNDLE` map, so an allowlist miss surfaces on the PR that creates the directory instead of as a silently-missing OTA. It also rejects any `!` negation in the trigger (denylist creep), a dead pattern after a rename, and the narrowing of `shared/**`. `tests/ota-trigger-paths.test.js` is the fires/does-not-fire table, calibrated against two real observed runs. **On PRs it is a signal, not a gate** — same caveat as the dependency audit below: `main` has no branch protection at all, so a red Web CI blocks no merge and a direct-to-main push skips PR checks entirely. It *is* a real gate in one place: the same command runs inline in `eas-update.yml`'s own CI-mirror step, where an unclassified path aborts the publish. **Three known limits, all deliberate**: classification is per top-level entry, so per-file over-triggers inside a listed directory are invisible (icon/splash art under `mobile/assets/**`, and every `*.test.js` under `mobile/lib/**` and `shared/**`, publish no-op groups — pinned in the test table); `NON_BUNDLE` is an assertion frozen when written and nothing rechecks reachability, so a file added under e.g. `mobile/scripts/` and then imported by the app would be stranded silently; and the tree-walk covers `mobile/` only, so a new `shared/docs/` publishes and the check still reports clean.
- **`check:route-guards`** fails if an `/api` route ships with no auth guard (the #408 class). Session routes need `getCurrentUser`/`withAuth`; webhooks need `verify*()`; cron needs `CRON_SECRET`; genuinely-public token routes go in the script's `EXEMPT` map.
- **`check:dependency-audit` covers the WEB tree; `check:dependency-audit:mobile` covers `mobile/`.** Two trees, two allowlists (`/.audit-allowlist.json`, `mobile/.audit-allowlist.json`) — never paste a GHSA id between them without re-arguing the reason for that tree. The mobile gate audits the **whole** tree, not just runtime deps: `--omit=dev` is **inert** under `--package-lock-only` (verified 2026-08-07 — byte-identical reports with and without it), which is also why the mobile audit needs **no `npm ci`** and CI never installs the Expo/RN tree to run it. Mobile went unaudited until DEPAUDIT.2 even though the workflow had listed `mobile/package*.json` in its `paths:` trigger from day one — the first real run found 4 HIGH + 1 CRITICAL. **`npm`'s `fixAvailable:false` means "no fix reachable within the CURRENT constraints", not "no patched version published"** — read it as a prompt to check `npm view <pkg> versions`, not as a dead end. Two `linkify-it` HIGH advisories (range `<=5.0.1`) looked unfixable for exactly that reason: `react-native-markdown-display@7.0.2` → `markdown-it@10.0.0` pins `linkify-it ^2.0.0`. An `overrides: { "linkify-it": "^5.0.2" }` in `mobile/package.json` changes the constraint and clears both — **5.0.2 keeps `module.exports = LinkifyIt`**, which is what markdown-it@10's `new require('linkify-it')()` needs; **6.x would white-screen the contracts page** (it switched to named exports). Both allowlists are now empty, which is the healthy state.
- **`check:dependency-audit`** is deliberately **NOT** in the mirror above — it hits the npm registry, and the mirror is meant to run offline and fast. It's the Dependency audit workflow's gate (schedule + dep-touching PRs). Run it by hand when you change dependencies. A HIGH/CRITICAL runtime advisory fails unless it's recorded in `.audit-allowlist.json` with a reason **and an expiry** — an expired entry fails exactly like an unlisted one, so accepting is always a dated decision, never a permanent mute. Fix order: upgrade → remove the dep → accept. **The job is not a required check** (`main` has no branch protection at all), so a red audit blocks nothing; the scheduled run now opens a tracking issue on failure, which is the only signal, since a red scheduled run on `main` has no PR to show an X on.
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

**RLS model + full table map: [`docs/architecture/REFERENCE.md`](docs/architecture/REFERENCE.md).** Migrations live in `supabase/migrations/`.

---

## Coding conventions

Full set in [`docs/architecture/REFERENCE.md`](docs/architecture/REFERENCE.md); the high-frequency ones:

- **UI primitives** live in `src/components/ui/` (`Button`/`Modal`/`Card`/`Field`/`Table` from `@/components/ui`); compose them, don't re-roll. Colours use intent-named `un1t-*` tokens (the palette is a **light theme with inverted token names** — `un1t-black` is white). **Status chips: `bg-<c>-500/10 text-<c>-700`** — text on light cards needs the -700 ramp, never -300/-400, and never the dark-theme recipe (`bg-*-900` + low ramp; the unreadable green-on-green credits pill, operator-reported 2026-07-03). Lint-enforced via `check:guardrails` (`no-low-contrast-chip`); genuinely dark surfaces (TV/present) are path-excluded in `eslint.guardrails.config.mjs`. **The chip rule only inspects the bg+text PAIRING**, so plain accent text with no chip background was invisible to it — 52 shipped that way across the six Communications editors. `no-low-contrast-accent-text` covers that half: any `text-<palette>-300/400/500` with no `bg-black` on the same element. It is **armed per-path**, not repo-wide (it cannot see the rendered surface, and ~500 low-ramp sites elsewhere include correct dark-surface idiom) — the armed list in `eslint.guardrails.config.mjs` is currently the Communications area; **clean an area, then add its path, one line**. A genuine dark island inside a light page keeps its low ramp by putting `bg-black` on the *same* element, not by a disable comment.
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

Feature deep-dives also in `docs/`: `roster-v2.md`, `events.md`, `staff-attendance.md`, `invoices-queue-plan.md`, `whatsapp-setup.md`, `unifi-access-setup.md`, `EMAIL_DELIVERABILITY.md`, `PLATFORM_ROADMAP.md`, and the dated design docs (`*_DESIGN.md`, `*_2026-06.md`).

## API reference

OpenAPI 3.1 generated from the Zod schemas (`src/lib/openapi.js`): `/api/openapi.json` (raw) and `/api-docs` (Swagger UI). Register every new route/schema in `openapi.js` so the spec stays in sync.

## champ-app shared sync rule (Repset merge P1, 2026-08-17)

Phase 1 of the Repset one-app merge landed champ-app's `shared/` modules here as
**copies, not moves** — champ-app's live backend still consumes its own `shared/`
and stays authoritative for its copies until backend consolidation.

**Modules that exist in BOTH repos and are consumed by the champ-app server**
(empirically derived from `champ-app/src` imports of `../shared` / `@/shared`):
`achievement-progress`, `brand`, `challenges`, `cohort-board`,
`customer-notifications`, `customer-push-channels`, `dublin-time`, `format`,
`goals`, `heart-rate`, `hr-analytics`, `hr-session-report`,
`progress-analytics`, `sessions-list`, `share-card`, `social`, `tier-window`,
`tiers`, `wearable-trends-view`, `workout-detail`.

- **Mirror rule:** any edit to one of these modules in either repo MUST be
  mirrored in the other repo **in the same working session**. No drift.
- **Divergence window:** until the P2 app-tree port merges, ANY change to
  champ-app `shared/` (not just the list above) must be mirrored into
  `un1t-crm/shared/`.
- **Pre-existing cross-repo pairs** (now three-way, since the shared copies
  live here too): `src/lib/tiers.js` ↔ `shared/tiers.js`,
  `src/lib/tv-zone-colors.js` ↔ `shared/zone-colors.js`,
  `src/lib/hr-analytics.js` ↔ `shared/hr-analytics.js`.
- `shared/customer-push-channels.js` was the ONE filename collision at landing
  time (verbatim copies, comment-only diff) — un1t-crm's copy stands.
