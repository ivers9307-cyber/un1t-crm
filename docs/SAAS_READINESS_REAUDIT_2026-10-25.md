# SaaS and self-onboarding re-audit (2026-10-25)

Scope: un1t-crm at `origin/main` 146316c3 (25 Oct 2026), live Supabase project `iyvtbjjxdggiadzwwvdj`. This re-audits [SAAS_READINESS_REVIEW_2026-10-09.md](SAAS_READINESS_REVIEW_2026-10-09.md) (the 9–11 Oct review and its §3a "What remains"). It adds one question that review did not ask: **can a gym nobody has spoken to sign itself up, pay, set up and run with no help from Richard?**

Method: five parallel read-only code reviews (self-signup journey, Wave 2 money, Wave 3 self-serve gates, operability/namespaces/minors, regressions across the 227 commits since 11 Oct), plus live DB and advisor checks. The two security findings (§2) were re-read by hand against the live function and the route source.

## 0. Headline

**Safe for a concierge-onboarded second gym on the identity side, with two exceptions (PIN login, metadata-trusted signup trigger). Not safe on money. Not self-serve at all.**

- Waves 0, 1 and the timezone wave held. No new cross-*organisation* leak was found in the ORGCONTACTS, WAORGNUMBER or un1t.online work; the org fences there are DB-enforced.
- **Wave 2 (money) has not started.** Since 11 Oct, two new money paths (charity donations, paid trials) copied the same "default to UN1T's Revolut" behaviour.
- **Wave 3 (self-serve) has barely moved.** There is no public sign-up, no recurring billing, no B2B contract acceptance, and no first-run experience. Provisioning, plan pin, bundles, CSV import and a second location all still need a master.
- **New single-tenant surface:** the paid-trial feature (`/trial`) is hard-wired to Stillorgan and Hatch, and its landing block is offered to every tenant.

## 1. Live state (queried 25 Oct)

| Fact | 9 Oct | 25 Oct | Meaning |
|---|---|---|---|
| Organisations / locations | 3 / 6 | 3 / 6 | No new tenant |
| `profile_organizations` (org admins) | 0 | **0** | Every org-level page is still master-only in practice |
| `api_keys` | 0 | **0** | The legacy key is retired in code (APIKEYS.4). **Nothing holds an integration key**, so anything n8n calls on `/api` with a Bearer is being refused. Check n8n. |
| `tenant_domains` | 0 | 3 | The automatic `<slug>.repset.ie` rows, one per org |
| `tenant_email_domains` | 0 | 1 | `un1tdublin.com` is live, with DKIM, Return-Path and webhooks |
| `location_plans` | 1 | 3 | Test Studio, Stillorgan, Hatch. CCF, SourceIt and Pride have no pin, which means free and unlimited |
| `wallets` | 0 | 0 | Metering has never drawn against a wallet |
| `tenant_heartbeats` | 2 crons | 3 crons | glofox-sync, glofox-data-quality, un1t-online-sync |
| Masters | 1 | 1 | Richard |
| Supabase security advisor | 0 ERROR / 2 WARN | 0 ERROR / 2 WARN | Unchanged (`list_enabled_integrations`, `scan_straps_for_contact`) |

## 2. New blockers found in this pass

1. **Studio PIN login crosses tenants.** `findProfileByPin` scans every active profile with a PIN, estate-wide (`src/lib/studio-pin.js:126-149`). `pin-login` mints a studio session, and with `mint_session` real Supabase tokens, for whoever matches. It never checks that person's membership at `device.location_id` (`src/app/api/auth/pin-login/route.js:164-245`). `set-pin` also answers 409 "already in use" estate-wide with no rate limit (`src/app/api/auth/set-pin/route.js:78-85`), which lets anyone learn which PINs exist.
   - Outcome: staff at gym B, on gym B's paired device, can sign in as a gym A staffer.
   - Mitigated today only because device pairing is master-only. It must be fixed before org admins can pair devices.
   - A second problem: once more than 200 profiles hold a PIN, PIN login fails for everyone (`studio-pin.js:139`).
   - Fix: match only profiles with an active membership at the device's location, scope uniqueness per org, and rate-limit set-pin.
2. **`handle_new_user` trusts the `role` in user metadata.** This was verified on the live function. With `invited_for='staff'`, it inserts `profiles.role = raw_user_meta_data->>'role'` and attaches the user to `locations WHERE active LIMIT 1` (arbitrary, no ORDER BY).
   - `/api/staff` is the only legitimate writer. But if Supabase Auth's public sign-up is ever on, `supabase.auth.signUp({ options: { data: { invited_for: 'staff', role: 'master' } } })` mints a **master**.
   - The clients use `shouldCreateUser:false`, but the dashboard setting decides, and it could not be read from here. **Confirm "Allow new users to sign up" is off in Supabase Auth now.**
   - Change the trigger to ignore the metadata role (the invite route can set the role server-side after creating the user) before any self-signup work starts.

## 3. Self-signup journey (new in this audit)

| Step | Status | Evidence |
|---|---|---|
| Public SaaS marketing/pricing page | Missing | No pricing/signup route; no repset.ie marketing brand in `src/lib/brands.js`. A site outside this repo was not checked. |
| "Create account / start trial" | Missing | Login OTP `shouldCreateUser:false` (`src/app/login/page.js:128`; mobile `auth-context.jsx:141-159`); no `signUp(` anywhere. `/trial` is UN1T's member funnel. |
| Create org + location + owner + org admin | Master-only | Wizard `admin/tenants/new/page.js:29`; `POST /api/admin/organizations:69`; `POST /api/locations:72` (an owner cannot add a 2nd studio); `PUT /api/staff/[id]/org-admin:37`. |
| Plans, pricing, pin | Master-only | `/api/admin/plans*`, `/api/admin/tenants/[orgId]/plans:69`. `plan_versions.currency CHECK = 'EUR'` (mig 413:55). |
| Unpinned location | Free and unlimited | `src/lib/plans.js:5-9`, `wallet-enforcement.js:6-10`. Only org hard caps apply. |
| Recurring subscription / card / trial / dunning | Missing | No Stripe subscription code. `executeAutoTopup` is a stub (`wallet-topup.js:32-35`). The MSA draft promises "30-day trial, card up-front"; nothing implements it. |
| Wallet top-up | Org admin, once pinned | `/settings/billing`; one-off Checkout, 23% IE VAT, seller "Champ Fitness Ltd (trading as UN1T Dublin)" (`wallet-topup.js:50-63`). |
| B2B terms / DPA acceptance | Missing | `/terms` is a consumer/platform mix; MSA and DPA are solicitor drafts with `[SOLICITOR]` gaps (`docs/compliance/`); nothing records acceptance. Sub-processor page lists UN1T-only vendors (Glofox, Zoom). |
| Feature bundles | Master-only | New location: messaging/sales/members ON; money, marketing, team, operations, cars OFF (`location-seed.js:68-89`). Only `canEditLocationFeatures` (master, `staff-access.js:185`) or a master plan pin turns them on. |
| First-run checklist, sample data, help docs, support channel | Missing | Only the assistant's "Help me get started" prompt. Support sessions are master-initiated. |
| Integrations hub | Owner / org admin | Good: WhatsApp, Glofox, un1t.online, Xero, Stripe Connect, Meta Ads, Shelly, Instagram (pasted token). UniFi, AC, BCA are a master-only tier hidden from tenants. |
| `<slug>.repset.ie` | Automatic, but created at master org creation | `admin/organizations/route.js:103`. CRM itself stays on crm.repset.ie. |
| Custom domain | Master-only + manual Vercel/DNS | No `api.vercel.com` call in `src`. |
| Suspend / cancel / export / delete | Master-only / missing | Suspend shows staff no message; no tenant cancel; org export and deletion are runbook SQL (`docs/runbooks/tenant-offboarding.md`). |
| Staff and member app | One "Repset" binary, runtime brand | Works for a tenant once their staff are invited. Android id `com.un1tdublin.crm` kept by decision. |

## 4. Status of the 11 Oct "What remains" list

### Wave 2: money (B7): still open, and spreading

| Item | Status | Evidence |
|---|---|---|
| Offer checkout | Open (interim pin) | `offers-home.js:7,19-21` pinned to Stillorgan; checkout calls `revolut.createOrder` directly with `UN1T — …` (`api/public/offers/[slug]/checkout/route.js:68-96`). It never calls the resolver. |
| Internal events, races, race gap | Open | `event-hosts.js:38-43` → `revolut` when no host; `race-payments.js:166-189`, `race-gap-payment.js:164-173`. |
| Car deposits | Open | `accept-and-pay/route.js:146-160` calls `createOrder` directly, `'EUR'`. CCF Autos is a separate company settling into UN1T's merchant. |
| Default class-pay | Open (brand fixed) | `location-payments.js:10-21`: anything not Stripe → Revolut, `canTakePayments` always true. |
| Hosted-event application fee / `revolut` host option | Open | `stripe-connect.js:114-126`; `hosts/route.js:35` accepts `revolut` from any org's manager, who also sets `platform_fee_cents`. |
| **New: charity donations** | Same flaw | `donation-payments.js:72-91`: donor money for any org's internal event → UN1T Revolut. |
| **New: paid trials (Stillorgan)** | Same flaw, UN1T-only today | `trial-purchase-payments.js:28-42`; also no `un1t_trial_purchase` branch in the Stripe webhook (`webhooks/stripe/route.js:117,145`). |
| **New: Integrations hub** | Misleading | `integrations-hub.js:200-207` shows Payments "connected" for every location because the platform is the merchant. |
| Hatch via un1t.online | OK | Money goes to un1t.online on the studio's own token. |
| Org-aware "no provider" refusal | Nowhere | Root cause. Fix in `resolveLocationPaymentProvider` / `resolvePaymentProvider`, then reroute offers and car deposits (which bypass the resolvers), then gate the `revolut` choice to UN1T Group in `stripe-connect/select/route.js:42` and `hosts/route.js:35`. |
| Minors | Open | `country:'IE'` default (`stripe-connect.js:27`); EUR fallbacks in 5 payment libs + migs; € in 73 lib files; cars 23% VAT. |

### Wave 3: self-serve: mostly still master or SQL

Closed since 11 Oct: Glofox trial membership/plan picker, Meta dataset id + CAPI token, un1t.online connect and sync (owner), Stripe Connect onboarding, Xero, Shelly, org WhatsApp numbers (org admin), contract template creation (org admin), wallet top-up (org admin).

Still master-only, in the order a migrating gym hits them:
1. Plan pin and bundle/feature toggles (`/admin/matrix`, `locations/[id]/features`).
2. Contacts CSV import, commit, rollback (`contacts/import/preview:55`, `commit:49`, `imports/[id]/rollback:44`), and the marketing-preferences import.
3. Glofox operator tools (bulk-sync, sync-member, probe, ping, reconcile-arrears/fees, payments-report, bookings/cancel, invoice CSV import).
4. Adding a second location; granting org admin to a co-owner.
5. Custom domain.
6. UniFi, AC credentials and devices, BCA, studio devices, trusted IPs, bridges.
7. Achievement rules, still a global table (`slug UNIQUE`, no org column, mig 116).
8. `/admin/health`; `settings/audit-log` page (its API admits owners, the page does not).
9. un1t.online write switch and trial product (`un1t-online/route.js:276`): fine while un1t.online is UN1T's own platform.

Still SQL-only: `landing_page_settings.public_path` (no public landing page without SQL), `settings.whatsapp_flow`, `settings.inbody.accounts`.
Still a code constant: the site-wide Meta pixel and the Hatch pixel (`src/lib/meta-pixel-paths.js:11-18`), loaded by the cookie banner on every tenant's pages.
Still manual: Instagram (pasted token, no `subscribed_apps`); Postmark inbound address and sender signatures not surfaced.
No starter contract templates are seeded.

The census counted about 56–58 route files with a hard master-only 403. About 28 of them are platform `/api/admin/*`; the list above is the subset a tenant needs.

### Wave 5: operability and namespaces: not started

- Per-tenant heartbeats: 3 of at least 19 per-location crons. Tenant integration health reads the **global** `cron_health` view (`integration-health.js:323`), so a tenant sees estate-wide job state, never its own. There is no org-admin health view.
- Ops alerts: `sendOpsAlert` is per org (7 callers). `fleet-health` still emails and pushes every master (`cron/fleet-health/route.js:518-563`).
- Glofox crons walk studios in fixed id order under one time budget, so a second Glofox studio can starve (`glofox-attendance-refresh:99-104`, `glofox-detail-backfill:93-98`). Discovery through the connection registry is closed.
- Global unique keys unchanged: `event_types.slug`, `sale_offers.slug`, `landing_page_settings.public_path`, `race_events.slug` (made global by mig 451), `event_hosts.slug`, `locations.slug`. Squattable once orgs self-serve. `email_mailboxes` address stays global by design.

### Minors

| Item | Status |
|---|---|
| Legacy `CRM_API_KEY` | **Closed** (APIKEYS.4, #1982), but see `api_keys = 0` in §1 |
| Host re-invite (#2011) | **Closed** |
| `/live` TV display button | **Closed** (#1975) |
| Welcome greeting ignores `agent_name` | **Closed** |
| Invite hint in user metadata, not `app_metadata` | Open (`staff/route.js:185`, `hosts/[id]/invite/route.js:99`). Ties into §2.2 |
| `car_enquiries` has no tenant column | Open |
| Suspended-org message | Open |
| Mia test allowlist (last 9 digits = Irish) | Open (`agent/core.js:43-53`) |
| `'un1t'` membership provider | Open (resolves to `none`; `un1t_online` is real) |
| `purge-spam-mail` stamps `purge-spam-tickets` | Open, cosmetic |
| Android `com.un1tdublin.crm` | Kept by decision |

## 5. Regressions since 11 Oct (227 commits)

1. **Paid trial is UN1T-only by construction.**
   - `/trial` pins `STILLORGAN_LOCATION_ID`, `UN1T_GROUP_ORG_ID`, the slugs `stillorgan`/`hatch-street`, a Supabase hero URL and the title "The UN1T Trial" (`src/app/trial/page.js:35-112`).
   - The API takes `z.enum(['stillorgan','hatch'])` and switches the provider on `studio.key === 'hatch'` rather than `membership_source` (`api/public/trial-purchases/route.js:42,78-288`; `trial-studios.js:10-11`).
   - `/trial` is missing from the tenant-domain allowlist (`tenant-domains-edge.js:121-128`).
2. **The "Paid trial product" landing block is offered to every tenant** (`landing-page-blocks.js:318`), but only `/trial` reads it.
   - Its defaults name Stillorgan and "UN1T Hatch Street" (`landing-page-blocks.js:225,256`; `paid-trial.js:12-13`).
   - It sends Meta `https://www.un1tdublin.com/trial` as a fallback source URL (`paid-trial.js:105`).
   - Both undo W1.S1b's "no default names a gym".
3. **Charity donations** shipped on the UN1T Revolut default (§4, Wave 2).
4. **Integrations hub** shows UN1T's merchant as the tenant's connected payments (§4, Wave 2).
5. Cosmetic staff copy: "Hatch payments and booking" (`hatch-copy-fields.js:15`), "(Hatch Street)" in `CustomerAgentClient.jsx`, "e.g. 'Stillorgan mobile'", default template names `hatch_trial_done_*`.

Verified clean: un1t.online branches key on per-location `membership_source` and switches, never the Hatch id. New public pages (`/h/[slug]/join`, `/book/manage/[token]`, `/pay-done/[token]`) are tenant-resolved and on all four allowlists. About 20 new routes were spot-checked for scoping; none leaked. No new `'Europe/Dublin'` literal or `dublin-time` import.

## 6. What onboarding gym #2 takes today

Concierge (Richard): (1) wizard: org, location, timezone, owner invite with org admin, `<slug>.repset.ie`; (2) pin a plan, which also turns its bundles on, or flip bundles at `/admin/matrix`; (3) upload logo; (4) set `public_path` and any `whatsapp_flow` / `inbody` settings in SQL; (5) run the contacts CSV import, or the Glofox bulk sync, for them; (6) custom domain in Vercel + DNS if wanted; (7) AC/UniFi/devices if wanted; (8) tell them that offers, internal events, races, donations, car deposits and default class-pay settle to UN1T's Revolut unless they connect Stripe, and that a Stripe-connected manager can still switch back to Revolut; (9) no contract or DPA is signed and nothing bills them.

Self-serve by the owner after that: WhatsApp embedded signup, Glofox or un1t.online connect, Xero, Stripe Connect, Meta Ads, Shelly, Instagram (token), email domain (on a paid plan), staff invites, contract templates, wallet top-up.

## 7. Suggested order

1. **Now (small, security):** confirm Supabase public sign-up is off; stop `handle_new_user` trusting the metadata role; fix PIN login (membership at the device's location, per-org uniqueness, rate-limit set-pin). Check what n8n is using now that `api_keys` is empty.
2. **Wave 2: money.** Org-aware resolvers returning "none" outside UN1T Group; reroute offers, car deposits and donations; gate the `revolut` choice; decide the hosted-event fee; fix the hub's Payments grade; add the Stripe trial webhook branch.
3. **Wave 3a: the tenant can run itself once created.** Org-admin bundle/feature toggles, CSV import, Glofox bulk sync and reconcile, add a location, grant org admin, a `public_path` editor, a per-tenant pixel setting, and starter contract templates. Make the paid-trial block hidden or brand-neutral outside UN1T.
4. **Wave 3b: self-signup and commercial.** Decide the selling entity (Repset vs Champ Fitness "t/a UN1T Dublin"), currency and VAT. Then: Stripe subscriptions with trial and dunning; a public sign-up that creates the user server-side and runs the wizard's steps; B2B terms and DPA acceptance recorded per org; a first-run checklist; tenant cancel and export.
5. **Wave 5: operability.** Per-tenant heartbeats on every per-location cron and a tenant health view from `tenant_cron_health`; per-org fleet alerts; rotate the Glofox studio budget; scope the six global slugs.

## 8. Limits

Not checked: the Supabase Auth dashboard settings, any repset.ie site outside this repo, n8n's current configuration, champ-app beyond the shared seam, and live `locations.settings.payments` values. The census of master gates is a grep-plus-read of 131 files; treat counts as approximate.
