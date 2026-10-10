# SaaS Wave 1 — Identity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After this wave a second gym's customers and staff never see "UN1T": every email sends under the tenant's brand with the tenant's Reply-To, every customer-facing link lands on the tenant's own host, every product name reads `{Brand} Points` / `{Brand} HR`, a new location is born with its settings rows, and a gym with no membership source sees "no membership source connected" instead of empty Glofox-shaped data.

**Architecture:** Two helpers land first and everything else consumes them: `src/lib/brand-name.js` (the brand chain `company_settings → org_settings → locations.name`, plus `productName(brand, 'Points'|'HR')`, mirrored into `shared/` for the phone and champ-app) and `src/lib/tenant-host.js` (org → `https://<org.slug>.repset.ie`, custom domain on top, platform host as fallback). The email identity track makes the existing `tenant_email_domains` machinery reachable (plan pin, org-admin tier, webhooks, per-server suppression) and gives every pre-domain send a brand display name + the location's Reply-To on the platform sender. The sweep is six mechanical PRs driven by the appendix table. The membership seam (`locations.membership_source`, a provider interface Glofox implements today) is an independent track `W1.M*`. Every PR is small, independently mergeable, tested first; migrations are forward-only and applied by the orchestrator via the Supabase MCP before merge.

**Tech Stack:** Next.js 16 App Router (JS), Supabase (service-role client; RLS and column GRANTs bind the browser/phone only), Zod, Vitest (4 CI shards), Postmark (Server + Account APIs), Vercel (`*.repset.ie` wildcard), Expo SDK 57 (`mobile/`, OTA via `eas-update.yml`), champ-app (Next.js web, same Supabase).

**Source review:** `docs/SAAS_READINESS_REVIEW_2026-10-09.md` — §1 foundation facts, §2 per-applet verdicts, §3 Blocker 8 + Majors themes B (brand fallbacks), C (links and hosts), E (Glofox dependency), §5 "Wave 1 — identity". Format precedent: `docs/superpowers/plans/2026-10-09-saas-wave0-stop-the-leaks.md`.

---

## Decisions already made by Richard (binding; do not re-open, do not add cards for these)

1. **Tenant sending domain is a PAID PLAN feature**: it comes with the plan that opens email marketing. Keep the plan feature gate (`custom_email_domain` or whatever the plan feature is named; verify in `src/lib/tenant-email.js` and the plans code) but make it REACHABLE: plans pinnable per location from `/admin/plans` (verify what exists), the gate on the org_admin tier must be satisfiable (`profile_organizations`; check whether master bypasses), and the env gate removed or documented. Once a plan with the feature is pinned, the org admin manages the domain.
2. **Before a verified domain**, every tenant email sends from the platform address (`hello@repset.ie`, confirm the platform sender/domain that exists in Postmark via `src/lib/postmark*.js` and docs) with the tenant's brand as display name and Reply-To = the location's own email address. Nothing says UN1T.
3. **Brand chain**: company_settings (location) → org_settings → `locations.name`; the literal `'UN1T'` fallback in `src/lib/location-branding.js` (`DEFAULT_COMPANY_NAME`) goes. Product names become `{Brand} Points` and `{Brand} HR` via a shared helper, so UN1T keeps "UN1T Points" and another gym sees its own name.
4. **Links**: every org gets an automatic `<slug>.repset.ie` host (wildcard `*.repset.ie` in Vercel and DNS is Richard's one-time manual step; the plan states it as a prerequisite with the exact Vercel/DNS actions); a custom domain can be added on top later; customer-facing links (unsubscribe, preferences, view-email, booking, events, host pages, ICS, OG metadata) resolve to the org's host with the platform host as fallback. `customerFacingMetadata` resolves by the request's org. Widen the tenant-domain default allowlist (funnel, unsubscribe, preferences, view-email, host paths) — find the four public-path allowlists the review mentions.
5. **Sweep scope = everything**: un1t-crm web, `mobile/` (staff app; OTA rules: `mobile/package-lock.json` is a publish path, a merge is not a publish), `shared/` seam (web+mobile pair-sync test), AND champ-app (`/Users/richardivers/code/champ-app`, customer fitness app, same Supabase, has its own OTA). Inventory every customer- or staff-visible "UN1T" literal across all four with `git grep -n "UN1T"` filtered to UI/copy/prompts (exclude internal identifiers like env names, table names, CSS class prefixes `un1t-`, package ids, the UN1T Group org row). Put the inventory in an appendix table (file, literal, surface, replacement rule) — this is the deliverable that makes the sweep PRs mechanical.
6. **Seeded company_settings**: creating an org/location (the `/admin/tenants/new` path) seeds company_settings (name from the location, logo null), notification_config, quiet hours defaults.
7. **Membership seam, now**: `locations.membership_source` (enum/text check: 'none' | 'glofox'; 'un1t' is the home-grown option arriving in a few weeks and must plug in without a schema change), backfill existing locations with a Glofox connection to 'glofox' and others to 'none'; a settings UI to choose it per location; gate Glofox-only surfaces (classifier, churn radar, membership trend, credits, class automations, Mia booking tools — verify the list in §2 of the review) behind a visible "no membership source connected" state instead of empty data; define the provider interface (`src/lib/membership/source.js` or similar) that Glofox implements today and the home-grown source implements next.

**Out of scope (own waves):** per-location timezone threading (next wave), money/merchant (Wave 2), self-serve wizard beyond seeding (Wave 3).

**Delivery (as Wave 0):** the executor opens, self-reviews, gates on CI and merges each PR, applying migrations via the Supabase MCP (project `iyvtbjjxdggiadzwwvdj`) BEFORE merge. Tasks marked ⚠️ change VISIBLE behaviour for existing UN1T customers or staff: the orchestrator shows Richard a decision card before merging those.

---

## Live facts verified 10 Oct 2026 (the plan rests on these)

Verified against the live database (read-only SQL), Vercel (`list_project_domains`), Postmark (`getServerInfo`/`listWebhooks`) and public DNS. Re-check any row before relying on it in a later session.

| Fact | Value |
|---|---|
| Latest migration prefix | `714_policies_write_rls_org.sql` (712 and 713 each hold two files, by convention). **This wave starts at 715.** |
| Vercel project `un1t-crm` domains | 14, **including `*.repset.ie` (verified: true, added 2026-10-10)**, `crm.repset.ie`, `www.repset.ie`, `repset.ie`→www (308), `crm.un1tdublin.com`, `www.un1tdublin.com`, `host.un1tdublin.com`, `pay.ccfautos.com`, `www.ccfautos.com`, `www.giversautos.com`, `un1t-crm.vercel.app`. The review's "no wildcard" is already out of date. |
| DNS `*.repset.ie` | `CNAME cname.vercel-dns.com` (probe `wildcardprobe-xyz.repset.ie` resolves to Vercel). **Wildcard DNS is done.** |
| DNS `repset.ie` mail posture | `TXT "v=spf1 -all"`, `_dmarc.repset.ie "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s;"`, no Postmark DKIM selector answers (every `*._domainkey.repset.ie` returns Vercel's empty `v=DKIM1; p=`), and `pm-bounces.repset.ie` falls into the wildcard CNAME (Vercel, not `pm.mtasv.net`). **`hello@repset.ie` is NOT a Postmark-verified sender today; with p=reject + `-all` a send from it would be rejected.** Richard's prerequisite P2 below. |
| DNS `un1tdublin.com` | SPF includes mlsend + google (`~all`), DMARC `p=none`, `pm-bounces.un1tdublin.com → pm.mtasv.net` (Postmark Return-Path verified). `mail.un1tdublin.com` is the Postmark inbound domain. |
| Postmark global server | `CRM.UN1T` id `19058588`; open + link tracking on; legacy server-level webhooks AND three Webhooks-API hooks (streams `outbound`, `broadcast`, `colm-events`) all to `https://crm.un1tdublin.com/api/webhooks/postmark` with triggers Open, Click, Delivery, Bounce, SpamComplaint, SubscriptionChange. Inbound → `/api/webhooks/invoices-inbound/<token>`. **This is the event set a tenant server must register (task W1.E3).** |
| `plans` / `plan_versions` (mig 413 seed, live unchanged) | tiers `core` (`custom_email_domain:false`, `ai_agent:false`), `growth` (`custom_email_domain:false`), `scale` (`custom_email_domain:true`); add-on `custom_email_domain` (`custom_email_domain:true`, €15). Every version also carries all eight bundle keys `true`. One version each, `effective_from 2026-07-19`, notes "EXAMPLE pricing". |
| `location_plans` | **1 row: Test Studio → the `custom_email_domain` ADD-ON, no tier.** `getLocationPlan()` (`src/lib/plans.js:123-160`) returns `null` unless a TIER row exists, so this pin is invisible and `orgHasEmailDomainAddon` is false for UN1T Group despite the pin. Task W1.E1 fixes the resolver. |
| `profile_organizations` | 0 rows. No org admin exists anywhere. |
| `tenant_domains` / `tenant_email_domains` | 0 / 0 rows. |
| `organizations` | columns `id, name, slug (NOT NULL), active, created_at, updated_at, master_location_id`. Slugs: `un1t-group`, `ccf-autos`, `givers-consultancy`. **`organizations.slug` exists; the automatic host is `<org.slug>.repset.ie`.** |
| `locations` (6 rows) | UN1T Stillorgan `a0000000-…-0001` (slug `un1t-stillorgan`, email `stillorgan@un1t.com`, `settings.glofox.branch_id` set, `notification_config` set, `company_settings.company_name` = "UN1T stillorgan"); UN1T Hatch Street `28c78d6b-…` (email `hatchstreet@un1t.com`, `settings.glofox` present but `branch_id` NULL, company_settings "UN1T Hatch Street"); Test Studio `9e069256-…`; Pride Training Club (host anchor) `95be0b12-…`; CCF Autos `f45ef67e-…` (`settings.glofox` present, `branch_id` NULL); SourceIt `7010edf9-…`. **Only Stillorgan has a real Glofox branch id** → the backfill in W1.M1 marks exactly one location `'glofox'`. All six are `Europe/Dublin`. `locations.email` is NULL on four of six (Reply-To fallback in W1.E2 must handle NULL). |
| `locations.notification_config` | a **jsonb COLUMN on `locations`** (CHECK `jsonb_typeof = 'object'`), not a table. Set on Stillorgan only. |
| `company_settings` | 2 rows (Stillorgan, Hatch). Columns: `id, location_id (NOT NULL), logo_url, favicon_url, company_name, updated_at, updated_by, send_quiet_hours_enabled (NOT NULL default true), send_quiet_hours_start (default 21), send_quiet_hours_end (default 8), view_in_browser_label, hosted_copy_note, email_signature, email_spam_filter_enabled (default true), email_spam_threshold (default 5.0)`. An INSERT of `(location_id, company_name)` alone is valid; quiet hours default in the schema. |
| `org_settings` | 2 rows: UN1T Group (`company_name` "UN1T Dublin"), CCF Autos (`company_name` NULL). Columns incl. `legal_entity_name, legal_trading_name, legal_address, privacy_contact_email, ops_alert_emails`. |
| `locations` column grants to `authenticated` (mig 648) | SELECT: `active, address, country, created_at, email, features, id, is_host_anchor, name, organization_id, phone, slug, timezone, updated_at`. UPDATE: LocationForm's columns (`name, slug, address, phone, email, timezone, country, active, updated_at, car_deposit_*, invoices_inbound_slug, monthly_contractor_budget_eur`). **A new `membership_source` column needs an explicit grant decision in its migration** (W1.M1 grants SELECT only; writes go through the route). |
| `whatsapp_templates` | 21 rows, all Stillorgan's; 19 APPROVED templates contain "UN1T" in their Meta-approved text (`outstanding_payment_`, `agent_first_class_checkin_v1`, `eot_salesmsg`, `booking_consult_confirmed`, `booking_class_confirmed_`, `agent_followup`, `book_first_visit`, `reopen_message_`, `customer_followup`, `new_account_creation_`, `consultation_booking`, `outstanding_payment_link_`, `august_offer_followup_`, `august_offer_for_24_hours`, `end_of_trial_`, `hatch_book_your_week`, `hatch_3_free_classes`, `meta_ad_whatsapp_lead`, `hatch_first_class_waiting`). Templates are per LOCATION rows: these are UN1T's own and stay UN1T. No Meta text change is needed for Wave 1; a second gym authors its own templates. The code-side `{{location_name}}` fallback is the only WhatsApp literal in scope (W1.S3). |
| champ-app | `mobile/` was DELETED (commit `558053e`, "Phase 5 GRAFT sunset"); the member app ships inside the Repset binary in un1t-crm. champ-app is a Next.js web deploy only — **no champ-app OTA exists any more**. Remote `ivers9307-cyber/champ-app`, default `main`. |

---

## Prerequisites owed by Richard (state before the dependent task merges)

| # | Prerequisite | Needed by | Exact action | Status 10 Oct |
|---|---|---|---|---|
| P1 | Wildcard host `*.repset.ie` in Vercel + DNS | W1.L1 | Vercel → project `un1t-crm` → Domains → add `*.repset.ie` (Vercel asks for a TXT `_vercel` verification on `repset.ie` if the apex is not already on this project). DNS at the `repset.ie` registrar: `* CNAME cname.vercel-dns.com`. | **DONE** — `*.repset.ie` is on the project, verified, and the wildcard CNAME answers. Nothing to do; W1.L1 merely documents it. |
| P2 | Platform sending domain `repset.ie` verified in Postmark | W1.E2 (⚠️ the pre-domain sender) | Postmark → Sender Signatures → Domains → Add `repset.ie`. Then at the registrar: (a) the DKIM TXT Postmark shows (`<selector>._domainkey.repset.ie`), (b) Return-Path `pm-bounces.repset.ie CNAME pm.mtasv.net` — **this explicit record must be added because the wildcard currently swallows `pm-bounces`**, (c) replace `repset.ie TXT "v=spf1 -all"` with `"v=spf1 include:spf.mtasv.net -all"`, (d) keep DMARC `p=reject` but **add `rua=mailto:<ops mailbox>`** and consider `adkim=r` until the first week's reports are clean. Then set Vercel env `POSTMARK_FROM_EMAIL=hello@repset.ie` (production + preview) and add a `hello@repset.ie` sender signature or rely on the domain. Until P2 is done, W1.E2 keeps `POSTMARK_FROM_EMAIL` as is (today's `un1tdublin.com`/`un1t.ie` sender) and only changes the display name + Reply-To; it is written so the address is env-driven. | **OPEN.** SPF `-all`, DMARC strict reject, no Postmark DKIM, `pm-bounces` on the wildcard. |
| P3 | `POSTMARK_ACCOUNT_TOKEN` in Vercel env | W1.E3 (tenant server provisioning) | Postmark → Account → API Tokens → copy the Account token → Vercel env `POSTMARK_ACCOUNT_TOKEN` (production + preview). W1.E1 documents the env as "required for tenant provisioning" rather than removing the gate (decision 1: "removed or documented"). | **Not verifiable from here** (env values are not readable). W1.E1's status endpoint reports `account_configured`. |
| P4 | Edit the example plan prices before any pin (mig 413 notes say "EXAMPLE pricing — edit in /admin/plans before launch") | W1.E1 | `/admin/plans` as master; the task does not change prices. | OPEN, Richard's call; not blocking. |
| P5 | Meta WhatsApp template text | — | **None for Wave 1.** The 19 UN1T-text templates are Stillorgan's own rows. | n/a |
| P6 | Mobile OTA: the `shared/` + `mobile/` sweep PRs (W1.S5, W1.S6) each PUBLISH an OTA on merge (`shared/**` and `mobile/lib/**` are bundle paths). A partial rollout left on the staff lane blocks them. | W1.S5, W1.S6 | Before merging either, confirm `eas update:list` shows no 1–99% group on the staff runtime; `mobile/docs/ota-rollout.md`. | Check at merge time. |

---

## PR ritual (every task ends with this)

Repo conventions: fresh worktree per task (never share one), one changelog file per PR, CI = `Test & lint` + `Next build` required checks, 4 vitest shards (~5 min). Never `git stash` in a worktree. `[id]`/`[slug]` paths need single quotes in zsh. Never run the whole vitest suite locally on the 8 GB machine: targeted `npx vitest run <files>` plus the four `check:*` gates.

```bash
# 1. Fresh worktree from main
cd /Users/richardivers/code/un1t-crm && git fetch origin main -q
git worktree add -q /Users/richardivers/code/un1t-crm-w1-<slug> -b w1-<slug> origin/main
cd /Users/richardivers/code/un1t-crm-w1-<slug> && npm ci --silent
# 2. ... task steps (test first, then code) ...
# 3. Gates that run locally in seconds
npm run check:route-guards && npm run check:location-scoping && npm run check:select-columns && npm run check:guardrails
npx vitest run <changed test files> tests/changelog-entries.test.js
# 4. PR
git push -u origin w1-<slug>
gh pr create --base main --title "W1.<n> <TITLE>" --body-file .pr-body.md   # body ends with "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
# 5. Changelog entry AFTER the PR number exists
printf '| #%s | W1.<n> — <title> | %s. <what and why> |\n' "$PR" "$(date +%F)" > docs/changelog/entries/$PR.md
git add docs/changelog/entries/$PR.md && git commit -m "W1.<n> — changelog entry" && git push
# 6. Migration (if any): orchestrator applies it via Supabase MCP apply_migration on iyvtbjjxdggiadzwwvdj, then get_advisors(security)
# 7. Wait for CI, self-review the diff once more, bring up to date, merge
gh pr update-branch $PR && gh pr checks $PR --watch && gh pr merge $PR --squash --auto --delete-branch
# 8. Remove the worktree
cd /Users/richardivers/code/un1t-crm && git worktree remove /Users/richardivers/code/un1t-crm-w1-<slug>
```

Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. For champ-app tasks the same ritual runs in `/Users/richardivers/code/champ-app` (worktree `champ-app-w1-<slug>`, remote `ivers9307-cyber/champ-app`); champ-app has no changelog-entries convention, so the PR body carries the row.

---

## Task map, order and migrations

Six tracks, 26 tasks (25 headings: W1.L3 is one task split into two PRs, L3a and L3b). Tracks B and L land first (the helpers everything else consumes); Track E and Track W are independent of the sweep; Track M is an independent track that runs in parallel from day one. Within Track S the order is S1a → S1b → S1c → S2 → S3 → S4 → S5 → S6 (S4 before S5/S6 because the phone and champ-app import the shared signatures).

| # | Task | Track | Depends on | Migration | ⚠️ card |
|---|---|---|---|---|---|
| W1.B1 | Brand chain ends in `locations.name`; `org_settings.short_name`; `productName` helper | B | — | **715** `org_settings_short_name` | no (no visible change until S*) |
| W1.B2 | Phone + champ-app brand loaders | B | B1 | — | no |
| W1.L1 | `<slug>.repset.ie` platform rows + `resolveCustomerBaseUrl` | L | — | **716** `tenant_domains_platform_rows` | no |
| W1.L2 | Tenant-domain default allowlist covers the customer flow | L | L1 | — | no |
| W1.L3a | Marketing/sequence/HR links on the tenant host | L | L1, L2 | — | ⚠️ (UN1T links move host) |
| W1.L3b | Event/booking/host/Mia links on the tenant host | L | L1, L2 | — | ⚠️ (same card as L3a) |
| W1.L4 | Metadata, site name, favicon, front page by host | L | L1, B1 | — | ⚠️ |
| W1.L5 | Event ICS carries tenant brand + host | L | L1, B1 | — | no |
| W1.E1 | `custom_email_domain` gate reachable (add-on pins, wizard org_admin, pin link, env documented) | E | — | — | no |
| W1.E2 | Pre-domain sender: `{Brand} <platform>` + location Reply-To | E | B1 | — | ⚠️ |
| W1.E3 | Tenant Postmark server born with streams + webhooks | E | — | **718** `tenant_email_domains_webhooks` | no |
| W1.E4 | Suppressions + consent drift per server | E | — | — | no |
| W1.W1 | Location creation seeds company_settings + notification_config | W | — | — | no |
| W1.S1a | Sweep: customer email/ICS/message libs + `{{company_name}}` | S | B1, E2 | — | ⚠️ |
| W1.S1b | Sweep: public pages, widgets, landing pages, TV boards | S | B1, L4 | — | ⚠️ |
| W1.S1c | Sweep: host portal + host emails | S | B1, L4 | — | no |
| W1.S2 | Sweep: staff chrome + staff emails | S | B1 | — | no |
| W1.S3 | Sweep: Mia, WhatsApp merge, hyrox, assistant | S | B1 | — | no |
| W1.S4 | Sweep: `shared/` seam + `src/lib` twins | S | B1 | — | no (OTA no-op) |
| W1.S5 | Sweep: `mobile/` screens | S | B2, S4 | — | no (OTA) |
| W1.S6 | Sweep: champ-app | S | B2, S4 | — | ⚠️ (pre-sign-in default only) |
| W1.M1 | `locations.membership_source` + provider interface | M | — | **717** `locations_membership_source` | no |
| W1.M2 | Membership-source setting + route | M | M1 | — | no |
| W1.M3a | Web surfaces gate on the source | M | M1 | — | no |
| W1.M3b | Crons + Mia discover through the seam; backfill route bug | M | M1 | — | no |
| W1.M3c | Phone dashboards show the state | M | M1, M3a | — | no (OTA) |

Migrations in prefix order: 715 (B1), 716 (L1), 717 (M1), 718 (E3). Each is forward-only, applied by the orchestrator via `apply_migration` on `iyvtbjjxdggiadzwwvdj` BEFORE its PR merges, followed by `get_advisors(type=security)`. Prefix collisions with a concurrent PR are allowed by convention (`migration-duplicate-prefixes`); pick the next free number at execution time if one lands first.

## File structure (what changes where)

| Task | Files |
|---|---|
| W1.B1 | mig 715; `shared/brand-name.js` (+test); `src/lib/brand-name.js` (re-export); `src/lib/location-branding.js` (+test); `src/lib/default-site-name.js`; `src/lib/contracting-entity.js`; `src/lib/churn-winback.js`; `src/components/OrgBrandingSettings.jsx`; `src/app/api/settings/org-branding/route.js`; `tests/shared-pair-sync.test.js` manifest |
| W1.B2 | `mobile/lib/brand.js` (+test); `src/app/api/public/branding/route.js`; champ-app `src/lib/load-brand.js` (+test), `src/lib/load-share-card.js` |
| W1.L1 | mig 716; `src/lib/tenant-host.js` (+test); `src/app/api/admin/organizations/route.js` (+new test); `src/app/api/admin/tenant-domains/route.js` (+test); `src/lib/tenant-domains-edge.js` |
| W1.L2 | `src/lib/tenant-domains-edge.js:86`; `src/lib/brands.js:80-136`; `src/public-compliance-paths.test.jsx` |
| W1.L3a | `src/lib/campaign-sender.js`; `src/lib/sequences/steps.js`; `src/lib/host-campaign-queue.js`; `src/lib/hr-post-class-email.js`; two send-test routes; their tests |
| W1.L3b | ~30 event/booking/host/Mia minting sites listed in the task; their tests |
| W1.L4 | `src/lib/default-site-name.js`; `src/lib/default-favicon.js`; `src/app/api/public/branding/route.js`; `src/lib/welcome-front-page.js`; `src/app/welcome/page.js`; seven layouts; OG literal pages; `src/lib/brands.js` (`organizationId` on `un1t-marketing`); `src/lib/tenant-domains-edge.js:220-223`; tests |
| W1.L5 | `src/lib/event-ics.js` (+test); `src/components/RaceConfirmedPage.jsx`; `src/app/event/[slug]/confirmed/page.js` |
| W1.E1 | `src/lib/plans.js` (+test); `src/lib/tenant-email.js` (+test); `src/components/admin/TenantWizard.jsx` (+test); `src/app/settings/email-domain/page.js`; `src/components/settings/EmailDomainWizard.jsx`; `docs/architecture/INTEGRATIONS.md` |
| W1.E2 | `src/lib/tenant-email.js`; `src/lib/postmark.js`; new `src/lib/postmark-reply-to.js`; `src/lib/campaign-sender.js`; `src/lib/sequences/steps.js`; `src/lib/email-inbox-send.js`; four direct senders; send-test route; tests |
| W1.E3 | mig 718; `src/lib/postmark-account.js` (+test); `src/lib/email-domain-service.js`; `src/app/api/settings/email-domain/route.js` |
| W1.E4 | `src/lib/postmark-suppressions.js` (+test); new `src/lib/postmark-server-for-location.js` (+test); 7 callers |
| W1.W1 | `src/lib/location-seed.js` (+test); new `src/app/api/locations/route.test.js` |
| W1.S1a–S6 | per Appendix A–D; `tests/un1t-literal-sweep.test.js` (created in S1a, extended by every sweep PR); champ-app twin guard |
| W1.M1 | mig 717; `src/lib/membership/source.js`, `sources/none.js`, `sources/glofox.js` (+tests); `tests/helpers/credential-column-grants.js`; `src/lib/location-client-shape.js`; `tests/glofox-settings-readers.test.js` list |
| W1.M2 | new `src/app/api/locations/[id]/membership-source/route.js` (+test); `src/components/settings/LocationIntegrations.jsx`; `src/app/api/locations/[id]/integrations/[provider]/route.js`; `src/lib/account-home.js`; `src/components/account/AccountHome.jsx`; `src/lib/openapi.js` |
| W1.M3a | new `src/components/MembershipSourceGate.jsx` (+test); `src/lib/membership/state-for-page.js`; 4 dashboard pages; automations + Shelly cards; pipeline page note; `src/lib/automations/registry.js` |
| W1.M3b | new `src/lib/membership/locations-for-source.js` (+test); 11 crons; `src/lib/agent/booking-tools.js`, `account-tools.js`, `prompt.js`; `src/app/api/admin/backfill-class-bookings/route.js` |
| W1.M3c | `src/app/api/dashboard/business/route.js`; `mobile/lib/dashboard-api.js` (+test); `mobile/lib/membership-source-copy.js` (+test); `mobile/components/dashboard/BusinessDashboard.jsx`; Studio tab component |

---

## Track B — Brand chain and product names (decision 3; review theme B, :97, :127, :167)

Research facts (HEAD e33e786b):
- `src/lib/location-branding.js`: `DEFAULT_COMPANY_NAME = 'UN1T'` (:20); `getLocationBranding` (:35-76) resolves per field `company_settings` → `org_settings` → `'UN1T'` (:68); `getOrgBrandName` (:89-102) reads `org_settings.company_name` only; `locations.name` is never consulted. 18 non-test importers (table in the research; the ones that re-apply their own `|| 'UN1T'`: `churn-winback.js:5`, `contracting-entity.js:48`, `contractor-invoice-email.js:87`, `wallet-topup.js:400`, `contracts-email.js:69,89`, `agent/approval-suggest.js:123`, `agent/followups.js:369`, `agent/prompt.js:264`).
- No shared product-name helper exists; "UN1T Points" is a separate literal at ~60 sites across web, `shared/`, `mobile/`, champ-app; "UN1T HR" at `hr-post-class-email.js:261`, `strava.js:103`, `external-export.js:250,253`, `tcx-builder.js:45`.
- `company_settings` is service-role only since mig 674; the phone cannot read it. `/api/public/branding?location_id=` (`src/app/api/public/branding/route.js:22-28`) already returns `company_name`/`logo_url` via `getLocationBranding` — the phone's brand source.
- Pair-sync: `customer-notifications.js` and `hr-analytics.js` are `identical` twins (`tests/shared-pair-sync.test.js:189-197`) with identical test copies; `goals.js` is `diverged` with `GOAL_DEFS` not on the drifted list (:229-240).
- `tests/legal-entity-consistency.test.js` guards the legal copy ("Champ Fitness Ltd (trading as UN1T Dublin)") on the legal pages — those are UN1T's legal entity by design; the per-tenant legal entity already resolves through `org_settings.legal_*` (mig 425) and `src/lib/tenant-privacy.js`. Not in the sweep.

### Task W1.B1: The brand chain ends in `locations.name`; `DEFAULT_COMPANY_NAME` goes; shared `productName` helper

**Why:** decision 3; review :237 "Replace `getLocationBranding`'s final `'UN1T'` fallback with `locations.name`". Everything in Track S consumes this.

**Why the short name:** UN1T's configured brands are "UN1T stillorgan" / "UN1T Hatch Street" (company_settings) and "UN1T Dublin" (org_settings); `productName` on those gives "UN1T Dublin Points", but decision 3 says UN1T keeps "UN1T Points". So product names use an operator-editable `org_settings.short_name` (the wordmark used in product names), defaulting to the org brand name. One-time data step after mig 715: `update org_settings set short_name = 'UN1T' where organization_id = 'f117b7b8-5f56-4f80-8299-2c698242e4d2'`.

**Files:**
- Create: `supabase/migrations/715_org_settings_short_name.sql`
- Modify: `src/lib/location-branding.js` (whole file), `src/lib/location-branding.test.js:54-70,129-146`
- Modify: `src/components/OrgBrandingSettings.jsx:53-57,89` (+ "Short brand name (used in product names: «UN1T» → UN1T Points)" input), `src/app/api/settings/org-branding/route.js:17-19,72-79` (`short_name` max 40, written `?? null` like its siblings), `src/app/api/settings/org-branding/route.test.js`
- Create: `shared/brand-name.js`, `shared/brand-name.test.js` (pure; mobile + champ-app import it)
- Create: `src/lib/brand-name.js` as a re-export shim (`export * from '../../shared/brand-name.js'` — the `reexport` pair-sync mode, `tests/shared-pair-sync.test.js` manifest entry `brand-name: { mode: 'reexport', reason: 'W1.B1 — one source for product names' }`)
- Modify: `src/lib/default-site-name.js:58,136-141` (import `PLATFORM_SITE_NAME` floor instead of `DEFAULT_COMPANY_NAME`), `src/lib/brand-chrome.test.js:33`, `src/lib/contracting-entity.js:48,142-156` (`DEFAULT_BRAND` → read `companyNameConfigured`; the claim-vs-wordmark split stays), `src/lib/churn-winback.js:5`

- [ ] **Step 0: Migration** `supabase/migrations/715_org_settings_short_name.sql`:

```sql
-- 715 — W1.B1: the SHORT brand an organisation uses in product names.
-- "UN1T Points" must stay "UN1T Points" while the org's brand name is
-- "UN1T Dublin" and a studio's is "UN1T Hatch Street": productName() in
-- shared/brand-name.js reads org_settings.short_name, falling back to the
-- org brand name. Operator-editable at /settings/locations/[id] → Organisation
-- branding (customer-facing copy is never hard-coded). Safe before deploy.
alter table public.org_settings
  add column if not exists short_name text
    check (short_name is null or (length(short_name) between 1 and 40));
comment on column public.org_settings.short_name is
  'W1.B1 (mig 715) — short wordmark for product names ("UN1T" → "UN1T Points"); NULL = use company_name.';
-- Data step (orchestrator, after apply): UN1T Group keeps "UN1T Points".
update public.org_settings set short_name = 'UN1T'
 where organization_id = 'f117b7b8-5f56-4f80-8299-2c698242e4d2' and short_name is null;
```

(No client grant change: `org_settings` is service-role only through its route.)

- [ ] **Step 1: Failing tests** — in `src/lib/location-branding.test.js` replace the "falls back to UN1T" cases (:54-70) with:

```js
it('W1.B1 — with no company_settings and no org_settings the brand is the location name', async () => {
  const db = fakeDb({ company_settings: [], org_settings: [], locations: [{ id: 'loc-1', name: 'Gym A North', organization_id: 'org-a' }] })
  const b = await getLocationBranding(db, 'loc-1')
  expect(b.companyName).toBe('Gym A North')
  expect(b.companyNameConfigured).toBe(false)
})
it('W1.B1 — company_settings beats org_settings beats locations.name, per field', async () => {
  const db = fakeDb({ company_settings: [{ location_id: 'loc-1', company_name: '', logo_url: 'l.png' }],
    org_settings: [{ organization_id: 'org-a', company_name: 'Gym A', favicon_url: 'f.ico' }],
    locations: [{ id: 'loc-1', name: 'Gym A North', organization_id: 'org-a' }] })
  const b = await getLocationBranding(db, 'loc-1')
  expect(b).toEqual({ companyName: 'Gym A', shortName: 'Gym A', companyNameConfigured: true, logoUrl: 'l.png', faviconUrl: 'f.ico' })
})
it('W1.B1 — shortName is org_settings.short_name when set, else the resolved brand', async () => {
  const db = fakeDb({ company_settings: [{ location_id: 'loc-1', company_name: 'UN1T Hatch Street' }],
    org_settings: [{ organization_id: 'org-a', company_name: 'UN1T Dublin', short_name: 'UN1T' }],
    locations: [{ id: 'loc-1', name: 'UN1T Hatch Street', organization_id: 'org-a' }] })
  expect((await getLocationBranding(db, 'loc-1')).shortName).toBe('UN1T')
})
it('W1.B1 — no db / no location / a thrown error yields an EMPTY name, never a literal', async () => {
  expect((await getLocationBranding(null, 'loc-1')).companyName).toBe('')
  expect((await getLocationBranding({ from() { throw new Error('x') } }, 'loc-1')).companyName).toBe('')
})
it('W1.B1 — the module exports no DEFAULT_COMPANY_NAME', async () => {
  const mod = await import('./location-branding')
  expect(mod.DEFAULT_COMPANY_NAME).toBeUndefined()
})
```

and `shared/brand-name.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { productName, pointsUnit, PLATFORM_NAME } from './brand-name.js'

describe('brand-name (W1.B1)', () => {
  it('builds {Brand} Points and {Brand} HR', () => {
    expect(productName('UN1T', 'points')).toBe('UN1T Points')
    expect(productName('Gym A', 'hr')).toBe('Gym A HR')
  })
  it('with no brand the product name is the bare noun, never a literal gym', () => {
    expect(productName('', 'points')).toBe('Points')
    expect(productName(null, 'hr')).toBe('HR')
  })
  it('the short unit is the brand itself, or "pts"', () => {
    expect(pointsUnit('UN1T')).toBe('UN1T')
    expect(pointsUnit('')).toBe('pts')
  })
  it('the platform name is Repset', () => { expect(PLATFORM_NAME).toBe('Repset') })
})
```

- [ ] **Step 2: Run** `npx vitest run src/lib/location-branding.test.js shared/brand-name.test.js` → FAIL.

- [ ] **Step 3: Implement** `shared/brand-name.js`:

```js
// W1.B1 — product names are built from the tenant's brand, never spelled.
// Pure; consumed by web (src/lib/brand-name.js re-export), mobile and
// champ-app. The brand string comes from getLocationBranding (web) or
// /api/public/branding?location_id= (phone / champ-app).
export const PLATFORM_NAME = 'Repset'

const NOUNS = Object.freeze({ points: 'Points', hr: 'HR' })

/** `${brand} Points` / `${brand} HR`; bare noun when the brand is unknown. */
export function productName(brand, kind) {
  const noun = NOUNS[kind]
  if (!noun) throw new Error(`productName: unknown kind ${kind}`)
  const b = (brand || '').trim()
  return b ? `${b} ${noun}` : noun
}

/** The short unit after a number ("280 UN1T"); "pts" when unknown. */
export function pointsUnit(brand) {
  const b = (brand || '').trim()
  return b || 'pts'
}
```

`src/lib/location-branding.js` — delete `DEFAULT_COMPANY_NAME`; `fallback.companyName = ''`; replace the private `getOrgBranding` with one that also returns the location name:

```js
async function getOrgBranding(db, locationId) {
  try {
    const { data: locRows, error: locErr } = await db.from('locations')
      .select('name, organization_id').eq('id', locationId).limit(1)
    const loc = (!locErr && locRows && locRows[0]) || null
    if (!loc) return null
    const base = { locationName: (loc.name || '').trim(), company_name: null, logo_url: null, favicon_url: null }
    if (!loc.organization_id) return base
    const { data: orgRows, error: orgErr } = await db.from('org_settings')
      .select('company_name, short_name, logo_url, favicon_url').eq('organization_id', loc.organization_id).limit(1)
    if (orgErr || !orgRows || !orgRows[0]) return base
    return { ...base, ...orgRows[0] }
  } catch { return null }
}
```

and in `getLocationBranding` after the org merge: `name = name || (org?.company_name || '').trim() || org?.locationName || ''`; the return gains `shortName: (org?.short_name || '').trim() || name`; `companyNameConfigured: Boolean(configuredName)` where `configuredName` is the name BEFORE the `locationName` tier (a location name is a label, not a configured brand — `contracting-entity.js` depends on this distinction). In the `catch` add `logError('location-branding', 'unresolved', { locationId })` (`import { logError } from './log'`). `getOrgBrandName(db, orgId)`: `org_settings.company_name` → the org's `master_location_id` location name → the earliest active location's name in the org (`.order('created_at').limit(1)`) → `''`.

`default-site-name.js:136-141` `resolveGymSiteName` floors on `PLATFORM_SITE_NAME` (it is replaced by host resolution in W1.L4; this keeps it compiling and UN1T-free). `churn-winback.js:5` `defaultWinbackMessage(firstName, companyName)` uses `companyName || 'the studio'`.

- [ ] **Step 4: Run** → PASS, then `npx vitest run src/lib/brand-chrome.test.js src/lib/contracting-entity.test.js src/lib/churn-winback.test.js tests/shared-pair-sync.test.js` → PASS (update `brand-chrome.test.js:33`, which pins `DEFAULT_COMPANY_NAME`). `npm run check:select-columns` (`locations.name` and `org_settings.short_name` are real once mig 715 is in the tree) → PASS. Apply mig 715 via MCP BEFORE merge, then the data step. `npm run check:mobile-imports` → the new shared module is importable. PR ritual. Changelog: `W1.B1 — brand chain ends in locations.name; org_settings.short_name (mig 715); DEFAULT_COMPANY_NAME removed; shared productName helper`.

Merge note: this PR changes NO visible string on its own: every consumer still applies `|| 'UN1T'` locally until Track S removes it, and UN1T's three gym locations all resolve a configured name ("UN1T stillorgan", "UN1T Hatch Street", org "UN1T Dublin"). Note `shared/**` is an OTA bundle path: merging publishes a no-op OTA group (accepted, as `tests/ota-trigger-paths.test.js` pins).

---

### Task W1.B2: The phone and champ-app can read the brand (`useBrand`, `loadBrand`)

**Why:** `company_settings` is closed to client sessions (mig 674); the 34 mobile rows and 36 champ-app rows in the appendix need a brand string. `/api/public/branding?location_id=` already answers it.

**Files:**
- Create: `mobile/lib/brand.js` (`loadBrand(locationId)` → `api('/api/public/branding?location_id=…')`, cached per location in memory + AsyncStorage key `brand:<locationId>`; `useBrand()` hook reading the active location from the existing session context — find it: `grep -rn "activeLocation" mobile/lib | head`), `mobile/lib/brand.test.js`
- Modify: `src/app/api/public/branding/route.js:22-28` — no change needed for `?location_id` (verify the response includes `company_name`); add `product_names: { points, hr }` built with `productName` so the phone does not even need the helper for the common case
- champ-app: create `src/lib/load-brand.js` (`loadBrandForContact(db, contactLocationId)` → `company_settings` → `org_settings` → `locations.name`, the same chain, server-side), `src/lib/load-brand.test.js`; add `location_id` to `src/lib/load-share-card.js:14`'s select

- [ ] **Step 1: Failing test** `mobile/lib/brand.test.js` (vitest, mobile config):

```js
import { describe, it, expect, vi } from 'vitest'
vi.mock('./api', () => ({ api: vi.fn(async () => ({ success: true, data: { company_name: 'Gym A', logo_url: null, product_names: { points: 'Gym A Points', hr: 'Gym A HR' } } })) }))
import { loadBrand, _resetBrandCache } from './brand'

describe('brand (W1.B2)', () => {
  it('loads the brand for a location once and caches it', async () => {
    _resetBrandCache()
    const { api } = await import('./api')
    expect((await loadBrand('loc-1')).companyName).toBe('Gym A')
    expect((await loadBrand('loc-1')).productNames.points).toBe('Gym A Points')
    expect(api).toHaveBeenCalledTimes(1)
  })
  it('a failed load yields empty strings, never a literal', async () => {
    _resetBrandCache()
    const { api } = await import('./api')
    api.mockRejectedValueOnce(new Error('offline'))
    expect((await loadBrand('loc-2')).companyName).toBe('')
  })
})
```

- [ ] **Step 2–4:** run → FAIL → implement (the `api()` wrapper from `mobile/lib/api.js`, inside its try as the session-guard memory requires) → PASS. `npm run check:mobile-imports && npm run check:mobile-lint`. `mobile/lib/**` is an OTA path (no-op publish). PR ritual. Changelog: `W1.B2 — phone and champ-app brand loaders`.

---


---

## Track L — Links and hosts (decision 4; review theme C, §1 "Hostnames", §2 "Foundation" :96-97, "Events" :162, "Host portal" :163)

Research facts this track rests on (HEAD e33e786b):
- `getAppUrl()` (`src/lib/app-url.js:16-25`) is env-only; 74 invocations in 59 files, ~45 of them customer-facing (list in W1.L3).
- The host → tenant mapping is `resolveTenantDomainBrand` in `src/lib/tenant-domains-edge.js:201-208` (5-min cache of active `tenant_domains` rows, :125-143); unknown hosts fall through to the CRM auth gate (`src/proxy.js:76-110`).
- `tenant_domains` (mig 415:41-53, 432:32-33): `hostname UNIQUE CHECK lower`, `organization_id`, `brand jsonb`, `active`, `location_id` nullable.
- The four public-path allowlists: (1) `src/proxy.js:210` `publicPaths`, (2) `src/components/AppShell.jsx:78` `PUBLIC_PATHS`, (3) `src/lib/brands.js:80-136` `un1t-marketing.allowedPaths`, (4) `src/lib/tenant-domains-edge.js:86` `DB_BRAND_DEFAULTS.allowedPaths`. Guard: `src/public-compliance-paths.test.jsx`.
- `DB_BRAND_DEFAULTS.allowedPaths` today: `/welcome, /book/, /event/, /event/entry/, /event-pay/, /privacy, /legal/, /account-deletion, /cancel/, /api/public/, /api/webhooks/` — omits `/unsubscribe/`, `/preferences/`, `/view-email/`, `/api/unsubscribe/`, `/api/preferences/`, `/class-pay/`, `/h/`, `/host`, `/host-connect/`, `/api/host/`, `/embed/`, `/terms`, `/start`, `/free-class`, `/offers` (review :121; its `:52/:83` citations have drifted to `:51/:86`).
- `customerFacingMetadata` lives in `src/lib/default-site-name.js:161-167`, not `app-url.js`; it reads the FIRST `company_settings.company_name` ordered by `location_id` (:84-100) — today that is Stillorgan's "UN1T stillorgan". Seven layouts call it with no arguments (`host`, `book/[slug]`, `host-connect`, `reset-password`, `account`, `event`, `event-pay`). `resolveDefaultFaviconUrl` (`src/lib/default-favicon.js:52-70`) and `/api/public/branding` anonymous branch (`route.js:31-35`, no `order()`) have the same first-row shape.
- `organizations.slug` exists (mig 079:35-42, NOT NULL UNIQUE; "Reserved for future … sub-domains"); live slugs `un1t-group`, `ccf-autos`, `givers-consultancy`.
- Customer event ICS is built in `src/components/RaceConfirmedPage.jsx:101-117` (`PRODID:-//UN1T//Events//EN`, `UID:<id>@un1tdublin.com`, fallback summary `UN1T Event`).
- Vercel already carries `*.repset.ie` (verified) and DNS has the wildcard CNAME (Live facts table). The `*.repset.ie` host reaches the proxy as an unknown host today → CRM auth gate → `/login`.

### Task W1.L1: Every organisation gets `<slug>.repset.ie` — host resolver + platform tenant_domains rows

**Why:** decision 4; review §1 "A `tenant_domains` row does not make a hostname resolve" is now false for `*.repset.ie` (wildcard verified 10 Oct), so an auto row per org makes the host live with zero Vercel work. Blocker 8's "links on crm.repset.ie" needs a resolver every minting site can call.

**Files:**
- Create: `supabase/migrations/716_tenant_domains_platform_rows.sql`
- Create: `src/lib/tenant-host.js`, `src/lib/tenant-host.test.js`
- Modify: `src/app/api/admin/organizations/route.js:57-61` (insert the platform row after the org), `src/app/api/admin/organizations/route.test.js` (new — none exists)
- Modify: `src/lib/tenant-domains-edge.js:131-134` (select `source` too), `src/app/api/admin/tenant-domains/route.js:21,64,67` (refuse a hand-made `*.repset.ie` row: the platform row is automatic)

- [ ] **Step 1: Migration** `supabase/migrations/716_tenant_domains_platform_rows.sql`:

```sql
-- 716 — W1.L1: every organisation owns a platform host <org.slug>.repset.ie.
--
-- WHY. Customer-facing links were minted on NEXT_PUBLIC_APP_URL (crm.repset.ie)
-- because no tenant had a hostname that resolved. Vercel now carries the
-- wildcard *.repset.ie (verified 2026-10-10) and DNS answers it, so a
-- tenant_domains row is all a hostname needs. One automatic row per org,
-- source='platform'; a tenant's own domain is a second row, source='custom',
-- and src/lib/tenant-host.js prefers custom over platform.
--
-- Safe before the code deploys: the proxy's DB tier already serves any
-- active row with the default public allowlist (tenant-domains-edge.js), so
-- un1t-group.repset.ie simply starts answering /welcome, /book/, /event/…
-- exactly as a hand-inserted row would have.

alter table public.tenant_domains
  add column if not exists source text not null default 'custom'
    check (source in ('platform', 'custom'));

comment on column public.tenant_domains.source is
  'W1.L1 (mig 716) — platform = the automatic <org.slug>.repset.ie row (one per org, never edited by hand); custom = a domain the tenant brought.';

-- One platform row per org. idempotent.
insert into public.tenant_domains (hostname, organization_id, brand, active, source)
select o.slug || '.repset.ie', o.id, '{}'::jsonb, o.active, 'platform'
  from public.organizations o
 where not exists (
   select 1 from public.tenant_domains t
    where t.organization_id = o.id and t.source = 'platform');

create unique index if not exists tenant_domains_one_platform_per_org
  on public.tenant_domains (organization_id) where source = 'platform';

-- No client privilege changes: mig 415's RLS (master + org membership SELECT)
-- already covers the new column; the proxy reads via the service role.
```

Pre-check before applying: `select slug from organizations where slug !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'` must return 0 rows (a slug that is not a DNS label cannot become a host). Post-check: `select hostname, source from tenant_domains order by 1` → `ccf-autos.repset.ie`, `givers-consultancy.repset.ie`, `un1t-group.repset.ie`, all `platform`.

- [ ] **Step 2: Failing test** `src/lib/tenant-host.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { platformHostnameFor, pickTenantHost, resolveCustomerBaseUrl, _resetTenantHostCache } from './tenant-host'

const fakeDb = (rows, loc = { organization_id: 'org-a' }, org = { slug: 'gym-a' }) => ({
  from(table) {
    const b = { _t: table, eq() { return b }, in() { return b }, order() { return b }, limit() { return b },
      maybeSingle: async () => (table === 'locations' ? { data: loc, error: null } : { data: org, error: null }),
      then(res) { return Promise.resolve({ data: table === 'tenant_domains' ? rows : null, error: null }).then(res) } }
    return b
  },
})

describe('tenant-host (W1.L1)', () => {
  beforeEach(() => { _resetTenantHostCache(); vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.repset.ie') })

  it('the platform hostname is <slug>.repset.ie', () => {
    expect(platformHostnameFor('gym-a')).toBe('gym-a.repset.ie')
  })
  it('a custom row beats the platform row; a location-scoped row beats a whole-org row', () => {
    const rows = [
      { hostname: 'gym-a.repset.ie', source: 'platform', location_id: null },
      { hostname: 'www.gym-a.com', source: 'custom', location_id: null },
      { hostname: 'north.gym-a.com', source: 'custom', location_id: 'loc-a2' },
    ]
    expect(pickTenantHost(rows, 'loc-a1')).toBe('www.gym-a.com')
    expect(pickTenantHost(rows, 'loc-a2')).toBe('north.gym-a.com')
    expect(pickTenantHost([rows[0]], 'loc-a1')).toBe('gym-a.repset.ie')
    expect(pickTenantHost([], 'loc-a1')).toBe(null)
  })
  it('resolves https://<host> for a location, and falls back to the platform host with no rows', async () => {
    expect(await resolveCustomerBaseUrl(fakeDb([{ hostname: 'gym-a.repset.ie', source: 'platform', location_id: null }]), 'loc-a1')).toBe('https://gym-a.repset.ie')
    expect(await resolveCustomerBaseUrl(fakeDb([]), 'loc-a1')).toBe('https://gym-a.repset.ie') // synthesised from org.slug
    expect(await resolveCustomerBaseUrl(fakeDb([], null, null), 'loc-a1')).toBe('https://crm.repset.ie') // no org → platform CRM host
    expect(await resolveCustomerBaseUrl(null, null)).toBe('https://crm.repset.ie')
  })
  it('never throws on a db error — the CRM host is the floor', async () => {
    const db = { from() { throw new Error('boom') } }
    expect(await resolveCustomerBaseUrl(db, 'loc-a1')).toBe('https://crm.repset.ie')
  })
})
```

- [ ] **Step 3: Run** `npx vitest run src/lib/tenant-host.test.js` → FAIL (module missing).

- [ ] **Step 4: Implement** `src/lib/tenant-host.js`:

```js
// W1.L1 — the host a CUSTOMER-facing link is minted on, per tenant.
//
// Order: a custom tenant_domains row (location-scoped first, then whole-org)
// → the org's platform row <org.slug>.repset.ie → the same host synthesised
// from organizations.slug when the row is missing → the CRM host
// (getAppUrl()). NEVER throws past the floor: a link must always be minted,
// and crm.repset.ie serves every public path, so the floor is always safe.
//
// Staff-facing links (invites, rosters, approvals, QStash callbacks, Stripe
// Connect returns for staff) keep getAppUrl(): the CRM lives on the CRM host.
import { getAppUrl } from './app-url'

export const PLATFORM_HOST_SUFFIX = 'repset.ie'
const CACHE_TTL_MS = 60_000
const cache = new Map()

export function _resetTenantHostCache() { cache.clear() }

/** Pure. */
export function platformHostnameFor(orgSlug) {
  return `${orgSlug}.${PLATFORM_HOST_SUFFIX}`
}

/** Pure: pick the hostname from an org's active rows for one location. */
export function pickTenantHost(rows, locationId) {
  const list = Array.isArray(rows) ? rows : []
  const custom = list.filter((r) => r.source === 'custom')
  return (
    custom.find((r) => r.location_id && r.location_id === locationId)?.hostname ||
    custom.find((r) => !r.location_id)?.hostname ||
    list.find((r) => r.source === 'platform')?.hostname ||
    null
  )
}

async function loadHostForLocation(db, locationId) {
  const { data: loc, error: locErr } = await db.from('locations').select('organization_id').eq('id', locationId).maybeSingle()
  if (locErr || !loc?.organization_id) return null
  const { data: rows } = await db.from('tenant_domains')
    .select('hostname, source, location_id')
    .eq('organization_id', loc.organization_id).eq('active', true)
  const picked = pickTenantHost(rows, locationId)
  if (picked) return picked
  const { data: org } = await db.from('organizations').select('slug').eq('id', loc.organization_id).maybeSingle()
  return org?.slug ? platformHostnameFor(org.slug) : null
}

/**
 * @param {object|null} db service-role client
 * @param {string|null} locationId
 * @returns {Promise<string>} `https://<host>` with no trailing slash
 */
export async function resolveCustomerBaseUrl(db, locationId) {
  const floor = () => getAppUrl()
  if (!db || !locationId) return floor()
  try {
    const hit = cache.get(locationId)
    let host
    if (hit && hit.expiresAt > Date.now()) host = hit.host
    else {
      host = await loadHostForLocation(db, locationId)
      cache.set(locationId, { host, expiresAt: Date.now() + CACHE_TTL_MS })
    }
    return host ? `https://${host}` : floor()
  } catch {
    return floor()
  }
}
```

- [ ] **Step 5: Run** → PASS. Then: in `src/lib/tenant-domains-edge.js:131-134` add `source` to the select (the proxy ignores it; `tests/`'s fake rows need no change). In `src/app/api/admin/tenant-domains/route.js` reject `hostname.endsWith('.repset.ie')` with 400 `"<slug>.repset.ie hosts are automatic; bring your own domain here"` (next to the reserved-host check at :105), and in the DELETE/PATCH handlers refuse `source === 'platform'` rows with 409. In `src/app/api/admin/organizations/route.js` after the org insert:

```js
  // W1.L1 — the platform host is born with the org.
  const { error: hostErr } = await db.from('tenant_domains').insert({
    hostname: `${slug}.repset.ie`, organization_id: org.id, brand: {}, active: true, source: 'platform',
  })
  if (hostErr) logError('organizations.create.platform_host', hostErr, { orgId: org.id })
```

Write `src/app/api/admin/organizations/route.test.js` in the Style A shape (`makeFakeDb` from `@/lib/api-auth.test-helpers.js`, master user) asserting the two inserts. Add `src/app/api/admin/tenant-domains/route.test.js` cases for the two refusals.

- [ ] **Step 6: Gates** `npx vitest run src/lib/tenant-host.test.js src/lib/tenant-domains-edge.test.js src/app/api/admin/organizations src/app/api/admin/tenant-domains src/proxy.tenant-domains.test.js` and `npm run check:select-columns` (the new column is in the migration, so `source` resolves) → PASS. Apply mig 716 via MCP BEFORE merge; `get_advisors(security)`. PR ritual. Changelog: `W1.L1 — every organisation gets <slug>.repset.ie (mig 716); resolveCustomerBaseUrl`.

Merge note: after merge, `https://un1t-group.repset.ie/welcome` must render UN1T's chooser (the W1.L4 host-aware front page comes later; until then it renders the un1t-group slug page, which is correct for that host).

---

### Task W1.L2: Widen the tenant-domain default allowlist to the whole customer flow

**Why:** decision 4; review :121/:163 and theme A "widen the tenant-domain default allowlist to cover the funnel, unsubscribe, preferences, view-email and host paths". Without this, a link W1.L3 mints on the tenant host rewrites to `/welcome` and the customer never reaches the unsubscribe page (`DB_BRAND_DEFAULTS.fallbackHandler = 'rewrite'`).

**Files:**
- Modify: `src/lib/tenant-domains-edge.js:86`
- Modify: `src/public-compliance-paths.test.jsx` (the four-allowlist guard)
- Modify: `src/lib/brands.js:80-136` (`un1t-marketing.allowedPaths`: add the same marketing + host paths so UN1T's own marketing host serves them too)

- [ ] **Step 1: Failing test** — add to `src/public-compliance-paths.test.jsx` (follow its existing `it.each` over paths against the real `DB_BRAND_DEFAULTS` and the real proxy):

```js
describe('W1.L2 — the customer flow is complete on a tenant domain', () => {
  const FLOW = ['/unsubscribe/abc', '/preferences/abc', '/view-email/abc', '/api/unsubscribe/abc', '/api/preferences/abc',
    '/class-pay/abc', '/h/pride', '/host', '/host/login', '/host-connect/abc', '/api/host/x', '/embed/event/x', '/terms']
  it.each(FLOW)('%s is served, not rewritten, on a tenant_domains host', async (path) => {
    const res = await runProxyFor('gym-a.repset.ie', path) // the file's existing helper that seeds a tenant row
    expect(res.rewrittenTo).toBeUndefined()
  })
  it.each(['/start', '/free-class', '/offers'])('%s stays OFF the default (Stillorgan-pinned until Wave 2/3)', async (path) => {
    const res = await runProxyFor('gym-a.repset.ie', path)
    expect(res.rewrittenTo).toBe('/welcome')
  })
})
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — replace `allowedPaths` at `tenant-domains-edge.js:86` with:

```js
  allowedPaths: Object.freeze([
    '/welcome', '/book/', '/event/', '/event/entry/', '/event-pay/', '/privacy', '/legal/', '/terms',
    '/account-deletion', '/cancel/', '/api/public/', '/api/webhooks/',
    // W1.L2 — the marketing flow a tenant's customer reaches from an email:
    '/unsubscribe/', '/preferences/', '/view-email/', '/api/unsubscribe/', '/api/preferences/',
    // the paid class leg, the host portal and host onboarding, embeds:
    '/class-pay/', '/h/', '/host', '/host-connect/', '/api/host/', '/embed/',
  ]),
```

and add a comment block above it: `/start`, `/free-class`, `/offers` are deliberately absent (they are Stillorgan literals: `src/app/start/page.js`, `free-class/page.js`, W0.4's pinned `/offers`) — serving them on another tenant's host would show UN1T's funnel; UN1T Group's own platform row may list them in `brand.allowedPaths` (W1.L1's row has `{}` → defaults; the orchestrator adds `{"allowedPaths":[...defaults, "/start","/free-class","/offers"]}` to the `un1t-group.repset.ie` row by SQL after this merges). Mirror the same additions into `un1t-marketing.allowedPaths` in `brands.js` (it lacks `/unsubscribe/`, `/preferences/`, `/view-email/`, `/api/unsubscribe/`, `/api/preferences/`, `/class-pay/`, `/h/`, `/host`, `/host-connect/`, `/api/host/`). Update the stale column comment reference in mig 415:59 by a one-line note in the new file's header (never edit an applied migration).

- [ ] **Step 4: Run** `npx vitest run src/public-compliance-paths.test.jsx src/proxy.tenant-domains.test.js src/lib/brands.test.js src/calendar-feed-path.test.js` → PASS (the calendar-feed pin must still hold: `/api/calendar-feed` is not added). PR ritual. Changelog: `W1.L2 — tenant domains serve the whole customer flow (unsubscribe, preferences, view-email, class-pay, host)`.

---

### Task W1.L3: Customer-facing links are minted on the tenant host (two PRs)

**Why:** decision 4; review :96 "every emailed or WhatsApp link … is minted on crm.repset.ie"; :139 unsubscribe/preferences/view-in-browser on `NEXT_PUBLIC_APP_URL`. Depends on W1.L1 (resolver) and W1.L2 (paths served).

**Split:** W1.L3a = marketing + sequences + HR email links; W1.L3b = events, booking, host, Mia. Each site already has a `locationId` (or a row carrying one) in scope — verified per site below. Staff links are NOT touched (invites, rosters, approvals, QStash, staff calendar feed, staff Stripe Connect).

**Files W1.L3a:**
- Modify: `src/lib/campaign-sender.js:736` (`const baseUrl = getAppUrl()` → `await resolveCustomerBaseUrl(db, campaign.location_id)`), feeding `:753` view-email, `:768` unsubscribe, `:778` preferences
- Modify: `src/lib/sequences/steps.js:288` (sequence has `location_id`), `:289`, `:335`
- Modify: `src/lib/host-campaign-queue.js:203` (host campaign → host's anchor location id; the row carries `location_id`)
- Modify: `src/lib/hr-post-class-email.js:476` (`/api/preferences/hr-emails`; the session row carries `location_id`)
- Modify: `src/app/api/campaigns/[id]/send-test/route.js:113`, `src/app/api/host/emails/[id]/send-test/route.js:117`
- Tests: `src/lib/campaign-sender.test.js`, `src/lib/sequences/steps.test.js`, `src/lib/host-campaign-queue.test.js`, `src/lib/hr-post-class-email.test.js`, the two send-test route tests (41 test files mock `app-url`; each touched one gains `vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://gym-a.repset.ie') }))`)

- [ ] **Step 1: Failing test** (campaign-sender, add):

```js
it('W1.L3a — unsubscribe, preferences and view-in-browser links use the campaign location\'s tenant host', async () => {
  resolveCustomerBaseUrl.mockResolvedValueOnce('https://gym-a.repset.ie')
  const html = await renderForRecipient(campaignFixture({ location_id: 'loc-a1' }), contactFixture())
  expect(html).toContain('https://gym-a.repset.ie/unsubscribe/')
  expect(html).toContain('https://gym-a.repset.ie/preferences/')
  expect(html).toContain('https://gym-a.repset.ie/view-email/')
  expect(html).not.toContain('crm.repset.ie')
})
```

(adapt the two fixture helpers to the file's existing ones; the assertion is the three hosts). Same shape for `steps.test.js` (sequence step email), `host-campaign-queue.test.js` (`/unsubscribe/host/`), `hr-post-class-email.test.js` (`/api/preferences/hr-emails`).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** each site as `const baseUrl = await resolveCustomerBaseUrl(db, <locationId>)` with `import { resolveCustomerBaseUrl } from '@/lib/tenant-host'`; where the function was sync, it is already inside an async send path at every listed site (verify: campaign-sender `:736` is inside `async function sendCampaignBatch`). Keep `getAppUrl()` imports only where a staff link remains in the same file.

- [ ] **Step 4: Run** the touched tests → PASS. `npm run check:guardrails` (no new bare writes). PR ritual. Changelog: `W1.L3a — marketing, sequence and HR email links minted on the tenant host`.

**Files W1.L3b:**
- Modify (event + race flow, each row has `location_id`): `src/app/api/public/events/[slug]/register/route.js:692-696` (Stripe success/cancel return URLs), `src/app/api/public/races/[slug]/register/route.js:379`, `src/lib/race-register-solo.js:167-174`, `src/app/api/event-registrations/[id]/moves/[moveId]/gap-link/route.js:102`, `src/lib/race-gap-payment.js:142,248,278`, `src/app/api/public/entry/[token]/move/route.js:129`, `src/lib/entry-manage-tokens.js:85`, `src/lib/event-waitlist.js:157`, `src/lib/race-confirmations.js:75`, `src/lib/event-attendee-reminders.js:234`, `src/app/api/events/[id]/qr-code/route.js:58`, `src/app/(members)/events/page.js:110` (the copyable public link)
- Modify (Mia): `src/lib/agent/event-tools.js:249,336,476` (`signup_url` — the tool has the conversation's `locationId`)
- Modify (class pay): `src/lib/class-booking-payments.js:29`
- Modify (cancellation form): `src/app/api/contacts/[id]/cancellation-form/route.js:76` → `copy.public_base_url || await resolveCustomerBaseUrl(db, contact.location_id)` (the per-location override stays first)
- Modify (host): `src/app/host/(portal)/page.js:75`, `src/app/api/host/signup-qr/route.js:47`, `src/app/api/hosts/[id]/onboarding-link/route.js:39`, `src/app/api/hosts/[id]/onboarding-link/send/route.js:46`, `src/app/api/public/host-connect/[token]/start/route.js:58`, `.../refresh/route.js:19`, `src/lib/host-notifications.js:44,53,91,141`, `src/app/api/hosts/[id]/invite/route.js:71` (`/host/set-password` — a host is a customer of the platform, lands on the org host)
- Modify (contracts, member-facing links only): `src/lib/contracts-email.js:89,108,169,219` (recipient links; the issuer links at `:220,:309` stay on getAppUrl)
- NOT changed: `src/app/api/public/events/checkin-qr/route.js:40` (the QR encodes the STAFF scan URL) and `src/lib/race-confirmations.js:75` / `event-attendee-reminders.js:234` ONLY where the link is the QR image URL `/api/public/events/checkin-qr` — that image may stay on the CRM host (it is fetched by the mail client, not read by the customer); the plan lists them for the executor to confirm which of the two URLs each site builds.
- Tests: each touched file's existing `.test.js` gains one host assertion as in W1.L3a.

- [ ] **Step 1: Failing tests** — one per touched module in the W1.L3a shape (assert `https://gym-a.repset.ie/event/…`, `/event-pay/…`, `/event/entry/…`, `/class-pay/…`, `/h/…`, `/host-connect/…`, `/race/…` for Mia's `signup_url`).
- [ ] **Step 2–4:** as W1.L3a. `npm run check:route-guards && npm run check:location-scoping` → PASS. PR ritual. Changelog: `W1.L3b — event, booking, host and Mia links minted on the tenant host`.

⚠️ **Visible change for UN1T:** after L3a/L3b UN1T's own customers receive links on `un1t-group.repset.ie` instead of `crm.repset.ie`. Both resolve; the host string changes. Card: "UN1T's customer links move to un1t-group.repset.ie (or set a custom host, e.g. go.un1tdublin.com, as a `custom` tenant_domains row first)". If Richard prefers a UN1T custom host, the orchestrator inserts it BEFORE merging L3a (the resolver prefers custom automatically).

---

### Task W1.L4: Customer-facing metadata, site name and favicon resolve by the request's host ⚠️

**Why:** decision 4 "`customerFacingMetadata` resolves by the request's org"; review :97 first-row branding, :162 OG "UN1T Dublin", `default-site-name.js:20-26,128-131` own "SAAS-8 HANDOFF … thread the host in" comments.

**Files:**
- Modify: `src/lib/default-site-name.js:84-100,113-118,136-141,161-167` (host-keyed; caches keyed by host)
- Modify: `src/lib/default-favicon.js:52-70`
- Modify: `src/app/api/public/branding/route.js:31-35` (anonymous branch → host)
- Modify: `src/lib/welcome-front-page.js:37-45` (`loadFrontPage(db, { orgId })`; `src/app/welcome/page.js:138-145` passes `resolveTenantOrgId(host)`)
- Modify: the seven layouts calling `customerFacingMetadata()` → `customerFacingMetadata({ host: (await headers()).get('host') })` (`src/app/host/layout.js:18`, `book/[slug]/layout.js:17`, `host-connect/layout.js:16`, `reset-password/layout.js:18`, `account/layout.js:16`, `event/layout.js:22`, `event-pay/layout.js:17`), and `src/app/layout.js:73-74`
- Modify: OG literals `src/app/event/[slug]/page.js:46,51,58`, `src/app/embed/event/[slug]/page.js:40,45`, `src/app/welcome/[location]/page.js:56,60,70`, `src/app/welcome/[location]/events/page.js:57,58,67`, `src/app/welcome/page.js:62,65,67`, `src/app/unsubscribe/[token]/page.js:9`, `unsubscribe/host/[token]/page.js:25`, `preferences/layout.js:20`, `preferences/[token]/page.js:9` — each becomes the resolved brand (these pages all have a location or token→location in scope; the welcome/event ones use the page's own location)
- Tests: `src/lib/brand-chrome.test.js` (covers `customerFacingMetadata` at :29,:267-289), `src/lib/default-favicon.test.js`, `src/lib/welcome-front-page.test.js`, `src/app/api/public/branding/route.test.js`

- [ ] **Step 1: Failing test** (brand-chrome.test.js, add):

```js
it('W1.L4 — customerFacingMetadata resolves the brand of the host\'s organisation', async () => {
  seedTenantDomain({ hostname: 'gym-a.repset.ie', organization_id: 'org-a' })
  seedOrgSettings({ organization_id: 'org-a', company_name: 'Gym A' })
  const meta = await customerFacingMetadata({ host: 'gym-a.repset.ie' })
  expect(meta.title).toBe('Gym A')
  expect(meta.openGraph.siteName).toBe('Gym A')
})
it('W1.L4 — on the CRM host with no org the name is the platform name, never the first company_settings row', async () => {
  const meta = await customerFacingMetadata({ host: 'crm.repset.ie' })
  expect(meta.title).toBe('Repset')
})
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**: in `default-site-name.js` replace `readConfiguredCompanyName` with `resolveBrandNameForHost(db, host)`: `resolveTenantOrgId(host)` → `getOrgBrandName(db, orgId)` (from W1.B1's chain: org_settings → first ACTIVE location's `company_settings` in that org → the org's `master_location_id` location name) → `'Repset'`. Key the 5-min cache by host. `resolveDefaultFaviconUrl(host)` same shape on `org_settings.favicon_url` → first location `company_settings.favicon_url` in the org → platform favicon. `/api/public/branding` anonymous branch: `resolveTenantOrgId(request.headers.get('host'))` → `getOrgBranding`; no org → `{ companyName: 'Repset', logoUrl: null }`. `loadFrontPage(db, { orgId })`: `orgId ?? FRONT_PAGE_ORG_SLUG` lookup. The `headers()` import is `import { headers } from 'next/headers'` (async in Next 16: `await headers()`).

- [ ] **Step 4: Run** the four test files + `src/public-compliance-paths.test.jsx` → PASS; `npm run build` locally (layouts changed; `headers()` makes these routes dynamic — confirm no `generateStaticParams` conflict in `event/[slug]`). PR ritual. Changelog: `W1.L4 — customer-facing metadata, favicon and front page resolve by host`.

⚠️ Card: on `crm.repset.ie` the anonymous `<title>`/OG for `/book/`, `/event/`, `/reset-password` changes from "UN1T stillorgan" (first row) to "Repset"; on `un1t-group.repset.ie` and `un1tdublin.com` it reads "UN1T Dublin" (org_settings). The in-code `un1t-marketing` brand (`un1tdublin.com`) needs an `organizationId` to resolve: add `organizationId: process.env.MARKETING_ORG_ID || 'f117b7b8-5f56-4f80-8299-2c698242e4d2'` to that brand entry in `brands.js:75-141` and have `resolveTenantOrgId` consult the in-code tier first (one line in `tenant-domains-edge.js:220-223`).

---

### Task W1.L5: Customer ICS carries the tenant's identity

**Why:** review :162 "ICS `@un1tdublin.com`"; the event ICS is built client-side in `src/components/RaceConfirmedPage.jsx:101-117` with `PRODID:-//UN1T//Events//EN`, `UID:<id>@un1tdublin.com`, fallback `SUMMARY:UN1T Event`.

**Files:**
- Modify: `src/components/RaceConfirmedPage.jsx:101-117` (take `brandName` and `hostname` props; `PRODID:-//Repset//Events//EN`, `UID:<id>@<hostname>`, fallback summary `${brandName} event`)
- Modify: `src/app/event/[slug]/confirmed/page.js` (the server page that renders it: resolve `brandName` via `getLocationBranding(db, event.location_id).companyName` and `hostname` via `new URL(await resolveCustomerBaseUrl(db, event.location_id)).hostname`)
- Tests: `src/components/RaceConfirmedPage.test.jsx` (exists? if not, create with the file's RTL style) — assert the three lines.

- [ ] **Step 1: Failing test:**

```js
it('W1.L5 — the ICS names the tenant, never UN1T', () => {
  const ics = buildEventIcs({ id: 'e1', title: '', startsAt: '2026-11-01T10:00:00Z' }, { brandName: 'Gym A', hostname: 'gym-a.repset.ie' })
  expect(ics).toContain('PRODID:-//Repset//Events//EN')
  expect(ics).toContain('UID:e1@gym-a.repset.ie')
  expect(ics).toContain('SUMMARY:Gym A event')
  expect(ics).not.toContain('UN1T')
})
```

(extract the inline builder at `:101-117` into an exported pure `buildEventIcs(event, { brandName, hostname })` in `src/lib/event-ics.js` so it is testable without React; the component calls it.)

- [ ] **Step 2–4:** run → FAIL → implement → PASS. `npx vitest run src/lib/event-ics.test.js src/components/RaceConfirmedPage.test.jsx`. PR ritual. Changelog: `W1.L5 — event ICS files carry the tenant brand and host`.

---

## Track E — Email identity (decision 1 + 2; review Blocker 8, :139-140, §1 "machinery never exercised")

Research facts (HEAD e33e786b):
- Gates: plan feature `custom_email_domain` only in `orgHasEmailDomainAddon` (`src/lib/tenant-email.js:137-154`), enforced on POST provision only (`src/app/api/settings/email-domain/route.js:117-124`); org-admin gate `isOrgAdminSomewhere` (`src/lib/org-admin.js:42-45`, **master passes**) at `route.js:44`, `verify/route.js:32`, `page.js:30`, `settings-tree.js:222`; env gate `isPostmarkAccountConfigured()` (`src/lib/postmark-account.js:28-30`) → 503 at `route.js:53-55`. **Master does not bypass the plan gate.**
- `getLocationPlan` returns `null` with no TIER pin (`src/lib/plans.js:135-136`), so the live add-on-only pin on Test Studio grants nothing. Pins are written by `POST/DELETE /api/admin/tenants/[orgId]/plans` (master; `TenantDetailView.jsx:37-48` is the UI at `/admin/tenants/[orgId]`); `/admin/plans` is the catalogue editor. The wizard's Done step links "Assign a plan" to `/admin/plans` (`TenantWizard.jsx:359`), the wrong page.
- `createTenantServer` (`postmark-account.js:152-160`) posts `{ Name, Color }` only: no webhooks, no `broadcast` stream (`sendBatch` puts `MessageStream: 'broadcast'` on every campaign send, `postmark.js:401`; a bare server has only `outbound`/`inbound`, so a tenant campaign would fail with Postmark ErrorCode 1235). `docs/domain-migration-stage3.md:428` says "sending-only, no webhooks by construction".
- Suppression sync (`postmark-suppressions.js:85-92`) always uses the global token (`POSTMARK_API_KEY || POSTMARK_SERVER_TOKEN`); 7 callers listed in the research. Inbound reactivation already maps `ServerID` → `tenant_email_domains.postmark_server_id` (`postmark-webhook-processor.js:131-144`).
- From chain: `sendEmail` `tenant.from || from || POSTMARK_FROM_EMAIL || 'UN1T <hello@un1t.ie>'` (`postmark.js:275`), `sendBatch` same per email (:394); `resolveTenantOverride` (:70-83) applies the tenant From ONLY when a tenant token exists. Reply-To: `sendMarketingEmail` → `getLocationInboxReplyTo(locationId)` (:933-936, default mailbox then deprecated `locations.email_inbox_reply_to`); campaign-sender :746-750 same; transactional sends pass `replyTo` only if the caller does. `email-inbox-send.js:154-156` fallback `'UN1T <hello@un1t.ie>'`. Four direct-fetch senders hard-code the same literal (`contractor-invoice-email.js:31`, `xero/bills-email.js:47`, `xero/contractor-bills.js:28`, `xero/fte-expense-claims.js:35`).
- Platform From today: `POSTMARK_FROM_EMAIL=hello@un1t.ie` (`.env.local.example:29`, `docs/architecture/INTEGRATIONS.md:12`). **No `hello@repset.ie` exists anywhere, and `repset.ie` is not Postmark-verified (Live facts).** Decision 2 names `hello@repset.ie`: it is P2, Richard's step; the code reads `POSTMARK_FROM_EMAIL` and never spells an address.
- Campaign test sends (`campaigns/[id]/send-test/route.js:136-150`) pass no `locationId`, so a test send never exercises the tenant path.
- Probable bug, out of scope, flagged for a follow-up chip: `notify.js:169` judges `res?.ErrorCode === 0 || res?.MessageID` but `sendEmail` returns `{ messageId }` (`postmark.js:357-361`), so successful fallbacks count as `email_failed`.

### Task W1.E1: The `custom_email_domain` gate is reachable — add-on pins count, the pin UI is linked, the env gate is documented

**Why:** decision 1; review Blocker 8 "gated behind a plan pin, an org-admin grant and an env var that no org has".

**Files:**
- Modify: `src/lib/plans.js` (add `locationHasPlanFeature`), `src/lib/plans.test.js`
- Modify: `src/lib/tenant-email.js:137-154`, `src/lib/tenant-email.test.js`
- Modify: `src/components/admin/TenantWizard.jsx:359` (link to `/admin/tenants/${orgId}`), `src/components/admin/TenantWizard.jsx:228-231` (owner step: `org_admin: true` default-on checkbox → after the invite, `POST /api/staff/${id}/org-admin`), `src/lib/tenant-wizard.test.js`
- Modify: `src/app/settings/email-domain/page.js` + `src/components/settings/EmailDomainWizard.jsx` (when `!accountConfigured` show "Platform Postmark account token is not configured — ask Repset support" instead of a bare 503; when `!addonActive` show "Comes with the plan that includes email marketing — ask your account manager to pin it" naming the plan)
- Modify: `docs/architecture/INTEGRATIONS.md` env table: `POSTMARK_ACCOUNT_TOKEN` "required for tenant email domains (W1.E1); unset = the feature reports not configured"

- [ ] **Step 1: Failing tests** — `src/lib/plans.test.js`:

```js
describe('locationHasPlanFeature (W1.E1)', () => {
  it('true when an active ADD-ON pin grants the feature even with no tier pin', async () => {
    const db = fakePins([{ active: true, version: { features: { custom_email_domain: true }, plan: { kind: 'addon' } } }])
    expect(await locationHasPlanFeature(db, 'loc-1', 'custom_email_domain')).toBe(true)
  })
  it('true when the tier grants it; false when nothing active grants it; false on error', async () => {
    expect(await locationHasPlanFeature(fakePins([{ active: true, version: { features: { custom_email_domain: true }, plan: { kind: 'tier' } } }]), 'loc-1', 'custom_email_domain')).toBe(true)
    expect(await locationHasPlanFeature(fakePins([{ active: true, version: { features: { custom_email_domain: false }, plan: { kind: 'tier' } } }]), 'loc-1', 'custom_email_domain')).toBe(false)
    expect(await locationHasPlanFeature({ from() { throw new Error('x') } }, 'loc-1', 'custom_email_domain')).toBe(false)
  })
})
```

(`fakePins` returns the rows the `location_plans` select at `plans.js:124-131` yields.) `src/lib/tenant-email.test.js`: "an org whose only pin is the add-on has the add-on" (mock `locationHasPlanFeature`).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** in `plans.js`:

```js
/**
 * W1.E1 — does ANY active pin (tier OR add-on) on this location grant `key`?
 * getLocationPlan() answers null without a tier pin, which made an add-on-only
 * pin invisible (the live Test Studio pin). This reads the pins directly and
 * ORs their features. Fail closed: false on any error.
 */
export async function locationHasPlanFeature(db, locationId, key) {
  try {
    const { data, error } = await db.from('location_plans')
      .select('active, version:plan_versions!plan_version_id(features, plan:plans!plan_id(kind))')
      .eq('location_id', locationId).eq('active', true)
    if (error) return false
    return (data || []).some((r) => r.version?.features?.[key] === true)
  } catch { return false }
}
```

`tenant-email.js` `orgHasEmailDomainAddon`: replace the `getLocationPlan` loop body with `if (await locationHasPlanFeature(db, loc.id, 'custom_email_domain')) return true`. Wizard: the owner step body gains `org_admin: true` (checkbox "Organisation admin (billing, email domain, API keys)" default checked; on submit, after `POST /api/staff` returns the profile id, `POST /api/staff/${id}/org-admin` with `{ organization_id }`; the route is master-only, which the wizard already is). Done-step link → `/admin/tenants/${orgId}` "Assign a plan".

- [ ] **Step 4: Run** `npx vitest run src/lib/plans.test.js src/lib/tenant-email.test.js src/lib/tenant-wizard.test.js src/app/api/settings/email-domain src/app/settings/email-domain` and `npm run check:select-columns` → PASS. PR ritual. Changelog: `W1.E1 — custom_email_domain gate honours add-on pins; wizard grants org_admin and links the pin page; env gate documented`.

Merge note (not a card — no customer-visible change): after merge, UN1T Group "has" the add-on through Test Studio's live pin, so `/settings/email-domain` becomes usable by master for UN1T Group as soon as P3 (`POSTMARK_ACCOUNT_TOKEN`) is set.

---

### Task W1.E2 ⚠️: Before a verified domain, every tenant email sends as "{Brand} <platform address>" with Reply-To = the location's address

**Why:** decision 2; Blocker 8 "refuse or clearly label 'sending as UN1T' instead of silently falling back"; review :139 From chain; the literal `'UN1T <hello@un1t.ie>'` at `postmark.js:275,394`, `email-inbox-send.js:155` and four direct senders.

**Files:**
- Modify: `src/lib/tenant-email.js:45-66,100-116` (`globalDefaultSender` → `platformSenderFor(db, locationId)`: `{ serverToken: null, fromEmail: POSTMARK_FROM_EMAIL, fromName: <brand>, replyTo: <location reply-to> }`), `src/lib/tenant-email.test.js`
- Modify: `src/lib/postmark.js:70-83,275,290,394,400,933-936` (apply `fromName` + `replyTo` from the resolver when there is NO tenant token; delete the literal), `src/lib/postmark.test.js`, `src/lib/postmark-tenant-send.test.js`
- Modify: `src/lib/campaign-sender.js:838-840` (the campaign's `from_name` stays the display name when set; the ADDRESS is the resolver's, never `campaign.from_email` pre-domain), `:871-873` (log what went on the wire), `src/lib/campaign-sender.test.js`
- Modify: `src/app/api/campaigns/[id]/send-test/route.js:136-150` (pass `locationId: campaign.location_id` so a test send matches a real one)
- Modify: `src/lib/email-inbox-send.js:154-156` (`fallbackFromAddress(locationId)` → `${brand} <${POSTMARK_FROM_EMAIL}>`), `src/lib/email-inbox-send.test.js`
- Modify: `src/lib/contractor-invoice-email.js:31`, `src/lib/xero/bills-email.js:47`, `src/lib/xero/contractor-bills.js:28`, `src/lib/xero/fte-expense-claims.js:35` (staff/supplier-facing: `${PLATFORM_NAME} <${POSTMARK_FROM_EMAIL}>`; throw-free: if the env is unset, log and send `POSTMARK_FROM_EMAIL` raw — `getPostmarkToken` already throws before this point when the server is unconfigured)
- Modify: `src/lib/sequences/steps.js:357-359` (sequence `from_name` → display name; address from the resolver)

- [ ] **Step 1: Failing tests** — `src/lib/tenant-email.test.js`:

```js
it('W1.E2 — with no live tenant row the sender is the platform address with the brand as display name and the location reply-to', async () => {
  vi.stubEnv('POSTMARK_FROM_EMAIL', 'hello@platform.test')
  const db = fakeDb({ locations: [{ id: 'loc-1', name: 'Gym A', organization_id: 'org-a', email: 'hi@gyma.ie' }], tenant_email_domains: [], company_settings: [], org_settings: [], email_mailboxes: [] })
  expect(await resolveEmailSender(db, 'loc-1')).toEqual({ serverToken: null, fromEmail: 'hello@platform.test', fromName: 'Gym A', replyTo: 'hi@gyma.ie' })
})
it('W1.E2 — the default mailbox beats locations.email for reply-to; a NULL location email yields replyTo null', async () => { /* two cases on email_mailboxes is_default / locations.email null */ })
it('W1.E2 — a LIVE tenant row still wins outright (its own from + server token), replyTo still the location', async () => { /* unchanged tenant path + replyTo */ })
```

`src/lib/postmark.test.js`: "sendEmail with locationId and no tenant token puts `Gym A <hello@platform.test>` and `ReplyTo: hi@gyma.ie` on the wire"; "sendEmail without locationId and without an explicit from uses `Repset <hello@platform.test>`"; "no code path produces the string `hello@un1t.ie`" (`expect(JSON.stringify(wire)).not.toContain('un1t.ie')`). `campaign-sender.test.js`: "a campaign with from_name 'Garrett at Gym A' sends `Garrett at Gym A <hello@platform.test>` pre-domain, never `campaign.from_email`".

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — `tenant-email.js`:

```js
import { getLocationBranding } from '@/lib/location-branding'
import { PLATFORM_NAME } from '@/lib/brand-name'
import { getLocationInboxReplyTo } from '@/lib/postmark-reply-to' // extract :856-898 of postmark.js into this module to avoid a cycle

export function globalDefaultSender() {
  return { serverToken: null, fromEmail: process.env.POSTMARK_FROM_EMAIL || null, fromName: PLATFORM_NAME, replyTo: null }
}

// W1.E2 — the PRE-DOMAIN sender: platform address, tenant display name,
// tenant reply-to. Nothing says UN1T.
async function platformSenderFor(db, locationId) {
  const [branding, replyTo] = await Promise.all([
    getLocationBranding(db, locationId),
    getLocationInboxReplyTo(db, locationId),   // default mailbox → locations.email_inbox_reply_to → locations.email
  ])
  return { serverToken: null, fromEmail: process.env.POSTMARK_FROM_EMAIL || null, fromName: branding.companyName || PLATFORM_NAME, replyTo: replyTo || null }
}
```

`resolveEmailSender`: `row ? { ...senderFromRow(row), replyTo } : await platformSenderFor(db, locationId)` (cache the whole object). `postmark.js` `resolveTenantOverride` returns `{ token, from, replyTo }` where `from` is `"${fromName} <${fromEmail}>"` whenever `fromEmail` is set (tenant token or not); `sendEmail` From = `tenant.from ? displayNameOverride(from, tenant.from) : (from || ${PLATFORM_NAME} <${POSTMARK_FROM_EMAIL}>)` — `displayNameOverride(explicitFrom, resolvedFrom)` keeps an explicit caller display name (campaign `from_name`) but ALWAYS uses the resolved address: parse `"Name <addr>"` → `"Name <resolvedAddr>"`. `ReplyTo = replyTo || tenant.replyTo || undefined`. `sendBatch` same per email. Delete `'UN1T <hello@un1t.ie>'`. `getLocationInboxReplyTo` gains the `locations.email` tier at the end.

- [ ] **Step 4: Run** `npx vitest run src/lib/tenant-email.test.js src/lib/postmark.test.js src/lib/postmark-tenant-send.test.js src/lib/campaign-sender.test.js src/lib/email-inbox-send.test.js src/lib/sequences/steps.test.js src/app/api/campaigns/\[id\]/send-test src/lib/contractor-invoice-email.test.js` and `npm run check:guardrails` → PASS. `git grep -n "hello@un1t.ie" src` → only comments. PR ritual. Changelog: `W1.E2 — pre-domain sends go out as "{Brand} <platform address>" with the location's reply-to; UN1T literal sender removed`.

⚠️ Card for Richard: today UN1T's transactional mail shows From "hello@un1t.ie" (no display name) and campaigns show the operator's From name; after merge every UN1T send shows `UN1T stillorgan <hello@un1t.ie>` / `UN1T Hatch Street <…>` (the configured company_settings names — **fix the lower-case "stillorgan" in `/settings/locations/[id]` branding first**) and Reply-To `stillorgan@un1t.com` / `hatchstreet@un1t.com` where no default mailbox exists. The address becomes `hello@repset.ie` only when P2 is done and `POSTMARK_FROM_EMAIL` is changed.

---

### Task W1.E3: A tenant Postmark server is born with its streams and webhooks

**Why:** Blocker 8 "register bounce/open/spam/subscription webhooks on the new server in `createTenantServer`"; review :140 "a tenant on its own server gets zero bounce/open/spam events". Campaign sends also need the `broadcast` stream.

**Files:**
- Modify: `src/lib/postmark-account.js:152-160` (+ new `ensureTenantServerStreams`, `ensureTenantServerWebhooks`), `src/lib/postmark-account.test.js`
- Modify: `src/lib/email-domain-service.js:120-168` (call both after the server is minted, idempotently, before marking `pending`→`verifying`), `src/lib/email-domain-service.read-errors.test.js`
- Modify: `src/app/api/settings/email-domain/route.js` (GET payload gains `webhooks_registered: boolean` from a new `tenant_email_domains.webhooks_registered_at`), `supabase/migrations/718_tenant_email_domains_webhooks.sql`

- [ ] **Step 1: Migration** `718_tenant_email_domains_webhooks.sql`:

```sql
-- 718 — W1.E3: record that a tenant server's streams + webhooks were registered.
alter table public.tenant_email_domains
  add column if not exists webhooks_registered_at timestamptz;
comment on column public.tenant_email_domains.webhooks_registered_at is
  'W1.E3 (mig 718) — set when the broadcast stream and the six-trigger webhooks on outbound+broadcast exist on the org''s Postmark server. NULL = provision again (idempotent).';
```

- [ ] **Step 2: Failing tests** `src/lib/postmark-account.test.js` (the file already stubs `fetch`):

```js
describe('W1.E3 tenant server streams + webhooks', () => {
  it('creates the broadcast stream when the server has only outbound/inbound', async () => {
    fetchMock.get('/message-streams', { MessageStreams: [{ ID: 'outbound' }, { ID: 'inbound' }] })
    await ensureTenantServerStreams('tok')
    expect(fetchMock.posted('/message-streams')).toEqual({ ID: 'broadcast', Name: 'Broadcasts', MessageStreamType: 'Broadcasts', SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Custom' } })
  })
  it('registers one six-trigger webhook per stream, with the X-Webhook-Token header, skipping ones that exist', async () => {
    vi.stubEnv('POSTMARK_WEBHOOK_TOKEN', 'wh-secret'); vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.repset.ie')
    fetchMock.get('/webhooks', { Webhooks: [{ Url: 'https://crm.repset.ie/api/webhooks/postmark', MessageStream: 'outbound' }] })
    await ensureTenantServerWebhooks('tok')
    const posted = fetchMock.postedAll('/webhooks')
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ Url: 'https://crm.repset.ie/api/webhooks/postmark', MessageStream: 'broadcast',
      HttpHeaders: [{ Name: 'X-Webhook-Token', Value: 'wh-secret' }],
      Triggers: { Open: { Enabled: true, PostFirstOpenOnly: false }, Click: { Enabled: true }, Delivery: { Enabled: true }, Bounce: { Enabled: true, IncludeContent: false }, SpamComplaint: { Enabled: true, IncludeContent: false }, SubscriptionChange: { Enabled: true } } })
  })
  it('both calls use the SERVER token header, never the account token', async () => { /* assert X-Postmark-Server-Token */ })
})
```

- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** in `postmark-account.js`:

```js
// W1.E3 — a bare server has only outbound+inbound streams and no webhooks:
// every campaign (MessageStream 'broadcast', postmark.js sendBatch) would be
// refused (ErrorCode 1235) and list health, bounce escalation and stats would
// read 0 for the tenant. Both helpers are idempotent (list first, create the
// missing) and use the SERVER token.
const WEBHOOK_TRIGGERS = Object.freeze({
  Open: { Enabled: true, PostFirstOpenOnly: false }, Click: { Enabled: true }, Delivery: { Enabled: true },
  Bounce: { Enabled: true, IncludeContent: false }, SpamComplaint: { Enabled: true, IncludeContent: false }, SubscriptionChange: { Enabled: true },
})
const WEBHOOK_STREAMS = ['outbound', 'broadcast']

function serverFetch(serverToken, path, init = {}) {
  return fetch(`https://api.postmarkapp.com${path}`, { ...init,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': serverToken, ...(init.headers || {}) } })
}

export async function ensureTenantServerStreams(serverToken) {
  const res = await serverFetch(serverToken, '/message-streams?includeArchivedStreams=false')
  const existing = ((await res.json()).MessageStreams || []).map((s) => s.ID)
  if (existing.includes('broadcast')) return { created: false }
  const create = await serverFetch(serverToken, '/message-streams', { method: 'POST', body: JSON.stringify({
    ID: 'broadcast', Name: 'Broadcasts', MessageStreamType: 'Broadcasts',
    SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Custom' } }) })
  if (!create.ok) throw new Error(`postmark message-streams: ${create.status}`)
  return { created: true }
}

export async function ensureTenantServerWebhooks(serverToken) {
  const url = `${getAppUrl()}/api/webhooks/postmark`
  const token = process.env.POSTMARK_WEBHOOK_TOKEN
  if (!token) throw new Error('POSTMARK_WEBHOOK_TOKEN is not set')
  const res = await serverFetch(serverToken, '/webhooks')
  const existing = (await res.json()).Webhooks || []
  const created = []
  for (const stream of WEBHOOK_STREAMS) {
    if (existing.some((w) => w.Url === url && w.MessageStream === stream)) continue
    const create = await serverFetch(serverToken, '/webhooks', { method: 'POST', body: JSON.stringify({
      Url: url, MessageStream: stream, HttpAuth: null, HttpHeaders: [{ Name: 'X-Webhook-Token', Value: token }], Triggers: WEBHOOK_TRIGGERS }) })
    if (!create.ok) throw new Error(`postmark webhooks (${stream}): ${create.status}`)
    created.push(stream)
  }
  return { created }
}
```

(The six triggers and the `X-Webhook-Token` header are exactly what the global server carries — Live facts, `docs/domain-migration-stage3.md:418-424`; the receiver checks that header, `src/app/api/webhooks/postmark/route.js:42-59`.) In `email-domain-service.js` `provisionEmailDomain`, after the server token is persisted (:130-142): `await ensureTenantServerStreams(token); await ensureTenantServerWebhooks(token); update webhooks_registered_at = now()` inside its own try — a failure here records `last_error` and leaves `webhooks_registered_at` NULL so the next provision call retries; it does NOT block domain creation. The GET route exposes `webhooks_registered`.

- [ ] **Step 5: Run** `npx vitest run src/lib/postmark-account.test.js src/lib/email-domain-service.read-errors.test.js src/app/api/settings/email-domain` and `npm run check:select-columns` → PASS. Apply mig 718 BEFORE merge. PR ritual. Changelog: `W1.E3 — tenant Postmark servers are created with the broadcast stream and the six-trigger webhooks (mig 718)`.

---

### Task W1.E4: Suppression sync and consent drift run per Postmark server

**Why:** review :140 "suppression sync and consent drift use the global token only (`postmark-suppressions.js:79,162,195`)"; Blocker 8 "run suppression sync per server".

**Files:**
- Modify: `src/lib/postmark-suppressions.js:79-92,162,195,263` (every exported function takes `{ serverToken }`; the header builder uses it or the global), `src/lib/postmark-suppressions.test.js`
- Create: `src/lib/postmark-server-for-location.js` (`serverTokenForLocation(db, locationId)` → the org's LIVE `tenant_email_domains.postmark_server_token` or null = global; 60 s cache like tenant-email), `src/lib/postmark-server-for-location.test.js`
- Modify the 7 callers: `src/app/api/unsubscribe/[token]/route.js:7`, `src/app/api/preferences/[token]/route.js:9`, `src/app/api/unsubscribe/host/[token]/route.js:22`, `src/app/unsubscribe/host/[token]/page.js:19`, `src/app/api/public/host-list/[slug]/subscribe/route.js:46`, `src/lib/marketing-consent.js:232` (each has the contact's `location_id` in scope; host ones use the host anchor location), and `src/app/api/cron/consent-drift-check/route.js:35` (iterate the global server PLUS every live tenant server: `select organization_id, postmark_server_token from tenant_email_domains where status='live'`)

- [ ] **Step 1: Failing tests** `postmark-suppressions.test.js`: "`addSuppression({ serverToken: 'tenant-tok' })` sends `X-Postmark-Server-Token: tenant-tok`; with no serverToken the global token is used (unchanged)". `postmark-server-for-location.test.js`: live row → token; no row / not live / error → null.
- [ ] **Step 2–4:** run → FAIL → implement → PASS; `npx vitest run src/lib/postmark-suppressions.test.js src/lib/postmark-server-for-location.test.js src/app/api/unsubscribe src/app/api/preferences src/lib/marketing-consent.test.js src/app/api/cron/consent-drift-check`. `npm run check:route-guards` (cron unchanged). PR ritual. Changelog: `W1.E4 — suppression sync and consent drift per Postmark server`.

---

## Track W — Seeded settings on creation (decision 6; review theme A "seed `company_settings`, `notification_config`, quiet hours", :99)

Research facts (HEAD e33e786b):
- ONE hook point: `seedLocationDefaults(db, location)` in `src/lib/location-seed.js:159-181`; its only caller is `POST /api/locations` (`src/app/api/locations/route.js:111-112`), which serves both the wizard (`TenantWizard.jsx:184`) and `LocationForm.jsx:141`. It seeds the acquisition pipeline + 11 stages + bundle flags, nothing else. Idempotent by design (:148-155).
- `company_settings`: `location_id NOT NULL UNIQUE` (mig 013:10); quiet hours are NOT NULL DEFAULT columns (mig 514:60-63: enabled true, start 21, end 8) — an INSERT of `{ location_id, company_name }` is valid and IS the quiet-hours seed. No `reply_to`/`from_name` column.
- `notification_config` is a nullable jsonb COLUMN on `locations` (mig 170:22-30); NULL = code defaults; `DEFAULT_NOTIFICATION_CONFIG` (`src/lib/notification-config.js:31-47`) is `{ categories: { tasks: { lead_times_minutes: [60, 1440] }, bookings: { lead_times_minutes: [60, 1440], notify_roles: ['owner','manager','head_coach'] } } }`. `validateConfig` drops unknown categories (:225-226), so seed EXACTLY that shape.
- Host-anchor locations (`src/lib/host-events.js:137-141`, `is_host_anchor: true`) are inserted without the seed and must stay that way.
- The wizard's branding step writes `org_settings` (`PUT /api/settings/org-branding`), not `company_settings`; seeding `company_settings.company_name = location.name` makes the LOCATION name the brand at that location, and the org name fills logo/favicon only — consistent with the brand chain of decision 3.
- `src/lib/location-seed.test.js:63-111` uses a table-routing `stubDb` that THROWS on an unexpected table: the new writes need the stub extended. `makeFakeDb` (`src/lib/api-auth.test-helpers.js:20`) has no `upsert`.

### Task W1.W1: Creating a location seeds `company_settings` (name, logo null, quiet hours) and `notification_config`

**Files:**
- Modify: `src/lib/location-seed.js:159-181`, `src/lib/location-seed.test.js:63-111,55-259`
- Modify: `src/lib/notification-config.js` (export `DEFAULT_NOTIFICATION_CONFIG` is already exported; no change) — import it in the seed
- Create: `src/app/api/locations/route.test.js` (none exists; Style A, master user; asserts the route calls the seed with the created row and that a seed failure returns the 500-with-row shape at `route.js:113-123`)

- [ ] **Step 1: Failing tests** — in `src/lib/location-seed.test.js` extend `stubDb` with `company_settings` (recording `upsert` calls) and `locations.update` capturing `notification_config`, then:

```js
it('W1.W1 — seeds company_settings with the location name, no logo, and the schema quiet-hours defaults', async () => {
  const db = stubDb()
  await seedLocationDefaults(db, { id: 'loc-1', name: 'Gym A North', features: {} })
  expect(db.upserts.company_settings).toEqual([[{ location_id: 'loc-1', company_name: 'Gym A North', logo_url: null, favicon_url: null }, { onConflict: 'location_id', ignoreDuplicates: true }]])
})
it('W1.W1 — seeds locations.notification_config with exactly DEFAULT_NOTIFICATION_CONFIG when it is null', async () => {
  const db = stubDb({ locations: [{ id: 'loc-1', notification_config: null }] })
  await seedLocationDefaults(db, { id: 'loc-1', name: 'Gym A North', features: {} })
  expect(db.updates.locations.find((u) => 'notification_config' in u.patch).patch.notification_config).toEqual(DEFAULT_NOTIFICATION_CONFIG)
})
it('W1.W1 — re-running never overwrites an operator\'s branding or notification config', async () => {
  const db = stubDb({ company_settings: [{ location_id: 'loc-1', company_name: 'Renamed' }], locations: [{ id: 'loc-1', notification_config: { categories: {} } }] })
  await seedLocationDefaults(db, { id: 'loc-1', name: 'Gym A North', features: {} })
  expect(db.upserts.company_settings[0][1]).toMatchObject({ ignoreDuplicates: true })
  expect(db.updates.locations.some((u) => 'notification_config' in u.patch)).toBe(false)
})
it('W1.W1 — a host-anchor location is not seeded with settings', async () => {
  const db = stubDb()
  await seedLocationDefaults(db, { id: 'loc-h', name: 'PTC (host events)', is_host_anchor: true, features: {} })
  expect(db.upserts.company_settings).toEqual([])
})
```

- [ ] **Step 2: Run** `npx vitest run src/lib/location-seed.test.js` → FAIL. **Step 3: Implement** — append to `seedLocationDefaults` after the features write:

```js
  // W1.W1 — settings rows a tenant location is born with. Both idempotent:
  // the company_settings upsert ignores an existing row (an operator's
  // branding is never overwritten), and notification_config is written only
  // while NULL (NULL already means "code defaults"; the explicit copy makes
  // the settings page show real values instead of an empty form).
  if (!location.is_host_anchor) {
    const { error: csErr } = await db.from('company_settings').upsert(
      { location_id: location.id, company_name: (location.name || '').trim() || null, logo_url: null, favicon_url: null },
      { onConflict: 'location_id', ignoreDuplicates: true })
    if (csErr) throw new Error(`seedLocationDefaults: company_settings seed failed: ${csErr.message}`)

    const { data: cur, error: curErr } = await db.from('locations').select('notification_config').eq('id', location.id).maybeSingle()
    if (curErr) throw new Error(`seedLocationDefaults: notification_config read failed: ${curErr.message}`)
    if (!cur?.notification_config) {
      const { error: ncErr } = await db.from('locations').update({ notification_config: DEFAULT_NOTIFICATION_CONFIG }).eq('id', location.id)
      if (ncErr) throw new Error(`seedLocationDefaults: notification_config seed failed: ${ncErr.message}`)
    }
  }
```

(`import { DEFAULT_NOTIFICATION_CONFIG } from './notification-config'`; the route passes the created row, which has `name` and `is_host_anchor` from the insert's `.select()` — confirm the select at `route.js:80-98` returns them, add if not.) Quiet hours need no explicit value: mig 514's defaults (21→8, enabled) apply on the insert.

- [ ] **Step 4: Run** `npx vitest run src/lib/location-seed.test.js src/app/api/locations/route.test.js` and `npm run check:select-columns && npm run check:guardrails` → PASS. PR ritual. Changelog: `W1.W1 — a new location is born with company_settings (name, quiet hours) and notification_config`.

No backfill of the four existing rows without `company_settings` (Test Studio, CCF, SourceIt, PTC): the brand chain (W1.B1) already falls through to `locations.name` for them.

---


---

## Track S — The literal sweep (decision 5; review theme B). Eight mechanical PRs driven by Appendix A–D.

**How every sweep PR is test-first.** Each PR starts by extending the guard `tests/un1t-literal-sweep.test.js` (created in W1.S1a) with the files it sweeps; the guard fails until the files are clean. The guard greps the listed files for `UN1T` outside comments and outside the `KEEP` allowlist (Appendix rows marked `keep`), so a later PR cannot reintroduce a literal into a swept file. Existing tests that PIN the old strings (`src/lib/event-email.test.js:64,94,101,231,267`, `src/lib/contracts-email.test.js:72-78`, `src/lib/hr-post-class-email.test.js:85,106,230-232`, `src/lib/customer-notifications.test.js:35,42` + its `shared/` twin, `src/lib/challenge-notifications.test.js:6,30`, `src/lib/agent/prompt.test.js:413-415`, `src/lib/whatsapp-template-components.test.js:119-129`, `src/app/login/page.test.jsx`, `src/app/tv/live/[token]/page.test.jsx`) are updated in the PR that sweeps their module, to assert the resolved brand instead.

```js
// tests/un1t-literal-sweep.test.js (W1.S1a creates; every later sweep PR appends to SWEPT and KEEP)
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs' // node ≥22; else fast-glob already in devDeps
const SWEPT = [ /* files listed per PR below */ ]
const KEEP = { 'src/app/offers/page.js': ['UN1T GIFT CARDS', 'A UN1T gift card', 'UN1T STILLORGAN'] /* … Appendix keep rows … */ }
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
describe('UN1T literal sweep (W1.S*)', () => {
  it.each(SWEPT)('%s carries no customer/staff-visible UN1T literal', (file) => {
    const src = stripComments(readFileSync(file, 'utf8'))
    const allowed = KEEP[file] || []
    const stripped = allowed.reduce((s, lit) => s.split(lit).join(''), src)
    expect(stripped).not.toMatch(/UN1T/)
  })
})
```

**Replacement rules (one line each, as used in the appendix):**
- `brand(loc)` → `const { companyName } = await getLocationBranding(db, locationId)` (server) or the `brand` prop/payload (client); `productName(shortName, 'points'|'hr')` for product names; `pointsUnit(shortName)` for the unit badge.
- `platform('Repset')` → `PLATFORM_NAME` from `shared/brand-name.js` (staff CRM chrome, platform money rails, "the CRM").
- `locationName` → `locations.name` already in scope (`{{location_name}}`, `studio_name`, hyrox `locationLabel`).
- `legalEntity(org)` → `org_settings.legal_trading_name || legal_entity_name` via `getContractingEntity` (`src/lib/contracting-entity.js`).
- `drop` → delete the fallback (the resolver now always answers) or the word.
- `keep` → UN1T-specific by design: legal pages (UN1T's own entity; tenant hosts already get `TenantPrivacyNotice`), `/start`, `/free-class`, `/offers` (pinned by W0.4), the `un1t-marketing`/`un1t-hosts` brand descriptions, master-only "UN1T studio customisation" toggles, `LEGACY_COUNTERSIGNATURE_ENTITY`, `wallet-topup.js:62` (the platform IS the seller), `CookieConsent.jsx:301` (only on `un1tdublin.com`).
- `meta-template (Richard)` → none needed (Live facts: the 19 UN1T templates are Stillorgan's own rows).

**[NS] sites** (no location/org in scope) are resolved per the appendix's "Sites with no locationId/orgId in scope" list: module constants become functions of `brand`; pure renderers gain a `brand` argument; static `metadata` becomes `generateMetadata` (token → location, or host → org via W1.L4's resolver); client components fed by a slug/token get `brand` in the API payload they already fetch.

### Task W1.S1a ⚠️: Customer-facing email, ICS and message libs

**Files (Appendix A rows for):** `src/lib/event-email.js:128,130,206` (+`buildEventEmailShell({ brand })`, `resolveEventEmail` resolves it from `race.location_id`), `src/lib/hr-post-class-email.js:261-448` (+`brand`/`shortName` through `pickSubject`/`renderText`/`renderHtml`), `src/lib/race-confirmations.js:192,364,636,790`, `src/lib/offer-purchase-emails.js:116,168`, `src/lib/manual-booking-confirm.js:44`, `src/lib/class-booking-payments.js:28`, `src/lib/contract-pdf.js:314`, `src/lib/contracting-entity.js:48`, `src/lib/contracts-email.js:69,89,109,113,248` (recipient copy; `contract.location_id` in scope), `src/lib/contracts-notify.js:56-57`, `src/app/api/contracts/[id]/resend/route.js:75-76`, `src/lib/external-export.js:250,253`, `src/lib/strava.js:103`, `src/lib/tcx-builder.js:45`, `src/app/api/cron/auto-end-stale-hr-sessions/route.js:183`, `src/lib/challenge-notifications.js:3`, `src/lib/customer-notifications.js:20` (twin of `shared/` — swept together with W1.S4; this PR only if S4 has merged, else leave to S4), `src/lib/sequence-templates.js` (21 rows: the 16 `UN1T {{location_name}}` sign-offs → `{{location_name}}`; the brand rows → a NEW merge tag `{{company_name}}`), `src/lib/postmark.js:491` `applyMergeTags` + `src/lib/sequences/steps.js:198,328-330` + `src/lib/campaign-sender.js:782,832` (add `company_name` to the merge context from `getLocationBranding`; merge tags are lowercase per the memory rule), `src/lib/status-page.js:32`.

- [ ] **Step 1:** create `tests/un1t-literal-sweep.test.js` with these files in `SWEPT` → run → FAIL. Also add to `src/lib/sequences/steps.test.js`: "`{{company_name}}` renders the location brand" and to `src/lib/event-email.test.js`: "the header wordmark and footer carry the brand" (replace the five UN1T pins).
- [ ] **Step 2:** sweep per the rules. **Step 3:** `npx vitest run tests/un1t-literal-sweep.test.js src/lib/event-email.test.js src/lib/hr-post-class-email.test.js src/lib/race-confirmations.test.js src/lib/contracts-email.test.js src/lib/sequence-templates.test.js src/lib/sequences/steps.test.js src/lib/postmark.test.js` → PASS; `npm run check:guardrails`. PR ritual. Changelog: `W1.S1a — customer email, ICS and message libs carry the tenant brand; {{company_name}} merge tag`.

⚠️ Card: UN1T's event emails, post-class emails and contracts switch their wordmark from "UN1T" to the configured brand of the sending location ("UN1T stillorgan" today — fix the casing in `/settings/locations/[id]` → Branding before merge, or set both studios' `company_name` to "UN1T" to keep the bare wordmark). "UN1T Points"/"UN1T HR" stay exactly as they are once `org_settings.short_name = 'UN1T'` (W1.B1's data step).

### Task W1.S1b ⚠️: Public pages, widgets, landing pages and TV boards

**Files:** `src/components/BookingWidget.jsx:299,557` (+`brand` in `/api/public/bookings/[slug]` payload), `src/components/RaceSignupWidget.jsx:64-142,788,1051,1124` (KIND copy table → `kindCopy(brand)`; `race.organization_name` already in the payload), `src/components/RaceConfirmedPage.jsx:248` (+ the ICS rows handled in W1.L5), `src/components/PreferenceCentre.jsx:147,219` + `src/app/api/preferences/[token]/route.js:125` (org brand via the token's contact → location → `getOrgBrandName`), `src/components/UnsubscribePage.jsx:179`, `src/app/api/preferences/hr-emails/route.js:356`, `src/components/WaitlistWidget.jsx:90`, `src/components/EventWaitlistForm.jsx:112`, `src/components/landing-page/BlockRenderers.jsx:184,340,457,855,897,966,976,980,1004` (SiteHeader/SiteFooter/LeadFormBlock gain `brand` + `locations` props from the page's existing location load; the two studio footer links become the org's active locations), `src/components/landing-page/EditModeOverlay.jsx:44,80`, `src/lib/landing-page-blocks.js:137,190,215` (defaults become functions of `brand`), `src/components/LandingPageSettingsForm.jsx:376,391-392,769`, `src/components/ClassFunnel.jsx:38-42` (DEFAULTS → functions of `brand`/`locationName`; closes the "leaks onto every tenant" note), `src/app/welcome/[location]/page.js:56,60,70,110,129`, `src/app/welcome/[location]/events/page.js:57,58,67,82,87`, `src/app/welcome/[location]/status/page.js:36`, `src/app/start/[path]/page.js:63,64,93`, `src/app/event/[slug]/page.js:46,51,58` (+ `location_id` in its select), `src/app/embed/event/[slug]/page.js:40,45`, `src/app/api/public/events/[slug]/register/route.js:559`, `src/app/api/public/races/[slug]/register/route.js:293`, `src/app/(members)/challenges/page.js:21`, `src/app/tv/cast/[token]/TVDisplay.jsx:235`, `src/app/tv/cast/[token]/page.js:19`, `src/app/tv/layout.js:20`, `src/app/tv/live/[token]/LiveTvClient.jsx:560,671` (+ `brand` in the tv-live payload: `src/app/api/public/tv-live/[token]/route.js`), `src/app/tv/live/[token]/challenges/ChallengeTvClient.jsx:57`, `src/app/(operations)/tv-displays/TVAdmin.jsx:325`, `src/components/CookieConsent.jsx` (no change — keep).

- [ ] Steps as S1a (extend `SWEPT`/`KEEP`; update `src/app/tv/live/[token]/page.test.jsx`, `src/app/tv/live/[token]/challenges/page.test.jsx`, `src/components/BookingWidget.test.jsx`, `src/components/RaceSignupWidget.test.jsx`, `src/components/PreferenceCentre.test.jsx` where they exist). `npm run build` locally (page metadata exports change shape). Changelog: `W1.S1b — public pages, widgets, landing pages and TV boards carry the tenant brand`.

⚠️ Card: the TV boards' "UN1T" wordmark (`tv/layout.js:1-4` records CHROME.1's "locked product decision") becomes the location's configured brand — identical output for UN1T if `company_settings.company_name` is "UN1T"; otherwise the card asks which.

### Task W1.S1c: Host portal and host emails

**Files:** `src/app/host/(portal)/layout.js:28`, `src/app/host/(portal)/page.js:110`, `src/app/host/(portal)/events/new/page.js:20`, `src/app/host/(portal)/events/[id]/edit/page.js:70`, `src/app/host/login/page.js:40,72`, `src/app/host/set-password/page.js:100` (pre-auth: host → org via W1.L4's `resolveTenantOrgId`, platform name on the CRM host), `src/components/HostConnect.jsx:104,156` (+`brand` in `/api/public/host-connect/[token]` payload), `src/components/host/HostEmailReport.jsx:295`, `src/components/host/HostEventActions.jsx:19`, `src/components/host/HostEventForm.jsx:273,527`, `src/lib/host-onboarding-email.js:29,33,37,52` (`renderHostOnboardingEmail({ hostName, url, brand })`; the `send*` wrapper has `host` → anchor location → org brand), `src/lib/host-campaign-launch.js:65-66`, `src/app/api/host/emails/[id]/send-test/route.js:84,93`, `src/app/api/host/events/[id]/route.js:146`, `src/lib/host-statements.js:59` (platform), `src/app/api/hosts/[id]/invite/route.js:89`, `src/app/api/hosts/[id]/link-staff/route.js:72`, `src/app/api/hosts/[id]/route.js:52`.

- [ ] Steps as S1a. Tests: `src/lib/host-onboarding-email.test.js`, `src/lib/host-campaign-launch.test.js`, `src/components/HostConnect.test.jsx` if present. Changelog: `W1.S1c — host portal and host emails carry the organisation brand`.

### Task W1.S2: Staff-facing web chrome and staff emails

**Files (platform rows + staff brand rows):** `src/app/login/page.js:238`, `src/app/reset-password/page.js:169,250`, `src/components/Sidebar.jsx:365`, `src/components/AppShell.jsx:164`, `src/app/api/email/conversations/_gone.js:40`, `src/lib/roster-email.js:133`, `src/lib/glofox-notes.js:14-15`, `src/lib/xero/bills-email.js:138`, `src/lib/xero/contractor-bills.js:124`, `src/lib/xero/fte-expense-claims.js:183`, `src/lib/zoom/external-contacts.js:29`, `src/lib/openapi.js:329,8287`, `src/components/WidgetTokensCard.jsx:91`, `src/components/accounting/EventFeesCard.jsx:41`, `src/app/settings/hosts/page.jsx:39`, `src/components/settings/HostsManager.jsx:135,166`, `src/components/settings/HostDetail.jsx:189,816,903,1037,1105,1203,1271,1312`, `src/components/settings/integrations/PaymentsIntegrationTab.jsx:115,138`, `src/components/RaceEventForm.jsx:1073,1081,1092,1101,1105,1136,1384`, `src/components/RaceControlPanel.jsx:271,290`, `src/components/ContractSignForm.jsx:96`, `src/components/ContractTemplateForm.jsx:59,63,64,150`, `src/components/PendingContractsAlert.jsx:114-115`, `src/app/account/page.js:125`, `src/app/account/contracts/page.js:63`, `src/components/CampaignDetail.jsx:621`, `src/components/CampaignEditor.jsx:39,1140` (default `from_name` → the location brand, loaded from `/api/public/branding?location_id=`), `src/components/BrandingSettings.jsx:159`, `src/components/OrgBrandingSettings.jsx:89`, `src/components/LocationForm.jsx:219`, `src/components/AddOrganizationButton.jsx:118`, `src/components/AchievementsAdminTable.jsx:29`, `src/components/ChallengeForm.jsx:23`, `src/app/settings/scoring/ScoringClient.jsx:114`, `src/lib/settings-tree.js:246`, `src/components/settings/StatusPageSettingsForm.jsx:146`, `src/lib/wallet-topup.js:400`, `src/lib/contractor-invoice-email.js:87`.

- [ ] Steps as S1a; `src/app/login/page.test.jsx` asserts "Repset" when no branding. Changelog: `W1.S2 — staff chrome says Repset; staff copy names the tenant brand`.

Note: "UN1T (settles via Revolut)" money-rail rows are `platform('Repset')` today because the rail IS the platform's; Wave 2 flips them to the org's own rail wording.

### Task W1.S3: Mia, WhatsApp merge, assistant and hyrox prompts

**Files:** `src/lib/agent/core.js:11` (`defaultHoldingMessage(brand)`; `auto-reply.js:1250,1404` pass the branding they already resolve at :475), `src/lib/agent/welcome-greeting.js:13` (`defaultWelcomeGreeting({ agentName, brand })`; `locationId` and `settings` are in scope at :35-36 — also fixes the review's "welcome greeting ignores `agent_name`"), `src/lib/agent/prompt.js:264-265` (drop `|| 'UN1T'`), `src/lib/agent/approval-suggest.js:123`, `src/lib/agent/followups.js:369`, `src/lib/churn-winback.js:5` (done in B1 — verify), `src/lib/whatsapp.js:1967` (`location_name` → `opts.companyName || opts.locationName` — pass `locationName` from the callers at `whatsapp.js:1373,1745` and `sequences/steps.js:529,606`; and add a `company_name` WhatsApp merge field alongside, so email and WhatsApp agree), `src/app/settings/customer-agent/CustomerAgentClient.jsx:462,506,603` (placeholders render the brand), `src/lib/assistant-prompt.js:56`, `src/lib/hyrox/prompt.js:12,23,48`, `src/lib/hyrox/expand-runner.js:33`, `src/lib/hyrox/generate-block.js:44`, `src/app/api/hyrox/blocks/[id]/expand/route.js:57`, `src/app/api/hyrox/sessions/[id]/regenerate/route.js:64`. `prompt.js:77-85` ("the Glofox app") is handled by W1.M3b.

- [ ] Steps as S1a; update `src/lib/agent/prompt.test.js:413-415`, `welcome-greeting.test.js`, `core.test.js`, `src/lib/whatsapp-template-components.test.js:119-129`, `src/lib/hyrox/prompt.test.js`. Changelog: `W1.S3 — Mia, WhatsApp merge fields and hyrox prompts speak the tenant brand`.

Mia talks to UN1T customers live (Stillorgan, Sonnet 5): the resolved brand for Stillorgan is its configured `company_settings.company_name` — the same value the prompt already receives today via `getLocationBranding` (only the fallback changes). Not a card.

### Task W1.S4: `shared/` seam (and its `src/lib` twins)

**Files:** `shared/customer-notifications.js:20` + `src/lib/customer-notifications.js:20` (identical twins; both `.test.js` copies), `shared/hr-analytics.js:198,214` + `src/lib/hr-analytics.js:198,214` (identical twins), `shared/goals.js:23,37` + `src/lib/goals.js:42,56` (`diverged` mode: edit both or add `GOAL_DEFS` to the drifted list — edit both), `shared/challenge-wrapped.js:20`, `shared/session-history.js:164,175`, `shared/permissions.js:734` (hint → "Notify when your studio issues you a contract…"). Every one becomes a function of `brand`/`shortName`: `pointsPhrase(n, shortName)`, `pickHighlight(stats, { shortName })`, `GOAL_DEFS(shortName)`, `METRIC_LABEL(shortName)`, `milestones(shortName, brand)`. Web callers pass the branding they resolve; phone callers pass `useBrand()` (W1.B2); champ-app mirrors in W1.S6.

- [ ] Steps as S1a; `npx vitest run tests/shared-pair-sync.test.js shared src/lib/customer-notifications.test.js src/lib/hr-analytics.test.js src/lib/goals.test.js`; `npm run check:mobile-imports`. **Merging publishes an OTA on the staff lane** (`shared/**`; P6). Changelog: `W1.S4 — shared seam product names and milestones take the brand`.

### Task W1.S5: `mobile/` screens (34 rows, Appendix B) + login placeholder

Depends on W1.B2 (`useBrand`) and W1.S4 (shared signatures). Files: the 32 bundled rows in Appendix B plus `mobile/app/(staff)/(auth)/login.jsx:131`. Mechanical: `const { companyName, shortName, productNames } = useBrand()`; the two `metricLabel === 'UN1T Points'` comparisons become key comparisons (`metric === 'points'`).

- [ ] Steps: extend the guard's `SWEPT` with the mobile files (the guard runs under the root vitest config; mobile files are plain JS to read) → FAIL → sweep → `npm run check:mobile-imports && npm run check:mobile-lint && npx vitest run tests/un1t-literal-sweep.test.js mobile/lib/brand.test.js` → PASS. Merging publishes an OTA (P6). The 6 store-copy rows (`mobile/docs/*`) are Richard's App Store Connect edits, listed in the PR body, not code. Changelog: `W1.S5 — phone screens take the tenant brand (OTA)`.

🔴 Reach note (memory `staff-home-screen-widgets`): the staff fleet is frozen on runtime 2.3.x until the 2.4.0 binaries install; `runtimeVersion` is already `'2.4.0'` in `app.config.js:457`, so this OTA reaches installed devices only after 2.4.0 ships. Merge anyway (it is correct on the new lane); say so in the PR body.

### Task W1.S6: champ-app (36 rows, Appendix D; repo `/Users/richardivers/code/champ-app`)

Depends on W1.S4 (mirror the four shared modules byte-for-byte per the CLAUDE.md mirror rule: `customer-notifications`, `hr-analytics`, `goals`, `challenge-wrapped`, `session-history`) and W1.B2's `src/lib/load-brand.js`. Files: Appendix D. `TopBar` gains a `brand` prop from the layout (which loads the signed-in member's contact → location); `layout.jsx:13-14` and `login/page.jsx:58` render `PLATFORM_NAME` pre-sign-in (no org is known on `app.champfitness.ie`; it is UN1T's host by configuration, so Richard may prefer `EXPO_PUBLIC_BRAND_NAME=UN1T` as the pre-sign-in default — offer it in the PR body as an env, default "Repset"); the two `metricLabel === 'UN1T Points'` compares become key compares; `share/[token]` resolves brand from the card's contact location (add `location_id` to `load-share-card.js:14`).

- [ ] Steps: in `champ-app-w1-sweep` worktree, create `tests/un1t-literal-sweep.test.js` (same guard) → FAIL → sweep → `npx vitest run tests/un1t-literal-sweep.test.js shared src/lib/load-brand.test.js` → PASS → `npm run build`. Vercel auto-deploys champ-app's `main` (web only, no OTA). Changelog row in the PR body. ⚠️ Card only for the pre-sign-in default ("Repset" vs env "UN1T").

**Not swept (and why):** the 62 `keep` rows (legal pages, the pinned funnel, platform money-rail copy, master-only toggles); the lowercase hostname/mailto literals (`un1tdublin.com`, `hello@un1tdublin.com`, `you@un1t.ie` placeholders, Meta CAPI source URLs at `src/app/api/public/leads/route.js:109-110`, `src/app/api/public/book/route.js:225`, `src/app/api/public/offers/[slug]/checkout/route.js:66`, `Sidebar.jsx:471`) — a second inventory `git grep -n -i "un1tdublin\.com\|un1t\.ie" src` is a Wave 3 item once the funnel is per-tenant; `src/app/terms/page.js` needs a tenant variant like `TenantPrivacyNotice` (Wave 3, legal copy is Richard's).

---

## Track M — Membership seam (decision 7; review theme E, §2 "Members hub" :126, §1 "Glofox is the only membership source"). Independent of Tracks B/E/L/S; runs in parallel.

Research facts (HEAD e33e786b):
- There is NO single "is Glofox connected" helper; five disagreeing tests exist: (a) registry-first `glofoxCredentialsForLocation` + `missingGlofoxCredentialsForLocation(creds).length === 0` (`src/lib/glofox.js:377,455`; the runtime paths and Mia); (b) legacy-slice containment `.filter('settings','cs',{glofox:{}})` + all three credentials in FIVE crons (`glofox-sync/route.js:52-66`, `glofox-attendance-refresh:72-81`, `glofox-detail-backfill:83-92`, `sync-class-occurrences:34-41`, `notify-onboarding-pace:66-74`); (c) `glofoxConnected(location)` legacy-only pure (`src/lib/automations/registry.js:47-51`, used by the automations cards); (d) `Boolean(location.settings?.glofox)` (`src/lib/account-home.js:232`, so CCF Autos' empty slice reads "connected"); (e) `settings?.glofox?.api_key` (`src/components/settings/LocationIntegrations.jsx:81`). Plus the studio dashboard's data inference (`src/app/dashboard/studio/page.js:106-110`) and the one real empty state `LocationEmptyState` (`src/components/dashboard/StudioScorecard.jsx:119-127`).
- The registry: `channel_connections` with `platform='glofox'` (migs 230, 418, 419), read via `src/lib/connection-registry.js` (`readGlofoxConfig` :384, registry-first then legacy). Dual-write at `src/app/api/locations/[id]/integrations/[provider]/route.js:295-306` (`syncConnectionFromLegacy`).
- Live: `settings.glofox` exists on Stillorgan (branch id set), Hatch (branch id NULL) and CCF Autos (NULL); only Stillorgan is a real connection.
- `locations` is column-granted (mig 648); a new column must `GRANT SELECT (col)` or state `-- column-grant: withheld locations.<col>` in its migration AND be added to `tests/helpers/credential-column-grants.js:15-27` (`tests/credential-column-grants-guard.test.js:239-275`).
- Glofox-only surfaces and their gates: lead radar (`src/lib/lead-radar-data.js:23-41`; page `src/app/dashboard/lead-radar/page.js`, perm `lead_radar` → `bundle_sales`), churn radar (`src/lib/churn-radar-data.js`; page `src/app/dashboard/churn-radar/page.js`, perm `churn_radar` → `bundle_members`), membership trend (`src/lib/membership-snapshot.js`; `src/app/api/dashboard/business/route.js:28-46`; web `src/app/dashboard/business/page.js:15,48`, phone `mobile/components/dashboard/BusinessDashboard.jsx` via `mobile/lib/dashboard-api.js:156`), studio scorecard (above), attendance credits (`src/lib/credit-attendance.js`; cron over ALL locations), class automations (`ClassClimateCard.jsx:72,179`, `BathroomClimateCard.jsx:72,179`, `AutomationsView.jsx:119`, Shelly editor gates), Mia booking tools (`src/lib/agent/booking-tools.js:41-49` `noBookingSystemAnswer`, used at :579,:621,:954,:1054; account tools `account-tools.js:601-615`), classifier (`shared/pipeline-classifier.js:216` — pure; non-Glofox contacts stay `new_lead`/`dormant`, which is CORRECT for a lead-only gym, so the pipeline is not gated, only annotated). Known bug: `src/app/api/admin/backfill-class-bookings/route.js:48` treats the array as a boolean (always 400) — fix in M3b.
- Public timetable/booking already has a working no-Glofox fallback (`src/lib/public-classes.js:69-72` manual classes; `class-booking-processor.js:200-207`).
- No reusable gate component exists; `src/components/ui/EmptyState.jsx:18` is the primitive.

### Task W1.M1: `locations.membership_source` + the provider interface

**Files:**
- Create: `supabase/migrations/717_locations_membership_source.sql`
- Create: `src/lib/membership/source.js`, `src/lib/membership/source.test.js`, `src/lib/membership/sources/none.js`, `src/lib/membership/sources/glofox.js`, `src/lib/membership/sources/glofox.test.js`
- Modify: `tests/helpers/credential-column-grants.js:15-27` (add `membership_source` to `select`)
- Modify: `src/lib/location-client-shape.js:38-46` (`CLIENT_LOCATION_COLUMNS` gains `membership_source`; check `tests/user-profile-consumers.test.js` — the user object ships it to every browser, which is intended: pages gate on it)

- [ ] **Step 1: Migration** `717_locations_membership_source.sql`:

```sql
-- 717 — W1.M1: which system is the source of truth for MEMBERSHIPS at a location.
--
-- WHY. Glofox was the only membership source and nothing said so: a gym
-- without Glofox got empty radars, a zero trend and a classifier that keyed
-- on glofox_* columns (SaaS review 2026-10-09 §1, theme E). Five crons found
-- Glofox locations by sniffing settings->'glofox' and five different code
-- tests disagreed about "connected". One column, read by one resolver
-- (src/lib/membership/source.js), answers it.
--
-- VALUES. 'none' (lead CRM only), 'glofox' (today), 'un1t' (the home-grown
-- source, arriving: listed now so it plugs in with NO schema change — its
-- provider module registers itself in code). The CHECK is the whole
-- contract; adding a fourth source later is a new migration by design.
--
-- BACKFILL. 'glofox' where a REAL connection exists: an active registry row
-- (channel_connections, platform='glofox', mig 418) with a branch id and a
-- token, or the legacy settings slice with all three credentials. Live on
-- 2026-10-10 that is exactly UN1T Stillorgan; Hatch Street and CCF Autos
-- carry an empty slice and stay 'none'.
--
-- GRANT. SELECT for authenticated (the phone's Studio tab and the browser
-- gate on it; it is not a secret). UPDATE withheld: writes go through
-- PUT /api/locations/[id]/membership-source (W1.M2).

alter table public.locations
  add column if not exists membership_source text not null default 'none'
    check (membership_source in ('none', 'glofox', 'un1t'));

update public.locations l
   set membership_source = 'glofox'
 where l.membership_source = 'none'
   and (
     exists (select 1 from public.channel_connections c
              where c.location_id = l.id and c.platform = 'glofox' and c.active = true
                and coalesce(c.external_account_id, '') <> '' and coalesce(c.access_token, '') <> '')
     or (coalesce(l.settings->'glofox'->>'branch_id', '') <> ''
         and coalesce(l.settings->'glofox'->>'api_key', '') <> ''
         and coalesce(l.settings->'glofox'->>'api_token', '') <> '')
   );

grant select (membership_source) on public.locations to authenticated;
-- column-grant: withheld locations.membership_source (UPDATE)

comment on column public.locations.membership_source is
  'W1.M1 (mig 717) — none | glofox | un1t. The ONE answer to "where do memberships come from"; resolved by src/lib/membership/source.js. Written only by PUT /api/locations/[id]/membership-source.';
```

Pre-check: `select name from locations where coalesce(settings->'glofox'->>'branch_id','')<>''` → only UN1T Stillorgan. Post-check: `select name, membership_source from locations order by 1` → Stillorgan `glofox`, five `none`. (Verify the registry column names `external_account_id`/`access_token` against mig 418 before applying; the research cites `connection-registry.js:11-23` for the mapping.)

- [ ] **Step 2: Failing tests** `src/lib/membership/source.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'
import { MEMBERSHIP_SOURCES, resolveMembershipSource, membershipSourceState } from './source'

vi.mock('./sources/glofox', () => ({ glofoxSource: { key: 'glofox', label: 'Glofox', capabilities: { memberships: true, bookings: true, credits: true, invoices: true, schedule: true },
  isConfigured: vi.fn(async (_db, locationId) => locationId === 'loc-ok' ? { configured: true } : locationId === 'loc-err' ? { configured: false, readError: 'GLOFOX_SETTINGS_UNREADABLE' } : { configured: false, missing: ['API Key'] }) } }))

const dbWith = (source) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { membership_source: source }, error: null }) }) }) }) })

describe('membership source (W1.M1)', () => {
  it('registers none and glofox; un1t is a known key with no provider yet', () => {
    expect(Object.keys(MEMBERSHIP_SOURCES)).toEqual(['none', 'glofox'])
    expect(MEMBERSHIP_SOURCES.none.capabilities).toEqual({ memberships: false, bookings: false, credits: false, invoices: false, schedule: false })
  })
  it('resolves the provider from locations.membership_source', async () => {
    expect((await resolveMembershipSource(dbWith('glofox'), 'loc-ok')).key).toBe('glofox')
    expect((await resolveMembershipSource(dbWith('none'), 'loc-ok')).key).toBe('none')
  })
  it('state: none | configured | unconfigured | unknown — a read error is never "none"', async () => {
    expect(await membershipSourceState(dbWith('none'), 'loc-ok')).toEqual({ source: 'none', state: 'none' })
    expect(await membershipSourceState(dbWith('glofox'), 'loc-ok')).toEqual({ source: 'glofox', state: 'configured' })
    expect(await membershipSourceState(dbWith('glofox'), 'loc-missing')).toEqual({ source: 'glofox', state: 'unconfigured', missing: ['API Key'] })
    expect(await membershipSourceState(dbWith('glofox'), 'loc-err')).toEqual({ source: 'glofox', state: 'unknown', readError: 'GLOFOX_SETTINGS_UNREADABLE' })
  })
  it('an unregistered value (a future "un1t" before its module lands) resolves to none with a warning, never throws', async () => {
    expect((await resolveMembershipSource(dbWith('un1t'), 'loc-ok')).key).toBe('none')
  })
})
```

- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** `src/lib/membership/source.js`:

```js
// W1.M1 — THE membership-source seam. A provider is a plain object:
//   { key, label, capabilities: { memberships, bookings, credits, invoices, schedule },
//     isConfigured(db, locationId) → { configured, missing?, readError? } }
// Glofox implements it today (./sources/glofox.js); the home-grown 'un1t'
// source registers itself here when it lands — no schema change (mig 717
// already admits the value). Pages, crons and Mia ask THIS module, never
// settings.glofox and never channel_connections directly.
import { logWarn } from '@/lib/log'
import { noneSource } from './sources/none'
import { glofoxSource } from './sources/glofox'

export const MEMBERSHIP_SOURCES = Object.freeze({ none: noneSource, glofox: glofoxSource })
export const MEMBERSHIP_SOURCE_KEYS = Object.freeze(['none', 'glofox', 'un1t']) // the mig 717 CHECK

export function providerFor(key) {
  const p = MEMBERSHIP_SOURCES[key]
  if (!p) { logWarn('membership-source', 'no provider registered for source', { key }); return noneSource }
  return p
}

export async function resolveMembershipSource(db, locationId) {
  const { data, error } = await db.from('locations').select('membership_source').eq('id', locationId).maybeSingle()
  if (error || !data) return noneSource
  return providerFor(data.membership_source)
}

/** 'none' | 'configured' | 'unconfigured' | 'unknown' — never collapse unknown into none. */
export async function membershipSourceState(db, locationId) {
  const provider = await resolveMembershipSource(db, locationId)
  if (provider.key === 'none') return { source: 'none', state: 'none' }
  const r = await provider.isConfigured(db, locationId)
  if (r.readError) return { source: provider.key, state: 'unknown', readError: r.readError }
  if (!r.configured) return { source: provider.key, state: 'unconfigured', missing: r.missing || [] }
  return { source: provider.key, state: 'configured' }
}
```

`sources/none.js`: `{ key: 'none', label: 'No membership source', capabilities: all false, isConfigured: async () => ({ configured: false }) }`. `sources/glofox.js`:

```js
import { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation } from '@/lib/glofox'
export const glofoxSource = Object.freeze({
  key: 'glofox', label: 'Glofox',
  capabilities: Object.freeze({ memberships: true, bookings: true, credits: true, invoices: true, schedule: true }),
  async isConfigured(db, locationId) {
    const creds = await glofoxCredentialsForLocation(db, locationId)
    if (creds.readError) return { configured: false, readError: creds.readError }
    const missing = missingGlofoxCredentialsForLocation(creds)
    return missing.length ? { configured: false, missing } : { configured: true }
  },
})
```

(`tests/glofox-settings-readers.test.js` lists every caller of `glofoxCredentialsForLocation` that must handle `readError`: add `src/lib/membership/sources/glofox.js`.)

- [ ] **Step 5: Run** `npx vitest run src/lib/membership tests/glofox-settings-readers.test.js tests/credential-column-grants-guard.test.js tests/user-profile-consumers.test.js` and `npm run check:select-columns && npm run check:rpc-names` → PASS. Apply mig 717 BEFORE merge; `get_advisors`. PR ritual. Changelog: `W1.M1 — locations.membership_source (mig 717) and the membership provider interface; Glofox implements it`.

---

### Task W1.M2: A per-location "Membership source" setting

**Files:**
- Create: `src/app/api/locations/[id]/membership-source/route.js` (+ `route.test.js`, Style B: real `assertLocationAccess` + `guardMasterOrOwner`), register in `src/lib/openapi.js`
- Modify: `src/components/settings/LocationIntegrations.jsx:76-82,213-214` (a "Membership source" card ABOVE the Glofox tab: select `none` / `glofox`, with `un1t` rendered disabled "coming soon"; the Glofox tab's status dot reads `membershipSourceState`, replacing test (e))
- Modify: `src/app/api/locations/[id]/integrations/[provider]/route.js:295-306` (saving Glofox credentials sets `membership_source='glofox'` when it is `'none'`, so the existing connect flow keeps working; DELETE of the Glofox connection sets it back to `'none'`)
- Modify: `src/lib/account-home.js:232` and `src/components/account/AccountHome.jsx:33-45` (`IntegrationChip` reads the state, replacing test (d))

- [ ] **Step 1: Failing tests** — route: "owner at the location PUTs `{ membership_source: 'glofox' }` → 200 and `locations.update({ membership_source: 'glofox' })` by id"; "`'un1t'` → 400 `not_available_yet` until a provider registers" (the route checks `MEMBERSHIP_SOURCES[key]`, not the CHECK); "a manager → 403; a foreign location → 404"; "`'none'` while `channel_connections` holds an active glofox row → 200 with `warning: 'glofox_credentials_kept'` (credentials are never deleted by this switch)". Component: `LocationIntegrations.test.jsx` — the select renders the three options with `un1t` disabled.
- [ ] **Step 2–4:** run → FAIL → implement (mutation skeleton: `getCurrentUser` → `assertLocationAccess` → `guardMasterOrOwner` → `validateBody` `z.object({ membership_source: z.enum(MEMBERSHIP_SOURCE_KEYS) })` → `createServerClient` → update → `{ success, data: await membershipSourceState(db, id) }`) → PASS. `npm run check:route-guards && npm run check:location-scoping`. PR ritual. Changelog: `W1.M2 — membership source is a per-location setting; connecting Glofox selects it`.

---

### Task W1.M3a: Glofox-only web surfaces show "No membership source connected" instead of empty data

**Files:**
- Create: `src/components/MembershipSourceGate.jsx` (+ `.test.jsx`): server-component-friendly wrapper: `<MembershipSourceGate state={…} capability="memberships" settingsHref=…>children</MembershipSourceGate>` — `state.state === 'none'` → `EmptyState` "No membership source connected" + "Choose one in Location settings → Integrations" (owner) / "Ask an owner to connect a membership source" (others); `'unconfigured'` → "Glofox is selected but not fully configured (missing: API Key)"; `'unknown'` → "Membership data could not be read right now" (never the none copy); `'configured'` → children
- Create: `src/lib/membership/state-for-page.js` (`membershipStateForPage(db, locationId)` with a 60 s cache — pages call it once)
- Modify (apply the gate): `src/app/dashboard/churn-radar/page.js`, `src/app/dashboard/lead-radar/page.js`, `src/app/dashboard/business/page.js:15,48` (gate only the membership trend card), `src/app/dashboard/studio/page.js:106-110` (replace the data inference with the state; `StudioScorecard.LocationEmptyState` copy becomes source-neutral), `src/app/(marketing)/automations/page.js:55,137,145` + `AutomationsView.jsx:119` + `ClassClimateCard.jsx:72,179` + `BathroomClimateCard.jsx:72,179` (replace `glofoxConnected(location)` with the state; copy "Connect a membership source with a class schedule"), Shelly editor gates (`ShellyScheduleEditor.jsx:30,119,158,184`, `ShellyDeviceCard.jsx:342,465`), `src/app/(sales)/pipeline/page.js` (an inline NOTE above the board when `state === 'none'`: "Stages that depend on memberships and credits will not move without a membership source" — the board itself stays)
- Modify: `src/lib/automations/registry.js:47-51` (`glofoxConnected` → deprecated alias of the state resolver; keep the export for one release, `tests/` pins the alias)

- [ ] **Step 1: Failing tests** `MembershipSourceGate.test.jsx` (RTL): the four states render the four copies; `configured` renders children; the none copy is never shown for `unknown`. Page tests where they exist (`src/app/dashboard/studio/page.test.js` etc.): "renders the gate when the state is none".
- [ ] **Step 2–4:** run → FAIL → implement → PASS. `npm run check:location-scoping` (pages unchanged in their queries). PR ritual. Changelog: `W1.M3a — radars, trend, scorecard and class automations gate on the membership source`.

Merge note: no UN1T change — Stillorgan is `glofox` + configured; Hatch Street is `none` and its radars were empty anyway: they now say why.

---

### Task W1.M3b: Crons and Mia discover Glofox locations through the seam; the backfill route bug

**Files:**
- Create: `src/lib/membership/locations-for-source.js` (`locationsWithSource(db, 'glofox')` → active locations where `membership_source = 'glofox'`, each with `membershipSourceState` so a cron can log `skipped: unconfigured|unknown` instead of silently passing), `+ .test.js`
- Modify the five legacy-slice crons to use it: `src/app/api/cron/glofox-sync/route.js:52-66`, `glofox-attendance-refresh/route.js:72-81`, `glofox-detail-backfill/route.js:83-92`, `sync-class-occurrences/route.js:34-41`, `notify-onboarding-pace/route.js:66-74` (their per-location credential re-read via `glofoxCredentialsForLocation` stays); their tests (`route.settings-read.test.js`, `route.test.js`, `route.cursor.test.js`, `route.reconcile.test.js`)
- Modify the six `active=true` crons that read `glofox_*` columns to skip `membership_source='none'` locations with a counted `skipped_no_source`: `glofox-data-quality:41-60`, `membership-snapshot:35-37`, `pipeline-classify:40-43` (the classifier still runs for 'none' — lead-only gyms need `new_lead`→`dormant`; only the Glofox-stage reconciliation is skipped: confirm in `src/lib/pipeline-reclassify.js:33-37,145` which selects are Glofox-only), `churn-radar-snapshot:30-32`, `lead-radar-snapshot:30-32`, `churn-radar-digest:38-40`; `credit-attendance/route.js:49`
- Modify Mia: `src/lib/agent/booking-tools.js:41-49` (`noBookingSystemAnswer` → source-aware copy: `'none'` → "This studio has no class booking system connected — hand off to the team"; `'unconfigured'`/`'unknown'` → the existing unavailable copy), `account-tools.js:601-615`; `src/lib/agent/prompt.js:77-85` ("the Glofox app"/"Glofox payment page" → `${provider.label}` from the conversation's location source; for `'none'` the two rules are omitted)
- Fix: `src/app/api/admin/backfill-class-bookings/route.js:48` (`if (missingGlofoxCredentialsForLocation(creds).length)`), + test

- [ ] **Step 1: Failing tests** — `locations-for-source.test.js`: returns only `membership_source='glofox'` active rows with states; a cron test per file: "a location with `settings.glofox` but `membership_source='none'` is NOT synced" (this is the behaviour change: discovery no longer sniffs the slice) and "a registry-only glofox location IS synced" (the review's latent bug closed). Mia: `booking-tools.test.js` "with source none the hand-off names no system".
- [ ] **Step 2–4:** run → FAIL → implement → PASS. `npm run check:route-guards` (cron Bearer unchanged). PR ritual. Changelog: `W1.M3b — Glofox crons and Mia discover locations through membership_source; backfill route bug fixed`.

Merge note: the slice-sniffing crons used to try Hatch Street and CCF Autos (empty slices) every tick and skip them on missing credentials; after this they are not even listed. Stillorgan is unchanged. Not a card.

---

### Task W1.M3c: The phone's Studio tab and Business dashboard show the membership-source state

**Files:**
- Modify: `src/app/api/dashboard/business/route.js:28-46` (payload gains `membership_source: { source, state }`), `mobile/lib/dashboard-api.js:156`, `mobile/components/dashboard/BusinessDashboard.jsx` (the trend card renders the state copy when not `configured`), the Studio tab's pending lists component (memory: `studio-dashboard-pending-lists`; find with `grep -rn "awaiting_approval" mobile/app/\(staff\)/studio`), `mobile/lib/dashboard-api.test.js`
- The phone can also read `locations.membership_source` directly (mig 717 grant) through its existing `locations` embed in the session; prefer the API payload so the state (configured/unconfigured) is server-judged.

- [ ] **Step 1: Failing test** `mobile/lib/dashboard-api.test.js`: "`business()` exposes `membership_source` from the payload; absent → `{ source: 'unknown', state: 'unknown' }` (never none)". Component test under `mobile/components/dashboard/BusinessDashboard.test.jsx` if a runner exists for it (the memory note says decisions go in `mobile/lib/` because there is no RN component runner — put the copy selection in `mobile/lib/membership-source-copy.js` with its own test and keep the component a thin renderer).
- [ ] **Step 2–4:** run → FAIL → implement → PASS. `npm run check:mobile-imports && npm run check:mobile-lint && npm run check:mobile-parity`. Merge publishes an OTA on the staff lane (P6 rollout check first). PR ritual. Changelog: `W1.M3c — phone dashboards show the membership-source state`.

---

## Verification at the end of Wave 1

Run from a fresh worktree on `origin/main` after the last PR merges (never the whole vitest suite on the 8 GB machine; these are the targeted files plus the four gates):

```bash
npm run check:route-guards && npm run check:location-scoping && npm run check:select-columns && npm run check:guardrails
npm run check:mobile-imports && npm run check:mobile-lint && npm run check:mobile-parity && npm run check:ota-paths
npx vitest run tests/un1t-literal-sweep.test.js tests/shared-pair-sync.test.js tests/credential-column-grants-guard.test.js \
  tests/glofox-settings-readers.test.js src/public-compliance-paths.test.jsx src/lib/location-branding.test.js \
  shared/brand-name.test.js src/lib/tenant-host.test.js src/lib/tenant-email.test.js src/lib/postmark.test.js \
  src/lib/postmark-account.test.js src/lib/membership src/lib/location-seed.test.js src/lib/brand-chrome.test.js \
  tests/changelog-entries.test.js
git grep -n "UN1T" -- 'src/**' ':!src/**/*.test.*' | grep -v -E "^\S+:\s*(//|\*|\{/\*)" | wc -l   # expect ≈ the 62 keep rows + comments only
git grep -n "hello@un1t.ie" src shared mobile | grep -v -E "//|\*"                              # expect 0
```

Live checks (read-only SQL on `iyvtbjjxdggiadzwwvdj`, then the browser):
- `select hostname, source from tenant_domains order by 1` → three `platform` rows; `curl -sI https://un1t-group.repset.ie/welcome` → 200.
- `select name, membership_source from locations order by 1` → Stillorgan `glofox`, five `none`.
- `select organization_id, short_name from org_settings` → UN1T Group `UN1T`.
- Send a campaign test (`/communications/campaigns/[id]` → Send test) from Stillorgan: From shows `UN1T stillorgan <hello@…>` (or the corrected name), Reply-To `stillorgan@un1t.com`, unsubscribe link host `un1t-group.repset.ie`, and the unsubscribe page renders the brand.
- `/settings/email-domain` as master with the active studio in UN1T Group: `addon_active: true`, `account_configured` reflects P3.
- Hatch Street `/dashboard/churn-radar` shows "No membership source connected"; Stillorgan's is unchanged.
- Phone (2.4.0 lane): Studio tab and Business dashboard render the membership state; a member screen shows "UN1T Points".
- champ-app `app.champfitness.ie`: signed-in member sees "UN1T Points"; `/share/<token>` OG reads the brand.

## What Wave 1 leaves open (for the record, not for this wave)
- Per-location timezone threading (next wave); money rails and the `platform('Repset')` money copy (Wave 2); the wizard beyond seeding, feature flips, SQL-only settings UIs, the `terms` tenant variant, the lowercase-hostname literal inventory (`un1tdublin.com`, `un1t.ie`, mailtos) (Wave 3).
- Richard's manual edits: App Store Connect description/review notes (Appendix B store-copy rows); P2 (`repset.ie` in Postmark) before `POSTMARK_FROM_EMAIL` changes; P3 (`POSTMARK_ACCOUNT_TOKEN`).
- Follow-up chips found during research, not in scope: `notify.js:169` judges `ErrorCode`/`MessageID` on a `{ messageId }` result (every successful staff-push email fallback likely counts as `email_failed`); `docs/architecture/MOBILE.md:56,104,137` is stale (runtime 2.0.0, 10% rollout); champ-app's working tree holds untracked `mobile/.env` and `mobile/AuthKey_*.p8` (an App Store Connect key) that are NOT gitignored.

---

## Appendix — UN1T literal inventory (the sweep deliverable)

Method: `git grep -n "UN1T"` on HEAD `e33e786b` (un1t-crm) and champ-app `origin/main c907f01`, test files excluded, every hit classified. Excluded (counted, not listed): code comments, test fixtures/helpers, dev-only harness (`src/app/welcome/preview/page.js`), internal identifiers (`UN1TCRM/` user-agent regex, `window.UN1TCookies`, `BRAND_WORDS` allow-list, env names, `un1t-` CSS tokens, bundle ids, the UN1T Group org id, API hostnames). `[NS]` = no locationId/orgId in scope at that site; the task that sweeps it says how the brand arrives. Replacement rules are defined in Track S.

**Counts:** un1t-crm web `src/` **310 rows** (341 lines; 302 excluded) · `mobile/` **34 bundled rows + 6 store-copy rows** (59 lines; 19 excluded) · `shared/` **9 rows** (35 lines; 26 excluded) · champ-app **36 rows** (74 lines; 36 excluded). Total **395 rows**. Per rule (web): brand(loc) 138 · keep 62 · platform 34 · drop 28 · productName('Points') 19 · locationName 13 · legalEntity(org) 11 · productName('HR') 5 · meta-template 0.

### A. un1t-crm web (`src/`) — 310 rows

| File:line | Literal (short) | Surface | Replacement rule |
|---|---|---|---|
| src/app/(members)/challenges/page.js:21 | `'UN1T Points'` metric label | customer-web | productName('Points') |
| src/app/(operations)/tv-displays/TVAdmin.jsx:325 | "Idle — UN1T mark + clock" | staff-web | brand(loc) |
| src/app/account-deletion/page.js:50 | "contractors of Champ Fitness Ltd, trading as UN1T Dublin" | legal | keep |
| src/app/account-deletion/page.js:51 | "managed by UN1T administrators" | legal | legalEntity(org) [NS] |
| src/app/account-deletion/page.js:98 | "have interacted with UN1T" | legal | legalEntity(org) [NS] |
| src/app/account-deletion/page.js:111 | "Champ Fitness Ltd (trading as UN1T Dublin)" contact | legal | keep |
| src/app/account/contracts/page.js:63 | "Documents UN1T Dublin has issued to you" | staff-web | legalEntity(org) |
| src/app/account/page.js:125 | "documents UN1T has issued you" | staff-web | brand(loc) |
| src/app/admin/tenant-domains/page.js:42 | "legacy hostnames (CRM, UN1T marketing…)" | staff-web | keep |
| src/app/api/contracts/[id]/resend/route.js:75–76 | `${user.full_name \|\| 'UN1T'} sent you a reminder` | staff-push | brand(loc) |
| src/app/api/cron/auto-end-stale-hr-sessions/route.js:183 | `N UN1T Points` push body | customer-push | productName('Points') |
| src/app/api/email/conversations/_gone.js:40 | "update the UN1T app" (410 error) | staff-web | platform('Repset') |
| src/app/api/host/emails/[id]/send-test/route.js:84 | "ask UN1T to verify your sending domain" | host-portal | brand(loc) |
| src/app/api/host/emails/[id]/send-test/route.js:93 | "ask UN1T to attach your Postmark stream" | host-portal | brand(loc) |
| src/app/api/host/events/[id]/route.js:146 | "contact UN1T to cancel it fully" | host-portal | brand(loc) |
| src/app/api/hosts/[id]/invite/route.js:89 | "That email is a UN1T staff account" | staff-web | brand(loc) |
| src/app/api/hosts/[id]/link-staff/route.js:72 | "isn't a UN1T staff account" | staff-web | brand(loc) |
| src/app/api/hosts/[id]/route.js:52 | "That is UN1T's shared Postmark stream" | staff-web | platform('Repset') |
| src/app/api/hyrox/blocks/[id]/expand/route.js:57 | `locationLabel: (loc?.name \|\| 'UN1T')` | assistant-prompt | locationName |
| src/app/api/hyrox/sessions/[id]/regenerate/route.js:64 | same locationLabel fallback | assistant-prompt | locationName |
| src/app/api/preferences/[token]/route.js:125 | `locationName: … \|\| 'UN1T'` | customer-web | locationName |
| src/app/api/preferences/hr-emails/route.js:356 | `<title>Email preferences · UN1T` | metadata/og | brand(loc) [NS] |
| src/app/api/public/events/[slug]/register/route.js:559 | "open to UN1T members only… UN1T account" | customer-web | brand(loc) |
| src/app/api/public/offers/[slug]/checkout/route.js:71 | `UN1T — ${offer.name}` order description | customer-web | keep (pinned to Stillorgan by W0.4) |
| src/app/api/public/races/[slug]/register/route.js:293 | "open to UN1T members only… UN1T account" | customer-web | brand(loc) |
| src/app/embed/event/[slug]/page.js:40 | `'UN1T Dublin — Sign up'` fallback title | metadata/og | brand(loc) [NS] |
| src/app/embed/event/[slug]/page.js:45 | same, catch branch | metadata/og | drop [NS] |
| src/app/event/[slug]/page.js:46 | `${name} — UN1T Dublin` | metadata/og | brand(loc) [NS] |
| src/app/event/[slug]/page.js:51 | 'Sign up at UN1T Dublin.' | metadata/og | brand(loc) [NS] |
| src/app/event/[slug]/page.js:58 | siteName 'UN1T Dublin' | metadata/og | brand(loc) [NS] |
| src/app/free-class/page.js:55 | "Every class at UN1T Stillorgan…" | customer-web | keep |
| src/app/free-class/page.js:68 | consent "hear from UN1T Stillorgan" | customer-web | keep |
| src/app/free-class/page.js:110 | testimonial "member of UN1T Dublin" | customer-web | keep |
| src/app/free-class/page.js:116 | title "…— UN1T Stillorgan" | metadata/og | keep |
| src/app/free-class/page.js:121 | og title | metadata/og | keep |
| src/app/free-class/page.js:124 | siteName 'UN1T Dublin' | metadata/og | keep |
| src/app/free-class/page.js:137 | logoAlt "UN1T Stillorgan" | customer-web | keep |
| src/app/host/(portal)/events/[id]/edit/page.js:70 | "UN1T asked for changes:" | host-portal | brand(loc) |
| src/app/host/(portal)/events/new/page.js:20 | "submit it to UN1T for review" | host-portal | brand(loc) |
| src/app/host/(portal)/layout.js:28 | header wordmark "UN1T" | host-portal | brand(loc) |
| src/app/host/(portal)/page.js:110 | 'UN1T booking fees' stat | host-portal | platform('Repset') |
| src/app/host/login/page.js:40 | wordmark "UN1T" | host-portal | brand(loc) [NS] |
| src/app/host/login/page.js:72 | "Access is set up by UN1T" | host-portal | brand(loc) [NS] |
| src/app/host/set-password/page.js:100 | wordmark "UN1T" | host-portal | brand(loc) [NS] |
| src/app/login/page.js:238 | `branding?.company_name \|\| 'UN1T'` | staff-web | platform('Repset') |
| src/app/offers/[slug]/page.js:25 | "…drop-in at UN1T Stillorgan" | customer-web | keep |
| src/app/offers/[slug]/page.js:67 | breadcrumb "UN1T Stillorgan" | customer-web | keep |
| src/app/offers/layout.js:33–34 | titles "— UN1T Stillorgan" | metadata/og | keep |
| src/app/offers/layout.js:65 | footer "UN1T STILLORGAN … CHAMP CHAMP FITNESS LIMITED" | legal | keep (has "CHAMP CHAMP" typo) |
| src/app/offers/page.js:101 | marquee 'UN1T GIFT CARDS' | customer-web | keep |
| src/app/offers/page.js:104 | "A UN1T gift card is…" | customer-web | keep |
| src/app/offers/page.js:143 | "UN1T STILLORGAN" | customer-web | keep |
| src/app/preferences/[token]/page.js:9 | title '— UN1T' | metadata/og | brand(loc) [NS] |
| src/app/preferences/layout.js:20 | title '— UN1T' | metadata/og | brand(loc) [NS] |
| src/app/privacy/authority-requests/page.js:21 | description "(trading as UN1T Dublin)" | legal | keep |
| src/app/privacy/authority-requests/page.js:37 | "Champ Fitness Ltd, trading as UN1T" | legal | keep |
| src/app/privacy/authority-requests/page.js:69 | "within UN1T Dublin (our data protection contact" | legal | keep |
| src/app/privacy/authority-requests/page.js:152 | contact block "(trading as UN1T Dublin)" | legal | keep |
| src/app/privacy/members/page.js:61 | "as UN1T Dublin" | legal | keep (platform-host branch; tenant hosts get TenantPrivacyNotice) |
| src/app/privacy/members/page.js:69 | "If you are a UN1T…" | legal | keep |
| src/app/privacy/members/page.js:76 | "operates UN1T Dublin fitness studios" | legal | keep |
| src/app/privacy/members/page.js:226 | "property of UN1T Dublin" | legal | keep |
| src/app/privacy/members/page.js:296 | contact "(trading as UN1T Dublin)" | legal | keep |
| src/app/privacy/page.js:29 | description "(trading as UN1T Dublin)" | legal | keep |
| src/app/privacy/page.js:45 | "Champ Fitness Ltd, trading as UN1T" | legal | keep |
| src/app/privacy/page.js:58 | "internal operations tool used by UN1T Dublin" | legal | legalEntity(org) [NS] |
| src/app/privacy/page.js:60 | "If you are not a UN1T staff member" | legal | legalEntity(org) [NS] |
| src/app/privacy/page.js:82 | "message history with UN1T" | legal | legalEntity(org) [NS] |
| src/app/privacy/page.js:212 | contact "(trading as UN1T Dublin)" | legal | keep |
| src/app/reset-password/page.js:169 | `branding?.company_name \|\| 'UN1T'` | staff-web | platform('Repset') |
| src/app/reset-password/page.js:250 | 'UN1T CRM v1.0' | staff-web | platform('Repset') |
| src/app/settings/customer-agent/CustomerAgentClient.jsx:462 | "Monthly UN1T-Points target" | staff-web | productName('Points') |
| src/app/settings/customer-agent/CustomerAgentClient.jsx:506 | placeholder "One of the UN1T team…" | editable-default | brand(loc) |
| src/app/settings/customer-agent/CustomerAgentClient.jsx:603 | placeholder "Mia… assistant at UN1T" | editable-default | brand(loc) |
| src/app/settings/hosts/page.jsx:39 | "UN1T's booking fee kept per ticket" | staff-web | platform('Repset') |
| src/app/settings/scoring/ScoringClient.jsx:114 | "How UN1T Points are awarded" | staff-web | productName('Points') |
| src/app/start/[path]/page.js:63 | not-found title 'UN1T Dublin' | metadata/og | drop [NS] |
| src/app/start/[path]/page.js:64 | studioName fallback 'UN1T Dublin' | metadata/og | brand(loc) |
| src/app/start/[path]/page.js:93 | logoAlt fallback 'UN1T Dublin' | customer-web | brand(loc) |
| src/app/start/page.js:40 | title "3 Free Classes — UN1T Stillorgan" | metadata/og | keep |
| src/app/start/page.js:41 | description "…at UN1T Stillorgan…" | metadata/og | keep |
| src/app/start/page.js:73 | logoAlt "UN1T Stillorgan" | customer-web | keep |
| src/app/technical/page.js:47 | description "(trading as UN1T Dublin) to UN1T gym franchises" | metadata/og | keep |
| src/app/technical/page.js:67 | "run the UN1T studios in Dublin" | customer-web | keep |
| src/app/technical/page.js:113 | "that runs UN1T." | customer-web | keep |
| src/app/technical/page.js:117–118 | "Built by UN1T Dublin… UN1T gym franchises" | customer-web | keep |
| src/app/technical/page.js:195–196 | "trading as UN1T Dublin… the UN1T studios" | legal | keep |
| src/app/technical/page.js:201 | "Repset for your UN1T franchise?" | customer-web | keep |
| src/app/terms/page.js:20 | description "(trading as UN1T Dublin)" | legal | keep [NS] |
| src/app/terms/page.js:36–37 | "trading as UN1T Dublin (\"UN1T\", \"we\")" | legal | keep [NS] |
| src/app/terms/page.js:46 | "trading as UN1T Dublin, is a company" | legal | keep |
| src/app/terms/page.js:48 | "UN1T fitness studios" | legal | keep |
| src/app/terms/page.js:164 | contact "(trading as UN1T Dublin)" | legal | keep |
| src/app/tv/cast/[token]/TVDisplay.jsx:235 | idle `companyName \|\| 'UN1T'` | tv-board | brand(loc) |
| src/app/tv/cast/[token]/page.js:19 | title 'UN1T' | metadata/og | brand(loc) [NS] |
| src/app/tv/layout.js:20 | title 'UN1T' | metadata/og | brand(loc) [NS] |
| src/app/tv/live/[token]/LiveTvClient.jsx:560 | OutroPodium wordmark "UN1T" | tv-board | brand(loc) [NS] |
| src/app/tv/live/[token]/LiveTvClient.jsx:671 | ClassStartIntro wordmark "UN1T" | tv-board | brand(loc) [NS] |
| src/app/tv/live/[token]/challenges/ChallengeTvClient.jsx:57 | 'UN1T Points' | tv-board | productName('Points') |
| src/app/unsubscribe/[token]/page.js:9 | title 'Unsubscribe — UN1T' | metadata/og | brand(loc) [NS] |
| src/app/unsubscribe/host/[token]/page.js:25 | title 'Unsubscribe — UN1T' | metadata/og | brand(loc) [NS] |
| src/app/welcome/[location]/events/page.js:57 | not-found title 'UN1T Dublin' | metadata/og | drop [NS] |
| src/app/welcome/[location]/events/page.js:58 | studioName fallback | metadata/og | brand(loc) |
| src/app/welcome/[location]/events/page.js:67 | siteName 'UN1T Dublin' | metadata/og | brand(loc) |
| src/app/welcome/[location]/events/page.js:82 | studioName fallback | customer-web | brand(loc) |
| src/app/welcome/[location]/events/page.js:87 | logoAlt fallback | customer-web | brand(loc) |
| src/app/welcome/[location]/page.js:56 | not-found title 'UN1T Dublin' | metadata/og | drop [NS] |
| src/app/welcome/[location]/page.js:60 | studioName fallback | metadata/og | brand(loc) |
| src/app/welcome/[location]/page.js:70 | siteName 'UN1T Dublin' | metadata/og | brand(loc) |
| src/app/welcome/[location]/page.js:110 | logoAlt fallback | customer-web | brand(loc) |
| src/app/welcome/[location]/page.js:129 | studioName fallback | customer-web | brand(loc) |
| src/app/welcome/[location]/status/page.js:36 | `loc?.name \|\| 'UN1T'` | customer-web | locationName |
| src/app/welcome/page.js:62 | title "UN1T Dublin — Choose your studio" | metadata/og | brand(org) via W1.L4 host resolver [NS] |
| src/app/welcome/page.js:65 | og title | metadata/og | brand(org) via W1.L4 [NS] |
| src/app/welcome/page.js:67 | siteName 'UN1T Dublin' | metadata/og | brand(org) via W1.L4 [NS] |
| src/app/welcome/page.js:91 | tile eyebrow "UN1T Dublin" | customer-web | brand(org) via W1.L4 [NS] |
| src/app/welcome/page.js:123 | edit-mode initialLogoAlt 'UN1T Dublin' | editable-default | brand(org) via W1.L4 [NS] |
| src/app/welcome/page.js:156 | brand bar "UN1T DUBLIN" | customer-web | brand(org) via W1.L4 [NS] |
| src/components/AchievementsAdminTable.jsx:29 | 'UN1T points' | staff-web | productName('Points') |
| src/components/AddOrganizationButton.jsx:118 | placeholder "UN1T Group" | staff-web | drop |
| src/components/AppShell.jsx:164 | `activeLocation?.name \|\| 'UN1T'` | staff-web | platform('Repset') |
| src/components/BookingWidget.jsx:299 | "Powered by UN1T" | customer-web | platform('Repset') |
| src/components/BookingWidget.jsx:557 | consent "send me UN1T promotional updates" | customer-web | brand(loc) [NS] |
| src/components/BrandingSettings.jsx:159 | placeholder "UN1T" | editable-default | drop |
| src/components/CampaignDetail.jsx:621 | From preview `from_name \|\| 'UN1T'` | staff-web | brand(loc) |
| src/components/CampaignEditor.jsx:39 | default from_name 'UN1T' | editable-default | brand(loc) |
| src/components/CampaignEditor.jsx:1140 | placeholder "UN1T" | editable-default | brand(loc) |
| src/components/ChallengeForm.jsx:23 | 'UN1T Points' option | staff-web | productName('Points') |
| src/components/ClassFunnel.jsx:38 | DEFAULTS consent "UN1T Stillorgan" | customer-web | brand(loc) (defaults become functions; the DEFAULTS merge at :53 leaks onto every tenant's landing page) |
| src/components/ClassFunnel.jsx:40 | DEFAULTS "See you at UN1T Stillorgan!" | customer-web | brand(loc) (as above) |
| src/components/ClassFunnel.jsx:42 | DEFAULTS "See you at UN1T Stillorgan!" | customer-web | brand(loc) (as above) |
| src/components/ContractSignForm.jsx:96 | "Let UN1T Dublin know why you're declining" | staff-web | legalEntity(org) |
| src/components/ContractTemplateForm.jsx:59 | merge-tag sample 'UN1T Stillorgan' | staff-web | locationName |
| src/components/ContractTemplateForm.jsx:63 | merge-tag sample 'UN1T' | staff-web | brand(loc) |
| src/components/ContractTemplateForm.jsx:64 | sample "Champ Fitness Ltd (trading as UN1T Dublin)" | staff-web | legalEntity(org) |
| src/components/ContractTemplateForm.jsx:150 | placeholder "e.g. UN1T Coach FTE Contract v1" | editable-default | drop |
| src/components/CookieConsent.jsx:301 | banner "UN1T Dublin" | customer-web | keep (shown only when host is un1tdublin.com, :205) |
| src/components/EventWaitlistForm.jsx:112 | consent "send me UN1T promotional updates" | customer-web | brand(loc) (organizationName prop already exists) |
| src/components/HostConnect.jsx:104 | "ask UN1T for a new one" | host-portal | brand(loc) [NS] |
| src/components/HostConnect.jsx:156 | `{name} × UN1T` | host-portal | brand(loc) [NS] |
| src/components/LandingPageSettingsForm.jsx:376 | hint "fall back to the UN1T wordmark" | staff-web | brand(loc) |
| src/components/LandingPageSettingsForm.jsx:391–392 | alt hint + placeholder 'UN1T Dublin' | editable-default | brand(loc) |
| src/components/LandingPageSettingsForm.jsx:769 | embed iframe title "UN1T event signup" | customer-web | brand(loc) |
| src/components/LocationForm.jsx:219 | placeholder "UN1T Dublin City" | editable-default | drop |
| src/components/OrgBrandingSettings.jsx:89 | placeholder "UN1T" | editable-default | drop |
| src/components/PendingContractsAlert.jsx:114–115 | "UN1T Dublin needs your signature…" | staff-web | legalEntity(org) [NS] |
| src/components/PreferenceCentre.jsx:147 | header "UN1T" | customer-web | brand(loc) [NS] |
| src/components/PreferenceCentre.jsx:219 | "unsubscribed from all UN1T marketing" | customer-web | brand(loc) [NS] |
| src/components/RaceConfirmedPage.jsx:104 | ICS `PRODID:-//UN1T//Events//EN` | customer-pdf/ics | platform('Repset') (W1.L5) |
| src/components/RaceConfirmedPage.jsx:111 | ICS SUMMARY fallback 'UN1T Event' | customer-pdf/ics | drop (W1.L5) |
| src/components/RaceConfirmedPage.jsx:248 | title "Verified UN1T member" | customer-web | brand(loc) [NS] |
| src/components/RaceControlPanel.jsx:271 | tooltip "verified UN1T members" | staff-web | brand(loc) |
| src/components/RaceControlPanel.jsx:290 | tooltip "Verified UN1T member" | staff-web | brand(loc) |
| src/components/RaceEventForm.jsx:1073 | "UN1T members are matched by the email…" | staff-web | brand(loc) |
| src/components/RaceEventForm.jsx:1081 | "UN1T (settles via Revolut)" | staff-web | platform('Repset') |
| src/components/RaceEventForm.jsx:1092 | option "UN1T (settles via Revolut)" | staff-web | platform('Repset') |
| src/components/RaceEventForm.jsx:1101 | "with UN1T's €x booking fee" | staff-web | platform('Repset') |
| src/components/RaceEventForm.jsx:1105 | "UN1T event — … settles to UN1T via Revolut" | staff-web | brand(loc) + platform('Repset') |
| src/components/RaceEventForm.jsx:1136 | "Different pricing for UN1T members" | staff-web | brand(loc) |
| src/components/RaceEventForm.jsx:1384 | "Which UN1T location's email identity" | staff-web | brand(loc) |
| src/components/RaceSignupWidget.jsx:64–66 | race members-only copy "verified UN1T member… UN1T account" | customer-web | brand(loc) [NS] |
| src/components/RaceSignupWidget.jsx:83–85 | workshop copy (same) | customer-web | brand(loc) [NS] |
| src/components/RaceSignupWidget.jsx:102–104 | seminar copy (same) | customer-web | brand(loc) [NS] |
| src/components/RaceSignupWidget.jsx:121–123 | open-day copy (same) | customer-web | brand(loc) [NS] |
| src/components/RaceSignupWidget.jsx:140–142 | masterclass copy (same) | customer-web | brand(loc) [NS] |
| src/components/RaceSignupWidget.jsx:788 | "UN1T members: use the email on your UN1T account" | customer-web | brand(loc) |
| src/components/RaceSignupWidget.jsx:1051 | consent "send me UN1T promotional updates" | customer-web | brand(loc) (race.organization_name in scope) |
| src/components/RaceSignupWidget.jsx:1124 | badge 'UN1T member' (MemberStatusBadge) | customer-web | brand(loc) [NS] |
| src/components/Sidebar.jsx:365 | `branding?.company_name \|\| 'UN1T'` | staff-web | platform('Repset') |
| src/components/UnsubscribePage.jsx:179 | header "UN1T" | customer-web | brand(loc) [NS] |
| src/components/WaitlistWidget.jsx:90 | default consent "hear from UN1T about the Hatch Street launch" | customer-web | brand(loc) [NS] |
| src/components/WidgetTokensCard.jsx:91 | "a UN1T home-screen widget" | staff-web | platform('Repset') |
| src/components/accounting/EventFeesCard.jsx:41 | "booking fee UN1T earned" | staff-web | platform('Repset') |
| src/components/host/HostEmailReport.jsx:295 | "contact UN1T" | host-portal | brand(loc) |
| src/components/host/HostEventActions.jsx:19 | confirm "needs UN1T approval again" | host-portal | brand(loc) |
| src/components/host/HostEventForm.jsx:273 | placeholder "e.g. UN1T Stillorgan" | host-portal | drop |
| src/components/host/HostEventForm.jsx:527 | "Leave blank to use UN1T defaults" | host-portal | brand(loc) |
| src/components/landing-page/BlockRenderers.jsx:184 | HeroBlock watermark "UN1T" | customer-web | brand(loc) |
| src/components/landing-page/BlockRenderers.jsx:340 | LeadFormBlock watermark "UN1T" | customer-web | brand(loc) [NS] |
| src/components/landing-page/BlockRenderers.jsx:457 | PillarsBlock "Why UN1T" | customer-web | brand(loc) |
| src/components/landing-page/BlockRenderers.jsx:855 | SiteHeader `logoAlt = 'UN1T Dublin'` | customer-web | brand(loc) [NS] |
| src/components/landing-page/BlockRenderers.jsx:897 | SiteHeader wordmark fallback "UN1T" | customer-web | brand(loc) [NS] |
| src/components/landing-page/BlockRenderers.jsx:966 | SiteFooter "UN1T DUBLIN" | customer-web | brand(loc) [NS] |
| src/components/landing-page/BlockRenderers.jsx:976 | footer link "UN1T Stillorgan" | customer-web | locationName [NS] |
| src/components/landing-page/BlockRenderers.jsx:980 | footer link "UN1T Hatch Street" | customer-web | locationName [NS] |
| src/components/landing-page/BlockRenderers.jsx:1004 | "© UN1T Dublin. All rights reserved." | legal | legalEntity(org) [NS] |
| src/components/landing-page/EditModeOverlay.jsx:44 | default `initialLogoAlt = 'UN1T Dublin'` | editable-default | brand(loc) [NS] |
| src/components/landing-page/EditModeOverlay.jsx:80 | `logoAlt \|\| 'UN1T Dublin'` | editable-default | brand(loc) [NS] |
| src/components/settings/HostDetail.jsx:189 | "never UN1T's shared broadcast stream" | staff-web | platform('Repset') |
| src/components/settings/HostDetail.jsx:816 | confirm "switch back to UN1T (settled via Revolut)" | staff-web | platform('Repset') |
| src/components/settings/HostDetail.jsx:903 | "an internal UN1T payout route" | staff-web | platform('Repset') |
| src/components/settings/HostDetail.jsx:1037 | 'UN1T booking fees' stat | staff-web | platform('Repset') |
| src/components/settings/HostDetail.jsx:1105 | hint "UN1T keeps this on every ticket" | staff-web | platform('Repset') |
| src/components/settings/HostDetail.jsx:1203 | "linked UN1T staff logins" | staff-web | brand(loc) |
| src/components/settings/HostDetail.jsx:1271 | "an existing UN1T staff member" | staff-web | brand(loc) |
| src/components/settings/HostDetail.jsx:1312 | "switch back to UN1T (settled via Revolut)" | staff-web | platform('Repset') |
| src/components/settings/HostsManager.jsx:135 | "UN1T's booking fee kept per ticket" | staff-web | platform('Repset') |
| src/components/settings/HostsManager.jsx:166 | hint "UN1T keeps this on every ticket" | staff-web | platform('Repset') |
| src/components/settings/IntegrationsHub.jsx:981 | master-only "UN1T studio customisation" | staff-web | keep |
| src/components/settings/IntegrationsHub.jsx:999 | master-only "· UN1T studio customisation" | staff-web | keep |
| src/components/settings/IntegrationsHub.jsx:1032 | master-only "· UN1T studio customisation" | staff-web | keep |
| src/components/settings/IntegrationsHub.jsx:1103 | master-only "Stays on for UN1T's own members" | staff-web | keep |
| src/components/settings/StatusPageSettingsForm.jsx:146 | placeholder `d.brand \|\| 'UN1T'` | editable-default | brand(loc) |
| src/components/settings/integrations/PaymentsIntegrationTab.jsx:115 | "charges to the UN1T merchant account" | staff-web | platform('Repset') |
| src/components/settings/integrations/PaymentsIntegrationTab.jsx:138 | option "Revolut (UN1T)" | staff-web | platform('Repset') |
| src/lib/agent/approval-suggest.js:123 | `businessName: companyName \|\| 'UN1T'` | mia-prompt | brand(loc) |
| src/lib/agent/core.js:11 | DEFAULT_HOLDING_MESSAGE "One of the UN1T team…" | customer-wa | brand(loc) [NS] |
| src/lib/agent/followups.js:369 | `businessName: companyName \|\| 'UN1T'` | mia-prompt | brand(loc) |
| src/lib/agent/prompt.js:264–265 | "AI assistant for ${businessName \|\| 'UN1T'}" | mia-prompt | brand(loc) |
| src/lib/agent/welcome-greeting.js:13 | DEFAULT_WELCOME_GREETING "assistant at UN1T" | customer-wa | brand(loc) [NS] |
| src/lib/assistant-prompt.js:56 | "bought a UN1T credit pack" | assistant-prompt | drop |
| src/lib/brands.js:77 | description "UN1T public marketing site" (tenant-domains admin) | staff-web | keep |
| src/lib/brands.js:151 | description "UN1T third-party event host portal" | staff-web | keep |
| src/lib/challenge-notifications.js:3 | metricLabel 'UN1T Points' | customer-push | productName('Points') [NS] |
| src/lib/churn-winback.js:5 | brand fallback `\|\| 'UN1T'` | customer-wa | brand(loc) |
| src/lib/class-booking-payments.js:28 | `UN1T intro — …` payment description | customer-web | brand(loc) |
| src/lib/contract-pdf.js:314 | `companyName \|\| 'UN1T'` | customer-pdf/ics | brand(loc) |
| src/lib/contracting-entity.js:48 | DEFAULT_BRAND = 'UN1T' | customer-pdf/ics | drop |
| src/lib/contracting-entity.js:57 | LEGACY_COUNTERSIGNATURE_ENTITY 'UN1T Dublin Ltd' | customer-pdf/ics | keep (executed documents) |
| src/lib/contractor-invoice-email.js:31 | From fallback 'UN1T <hello@un1t.ie>' | staff-email | drop (W1.E2) |
| src/lib/contractor-invoice-email.js:87 | header `companyName \|\| 'UN1T'` | staff-email | brand(loc) |
| src/lib/contracts-email.js:69 | `companyName \|\| 'UN1T'` | staff-email | brand(loc) |
| src/lib/contracts-email.js:89 | footer `entityLabel \|\| companyName \|\| 'UN1T'` | staff-email | legalEntity(org) |
| src/lib/contracts-email.js:109 | subject "…from UN1T" | staff-email | brand(loc) |
| src/lib/contracts-email.js:113 | "A UN1T administrator" | staff-email | brand(loc) |
| src/lib/contracts-email.js:248 | "stored in your UN1T account" | staff-email | brand(loc) |
| src/lib/contracts-notify.js:56–57 | push `issuer \|\| 'UN1T'` issued you… | staff-push | brand(loc) |
| src/lib/customer-notifications.js:20 | pointsPhrase `N UN1T Points` | customer-push | productName('Points') [NS] |
| src/lib/email-inbox-send.js:155 | From fallback 'UN1T <hello@un1t.ie>' | customer-email | drop (W1.E2) |
| src/lib/event-email.js:128 | header img alt="UN1T" | customer-email | brand(loc) [NS] |
| src/lib/event-email.js:130 | header wordmark "UN1T" | customer-email | brand(loc) [NS] |
| src/lib/event-email.js:206 | footer `UN1T · ${loc}` | customer-email | brand(loc) [NS] |
| src/lib/external-export.js:250 | TCX title `UN1T HR · date` | customer-web | productName('HR') |
| src/lib/external-export.js:253 | Strava name `UN1T HR · N pts` | customer-web | productName('HR') |
| src/lib/glofox-notes.js:14–15 | `[UN1T CRM · author]` note prefix | staff-web | platform('Repset') |
| src/lib/goals.js:42 | 'UN1T points this week' | customer-web | productName('Points') [NS] |
| src/lib/goals.js:56 | 'UN1T points this month' | customer-web | productName('Points') [NS] |
| src/lib/host-campaign-launch.js:65–66 | "ask UN1T to verify / attach…" | host-portal | brand(loc) [NS] |
| src/lib/host-onboarding-email.js:29 | header wordmark "UN1T" | host-portal | brand(loc) [NS] |
| src/lib/host-onboarding-email.js:33 | "host events with UN1T" | host-portal | brand(loc) [NS] |
| src/lib/host-onboarding-email.js:37 | "ask UN1T for a fresh one" | host-portal | brand(loc) [NS] |
| src/lib/host-onboarding-email.js:52 | subject "…for your UN1T events" | host-portal | brand(loc) [NS] |
| src/lib/host-statements.js:59 | CSV header 'UN1T fee' | host-portal | platform('Repset') |
| src/lib/hr-analytics.js:198 | "Personal best… UN1T Points." | customer-email | productName('Points') [NS] |
| src/lib/hr-analytics.js:214 | "top N%… UN1T Points." | customer-email | productName('Points') [NS] |
| src/lib/hr-post-class-email.js:261 | subject "Welcome to UN1T HR" | customer-email | productName('HR') |
| src/lib/hr-post-class-email.js:265 | subject "big day at UN1T (N UN1T Points)" | customer-email | brand(loc) + productName('Points') |
| src/lib/hr-post-class-email.js:267 | subject "— N UN1T Points" | customer-email | productName('Points') |
| src/lib/hr-post-class-email.js:295 | text "— N UN1T Points." | customer-email | productName('Points') |
| src/lib/hr-post-class-email.js:324 | "Overall: UN1T Points…" | customer-email | productName('Points') |
| src/lib/hr-post-class-email.js:377 | "UN1T Points overall:" | customer-email | productName('Points') |
| src/lib/hr-post-class-email.js:399 | eyebrow "UN1T · date" | customer-email | brand(loc) |
| src/lib/hr-post-class-email.js:410 | tile "UN1T Points" | customer-email | productName('Points') |
| src/lib/hr-post-class-email.js:448 | "monitor at UN1T" | customer-email | brand(loc) |
| src/lib/hyrox/expand-runner.js:33 | locationLabel `\|\| 'UN1T'` | assistant-prompt | locationName |
| src/lib/hyrox/generate-block.js:44 | default `locationLabel = 'UN1T'` | assistant-prompt | locationName |
| src/lib/hyrox/prompt.js:12 | "UN1T HOUSE STYLE" | assistant-prompt | drop [NS] |
| src/lib/hyrox/prompt.js:23 | "in UN1T's style" | assistant-prompt | drop [NS] |
| src/lib/hyrox/prompt.js:48 | default `locationLabel = 'UN1T'` | assistant-prompt | locationName |
| src/lib/landing-page-blocks.js:137 | default consent "hear from UN1T about the Hatch Street launch" | editable-default | brand(loc) [NS] |
| src/lib/landing-page-blocks.js:190 | default consent "hear from UN1T" | editable-default | brand(loc) [NS] |
| src/lib/landing-page-blocks.js:215 | default testimonial "separates UN1T from any gym" | editable-default | drop |
| src/lib/location-branding.js:20 | DEFAULT_COMPANY_NAME = 'UN1T' (resolver's last fallback) | customer-email | drop (W1.B1) |
| src/lib/manual-booking-confirm.js:44 | `studio_name: studioName \|\| 'UN1T'` | customer-email | locationName |
| src/lib/offer-purchase-emails.js:116 | "through the UN1T app" | customer-email | brand(loc) |
| src/lib/offer-purchase-emails.js:168 | `studio: loc?.name \|\| 'UN1T'` | customer-email | locationName |
| src/lib/openapi.js:329 | "UN1T marketing consent is untouched" | staff-web | drop |
| src/lib/openapi.js:8287 | "per-ticket fee UN1T earned" | staff-web | platform('Repset') |
| src/lib/postmark.js:275 | From fallback 'UN1T <hello@un1t.ie>' | customer-email | drop (W1.E2) |
| src/lib/postmark.js:394 | From fallback (batch) | customer-email | drop (W1.E2) |
| src/lib/race-confirmations.js:192 | raceName fallback 'UN1T Race' | customer-email | drop |
| src/lib/race-confirmations.js:364 | member badge "UN1T member" | customer-email | brand(loc) [NS] |
| src/lib/race-confirmations.js:636 | raceName fallback 'UN1T Race' | customer-email | drop |
| src/lib/race-confirmations.js:790 | raceName fallback 'UN1T Race' | customer-email | drop |
| src/lib/roster-email.js:133 | "notification from the UN1T CRM" | staff-email | platform('Repset') |
| src/lib/sequence-templates.js:37, 82, 115, 138, 176, 235, 252, 332, 421, 432, 595, 634, 645, 694, 704, 721 | sign-off `UN1T {{location_name}}` (332 is "drop into UN1T {{location_name}}") | editable-default | locationName (renders "UN1T UN1T Stillorgan" today) |
| src/lib/sequence-templates.js:134 | subject "How was your UN1T trial" | editable-default | brand(loc) via `{{company_name}}` |
| src/lib/sequence-templates.js:147 | "from the UN1T team" | editable-default | brand(loc) via `{{company_name}}` |
| src/lib/sequence-templates.js:166 | subject "Welcome to UN1T, {{first_name}}" | editable-default | brand(loc) via `{{company_name}}` |
| src/lib/sequence-templates.js:168 | "Welcome to the UN1T family." | editable-default | brand(loc) via `{{company_name}}` |
| src/lib/sequence-templates.js:226 | subject "Welcome to UN1T: your Glofox account…" | editable-default | brand(loc) via `{{company_name}}` |
| src/lib/sequence-templates.js:228 | "Your UN1T account is live." | editable-default | brand(loc) via `{{company_name}}` |
| src/lib/sequence-templates.js:314 | "give UN1T another shot" | editable-default | brand(loc) via `{{company_name}}` |
| src/lib/sequence-templates.js:331 | subject "Welcome to UN1T" | editable-default | brand(loc) via `{{company_name}}` |
| src/lib/sequence-templates.js:360 | subject "Welcome to UN1T… What's next" | editable-default | brand(loc) via `{{company_name}}` |
| src/lib/sequence-templates.js:361 | sign-off "See you soon, UN1T" | editable-default | brand(loc) via `{{company_name}}` |
| src/lib/sequence-templates.js:367 | subject "How our members talk about UN1T" | editable-default | brand(loc) via `{{company_name}}` |
| src/lib/sequence-templates.js:368 | "what makes UN1T different?" plus a customer link to `un1tdublin.com` | editable-default | brand(loc) (also replace the link with `{{location_url}}`) |
| src/lib/sequence-templates.js:459 | sign-off "See you there, UN1T" | editable-default | brand(loc) via `{{company_name}}` |
| src/lib/sequence-templates.js:512 | subject "Welcome to UN1T" | editable-default | brand(loc) via `{{company_name}}` |
| src/lib/sequence-templates.js:545 | "part of UN1T now" | editable-default | brand(loc) via `{{company_name}}` |
| src/lib/sequence-templates.js:717 | subject "keep your UN1T membership" | editable-default | brand(loc) via `{{company_name}}` |
| src/lib/sequence-templates.js:795 | "give UN1T another go" | editable-default | brand(loc) via `{{company_name}}` |
| src/lib/sequence-templates.js:868 | subject "A year with UN1T" | editable-default | brand(loc) via `{{company_name}}` |
| src/lib/sequence-templates.js:869 | "Happy UN1T anniversary" | editable-default | brand(loc) via `{{company_name}}` |
| src/lib/sequence-templates.js:897 | "birthday from the UN1T team" | editable-default | brand(loc) via `{{company_name}}` |
| src/lib/settings-tree.js:246 | "How UN1T Points are awarded" | staff-web | productName('Points') |
| src/lib/status-page.js:32 | DEFAULT_COPY.brand 'UN1T' | editable-default | brand(loc) [NS] |
| src/lib/strava.js:103 | default name 'UN1T HR session' | customer-web | productName('HR') [NS] |
| src/lib/tcx-builder.js:45 | default title 'UN1T HR session' | customer-web | productName('HR') [NS] |
| src/lib/wallet-topup.js:62 | SELLING_ENTITY_SUFFIX "(trading as UN1T Dublin)" | staff-email | keep (platform is the seller) |
| src/lib/wallet-topup.js:400 | header `companyName \|\| 'UN1T'` | staff-email | brand(loc) |
| src/lib/whatsapp.js:1967 | `location_name` → `opts.companyName \|\| 'UN1T'` | customer-wa | brand(loc) (W1.S3; note the field named location_name returns the BRAND) |
| src/lib/xero/bills-email.js:47 | From fallback 'UN1T <hello@un1t.ie>' | staff-email | drop (W1.E2) |
| src/lib/xero/bills-email.js:138 | "Forwarded from UN1T CRM" | staff-email | platform('Repset') |
| src/lib/xero/contractor-bills.js:28 | From fallback | staff-email | drop (W1.E2) |
| src/lib/xero/contractor-bills.js:124 | "forwarded from UN1T CRM" | staff-email | platform('Repset') |
| src/lib/xero/fte-expense-claims.js:35 | From fallback | staff-email | drop (W1.E2) |
| src/lib/xero/fte-expense-claims.js:183 | "forwarded from UN1T CRM" | staff-email | platform('Repset') |
| src/lib/zoom/external-contacts.js:29 | Zoom contact description "UN1T CRM sync - id" | staff-web | platform('Repset') |

**Web surface summary:** customer-web 63 · staff-web 60 · editable-default 38 · metadata/og 30 · legal 27 · customer-email 25 · host-portal 22 · staff-email 16 · assistant-prompt 8 · customer-pdf/ics 5 · customer-wa 4 · tv-board 4 · customer-push 3 · mia-prompt 3 · staff-push 2. Files with 5+ rows: `sequence-templates.js` 21, `BlockRenderers.jsx` 9, `hr-post-class-email.js` 9, `RaceSignupWidget.jsx` 8, `HostDetail.jsx` 8, `RaceEventForm.jsx` 7, `free-class/page.js` 7, `privacy/page.js` 6, `technical/page.js` 6, `welcome/page.js` 6, `terms/page.js` 5, `privacy/members/page.js` 5, `welcome/[location]/page.js` 5, `welcome/[location]/events/page.js` 5, `contracts-email.js` 5.

**Sites with no locationId/orgId in scope ([NS]) and how the brand arrives:**
1. Module-level constants → functions of `brand`: `agent/core.js:11`, `agent/welcome-greeting.js:13`, `host-campaign-launch.js:65-66`, `status-page.js:32`, `landing-page-blocks.js:137,190`, `RaceSignupWidget.jsx:64-142` KIND table, `goals.js:42,56`, `challenge-notifications.js:3`, `customer-notifications.js:20`.
2. Pure renderers gain a `brand` argument: `event-email.js` (`headerBlock`, `buildEventEmailShell`), `race-confirmations.js:364` (`buildConfirmationDefaults(ctx)`), `host-onboarding-email.js` (`renderHostOnboardingEmail`), `hr-analytics.js:198,214`, `hyrox/prompt.js:12,23`, `strava.js:103`, `tcx-builder.js:45`, `hr-post-class-email.js` private helpers.
3. Static `export const metadata` → `generateMetadata` with a lookup (token → location, or host → org via W1.L4): `preferences/[token]/page.js:9`, `preferences/layout.js:20`, `unsubscribe/[token]/page.js:9`, `unsubscribe/host/[token]/page.js:25`, `tv/layout.js:20`, `tv/cast/[token]/page.js:19`, `welcome/page.js:62-67`, `api/preferences/hr-emails/route.js:356`.
4. Missing column in a select: `event/[slug]/page.js:46-58` (add `location_id`), `embed/event/[slug]/page.js:40`.
5. Not-found/catch branches (no row): `embed/event/[slug]/page.js:45`, `start/[path]/page.js:63`, `welcome/[location]/page.js:56`, `welcome/[location]/events/page.js:57` → platform name.
6. Pre-auth host pages (hostname is the only input): `host/login/page.js:40,72`, `host/set-password/page.js:100` → W1.L4 host resolver.
7. Client components fed by a slug/token/id → `brand` in the payload they already fetch: `BookingWidget`, `RaceConfirmedPage`, `HostConnect`, `PreferenceCentre` (org brand: the page lists several locations), `PendingContractsAlert`, `UnsubscribePage`, `WaitlistWidget`, `MemberStatusBadge` (prop from the parent, which has `race.organization_name`).
8. Landing-page chrome: `BlockRenderers.jsx` `LeadFormBlock`/`SiteFooter`/`SiteHeader` gain props from the page's location load; `EditModeOverlay.jsx` gets `locationId` via postMessage later — default to the platform name until it arrives; `LiveTvClient.jsx` `OutroPodium`/`ClassStartIntro` → prop drilling from the parent's `locationId` (payload gains `brand`).
9. Static legal pages with no host branch: `privacy/page.js:58,60,82`, `account-deletion/page.js:51,98`, `terms/page.js` → a tenant variant like `TenantPrivacyNotice` (Wave 3; legal copy is Richard's).

**Observations the sweep must honour:** (1) `UN1T {{location_name}}` sign-offs render "UN1T UN1T Stillorgan" today (location names already carry the brand) — the rule is `locationName`; the brand rows need the new `{{company_name}}` merge tag (`applyMergeTags`, `src/lib/postmark.js:491`, supports only `{{location_name}}` today). (2) `whatsapp.js:1967`'s `location_name` returns the BRAND, email's returns `locations.name` — W1.S3 makes both channels offer both tags. (3) `ClassFunnel.jsx:53` merges DEFAULTS over blank copy, so the "UN1T Stillorgan" consent leaks onto every tenant's `class_funnel` block — W1.S1b makes the defaults functions of the location. (4) Money-rail wording is `platform('Repset')` because the rail IS the platform's today; Wave 2 flips it. (5) The `tv/layout.js:1-4` CHROME.1 note ("UN1T on the gym floor is a locked product decision") is honoured: UN1T's own boards resolve to UN1T's configured brand.

### B. `mobile/` (staff + member screens in the one Repset binary) — 34 bundled rows + 6 store-copy rows

All bundled rows are OTA-publishable (paths are in the `eas-update.yml` allowlist). "[member]" marks member-facing screens inside the staff binary.

| File:line | Literal (short) | Surface | Replacement rule |
|---|---|---|---|
| mobile/app/(member)/(tabs)/home.jsx:832 | `label="UN1T Points"` | member-mobile | productName('Points') |
| mobile/app/(member)/(tabs)/progress.jsx:267 | `label="UN1T Points"` | member-mobile | productName('Points') |
| mobile/app/(member)/(tabs)/progress.jsx:730 | `'sessions trained at UN1T'` | member-mobile | brand(loc) |
| mobile/app/(member)/(tabs)/progress.jsx:731 | `'UN1T Points earned'` | member-mobile | productName('Points') |
| mobile/app/(member)/(tabs)/sessions.jsx:136 | "…zone breakdowns and UN1T Points." | member-mobile | productName('Points') |
| mobile/app/(member)/(tabs)/sessions.jsx:239 | unit badge `UN1T` | member-mobile | productName('Points', short) |
| mobile/app/(member)/account/connect-apple-health.jsx:209 | "Connect Apple Health so UN1T can read…" | member-mobile | brand(loc) |
| mobile/app/(member)/account/connect-apple-health.jsx:234 | "…sync to UN1T automatically." | member-mobile | brand(loc) |
| mobile/app/(member)/account/notifications.jsx:41 | preview "UN1T Strength · 6:30pm tonight at Stillorgan…" | member-mobile | drop prefix; "Stillorgan" → locationName |
| mobile/app/(member)/challenges.jsx:218 | `points: 'UN1T Points'` | member-mobile | productName('Points') |
| mobile/app/(member)/challenges.jsx:350 | `subtitle="Monthly UN1T Points"` | member-mobile | productName('Points') |
| mobile/app/(member)/challenges.jsx:554,573 | `metricLabel === 'UN1T Points'` (logic) | member-mobile | compare on metric KEY, change with :218 |
| mobile/app/(member)/live.jsx:189 | `UN1T Points` heading | member-mobile | productName('Points') |
| mobile/app/(member)/live.jsx:364 | "…zones, UN1T Points and your Burn…" | member-mobile | productName('Points') |
| mobile/app/(member)/sessions/[id].jsx:77-79 | "UN1T Points up/down/steady vs…" | member-mobile | productName('Points') |
| mobile/app/(member)/sessions/[id].jsx:240 | share title `'My UN1T session'` | member-mobile | brand(loc) |
| mobile/app/(member)/sessions/[id]/wrapped.jsx:73 | a11y `${target} UN1T Points` | member-mobile | productName('Points') |
| mobile/app/(member)/sessions/[id]/wrapped.jsx:235 | share title `'My UN1T session'` | member-mobile | brand(loc) |
| mobile/app/(member)/sessions/[id]/wrapped.jsx:316 | `UN1T Points` hero | member-mobile | productName('Points') |
| mobile/app/(member)/wrapped/challenge/[id].jsx:243 | share "…challenge at UN1T 💪" | member-mobile | brand(loc) |
| mobile/app/(member)/wrapped/challenge/[id].jsx:244 | share "… UN1T Points" | member-mobile | productName('Points') |
| mobile/app/(member)/wrapped/month.jsx:59 | a11y `${target} UN1T Points` | member-mobile | productName('Points') |
| mobile/app/(member)/wrapped/month.jsx:207 | share "My {month} at UN1T 💪" | member-mobile | brand(loc) |
| mobile/app/(member)/wrapped/month.jsx:208 | share "… UN1T Points · …" | member-mobile | productName('Points') |
| mobile/app/(member)/wrapped/month.jsx:295 | `UN1T Points` hero | member-mobile | productName('Points') |
| mobile/app/(staff)/assistant/index.jsx:181 | "I'm your UN1T assistant…" | staff-mobile | platform('Repset') |
| mobile/app/(staff)/contracts/[id].jsx:286 | "UN1T Dublin will be notified by email." | staff-mobile | brand(loc) |
| mobile/app/(staff)/contracts/index.jsx:109 | "When UN1T issues you a contract…" | staff-mobile | brand(loc) |
| mobile/app/(staff)/races/scan.jsx:42 | "That's not a UN1T check-in code." | staff-mobile | drop ("not a check-in code") |
| mobile/app/(staff)/(auth)/login.jsx:131 | placeholder `you@un1t.ie` (lower-case, missed by grep) | staff-mobile | platform: `you@example.com` |
| mobile/components/member/BoardsPanel.jsx:183 | `UN1T Points` caption | member-mobile | productName('Points') |
| mobile/components/member/ProfileSetupWizard.jsx:273 | "…flow into UN1T automatically." | member-mobile | brand(loc) |
| mobile/docs/asc-review-notes-repset.md:20 | App Review notes "UN1T gym studios (Dublin, Ireland)" | store-copy | manual ASC edit, Richard; not code |
| mobile/docs/store-release-one-app.md:58,62,71,75,162 | store description "…for UN1T gyms", "train at a UN1T studio", "UN1T account" | store-copy | manual ASC edit, Richard; not code |

Not rows: `mobile/app.config.js` `name: 'Repset'`, `slug: 'un1t-crm-mobile'` (EAS id, never change), `scheme` incl. `un1tapp` (legacy deep links), bundle ids `ie.repset.app` / `com.un1tdublin.crm` — identifiers, native-only, keep. 19 excluded lines (15 comments, 4 internal doc notes).

### C. `shared/` (web + mobile seam) — 9 rows

| File:line | Literal (short) | Surface | Replacement rule | Pair-sync constraint (`tests/shared-pair-sync.test.js`) |
|---|---|---|---|---|
| shared/challenge-wrapped.js:20 | `METRIC_LABEL.points: 'UN1T Points'` | member-mobile | productName('Points') | no src twin |
| shared/customer-notifications.js:20 | push body `` `${n} UN1T Points` `` | customer-push | productName('Points') | `identical` + `twinTests: 'identical'` with `src/lib/customer-notifications.js:20`; both `.test.js` copies assert `'280 UN1T Points · Conditioning'` |
| shared/goals.js:23 | `'UN1T points this week'` | member-mobile | productName('Points') | `diverged`; GOAL_DEFS not on the drifted list → edit `src/lib/goals.js:42` too |
| shared/goals.js:37 | `'UN1T points this month'` | member-mobile | productName('Points') | as above, `src/lib/goals.js:56` |
| shared/hr-analytics.js:198 | "Personal best … — N UN1T Points." | customer-email + member report | productName('Points') | `identical` with `src/lib/hr-analytics.js:198` |
| shared/hr-analytics.js:214 | "In the top N% … — N UN1T Points." | customer-email + member report | productName('Points') | `identical` with `src/lib/hr-analytics.js:214` |
| shared/permissions.js:734 | hint "Notify when UN1T issues you a contract…" | staff-mobile | brand → "your studio" (static hint, no location in scope) | `unrelated` |
| shared/session-history.js:164 | "You've trained N times at UN1T" | member-mobile | brand(loc) | no twin |
| shared/session-history.js:175 | "N UN1T Points earned" | member-mobile | productName('Points') | no twin |

`shared/tv-template.js` has no brand text (pure zone/style). No "UN1T HR" literal exists in `mobile/` or `shared/`. `shared/brand.js` holds only `SUPPORT_EMAIL`; there is no `productName` helper yet (W1.B1 adds `shared/brand-name.js`).

### D. champ-app (`/Users/richardivers/code/champ-app`, Next.js web; its `mobile/` tree is deleted) — 36 rows

| File:line | Literal (short) | Surface | Replacement rule |
|---|---|---|---|
| shared/challenge-wrapped.js:20 | `points: 'UN1T Points'` | shared-helper | productName('Points') (mirror of un1t-crm `shared/`) |
| shared/customer-notifications.js:20 | `` `${n} UN1T Points` `` | customer-push | productName('Points') (byte-identical twin of un1t-crm `src/lib/customer-notifications.js`; unused in champ-app `src/`) |
| shared/goals.js:23,37 | `'UN1T points this week/month'` | shared-helper | productName('Points') |
| shared/hr-analytics.js:198,214 | "… N UN1T Points." | shared-helper | productName('Points') |
| shared/session-history.js:164 | "You've trained N times at UN1T" | shared-helper | brand(loc) |
| shared/session-history.js:175 | "N UN1T Points earned" | shared-helper | productName('Points') |
| src/app/account/integrations/IntegrationsManager.jsx:17 | "…auto-post your UN1T sessions back to Strava" | customer-web | brand(loc) |
| src/app/challenges/ChallengesToggle.jsx:16 | `points: 'UN1T Points'` | customer-web | productName('Points') |
| src/app/challenges/ChallengesToggle.jsx:29 | `metricLabel === 'UN1T Points'` (logic) | customer-web | compare on KEY |
| src/app/challenges/page.jsx:24 | `points: 'UN1T Points'` | customer-web | productName('Points') |
| src/app/challenges/page.jsx:129 | `subtitle="Monthly UN1T Points"` | customer-web | productName('Points') |
| src/app/challenges/page.jsx:281 | `metricLabel === 'UN1T Points'` (logic) | customer-web | compare on KEY |
| src/app/layout.jsx:13 | `title: 'UN1T'` | metadata | brand(loc) with platform default pre-sign-in |
| src/app/layout.jsx:14 | "…account at UN1T." | metadata | brand(loc) with platform default |
| src/app/login/page.jsx:58 | wordmark `UN1T` | customer-web | brand(loc) with platform default pre-sign-in |
| src/app/page.jsx:457 | points unit `UN1T` | customer-web | productName('Points', short) |
| src/app/progress/ProgressView.jsx:129 | `label="UN1T Points"` | customer-web | productName('Points') |
| src/app/sessions/[id]/page.jsx:96 | `unit="UN1T Points"` | customer-web | productName('Points') |
| src/app/sessions/[id]/page.jsx:158-160 | "UN1T Points up/down/steady…" | customer-web | productName('Points') |
| src/app/sessions/page.jsx:75 | "…zone breakdowns and UN1T Points." | customer-web | productName('Points') |
| src/app/sessions/page.jsx:133 | points unit `UN1T` | customer-web | productName('Points', short) |
| src/app/share/[token]/opengraph-image.jsx:21,38 | OG wordmark `UN1T` | metadata | brand(loc) |
| src/app/share/[token]/opengraph-image.jsx:52 | `UN1T pts` | metadata | productName('Points', short) |
| src/app/share/[token]/page.jsx:12 | fallback `{ title: 'UN1T' }` | metadata | platform default (card missing) |
| src/app/share/[token]/page.jsx:13 | `${name} · ${pts} UN1T Points…` | metadata | productName('Points') |
| src/app/share/[token]/page.jsx:16 | "A session at UN1T." | metadata | brand(loc) |
| src/app/share/[token]/page.jsx:30 | wordmark `UN1T` | customer-web | brand(loc) |
| src/app/share/[token]/page.jsx:33 | alt "… UN1T Points" | customer-web | productName('Points') |
| src/app/share/[token]/page.jsx:40 | "Tracked with heart-rate at UN1T." | customer-web | brand(loc) |
| src/app/social/BoardsPanel.jsx:99 | `UN1T Points` | customer-web | productName('Points') |
| src/components/ShareSessionButton.jsx:17 | `title: 'My UN1T session'` | customer-web | brand(loc) |
| src/components/TopBar.jsx:9 | header wordmark `UN1T` | customer-web | brand(loc) (TopBar takes no props → thread `brandName`) |
| src/components/ui/EffortNumber.jsx:5 | `unit="UN1T pts"` | customer-web | productName('Points', short) |

champ-app facts: no brand is read from the DB anywhere (no `company_settings`/`company_name` reference); every page already loads `contacts.location_id` for the signed-in member (`src/app/page.jsx:38,106`, `src/app/challenges/page.jsx:39,69`); `src/lib/load-share-card.js:14` fetches only `contact:contacts(name)` (needs `location_id` added). Test runner: vitest (`npm test -- <path>`). 36 excluded lines (13 docs, 1 package.json description, 22 comments).
