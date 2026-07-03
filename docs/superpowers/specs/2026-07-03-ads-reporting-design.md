# Ads Reporting & Performance — Design Spec

- **Date:** 2026-07-03
- **Status:** Approved design, pre-implementation
- **Feature area:** New `Ads` section in un1t-crm (dashboard + daily report)
- **Related:** [[meta-paid-ads-program]] (the live Meta campaign this reports on), `membership-snapshot.js` (snapshot pattern mirrored here), `morning-briefing.js` (email delivery reused), `agent/channels.js` (provider-abstraction precedent), `meta-capi.js` (existing Meta token usage)

---

## 1. Summary

Build an in-CRM **Ads** feature that (a) syncs paid-ad performance data daily from Meta into location-segmented snapshot tables, (b) joins that spend to what actually happened in the CRM — **booked classes via the `/start` funnel UTMs** — (c) surfaces it on a `/dashboard/ads` page with per-location and cross-location roll-up views, and (d) emails a plain-English daily performance report per location plus an optional group roll-up.

The whole feature is built on a **provider abstraction** so **TikTok is a drop-in next week**: implement one `tiktok.js` module + add a TikTok account row per location, and the dashboard, email, attribution and roll-up all work unchanged.

**The hero metric:** *cost per booked class, per ad.* Ads Manager stops at cost-per-click; only the CRM knows which click became a booking. That join is the reason this is built inside the CRM rather than read from Ads Manager.

## 2. Non-goals (v1 scope boundaries)

- **No full-funnel-to-revenue in v1.** Attribution stops at *booked class/consult*. The schema is built so it can later extend to membership conversion and LTV/ROAS, but v1 does not compute member revenue.
- **No click-to-WhatsApp (CTWA) booking attribution in v1.** Only website `/start` bookings are attributed (via UTMs). CTWA bookings (the `ctwa_clid` path in `meta-capi.js`) are a later attribution source.
- **No in-CRM ad *management*** (create/pause/edit ads). This is read-only reporting. Campaign changes stay in Ads Manager / the ads MCP.
- **No "every Meta breakdown."** v1 ships the decision-driving breakdowns (placement, age/gender, platform). Region/device/hourly/creative-asset/audience-delivery insights are explicitly deferred (YAGNI); the breakdown table is generic so they are additive later.
- **One active ad account per (location, provider) in v1.** The schema permits multiple rows and resolves the active one (token rotation), but the UI configures one.

## 3. Users & stories

- *As an owner,* I open `/dashboard/ads` and see, for my studio, what each ad cost and how many bookings it produced — sorted by cost per booked class.
- *As an owner,* I get a daily email that tells me in plain English which ad is winning and which is wasting money, without opening Ads Manager.
- *As a multi-studio owner,* I switch the dashboard to "All studios" and see a combined roll-up plus a per-studio comparison, and I get one group email covering every studio.
- *As an operator onboarding a new studio,* I add that studio's own Meta (and later TikTok) token on its settings page, and its data flows in — fully segregated from every other studio.

## 4. Architecture overview

Mirrors the existing `channel_connections` messaging-provider pattern.

```
src/lib/ads/
  provider.js       ← the interface every ad platform implements
  providers/
    meta.js         ← Graph API implementation (v1)
    tiktok.js       ← TikTok Marketing API implementation (next week)
  sync.js           ← per-account ingestion: entities + insights + breakdowns → normalized tables
  attribution.js    ← spend ↔ CRM bookings join (provider-agnostic)
  report.js         ← builds the daily email (per-location + roll-up), provider-agnostic
  accounts.js       ← resolve/mask/patch ad_accounts rows (extends channels.js helpers)
```

**Key principle:** provider modules are the *only* code that knows a platform's API shape. Everything downstream (sync orchestration, attribution, dashboard, email, roll-up) reads the **normalized** tables and is platform-agnostic. Adding a provider = one new module + one config row; no downstream change.

## 5. Data model

Four new tables. Every row carries `location_id` directly (denormalized, not just via FK) — this is the row-level enforcement of segmentation (§12).

### `ad_accounts` — per-location, per-provider connection
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| location_id | uuid not null → locations(id) | |
| provider | text not null | check in `('meta','tiktok')` |
| external_account_id | text not null | Meta ad account id (numeric, no `act_` prefix stored) / TikTok advertiser id |
| access_token | text | ads_read-scoped token; **masked to browser**, never returned raw |
| business_account_id | text | Meta business id / TikTok context |
| currency | text | account currency (for display) |
| account_timezone | text | reporting timezone (Meta reports in account TZ — see §7) |
| display_name | text | |
| is_active | boolean default true | |
| last_synced_at | timestamptz | |
| last_sync_error | text | surfaced in settings + dashboard health |
| created_at, updated_at | timestamptz | |

Unique `(location_id, provider, external_account_id)`. Partial-unique `(location_id, provider) where is_active` — at most one active per (location, provider); resolve via `resolveAdsAccount(locationId, provider)`.

### `ad_entities` — synced catalogue of campaigns/adsets/ads
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| location_id | uuid not null | denormalized |
| ad_account_id | uuid not null → ad_accounts(id) | |
| provider | text not null | |
| level | text not null | check in `('campaign','adset','ad')` |
| external_id | text not null | platform's stable id |
| name | text | |
| status | text | effective/delivery status |
| campaign_external_id | text | for ad/adset rows |
| adset_external_id | text | for ad rows |
| raw | jsonb | last-fetched attributes for extensibility |
| created_at, updated_at | timestamptz | |

Unique `(ad_account_id, level, external_id)`. Names/status are kept here so the dashboard shows stable labels even after an ad is renamed or deleted in Meta.

### `ad_insights_daily` — the snapshot (heart of the feature)
One row per entity per day. Mirrors `membership_snapshots` idempotency, keyed per entity+date.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| location_id | uuid not null | denormalized |
| ad_account_id | uuid not null | |
| provider | text not null | |
| level | text not null | campaign/adset/ad |
| entity_external_id | text not null | |
| date | date not null | account-TZ reporting date (§7) |
| spend | numeric(12,2) | |
| impressions | bigint | |
| reach | bigint | |
| frequency | numeric | |
| clicks | bigint | all clicks |
| link_clicks | bigint | |
| landing_page_views | bigint | |
| ctr | numeric | |
| cpc | numeric | |
| cpm | numeric | |
| results | bigint | optimization-event count |
| result_type | text | e.g. `landing_page_view` |
| actions | jsonb | full normalized actions array (leads, video views, etc.) for extensibility |
| synced_at | timestamptz | |

Unique `(ad_account_id, level, entity_external_id, date)`. Indexes: `(location_id, date)`, `(ad_account_id, level, date)`. The daily sync re-pulls the **last 3 days** each run to absorb Meta's late-updating attribution; the upsert makes that idempotent.

### `ad_insights_breakdown_daily` — decision breakdowns
Generic breakdown rows so new dimensions are additive.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| location_id, ad_account_id, provider, level, entity_external_id, date | | as above |
| dimension | text | `placement` / `age` / `gender` / `age_gender` / `platform` |
| segment | text | e.g. `facebook_feed`, `25-34`, `female` |
| spend, impressions, clicks, link_clicks, results | numeric/bigint | |
| actions | jsonb | |

Unique `(ad_account_id, level, entity_external_id, date, dimension, segment)`. Index `(location_id, date, dimension)`.

### Attribution capture (extends existing tables)
On `contacts`, add first-touch ad attribution (stamp-if-null, like `lead_source`):
- `utm_campaign text`, `utm_content text`, `utm_term text`, `ad_provider text`, `ad_external_id text` (the stable ad id), `attributed_at timestamptz`.

Rationale for a stable `ad_external_id` separate from `utm_content`: `utm_content` is set to `{{ad.name}}` for human readability, but names change. We additionally pass `&meta_ad_id={{ad.id}}` on ad URLs and store it as `ad_external_id`, so attribution joins on a stable id and falls back to name/campaign only when the id is absent (older clicks, organic).

## 6. Provider interface

```
// src/lib/ads/provider.js  (documented contract; providers implement it)
listEntities(account)
  → [{ level, external_id, name, status, campaign_external_id?, adset_external_id?, raw }]

fetchInsights(account, { since, until, level, breakdowns? })
  → [{ level, entity_external_id, date, spend, impressions, reach, frequency,
       clicks, link_clicks, landing_page_views, ctr, cpc, cpm, results,
       result_type, actions, dimension?, segment? }]   // normalized shape
```

- `meta.js` calls Graph API `GET /v21.0/act_{id}/insights` with `level`, `time_range`, `time_increment=1`, `fields=...`, and a separate call per breakdown; maps Meta field names → the normalized shape; paginates.
- `tiktok.js` (next week) calls the TikTok Marketing API report endpoints; maps TikTok field names → the same normalized shape.
- A field-mapping table (Meta ↔ TikTok ↔ normalized) lives in the spec's TikTok section (§15) and in each module's header.

## 7. Ingestion

Two crons (separation of concerns, matching the `membership-snapshot` + `morning-briefing` split), both: Bearer `CRON_SECRET`, service-role client, `stampHeartbeat`, `vercel.json` entry, seeded `cron_heartbeats` row.

- **`ad-insights-sync`** (~05:00 UTC): loop **every location × active ad_account**. For each: `provider.listEntities` → upsert `ad_entities`; `provider.fetchInsights` for last 3 days at campaign+adset+ad levels → upsert `ad_insights_daily`; `fetchInsights` with each breakdown → upsert `ad_insights_breakdown_daily`. Update `ad_accounts.last_synced_at`/`last_sync_error`. One failing account never stalls the sweep (per-account try/catch, collect results).
- **`ad-report-email`** (~07:00 UTC, after sync): compute day-over-day deltas and send per-location reports, then the group roll-up (§10).

**Backfill:** a one-time authenticated endpoint/script pulls from each campaign's start date via the same upsert path (idempotent). The live campaign is only days old, so this is trivial; the mechanism is retained for future onboarding.

**Timezone:** Meta reports in the *ad account's* timezone; `date` is that account-TZ reporting date, stored as-is and labelled as such. This is distinct from the CRM's Dublin-wall-clock booking dates (the account is Europe/Dublin in practice, but the two date spaces are kept conceptually separate and never silently mixed).

**Rate limits:** one account = a handful of calls/day — negligible. Meta async insights (for very large ranges) is not needed in v1.

## 8. Attribution — spend → booked classes

The value proposition, and it needs one gap closed.

**The gap:** ad URLs carry `utm_content={{ad.name}}`, but the `/start` funnel (`StartFunnel.jsx` → `/api/public/book` and `/api/public/class-booking`) does **not** currently persist those UTMs on the lead. So today we could attribute only at campaign level, not per-ad.

**The fix (Phase 2):**
1. `StartFunnel` reads `utm_*` + `meta_ad_id` from the URL on mount and includes them in its POST.
2. `/api/public/book` and `/api/public/class-booking` persist them first-touch (stamp-if-null) onto the contact's new attribution columns, with length/shape validation (marketing params, low-trust — sanitised, capped).
3. Add `&meta_ad_id={{ad.id}}` to the 4 live ad URLs (via the ads API) and to the runbook, so new clicks carry a stable id. `utm_content={{ad.name}}` stays for readability.
4. `attribution.js` counts **`/start` bookings** (class bookings from `class_booking_requests` reaching `booked`, and consult bookings in `bookings` with `source='meta_book'`) and joins each to its ad via `contacts.ad_external_id` (fallback: `utm_content` name match, then `utm_campaign` for campaign-level only).

**The metric:** for any ad and period, *cost per booked class* = `sum(spend for that ad in period) / count(bookings attributed to that ad, booked in period)`. Class vs consult are counted and shown separately as well as combined. Blended campaign/account CPA aggregates the same way.

## 9. Dashboard — `/dashboard/ads`

Permission-gated (`dashboard_ads`), new sidebar entry, recharts lazy-loaded (existing pattern). **Scope selector at the top: "This studio" (active location, default) | "All studios" (roll-up).**

**Per-location view:**
- KPI strip: spend (today / 7d / 30d), **cost per booked class** (hero), bookings (class + consult), blended CTR, active ads.
- Trend chart: spend + bookings + cost-per-booking over time.
- Per-ad table (the winner/loser view): ad name, spend, impressions, CTR, CPC, landing-page views, bookings, cost/booking — sortable; retired ads shown greyed.
- Breakdown panels: placement · age/gender · platform.
- Provider tabs: Meta today; a TikTok tab appears automatically once a TikTok account row exists for the location.
- Health note: surfaces `last_sync_error` / stale-sync if the token or pull is failing.

**Roll-up view ("All studios"):**
- Combined KPI strip across the locations the viewer can access (spend, bookings, blended cost/booking).
- Per-studio comparison table: spend, bookings, cost/booking per location, best/worst highlighted.
- Combined spend+bookings trend.
- Only aggregates locations the user is entitled to (§12) — never the whole org unless the user has access to the whole org.

## 10. Daily email report

Reuses `morning-briefing.js` shape → Postmark `sendEmail` (tag `ad-report`), sent by the `ad-report-email` cron.

**Per-location report (default):**
- Subject e.g. *"UN1T Stillorgan ads — 4 Jul: €10 → 3 booked, €3.33/booking."*
- Body: KPI headline; per-ad table (spend, CTR, bookings, cost/booking) with day-over-day deltas; a **plain-English callout** generated from the data ("schedule-fit is your cheapest booking at €X; testimonial spent most but converted least"); link to the dashboard.
- Recipients: `locations.settings.ads.report_recipients` (seeded with the owner; empty list = report off for that location). Separate from the churn-digest list.

**Group roll-up report (opt-in):**
- One email per organization to `organizations.settings.ads.rollup_recipients`.
- A row per studio (spend, bookings, cost/booking) + combined totals + best/worst-studio callout.
- Only includes studios the org owns; sent after all per-location sends. Off unless recipients are configured.

## 11. Settings & config

**Per-location (`/settings/locations/[id]` → Integrations → new "Ads" tab):**
- New `AdsIntegrationTab.jsx`, registered like the Glofox/UniFi/WhatsApp tabs, owner/master-guarded (trigger guard on `ad_accounts` writes, mirroring `settings.unifi`).
- Per provider (Meta, TikTok): `external_account_id`, `access_token` (masked; fresh-secret detection via the extracted `channels.js` helpers), `is_active`, a **"Test connection"** button (does a live cheap read and reports success/scope), and `last_sync_error` display.
- Report recipients field → `locations.settings.ads.report_recipients`.

**Org-level:** rollup recipients → `organizations.settings.ads.rollup_recipients` (minimal org-settings surface if none exists).

## 12. Data segmentation guarantees

"Segmented and must not overlap" enforced at four layers:
1. **Row level:** every ads table carries `location_id` directly; every query filters on it. A buggy join cannot surface another studio's rows.
2. **Ingestion:** the sync loop uses *only* a location's own token to pull *only* that location's account, stamping every row with that `location_id`. One studio's token never touches another's data.
3. **Read routes:** every route runs `getCurrentUser` → `assertLocationAccess` (the IDOR invariant); detail routes 404 (not 403) on no-access. Dashboard scopes to the active/entitled locations only.
4. **Reports:** each location's email covers only its own ads to its own recipients; the roll-up aggregates only the locations the viewer/recipient is entitled to.

## 13. Security & permissions

- New `WEB_PERMISSIONS` key `dashboard_ads` + `DEFAULT_WEB_PERMISSIONS_BY_ROLE` entry; decide the mobile counterpart (likely `WEB_ONLY_OK` with reason for v1 — desktop analytics surface, like the other dashboards) so `check:mobile-parity` passes.
- Tokens: plaintext column masked to the browser (matches `channel_connections`; Supabase at-rest encryption; never returned raw; written via a masked-echo-aware sanitiser). `ad_accounts` writes owner/master-only.
- All `/api` reads are service-role (no RLS reliance) and enforce access in app code; RLS on the new tables mirrors sibling snapshot tables and stays advisor-clean (`get_advisors` after DDL).

## 14. Prerequisite: Meta `ads_read` token (manual, per location)

The existing WhatsApp/CAPI token cannot read ads. Each location needs a **Meta System User token with `ads_read`** whose System User has access to that location's ad account. One-time setup per location (a 5-step Business-Settings click-guide ships with the feature). The settings "Test connection" button validates it. This is the only manual gate; everything else is automatic once the token is saved.

## 15. TikTok expansion (drop-in, next week)

- Implement `src/lib/ads/providers/tiktok.js` against the TikTok Marketing API (report endpoints for insights; advertiser/campaign/adgroup/ad for entities), mapping fields to the normalized shape.
- Add a `provider='tiktok'` row per location (advertiser id + OAuth access token) via the same Ads settings tab.
- The sync cron already loops providers; dashboard, attribution, email and roll-up are provider-agnostic and unchanged. A TikTok tab appears automatically.
- Field-mapping deltas to resolve in `tiktok.js`: TikTok's `stat_time_day` → `date`; `spend`→`spend`; `impressions`→`impressions`; `clicks`→`clicks`; `conversion`/`result` semantics differ (map to `results`/`result_type`); breakdowns use TikTok `dimensions`. TikTok requires per-advertiser OAuth (token stored the same masked way).

## 16. Phasing / build order

| Phase | Delivers | Notes |
|---|---|---|
| **0** Prereq | Per-location Meta `ads_read` token + `ad_accounts` settings tab + "Test connection" | Manual token gate |
| **1** Ingestion | 4 tables + `meta.js` + `sync.js` + `ad-insights-sync` cron + backfill | Data flowing, segmented |
| **2** Attribution | `/start` UTM capture + `meta_ad_id` on live ads + `attribution.js` | **Cost per booked class** |
| **3** Dashboard (per-location) | `/dashboard/ads` KPIs + trend + per-ad table | The daily-use surface |
| **4** Email (per-location) | `ad-report-email` cron + per-location report + recipients | The push |
| **5** Roll-up | "All studios" dashboard scope + group roll-up email | Multi-location |
| **6** Breakdowns | placement/age-gender/platform table + panels | Additive |
| **7** TikTok | `tiktok.js` + config; everything else unchanged | The abstraction payoff |

Phases 1–4 are the core loop (data → truth → view → report). 5 delivers the requested roll-up. 6 is additive depth. 7 is next week.

## 17. Testing strategy

- **Pure-lib vitest** (no DB, the repo pattern): `meta.js` field-normalization (Graph response fixture → normalized rows), `attribution.js` join/CPA math, `report.js` email builder (subject + callout generation), snapshot upsert idempotency, `accounts.js` mask/patch helpers.
- **Guarded checks:** `check:route-guards` (new routes), `check:mobile-parity` (the new permission key), `get_advisors` after each migration.
- **Manual E2E checklist** (a prior lesson: mock-heavy tests hide integration bugs): real token → real pull lands rows for the right location only; a real `/start` booking attributes to the correct ad; the daily email renders and sends to the configured recipient; a second location's data never appears in the first's view or email.

## 18. Risks & open questions

- **Token validity:** System User tokens are long-lived but can be invalidated (permission change, app review). Surface `last_sync_error` prominently + a stale-sync signal; a dead token degrades gracefully (stale data shown, health flag raised) rather than erroring the dashboard.
- **Attribution completeness:** v1 covers website `/start` only; CTWA and organic bookings are not per-ad attributed (fall back to campaign-level or unattributed). Documented in the UI so a low CPA-attribution rate isn't misread.
- **Historical clicks pre-`meta_ad_id`:** clicks before the URL change lack the stable id → name/campaign fallback. Acceptable; the window is tiny (campaign is days old).
- **Timezone edges:** account-TZ vs Dublin dates kept separate and labelled; revisit only if a non-Dublin ad account is ever added.
- **Multiple ad accounts per (location, provider):** v1 configures one active; schema permits more. Relax the UI only if a real need appears.
