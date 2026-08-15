# Platform Consolidation & Streamlining — Design

**Date:** 2026-08-14
**Scope:** un1t-crm (Studio tier) only. champ-app, bridge, sentinel out of scope.
**Audience:** UN1T Dublin staff today, designed to also work for future SaaS operators (Repset tiers).
**Appetite:** Merge and kill — overlapping features are consolidated into one canonical home and the rest retired, accepting migration work and staff retraining.

## 1. Problem

An operator with all features enabled sees a platform that has grown feature-by-feature rather than by design:

- **25 sidebar destinations across 8 sections**, plus a second tab-strip layer that double-lists several surfaces (Email inbox, Approvals, and Attendance each appear both as a sidebar item and as a tab inside another hub).
- **214 route pages** (~40 of which are legacy redirect stubs), 748 API routes, ~211k LOC across `src/app` + `src/components`.
- **Same job, many homes:**
  - Messaging spans 4 route trees: `/communications` (canonical) plus still-live template editors under `/email/templates/*` and `/whatsapp/templates/*`, and redirect stubs across `/email`, `/whatsapp`, `/segments`.
  - Approvals exist in 5 surfaces: central `/approvals`, `/schedule/approvals`, Hyrox sessions in `/admin/hyrox`, host event review in `/settings/hosts`, invoice approval in `/invoices`.
  - Money is split 6 ways: `/accounting`, `/invoices`, `/card-receipts`, `/orders`, `/schedule/invoices` + `/schedule/expenses`, `/settings/billing` + `/settings/usage`.
  - Analytics is split across the 7 `/dashboard` tabs, `/pulse`, `/settings/customer-agent/analytics`, `/cars/reports`, and the `/schedule` Reporting tab.
  - Integrations config lives in 4 places: `/settings/integrations-hub`, `/settings/integration-health`, `/admin/integrations`, `/settings/integrations/zoom-contacts`, plus per-location Integrations tabs.
- **Two competing config hubs:** `/settings` (24 links, 9 card sections) and `/admin` (20 pages) overlap; the settings index links into `/admin`. Platform-tier concerns (tenants, plans, tenant-domains) sit in the same `/admin` namespace as studio concerns (TV displays, checklists).
- **Feature flags and permissions share one namespace** (47 web keys, ~110 with mobile, in `shared/permissions.js`). "What the tenant bought" and "what this staff member may do" are conflated — too granular to package for SaaS plans.

What is already right and must be preserved:

- The three-shell structure (Platform `/admin/tenants…` / Account `/portfolio` / Studio) in `src/components/AppShell.jsx` is the correct SaaS bone structure. All sprawl is inside the Studio tier.
- The Studio sidebar is a **tested data contract** (`src/lib/nav-items.js` + `nav-items.test.js`). IA restructuring is an edit to that contract, not a component rebuild.
- The 4-tier permission resolver (`resolvePermission` in `shared/permissions.js`: location feature gate → per-user override → per-(location, role) template → role default) keeps its semantics.

## 2. Goals / Non-goals

**Goals**

1. A fully-enabled operator navigates ≤ 9 top-level hubs with one consistent secondary pattern (tab strip), two levels of navigation everywhere.
2. Every job has exactly one canonical home; duplicated surfaces are deleted.
3. One settings tree; `/admin` no longer exists as a hub.
4. Everything needing staff action is visible in one queue on Home.
5. A sellable feature-bundle layer for SaaS plans, without changing fine-grained permission semantics.
6. ~40 dead pages deleted.

**Non-goals**

- No visual-design refresh (component styling, theming) — this is IA and feature-surface work.
- No changes to the Platform or Account shells beyond receiving pages evicted from `/admin`.
- No changes to the host portal, public/unauthenticated pages, or the 7 full-screen display renderers (they are outputs, not navigation sprawl).
- No mobile-app IA redesign — mobile parity is maintained (`npm run check:mobile-parity`), not re-imagined.
- No booking-engine changes (Glofox remains the booking system; Pulse scope boundary unchanged).

## 3. Design

### 3.1 Information architecture — 9 hubs

The Studio sidebar (`nav-items.js`) collapses from 25 items / 8 sections to 9 hubs. Each hub owns a tab strip as its only secondary navigation. Sidebar badges are replaced by the Home queue (§3.3); only Home carries a count.

| # | Hub | Route | Contains (tabs) |
|---|-----|-------|-----------------|
| 1 | **Home** | `/home` | Today · Needs attention (queue, §3.3) · Reports (Studio, Business, Churn, Leads, Engagement, Ads, Agent — the current `/dashboard/*` tabs plus Mia analytics moved from `/settings/customer-agent/analytics`) |
| 2 | **Messages** | `/communications` | Inbox (unified WA + IG + email tickets + SMS) · Send · Sent |
| 3 | **Sales** | `/sales` | Pipeline · Contacts · Tasks |
| 4 | **Members** | `/members` | Bookings · Events · Challenges · Pulse · Live HR · Class timer · Hyrox |
| 5 | **Money** | `/money` | Overview (accounting hub) · Invoices (supplier) · Card receipts · Orders · Offer sales · Contractor invoices & expenses (moved from `/schedule`) |
| 6 | **Marketing** | `/marketing` | Campaigns · Broadcasts · Sequences & automations · Segments · List health · Templates (all channels) · Landing pages · Ads |
| 7 | **Team** | `/team` | Roster (the current `/schedule`) · Attendance · Time off · Swaps · Contracts (from `/admin/contracts`) · Policies |
| 8 | **Operations** | `/operations` | Maintenance · Displays (§3.2) · Studio devices & door · Checklists · Device automations · Fleet (master-gated tab) |
| 9 | **Settings** | `/settings` | One tree (§3.4) |

**Boundary decisions**

- **Messages vs Marketing:** Messages is conversational (inboxes, one-to-one send, sent log). Marketing is one-to-many and automated (campaigns, broadcasts, sequences, automations, segments, templates, landing pages, ads). Templates and segments live in Marketing; Messages links to them.
- **Vertical modules:** Cars (`/cars`) stays a standalone sidebar entry rendered only when its gate is enabled. For SaaS it is a tenant-specific module, not core IA. Orders stays in Money (it is the cross-stream revenue ledger, not a vertical).
- **Pinned above hubs:** Account home (`/portfolio`, master/owner) and the Event Host Portal link keep their current special-cased placement.
- **URLs:** hubs get the new routes above; existing deep URLs redirect (tracked, removed one phase later). `/communications` keeps its path since it is already canonical.

### 3.2 Merges and kills

1. **Legacy stubs deleted** (~40 pages): all redirect stubs under `/email`, `/whatsapp`, `/segments`, `/cars` (redirect variants), `/contacts/duplicates`, `/settings/shifts`, and any other pure-redirect `page.js`. Precondition: the 4 still-live editors (`/email/templates/[id]`, `/email/templates/new`, `/whatsapp/templates/[id]`, `/whatsapp/templates/new`) are folded into the canonical templates surface first (`/communications/templates` in phase 1; that surface itself moves to Marketing → Templates in phase 4).
2. **One approvals system.** The registry-driven `/approvals` becomes the only approvals inbox. Schedule approvals, Hyrox session approvals, host event review, and invoice approval register into it as domains. The per-domain approval pages are deleted; their former homes deep-link into the central inbox filtered by domain. Approval counts feed the Home queue.
3. **One money surface.** All six money surfaces become tabs of the Money hub. `/settings/billing` + `/settings/usage` (SaaS platform billing — what the tenant pays us) stay in Settings; they are a different job from operating the gym's money.
4. **One displays manager.** TV admin (`/admin/tv-displays`), Presentations (`/presentations`), and casting management merge into Operations → Displays. Runtime renderers (`/tv/*`, `/present/[token]`, `/event/[slug]/display`, `/live/*`) are untouched.
5. **One integrations page.** `/settings/integrations-hub` absorbs `/settings/integration-health` (as a Health tab), `/admin/integrations` (Strava/Garmin/Apple move into the grid), and `/settings/integrations/zoom-contacts`. Per-location Integrations tabs keep only genuinely per-location credentials/config.
6. **Pulse admin** merges into Members (tab), cross-linking to Home → Reports → Engagement rather than duplicating analytics.

### 3.3 Home needs-attention queue

One aggregated queue replaces per-item sidebar badges. Sources: approvals (all domains, post-merge), email tickets awaiting reply, unresolved WA/IG threads, supplier-invoice inbox, issues, offer-sale fulfilment. Each row: source icon, age, one-line summary, deep link into the owning hub. Server-aggregated by one endpoint that reuses the existing per-source count queries (which currently power sidebar badges). Row visibility respects the same permission keys as the underlying feature — the queue never leaks a domain the user cannot open. Counts follow the existing per-location comms/audience rules where applicable.

### 3.4 Settings — dissolve `/admin`, one tree

`/admin` is deleted as a hub. Its pages disperse by tier:

| Destination | Pages |
|---|---|
| **Platform shell** | `tenants/*`, `plans`, `tenant-domains`, `health`, `matrix` (cross-location feature grid), `webhook-dead-letter`, `bridges`, `fleet` (fleet also surfaces as a master-gated Operations tab for day-to-day restarts) |
| **Operations hub** | `tv-displays`, `studio-devices`, `checklists` |
| **Team hub** | `contracts/*`, `policies/*` (admin CRUD; the read surface `/policies` folds into Team → Policies) |
| **Members hub** | `hyrox`, `achievements` |
| **Settings tree** | `audit-log`, `glofox-import`, `marketing-import`, `integrations` |

`/settings` becomes one tree with 7 groups (replacing the 551-line card grid):

1. **Workspace** — locations (with the existing per-location tabs as the per-location layer), branding, holidays, class categories
2. **Team** — staff, roles/permissions templates
3. **Communications** — email domain, notifications (+ health), customer agent (config + requests; analytics moved to Home → Reports), scoring
4. **Integrations** — the single merged hub (§3.2.5)
5. **Billing & usage** — SaaS plan, usage meters
6. **Data** — Glofox import, marketing import, API keys, status page, landing-page settings (editor itself lives in Marketing → Landing pages; this holds domain/publishing config)
7. **Security** — audit log, access history, impersonation

### 3.5 SaaS gating — bundles over keys

Two layers, cleanly separated:

- **Feature bundles** (new): the sellable, location/plan-level gate. One bundle per hub plus vertical modules: `bundle_messaging`, `bundle_marketing`, `bundle_sales`, `bundle_members`, `bundle_money`, `bundle_team`, `bundle_operations`, `module_cars`. Home and Settings are never bundle-gated (every tenant has them; their contents are gated by the bundles/keys of the features they surface). Stored alongside the existing two plan flags in `plan_versions.features` (`shared/plans.js` `FEATURE_KEYS`) and mirrored per-location. The location Features tab and `/admin/plans` (post-move: Platform → Plans) manage bundles, not 47 individual keys; a per-key override list remains behind an "advanced" disclosure for exceptions.
- **Permission keys** (existing, unchanged): the role/user layer. All ~110 keys keep their names and semantics; role templates, per-user overrides, and mobile parity are untouched.

Resolver change: tier 1 of `resolvePermission` (location feature gate) first checks the bundle that owns the key (a static key→bundle map in `shared/permissions.js`); an explicitly disabled bundle denies all its keys for everyone at that location, exactly like today's explicit `false`. Individual-key location gates continue to work as the exception mechanism. Default remains enabled-unless-explicitly-false, except modules (`module_cars`, and the existing `bca_submit` precedent) which are opt-in. New locations keep the SourceIt convention (features default off at creation via explicit flags — now expressed as bundles, far fewer to set).

### 3.6 Delivery phases

Each phase is independently shippable, branched off fresh `origin/main`, migrations forward-only via Supabase MCP with `get_advisors` after DDL, mobile parity checked per phase.

1. **Prune.** Fold the 4 live template editors into `/communications` templates; delete ~40 redirect stubs. No IA change, no retraining.
2. **Regroup.** New 9-hub IA in `nav-items.js` (+ tests); settings tree replaces the card grid; `/admin` pages dispersed; old URLs 302-redirect (tracked in a single redirects module for removal in phase 5).
3. **Approvals + Home queue.** Approval domains register into central `/approvals`; per-domain pages deleted; Home ships Today + Needs attention + Reports.
4. **Money merge + Messages/Marketing split.** The deepest feature surgery: Money hub tabs assembled; campaigns/broadcasts/sequences/segments/templates move under Marketing; unified inbox confirmed as Messages' centrepiece.
5. **Bundles.** Key→bundle map, resolver tier-1 change, plans/location UI switched to bundles, phase-2 redirects removed.

## 4. Constraints and risks

- **Mobile parity:** every permission-key or nav change must pass `npm run check:mobile-parity`; `shared/mobile-nav.js` is a separate contract that must be updated in the same PR as `nav-items.js` changes.
- **Per-location comms model:** any queue/count/send surface must read the `contact_location_audience` view; row absent = that location may never send. Read the per-location comms model doc before touching send paths.
- **Muscle memory:** phase 2 changes every staff habit at once. Mitigations: old-URL redirects for two phases, and hub names chosen to match existing vocabulary (Messages, Money, Team).
- **Resolver blast radius:** `shared/permissions.js` (1,366 lines) is load-bearing for web + mobile + API. The bundle change is additive (a map + one tier-1 lookup); it ships with exhaustive resolver tests before any UI depends on it.
- **Approvals registry capacity:** merging 4 approval domains assumes the registry pattern generalises; phase 3 starts with the closest domain (schedule approvals) as the proving case before migrating the rest.
- **Parallel sessions:** primary clone is frequently on another branch; all work happens in dedicated worktrees off `origin/main`.

## 5. Success criteria

- Fully-enabled operator sees 9 sidebar entries (+ gated Cars module), each with one tab strip; no third navigation level anywhere.
- `page.js` count drops by ≥ 40; no route tree contains a redirect-only page after phase 5.
- One approvals inbox, one integrations page, one money hub, one settings tree; `/admin` returns 404 (Platform-shell paths excepted).
- A new SaaS location can be provisioned by setting ≤ 8 bundle flags instead of ~47 keys.
- `nav-items.test.js`, `platform-nav.test.js`, `account-nav.test.js`, resolver tests, and `check:mobile-parity` all green at every phase boundary.
