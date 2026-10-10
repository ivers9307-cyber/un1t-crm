# SaaS readiness review — fresh, code-grounded (2026-10-09)

Scope: un1t-crm at `origin/main` (c91ae071, 9 Oct 2026), live Supabase project `iyvtbjjxdggiadzwwvdj`, Vercel project `un1t-crm`, plus champ-app and the mobile app at the shell level. Question: can a second gym be onboarded into its own segmented environment with its own connections, and what is left before that is smooth? Method: ten parallel code reviews, one per hub, against one rubric (isolation, configuration, hard-coded tenant assumptions, onboarding path, seeded defaults), with every blocker-class claim re-verified by hand, plus live DB, Supabase advisor and Vercel checks. Prior reviews were not consulted for findings.

> **Status 10 Oct 2026:** Wave 0 (blockers 1–6, 9–11 and the five small holes) is delivered — see the dated block under [§3 Blockers](#blockers-fix-before-any-second-gym-has-staff-or-customers). Blockers 7 and 8 are deferred to Waves 2 and 1 as planned. The analysis below is left as written on 9 Oct.

## 0. Headline

**The goal is achievable and the architecture is already tenant-shaped. It is not yet safe to put a second gym on, and it is not yet smooth.**

What is sound:
- The tenant boundary (`location_id`, with `organizations` above it) is applied with real discipline. Across 852 API routes and 195 pages the ten reviews found **no bare-id IDOR in any staff route in any hub**: every detail route loads the row and checks its location or org. The three CI tripwires pass on main.
- Provider connections are per location in the DB (Glofox, WhatsApp numbers, Xero, Instagram, Shelly, Sonos, mailboxes, ad accounts), inbound webhooks resolve the tenant from the provider's identifier and drop unknowns, and the old "fall back to UN1T's WhatsApp number" tier has been retired.
- Xero, WhatsApp (embedded signup), Shelly, Sonos, TV displays, equipment, checklists, issues, automations, ads and Instagram feed are genuinely self-serve for a location owner.
- An org tier (org admins, org settings, org branding, legal entity, per-org Postmark server, per-org API keys, plans, wallets, metering, tenant domains, tenant wizard, admin health roster) exists in code.

What blocks a second gym today, in three families:
1. **Cross-tenant leaks** (nine, all verified): the legacy shared API key reads and writes every tenant; a WhatsApp message to gym B from someone who is already a UN1T contact is filed in UN1T's inbox and answered from UN1T's number; any event flagged "shared" appears on every tenant's staff list and public events page; the public `/offers` page lists every tenant's offers under a UN1T header; UN1T's staff handbook and privacy notice are served to every tenant's staff; a global unique index on contact email makes gym B silently lose a lead whose email exists at gym A and leaks existence; the weekly receipt-coverage email aggregates every tenant's bank anomalies to one env recipient; the settings/notifications page lists every tenant's locations; the live heart-rate board is public by bare location id.
2. **Money and identity are UN1T's**: offers, car deposits, internal events and races, and class-pay by default settle into the platform Revolut merchant; every email sends from the shared Postmark server as "UN1T" with links on crm.repset.ie, because the per-org sending domain feature is gated behind a plan pin, an org-admin grant and an env var that no org has, and a tenant Postmark server is created with no webhooks.
3. **Nothing is self-serve at the org level**: creating an org or location, granting the first org admin, pinning a plan, flipping feature bundles (money, marketing, team, operations are seeded OFF), CSV import, Glofox ops tools, AC/UniFi credentials, studio devices, bridges, contract templates and the custom domain all require Richard, and the wizard never grants the owner org-admin.

Two structural constraints to decide on rather than fix piecemeal: the platform is **Ireland/UK-time only** (`Europe/Dublin` hard-coded in 113 server files, honoured per-location in only a handful), and **Glofox is the only membership source** (a non-Glofox gym gets a contact CRM, HR floor and fitness hub, but no memberships, arrears, churn radar, class schedule, attendance credits or trial credits).

Rough scale, for planning:

| Severity | Count | Nature |
|---|---|---|
| Blocker | 11 | cross-tenant leaks, money routing, email identity |
| Major | ~45 | master-only gates, UN1T brand fallbacks, timezone, Glofox-only paths, seeding gaps |
| Minor | ~35 | copy, labels, defaults, namespaces |

## 1. Foundation facts (verified)

### Tenancy model
- `organizations` → `locations` (`location_id` is the tenant boundary on 172 of 265 public tables; 17 tables carry `organization_id`; ~40 child tables scope through a parent; ~35 are platform/global by design).
- Live: 3 orgs (UN1T Group ×4 locations incl. Test Studio and the Pride Training Club host anchor; CCF Autos ×1; Givers Consultancy ×1 "SourceIt"). All six locations are `IE` / `Europe/Dublin`. The two non-UN1T orgs are not gyms and run with nearly every feature off, so no gym applet has ever been exercised by a real second tenant.
- Roles per location (`profile_locations`), `master` = platform super-admin, `org_admin` grants (`profile_organizations`) gate org-level settings. Every `/api` route and server page uses the service-role client; RLS is browser-only defence; app-code scoping is the real boundary. `check-location-scoping`, `check-route-guards`, `check-rls-restrictive` pass on main. All tables have RLS on; 104 have RLS with zero policies (deny-all for browser roles). Supabase security advisor: 0 ERROR, 2 WARN (audited RPCs used by champ-app).

### SaaS machinery that exists in code
Tenant wizard `/admin/tenants/new`; `tenant_domains`; `org_settings` (branding, AI/email hard caps, ops alert emails, legal entity); `tenant_email_domains` (per-org Postmark server, own sending domain, DKIM/Return-Path verification UI); `plans`/`location_plans`/`wallets`/`usage_events`/`usage_rollups_daily`; per-org `api_keys`; `tenant_heartbeats`; `/admin/tenants`, `/admin/health`, `/admin/matrix`; support sessions and impersonation; feature bundles on `locations.features`; per-location seed (acquisition pipeline + 11 funnel stages + bundle flags).

### SaaS machinery never exercised live
| Table | Rows | Meaning |
|---|---|---|
| `tenant_domains` | 0 | no tenant has ever had its own hostname |
| `tenant_email_domains` | 0 | every tenant sends from the global Postmark server as `POSTMARK_FROM_EMAIL` |
| `wallets` | 0 | no tenant has a wallet; metering has never drawn against one |
| `location_plans` | 1 | one pin platform-wide |
| `profile_organizations` | 0 | no org admin exists; every org-level page is reachable only by the master account |
| `api_keys` | 0 | the legacy shared `CRM_API_KEY` is the only API credential in use |

### Global unique keys with no tenant column (cross-tenant collisions)
`contacts(email)` · `event_types(slug)` · `race_events(slug)` · `sale_offers(slug)` · `event_hosts(slug)` · `email_mailboxes(lower(address))` · `landing_page_settings(public_path)` · `locations(slug)` · `profiles` PIN hash. The contacts one is the serious one (see Blocker 6). The slugs are collision-safe (suffixing or a raw error) but one shared namespace: two gyms cannot both have `/book/free-consultation`.

### Hostnames
Vercel `un1t-crm` carries 13 fixed domains and **no wildcard**. A `tenant_domains` row does not make a hostname resolve; each tenant hostname is a manual Vercel + DNS step, and the wizard says so. A tenant domain only serves a short public allowlist (`/welcome`, `/book/`, `/event/`…) and rewrites everything else to `/welcome`; the CRM, login, invite links and every outbound URL (`getAppUrl()` = `NEXT_PUBLIC_APP_URL`) stay on crm.repset.ie.

### Time zone and locale
`src/lib/dublin-time.js` hard-codes `Europe/Dublin` and is imported by 113 non-test files; the zone-aware `src/lib/tz-time.js` by 14. `locations.timezone` exists but is read by few paths (push reminders, Shelly, checklists, geofence, roster runway, qualification digest). New locations default to `Europe/Dublin`/`IE`. EUR is assumed everywhere (no currency column on locations or organizations). Bank holidays are per `locations.country` (IE/GB/DE/AU/MT), the one place the locale is modelled properly.

## 2. Per-applet verdicts

| Applet | Verdict | Headline |
|---|---|---|
| Auth, tenant resolution, admin | READY-WITH-CAVEATS | isolation solid; shared host, first-row branding, single-host links |
| Tenant wizard, domains, plans, wallet | READY-WITH-CAVEATS | master-only concierge; wizard never grants org_admin; no Vercel API |
| API keys | NOT READY | legacy `CRM_API_KEY` is live and unscoped |
| Messages: inbox, WhatsApp, Mail, IG | READY-WITH-CAVEATS | one blocker in WA inbound routing; mail inbound contact match crosses tenants; Flow config SQL-only |
| Sales: pipeline, leads, booking widget | READY-WITH-CAVEATS | classifier is Glofox-shaped; global email/slug collisions; `public_path` SQL-only |
| Public funnel: /start, /free-class, /offers | UN1T-ONLY | `/offers` lists every tenant; offers money → UN1T Revolut |
| Members: contacts, Glofox, churn, HR | READY-WITH-CAVEATS (Glofox gyms) / NOT READY (non-Glofox) | CSV import master-only; achievement rules global; "UN1T Points" everywhere |
| Money: invoices, Xero, payables | READY-WITH-CAVEATS | Xero is the model self-serve integration; inbound invoice domain is UN1T's |
| Money: orders, Revolut, recon | NOT READY | single Revolut merchant; cross-tenant coverage report |
| Cars | READY-WITH-CAVEATS | off for gyms; CCF-shaped |
| Marketing: campaigns, sequences | isolation READY / identity NOT READY | sends as UN1T from crm.repset.ie; tenant email domain unreachable; new server gets no webhooks; templates are UN1T copy |
| Marketing: automations, ads, IG feed | READY | clean per-location config |
| Marketing: landing/welcome/hostnames | UN1T-ONLY today | master-only domains; UN1T metadata; first-row favicon |
| Team: staff, roster, attendance | READY-WITH-CAVEATS | bundle_team OFF + master-only flip; staff emails from UN1T sender; Dublin day math |
| Team: contracts / policies | READY-WITH-CAVEATS / NOT READY | contracts need org_admin + no templates; policies are global UN1T docs |
| Operations: TV, Sonos, Shelly, equipment | READY-WITH-CAVEATS | self-serve; Sonos ignores tenant tz; public live board by bare location id |
| Operations: AC, UniFi, studio devices | READY-WITH-CAVEATS | per-location but master-only to configure; automation device ids unvalidated |
| Operations: Pi fleet, bridges, straps | UN1T-ONLY (by design) | platform tailnet; Richard images Pis |
| Events, races | READY-WITH-CAVEATS | `shared` flag is global; brand UN1T in every customer touchpoint |
| Events: payments | NOT READY | internal events → UN1T Revolut; application fee → UN1T Stripe |
| Host portal | READY-WITH-CAVEATS | org-fenced; UN1T chrome; host domains under un1tdublin.com |
| Mia (customer agent) | READY-WITH-CAVEATS | per-location, metered, capped; says "UN1T" until branding set; Glofox named in prompt; Dublin quiet hours |
| Staff assistant | READY-WITH-CAVEATS | scoped; UN1T/Glofox/EUR vocabulary |
| Crons (79) | mixed | ~14 Glofox-only; ~15 Dublin-fixed decisions; only 2 stamp per-tenant heartbeats |
| Webhooks (25) | READY-WITH-CAVEATS | per-provider identifiers; silent drop on unknown; Strava POST unauthenticated |
| Mobile staff app | READY-WITH-CAVEATS | Repset shell; member-facing copy says UN1T |
| champ-app (member app) | UN1T-ONLY (by design) | single brand, "UN1T Points" |

Evidence for every row is in the per-applet notes that follow.

### Foundation, onboarding, settings, admin
- Links: `getAppUrl()` ignores `tenant_domains` (src/lib/app-url.js:16-25). Every emailed or WhatsApp link, invite redirect, unsubscribe, calendar feed and digest link is minted on crm.repset.ie.
- Shared chrome: login/reset fall back to "UN1T" and "UN1T CRM v1.0" (src/app/login/page.js:238; src/app/reset-password/page.js:169,250); anonymous branding, default site name and favicon come from the first `company_settings` row estate-wide (src/app/api/public/branding/route.js:30-35; src/lib/default-site-name.js:20-25,44-48; src/lib/default-favicon.js:52-70). The Supabase invite/recovery email is one project template.
- Wizard: org, location and tenant-domain creation are master-only; the owner is invited as a location `owner`, never `org_admin` (src/components/admin/TenantWizard.jsx:231), so the new owner cannot reach billing, API keys, email domain, usage caps, org branding, contracts or the device fleet. The org-admin grant is a separate master-only route (src/app/api/staff/[id]/org-admin/route.js:37).
- Seed: pipeline + stages + bundles only; messaging/sales/members ON, money/marketing/team/operations/cars OFF; feature flips are master-only (src/lib/staff-access.js:185-188). No `company_settings`, `notification_config`, quiet hours, templates, plan or wallet.
- Billing: top-ups go through Stripe Checkout on the platform account, EUR, 23% VAT, selling entity "Champ Fitness Ltd (trading as UN1T Dublin)" (src/lib/wallet-topup.js:59-62,172-180); no subscriptions; enforcement only binds pinned locations (src/lib/wallet-enforcement.js:7-11).
- Leaks: `/settings/notifications` lists every active location on the platform and counts every profile, gated only by the `settings` permission (src/app/settings/notifications/page.js:51-60,143-150). Policies hub returns every policy to every signed-in user (src/lib/policies.js:38-46).
- Org suspend flips rows inactive but staff still log in to an empty shell with no message.

### API keys
- Per-org `unitk_` keys are scoped via `orgScopeLocationIds` on 11 routes and have no scopes column (full org read/write).
- The legacy shared `CRM_API_KEY` is accepted by the proxy (src/proxy.js:286-289) and by `authenticateApiKey` with `orgId:null` (src/lib/api-auth.js:233-236); every scoping helper no-ops on null, so `GET /api/contacts`, `/contacts/[id]`, `/contacts/search`, `/deals`, `/bookings`, `/campaigns`, `/tasks`, `/activities`, `/notes`, `/stages`, `/locations`, event types return all tenants' rows and `POST` writes into any location (src/app/api/contacts/route.js:166-169; src/app/api/deals/route.js:41).

### Messages hub
- WhatsApp inbound: the contact is matched by phone across the whole estate with no org filter, preferring the receiving location, else the oldest match anywhere (src/app/api/webhooks/whatsapp/route.js:233-241; src/lib/whatsapp.js:2055-2062); the thread is then filed at that contact's location if it has a number (route.js:284-293). A UN1T contact texting gym B is answered by UN1T.
- WhatsApp config, templates, broadcasts are properly per-location; no number → 409 "No WhatsApp number is connected at this location"; embedded signup is owner self-serve. `{{location_name}}` merge falls back to "UN1T" (src/lib/whatsapp.js:1967). Broadcast send window defaults to Dublin, not `locations.timezone` (src/app/api/whatsapp/broadcasts/route.js:144).
- WhatsApp Flows: one platform keypair; `settings.whatsapp_flow.flow_id` has no writer (SQL only); public-key registration on the number is a manual Graph call; an unmatched flow or number event pushes an alert to every location that owns a number (src/lib/whatsapp-flow-events.js:53-56; src/lib/whatsapp-number-events.js:209-211).
- Mail applet: inbound contact link by From address is estate-wide with a location preference (src/app/api/webhooks/postmark-inbound/[token]/route.js:893-900; src/lib/email-inbox.js:175-187), so a foreign tenant's contact id can be stamped on a thread. Outbound on a Postmark sender-signature 422 silently falls back to "UN1T <hello@un1t.ie>" (src/lib/email-inbox-send.js:150-156,229-245). IMAP/SMTP/OAuth mailboxes are owner self-serve; Postmark ingress needs Richard (token and forwarding address are shown nowhere).
- Instagram DM: per-location token paste, but no Meta login or `subscribed_apps` call, so attaching a tenant's IG account to the Meta app is manual.
- Email templates: `/api/templates/[id]` skips both the location and the permission check when a template's `location_id` is NULL (src/app/api/templates/[id]/route.js:42-46,61,89; src/lib/auth.js:835).
- Quiet hours evaluate in Dublin regardless of `locations.timezone` (src/lib/send-quiet-hours.js:35,147,230).

### Sales hub and public funnel
- Pipeline and deals are correctly scoped; the classifier and lead radar key entirely on Glofox columns (shared/pipeline-classifier.js:149,218,281; src/lib/lead-radar-data.js:41), so a non-Glofox gym's contacts sit as leads forever.
- Public lead and class-booking forms resolve the tenant from `landing_page_settings.public_path`, which no API or UI can write (src/app/api/landing-page-settings/route.js:60-100; set only by migration SQL). On a cross-org duplicate email the form returns null and the lead is silently dropped (src/lib/race-contact-linking.js:163-171). Default tag and source are "hatch-founding-member"/"hatch_launch" (src/lib/leads.js:10-11); Meta CAPI source URL is un1tdublin.com (src/app/api/public/leads/route.js:107-109; src/lib/class-booking-processor.js:594).
- Booking widget `/book/[slug]`: slug is globally unique with a raw error on collision (src/app/api/bookings/event-types/route.js:85-100); the widget says "Powered by UN1T" and "send me UN1T promotional updates" (src/components/BookingWidget.jsx:299,557); the booking trigger's email match fails the insert for an email owned by another org (mig 336:37-40).
- `/offers` selects every active `sale_offers` row with no location filter under a "UN1T STILLORGAN" header (src/app/offers/page.js:115-140); checkout is always the platform Revolut merchant with description "UN1T — …" (src/app/api/public/offers/[slug]/checkout/route.js:62-68). `/start` and `/free-class` are Stillorgan literals. A tenant domain's default allowlist omits `/start`, `/free-class`, `/offers`, `/class-pay`, `/unsubscribe/`, `/preferences/`, `/view-email/`, `/h/` (src/lib/tenant-domains-edge.js:52,83). Meta pixel ids are code constants (src/lib/meta-pixel-paths.js:11-17); the cookie banner loads UN1T's pixel site-wide (src/components/CookieConsent.jsx:9,33).

### Members hub
- Contacts: every detail route is scoped; merge and link refuse cross-location pairs. CSV import, commit and rollback are master-only (src/app/api/contacts/import/preview/route.js:55). `POST /api/contacts` returns the raw Postgres unique-violation text (src/app/api/contacts/route.js:101-102), an existence oracle across tenants. `/account-deletion` is UN1T legal copy with a mailto (src/app/account-deletion/page.js:50-58,98-113).
- Glofox: connection is owner self-serve; the webhook verifies HMAC against that location's own secret; crons skip unconfigured locations cleanly. Every operator tool under `/api/glofox/*` (bulk sync, sync member, payments report, reconcile, probe) is master-only. Four crons discover locations through the legacy `settings.glofox` slice; the write path still dual-writes it, so this is latent, not live.
- Non-Glofox gym: `contacts.glofox_*`, `trial_credits_remaining`, `last_attended_at`, `class_bookings`, `class_occurrences`, `glofox_invoices` and identity statuses are written only by Glofox sync. No alternative membership source exists in src. Churn radar, membership trend, attendance credits, trial credits, class-driven automations (climate, Shelly rules, hyrox) and Mia's booking tools are all empty or hand off.
- HR floor: bridge tokens bind a location correctly; `achievement_rules` is global with a master-only editor (mig 116:41-45; src/app/achievements/page.js:49); "UN1T Points" / "Welcome to UN1T HR" is in the post-class email, insights, push copy and TV boards (src/lib/hr-post-class-email.js:261-448; src/lib/customer-notifications.js:20). Bridge provisioning is master-only. InBody account→location mapping has no UI and a single shared webhook secret.
- champ-app binds a member to their location correctly but is single-brand (title "UN1T", "UN1T Points", `un1t-*` tokens).

### Money hub and Cars
- Invoices, contractor bills, expenses, payables, card receipts: all scoped on the row's location. Inbound invoice address domain is hard-coded `mail.un1tdublin.com` and shown to operators (src/lib/inbound-invoices.js:22,77; src/components/InvoicesInbox.jsx:441).
- Xero is the model: per-location OAuth on the platform app, owner connects, picks the org, sets the bills address, refuses orgs held elsewhere; webhook maps by resource id. EUR/OUTPUT2 fallbacks only.
- Revolut: one merchant (src/lib/revolut.js:33-41). Flows that settle into it: paid class intro unless the location opted into Stripe Connect (src/lib/location-payments.js; src/lib/class-booking-payments.js:24-25), offer checkout always, internal (non-host) events and races always (src/lib/event-hosts.js:39; src/lib/race-payments.js:159-161), car deposits always (src/app/api/public/deposit/[token]/accept-and-pay/route.js:146-148). Only hosted events and opted-in class-pay reach the tenant.
- The weekly receipt-coverage report iterates every `xero_connections` row and emails one combined report, with a section per location across all tenants, to `RECEIPT_COVERAGE_REPORT_TO` (src/app/api/cron/receipt-coverage-weekly/route.js:65-89; src/lib/recon/report-email.js:139-147).
- Cars is off for gyms via `module_cars` (seeded off; pre-seed locations with `{}` features have it on). `car_enquiries` has no location and is read nowhere. BCA config is master-only; deposit links live on pay.ccfautos.com for every tenant.

### Marketing hub
- Campaign and broadcast isolation is good (per-location access, audience view, fair round-robin, per-location bundle gate).
- Sender identity: with no `tenant_email_domains` row the From is the operator-typed name (editor default "UN1T", placeholder hello@un1t.ie, src/components/CampaignEditor.jsx:39,1150), else `POSTMARK_FROM_EMAIL`, else "UN1T <hello@un1t.ie>" (src/lib/postmark.js:275,394), on the shared server. A tenant typing its own From fails at Postmark with no warning. Unsubscribe, preferences and view-in-browser links are always on `NEXT_PUBLIC_APP_URL` (src/lib/campaign-sender.js:736,768,778) and the pages carry UN1T copy (src/components/PreferenceCentre.jsx:147,219).
- Tenant email domain: a good design (own domain, DKIM TXT + Return-Path CNAME at the tenant's registrar, verify button) that is unreachable: gated on `isOrgAdminSomewhere` (0 grants), on a plan add-on `custom_email_domain` that no org is pinned to (src/lib/tenant-email.js:137-154, whose own comment says "the whole feature is unreachable"), and on `POSTMARK_ACCOUNT_TOKEN`. `createTenantServer` registers no webhooks (src/lib/postmark-account.js:152-160), so a tenant on its own server gets zero bounce/open/spam events and list health, bounce escalation and stats read 0; suppression sync and consent drift use the global token only (src/lib/postmark-suppressions.js:79,162,195).
- Sequences: every installable template body is UN1T copy with un1tdublin.com links and "the Glofox app" (src/lib/sequence-templates.js:37-459); the 3-Class Trial sequence is a live UN1T row, not a template. Anniversary and inactivity triggers use Dublin wall clock.
- Automations, ads and Instagram feed are clean per-location features; the ad report email passes no location so it sends from the UN1T sender with `€`.
- Landing/welcome: `tenant_domains` CRUD is master-only; a tenant-domain root without a location renders the UN1T Group chooser (src/lib/welcome-front-page.js:26); "UN1T Dublin" titles, OG and site name are literals (src/app/welcome/[location]/page.js:56-139).
- Host mailing: host sender domains are `<label>.mail.un1tdublin.com` on UN1T's DNS zone, so Richard adds the records; "ask UN1T to verify your sending domain" copy (src/lib/host-campaign-launch.js:65-66).

### Team hub
- Staff, roster, availability, swaps, attendance and qualifications are all scoped (bare-id approve/reject 404 unless the roster's location is in the caller's set; candidates widen to same-org siblings only). Staff invites are owner self-serve.
- `bundle_team` is OFF at seed and only a master can flip it. Staff email fallbacks never pass a location so they send from the UN1T sender with "Repset"/"UN1T CRM" copy (src/lib/notify.js:150,155; src/lib/roster-email.js:133). Dublin day and quiet-hour math in ~20 roster libs.
- Contracts carry `organization_id` and resolve the legal entity per org (good), but issuing one needs `org_admin` (src/lib/contract-gates.js:23-33), no templates are seeded, and the emails say "from UN1T" / "A UN1T administrator" (src/lib/contracts-email.js:109,113,248).
- Policies (`employee-handbook`, `acceptable-use-policy`, `staff-privacy-notice`) have no org column, are listed to every signed-in user and are master-only to edit (src/lib/policies.js:38-46; src/lib/policies-access.js:15-16).
- Studio PIN login scans every profile with a PIN estate-wide, PIN uniqueness is platform-wide with a cap of 200, and the match is never checked for a role at the device's location (src/lib/studio-pin.js; src/app/api/auth/pin-login/route.js:140-230).

### Operations hub
- TV displays, templates, presentations, timer: per-location with row checks; a tenant registers a TV and pastes the URL, no Pi. The live HR board is still public by bare location id at `/tv/[locationId]`, `/api/public/live/[locationId]` and `/api/public/challenges/[locationId]` (proxy allowlist src/proxy.js:217), exposing first name + last initial, BPM and points; a tokenised twin exists. UN1T brand is baked into the TV layouts and boards.
- Climate: per-location credentials with a clear 412 when absent, but credentials and device adds are master-only. `location_automations.config` is unvalidated `z.record(unknown)` (src/app/api/automations/[key]/route.js:12) and the runners fire on whatever `device_ids` are listed (src/lib/class-climate-runner.js:76), so pasting another tenant's device UUID turns on their AC. Slot keys and Sonos schedule windows evaluate in Dublin (src/lib/sonos/groups.js:89-92); Shelly reads `locations.timezone` (the pattern to copy).
- UniFi, studio device pairing and trusted IPs are master-only and need per-site network work. Pi fleet, bridges and HR straps are a platform tailnet by design; fleet alerts go to every master.
- Equipment, checklists, issues are clean. Hyrox is per-location but its prompt says "UN1T HOUSE STYLE".

### Events, races, hosting
- Staff routes are scoped; host→org is enforced on every admin path; entry move is fenced to the host's own events. `race_events.shared = true` is global: `.or('location_id.eq.X,shared.eq.true')` on the staff list (src/app/api/events/route.js:156; src/app/(members)/events/page.js:68) and the public events page (src/app/welcome/[location]/events/page.js:94), settable by any manager.
- Payments: internal events always settle to platform Revolut; hosted events charge the host's Stripe with the application fee to the platform Stripe regardless of org (src/lib/payments/stripe-connect.js:114-126) while the org's revenue page presents it as theirs; a tenant manager can create a host with `payment_provider:'revolut'`.
- Brand: "UN1T" wordmark and "UN1T · <loc>" footer on every confirmation and reminder (src/lib/event-email.js:107-109,185); "verified UN1T member", "open to UN1T members only", ICS `@un1tdublin.com`; OG metadata "UN1T Dublin"; `customerFacingMetadata()` picks the first location estate-wide.
- Host portal: UN1T chrome throughout; hostname fixed `host.un1tdublin.com`; `/h/`, `/host`, `/host-connect/` absent from the tenant-domain allowlist.

### Mia and the staff assistant
- Per-location settings with an owner UI; every tool pins the conversation's location; Anthropic spend is metered per location and capped per org (cap check fails open on error; wallet gate only binds pinned locations).
- Defaults say "UN1T": prompt identity, holding message, welcome greeting (which also ignores `agent_name`), approval suggestions and follow-ups (src/lib/agent/prompt.js:263-264; core.js:10-11; welcome-greeting.js:13; approval-suggest.js:122; followups.js:369), because `getLocationBranding` falls back to "UN1T" when no `company_settings` row exists (src/lib/location-branding.js:20). The prompt names "the Glofox app"/"Glofox payment page" (prompt.js:77-85). Quiet hours default Dublin with no timezone field; follow-ups run in a fixed 09:00–19:59 Dublin band; the test allowlist matches 9-digit Irish numbers.
- Without Glofox the booking, membership and payment-reminder tools hand off; first-class check-in never fires.

### Crons and webhooks
- Of 79 unique crons, only `glofox-sync` and `glofox-data-quality` stamp per-tenant heartbeats; every reader of tenant cron health is master-only, so a tenant cannot see its own cron health and a second tenant's rotting loop is masked by the first's green global stamp. `glofox-attendance-refresh` and `glofox-detail-backfill` run locations sequentially under one time budget with no rotation (first location can starve the rest).
- Would not run or would be meaningless for a non-Glofox gym: ~14 crons (sync, attendance, backfill, data quality, arrears, membership snapshot, churn and lead radar, classifier, credit attendance, class knowledge, class occurrences, onboarding pace, climate and hyrox via the occurrence spine). Env-pinned: `zoom-contact-sync` (one org), `fleet-health` (one tailnet), `receipt-coverage-weekly` (one recipient).
- Dublin-fixed decisions for a non-Irish gym: sequences send window and quiet hours, race timing, agent follow-ups and review, climate slot keys, Sonos windows, equipment inspection weekday, wallet/usage billing calendar, event reminder offsets, membership snapshot day, ad insight windows, scheduled report periods (server UTC).
- Webhooks: per-tenant auth exists only for Glofox (HMAC with the location's secret) and sequence tokens; every other provider uses one platform secret (acceptable). Unknown identifiers are silently dropped with 200 almost everywhere; only Postmark-inbound and InBody dead-letter. Strava's POST is unauthenticated by nature and unrate-limited (src/app/api/webhooks/strava/route.js:31-46). Instagram's lookup discards the DB error after claiming the dedup row, so a transient failure is permanent message loss (src/lib/agent/channels.js:168). InBody rows with an unknown account sit unscoped forever.

## 3. What is left — prioritised

### Blockers (fix before any second gym has staff or customers)
1. **Retire the shared `CRM_API_KEY`** after n8n moves to a per-org `unitk_` key; until then it reads and writes every tenant (src/lib/api-auth.js:233-236; src/proxy.js:286-289).
2. **Scope WhatsApp inbound contact matching to the receiving number's org** (src/app/api/webhooks/whatsapp/route.js:233-241; src/lib/whatsapp.js:2055-2062). Same fix for Postmark-inbound mail contact linking (src/app/api/webhooks/postmark-inbound/[token]/route.js:893-900).
3. **Org-fence `race_events.shared`** on the staff list, the members page and the public events page, or restrict who may set it (src/app/api/events/route.js:156; src/app/welcome/[location]/events/page.js:94).
4. **Make `/offers` per-location** (resolve from host or path; src/app/offers/page.js:115-140) and route offer checkout through the location's payment provider.
5. **Scope policies to an org** (add `organization_id`, seed per org, let org admins edit) so UN1T's handbook and privacy notice stop being served to other tenants' staff (src/lib/policies.js:38-46; mig 178).
6. **Re-scope `contacts_email_unique` to `(location_id, email)`** or `(organization_id, email)` (mig 008:21), then simplify `restrictToOrg`; stop returning the raw unique-violation message from `POST /api/contacts` (src/app/api/contacts/route.js:101-102).
7. **Money**: honour `resolveLocationPaymentProvider` in offer checkout, internal events/races and car deposits, and make "no provider connected" a hard refusal for non-UN1T orgs instead of defaulting to the UN1T Revolut merchant (src/lib/location-payments.js:21; src/lib/race-payments.js:159; src/lib/event-hosts.js:39). Decide who receives the hosted-event application fee per org (src/lib/payments/stripe-connect.js:120) and hide the `revolut` host option for other orgs.
8. **Email identity**: make `tenant_email_domains` reachable (seed a plan with `custom_email_domain` at provisioning or drop the add-on gate for now; grant org_admin in the wizard; set `POSTMARK_ACCOUNT_TOKEN`), register bounce/open/spam/subscription webhooks on the new server in `createTenantServer`, and run suppression sync per server. Until a tenant's domain is live, refuse or clearly label "sending as UN1T" instead of silently falling back (src/lib/tenant-email.js:100-116; src/lib/email-inbox-send.js:229-245).
9. **Per-tenant receipt-coverage report** to `org_settings.ops_alert_emails`, never one env recipient across orgs (src/app/api/cron/receipt-coverage-weekly/route.js:65-89).
10. **Scope `/settings/notifications`** to the caller's org (src/app/settings/notifications/page.js:51-60).
11. **Retire the location-keyed public live and challenge boards** in favour of the token routes (src/app/api/public/live/[locationId]/route.js; src/proxy.js:217).

Also close these smaller holes in the same pass: authenticate or rate-limit the Strava POST; guard NULL-location templates in `/api/templates/[id]`; validate `device_ids` against the location's own devices on automation save; stop WhatsApp number/flow events from paging every tenant; keep the Instagram lookup error instead of treating it as "unmatched".

#### Wave 0 delivered 9–10 Oct 2026

Status per blocker (PRs on `ivers9307-cyber/un1t-crm` unless noted; every PR is a scoping change plus a test, see `docs/superpowers/plans/2026-10-09-saas-wave0-stop-the-leaks.md`).

| # | Blocker | Status | PR | What landed |
|---|---|---|---|---|
| B1 | Legacy API key unscoped | **Closed** (one manual step left) | #1957 W0.1 | `CRM_API_KEY_ORG_ID` env pins the legacy key to the UN1T Group org; unset = key refused. **Richard still to mint a per-org `unitk_` key for n8n, then unset both envs.** |
| B2 | WA inbound contact match estate-wide | **Closed** | #1956 W0.2 | Org-scoped match; also covers the WA coexistence ingest and Postmark inbound mail. |
| B3 | `race_events.shared` global | **Closed** | #1962 W0.3 | Shared within the owning org only. |
| B4 | `/offers` lists all tenants | **Closed (interim)** | #1958 W0.4 | Pinned to Stillorgan until Wave 2. |
| B5 | Policies global | **Closed** | #1960 W0.5 | Mig 713: `policies.organization_id`, the 3 existing rows → UN1T Group. |
| B6 | `contacts_email_unique` global | **Closed** | #1961 W0.6 | Mig 712: per-org unique index, `nulls not distinct`, trigger-stamped `contacts.organization_id`. |
| B7 | Single Revolut merchant | Deferred → Wave 2 | — | Unchanged. |
| B8 | Email identity | Deferred → Wave 1 | — | Unchanged. |
| B9 | Receipt-coverage report cross-tenant | **Closed** | #1964 W0.7 | One report per org via `org_settings.ops_alert_emails`; env `RECEIPT_COVERAGE_REPORT_TO` retired. |
| B10 | `/settings/notifications` lists all locations | **Closed** | #1963 W0.8 | Scoped to the caller's locations. |
| B11 | Live HR board public by location id | **Closed; tv1 cut over, tv2 + Hatch pending** | #1969 W0.9a · un1t-pi #2 W0.9b · #1973 W0.9c | 9a: the token live route stamps the kiosk heartbeat and the challenges board is token-gated. 9b (un1t-pi): per-kiosk `tv-token-<device>` secret, `pi kiosk-refresh`. 9c: location-keyed `/tv/[locationId]`, `/api/public/live/[locationId]` and `/api/public/challenges/[locationId]` removed (merged 10 Oct). Kiosk cut-over 9 Oct: **stillorgan-tv1** done over Tailscale, heartbeat proven advancing 10 Oct 02:11 UTC; **stillorgan-tv2** offline (failing SD card, reimage with `pi prepare`); **hatch-tv1/tv2** not yet provisioned. |

The five small holes, plus hardening found during the review, also closed in Wave 0:

| PR | Task | What landed |
|---|---|---|
| #1970 | W0.10 | Strava webhook behind a URL token (`STRAVA_WEBHOOK_URL_TOKEN`). **Richard must recreate the Strava push subscription** with callback `https://crm.repset.ie/api/webhooks/strava/<token>`. |
| #1965 | W0.11 | Platform (location-less) email templates readable and editable by master only. |
| #1966 | W0.12 | Automation `device_ids` validated against the location's own `ac_devices`. |
| #1967 | W0.13 | Unmatched WhatsApp number/flow events logged, not fanned out to every studio. |
| #1968 | W0.14 | Instagram lookup failures retried instead of dropped as "unmatched". |

Open after Wave 0:
- Richard: the n8n `unitk_` key swap (then unset `CRM_API_KEY` + `CRM_API_KEY_ORG_ID`) and the Strava subscription recreate.
- Kiosks: provision hatch-tv1/tv2; reimage stillorgan-tv2.
- Follow-up chips (not blockers): `layout.js` scoping gate; policies write RLS per org; legacy-key proxy comments; remaining email lookups (incl. champ-app); climate runner device guard; the unreachable WA coexistence `account_update` handler.
- Regression to restore: the staff `/live/[locationId]` page lost its "TV display" button with 9c (needs the location's `tv_displays` token to rebuild).

### Majors, grouped by theme

**A. Self-serve onboarding (today every one of these is Richard)**
- Wizard: grant `org_admin` to the invited owner; seed `company_settings` (name, logo), `notification_config`, quiet hours, a plan pin and wallet, and turn all bundles ON (or let the org admin flip them). Make feature/bundle toggles org-admin-level, not master.
- Org-admin-level versions of: CSV import and rollback; `/api/glofox/*` operator tools; AC credentials and device adds; UniFi settings; studio device pairing and trusted IPs; BCA config; contract templates (seed a starter set); achievement rules (per org); bridge rows (if straps are ever offered).
- UIs for settings that are SQL-only today: `landing_page_settings.public_path`, `settings.whatsapp_flow`, `settings.glofox.trial_*`, `settings.inbody.accounts`, `settings.meta_ads` dataset and pixel ids.
- Domains: call the Vercel domains API from the tenant-domains route (or add a wildcard `*.repset.ie` and give each tenant a subdomain), and widen the tenant-domain default allowlist to cover the funnel, unsubscribe, preferences, view-email and host paths.
- Instagram: a Meta login + `subscribed_apps` flow instead of a pasted token. Postmark inbound: surface the forwarding address and per-tenant sender signatures.

**B. Brand fallbacks (every "UN1T" literal a tenant's customer or staff can see)**
Replace `getLocationBranding`'s final `'UN1T'` fallback with `locations.name` and make `company_settings.company_name` required before go-live, then sweep: Mia prompt/holding/welcome/approvals/follow-ups; WhatsApp `{{location_name}}`; campaign editor From default; sequence templates; booking widget "Powered by UN1T"; event emails, signup widget, ICS, OG metadata; host portal, login, onboarding email; contract, roster, staff and HR emails; "UN1T Points"/"UN1T HR" across web, mobile, champ-app and the shared seam; TV layouts and boards; hyrox prompt; `/account-deletion` legal copy (use `org_settings` legal entity); login/reset chrome; unsubscribe/preference pages; ad report; Strava export names; Xero "Car" theme and descriptions.

**C. Links and hosts**
`getAppUrl()` should resolve the org's tenant domain for customer-facing links (unsubscribe, preferences, view-email, booking, events, host pages) and fall back to the platform host; `customerFacingMetadata` should resolve by the request's org, not the first location.

**D. Timezone**
Either declare v1 as Ireland/UK only and enforce `timezone ∈ {Europe/Dublin, Europe/London}` at location creation, or thread `locations.timezone` through the `dublin-time` consumers that make per-tenant decisions (sequences scheduler, send-quiet-hours, agent follow-ups and review, Sonos windows, climate slot keys, race timing, equipment reminders, event reminder offsets, membership snapshot, wallet/usage month, scheduled report periods). Shelly, checklists and push reminders already show the pattern.

**E. Glofox dependency**
Decide the membership source for a non-Glofox gym (manual memberships on `contacts`, un1t.online, or "Glofox required for v1") and gate the Glofox-only surfaces (classifier, churn radar, trend, credits, class automations, Mia booking tools) with a visible "needs a membership source" state rather than empty data. Move Glofox cron discovery to the connection registry before legacy writes are retired, and rotate the per-location time budget.

**F. Observability**
Stamp `tenant_heartbeats` from every per-location cron, give org admins a read-only health view, and alert ops per org (`org_settings.ops_alert_emails`) instead of every master.

**G. Namespaces**
Scope `event_types.slug`, `sale_offers.slug`, `landing_page_settings.public_path` and the studio PIN pool per location or org; keep `race_events.slug` and `event_hosts.slug` global but suffix with the org.

### Minors
Dublin labels in confirmations and TV; `€`/EUR formatting and Irish VAT defaults; Android package id `com.un1tdublin.crm`; `car_enquiries` unscoped and unread; suspended-org message; `purge-spam-mail` heartbeat name; Irish-number test allowlist in Mia; welcome greeting ignoring `agent_name`; Stripe `'un1t_class_booking'` discriminator literal; `country:'IE'` default on Stripe Connect.

## 4. What onboarding gym #2 takes today (manual checklist)

Everything below is Richard, with SQL/env/Vercel/Postmark/Meta access:
1. `/admin/tenants/new`: org, first location (timezone/country), invite owner, org branding, tenant-domain row.
2. Grant the owner `org_admin` at `/settings/staff/[id]`.
3. Pin a plan at `/admin/plans` and top up or adjust a wallet.
4. Flip `bundle_money`, `bundle_marketing`, `bundle_team`, `bundle_operations` at `/admin/matrix`.
5. Insert `company_settings` (name, logo, quiet hours) and `notification_config` for the location.
6. Add the hostname in Vercel and DNS; widen the brand allowlist if the funnel pages are needed.
7. Set `POSTMARK_ACCOUNT_TOKEN`, provision the tenant Postmark server and domain, then register its webhooks by hand in Postmark.
8. Insert `landing_page_settings` with a `public_path`; insert `settings.whatsapp_flow`, `settings.meta_ads`, `settings.glofox.trial_*`, `settings.inbody.accounts` as needed.
9. Connect WhatsApp (owner can), register the Flow public key on the number by Graph call, attach the IG account to the Meta app.
10. Connect Glofox (owner can) and run the initial import; any reconcile/probe tool is master-only.
11. Enter AC/UniFi credentials, pair studio devices and trusted IPs, image a Pi if HR straps are wanted.
12. Create contract templates; accept that policies are UN1T's.
13. Tell the gym that offers, deposits, internal events and default class-pay will settle to UN1T's Revolut unless they connect Stripe, and that all email sends as UN1T until step 7 is complete.

## 5. Suggested order of work

- **Wave 0 — stop the leaks** (small, independent PRs): blockers 1–6, 9–11 and the five small holes. Each is a scoping change with a test. This wave alone makes it *safe* to invite a friendly second gym onto a shared host.
- **Wave 1 — identity**: seeded `company_settings`, `'UN1T'` fallback removal (theme B), tenant email domain reachable with webhooks and per-server suppression (blocker 8), per-tenant links (theme C). After this a tenant's customers never see UN1T.
- **Wave 2 — money**: blocker 7. After this a tenant's customers never pay UN1T.
- **Wave 3 — self-serve**: theme A, starting with the wizard (org_admin, plan, bundles, settings rows) and org-admin-level toggles, then the SQL-only settings UIs, then Vercel domain automation.
- **Wave 4 — decisions**: timezone (theme D) and membership source (theme E). Both are product decisions first; declaring Ireland/UK-only and Glofox-required for v1 is a legitimate answer that collapses most of the work.
- **Wave 5 — operability at scale**: per-tenant heartbeats and health, cron budget rotation, per-org ops alerts, namespace scoping.

## 6. Notes on method and limits
- Ten reviewers each covered one hub against the shared rubric; their reports are summarised above with file:line evidence. Every blocker and each surprising claim was re-read by hand in the worktree before inclusion.
- Not covered: un1t-platform, un1t-sentinel, the un1t-pi tool, the Hatch un1t.online platform, and champ-bridge internals beyond auth binding.
- "Verified" means read in code on this commit or queried in the live database today; "latent" means the path exists but a dual-write or default currently masks it.
