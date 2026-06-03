# UN1T Platform — Audit & Forward Plan

**Date:** 2026-06-02 · **Scope:** `un1t-crm` (Next.js 16 / Supabase) at mig 240 · **Method:** read-only audit — 3 parallel codebase sweeps + live Supabase inspection (advisors, structure, plan). No code changed during the audit.

> Standing review/planning document. The security findings in §1 are **live as of mig 240** — treat §1 + §2 (Supabase plan) as the actionable shortlist; the rest is a menu to prioritise from.

---

## Context

The platform has grown fast — 240 migrations, 387 API routes, ~2,890 tests, a mobile app, a desktop shell, and a dozen integrations — built largely in rapid Cowork/Claude sessions. This is a step back: where is it half-built, where is it risky, where can it be simplified, is the Supabase setup right (and should it be paid), and what should come next. The headline: **this is a genuinely mature, well-engineered platform, not a prototype** — the auth/crypto/webhook foundations are textbook, pagination and idempotency discipline are real, and TODO/stub density is tiny. But the audit found **three live data-exposure bugs that need fixing now**, a **Supabase Free-tier posture that is wrong for a production business (no backups)**, and a clear backlog of cleanup + roadmap opportunities.

---

## Executive summary — do these first

| # | Action | Why | Effort |
|---|--------|-----|--------|
| 1 | **Fix 3 cross-user data leaks** (contracts list+detail, consent-log, assistant tools) | Any authenticated staff member can read every employment contract (salaries, signatures) and every contact's consent/IP history across all tenants | ~½ day |
| 2 | **Upgrade Supabase to Pro ($25/mo)** | A live system handling payments + PII + contracts currently has **no backups** and can auto-pause | 5 min |
| 3 | **Enable leaked-password protection** (HaveIBeenPwned toggle) | Free Supabase Auth hardening. NB: the 2 SECURITY DEFINER RPC WARNs are **verified intentional — do not revoke** (see §1) | 5 min |
| 4 | **Add `cache_control` to the 3 Anthropic call sites** | ~50% input-cost cut on invoice OCR + assistant + auto-reply | ~30 lines |
| 5 | **Route-level tests for `webhooks/revolut/*` + deposit pay flow** | Highest-consequence untested surface (idempotency/replay on money) | ~1 day |
| 6 | **Cleanup migration**: drop deprecated columns + scrub stale comments | `event_types.reminder_*` (7 cols) dropped (mig 241); `profiles` comp cols NOT droppable — see §4. Stale `public.shifts` comment scrub still pending | ~2 hrs |

**Status (updated 2026-06-03):** **Do-first shortlist all shipped.** #1 ✅ ([#291](https://github.com/ivers9307-cyber/un1t-crm/pull/291)) · #2 ✅ org on Pro · #3 ✅ leaked-password toggle is operator-only (the 2 SECURITY DEFINER RPCs verified intentional — legitimate champ-app customer calls, `mig 216` — left alone) · #4 ✅ prompt caching ([#299](https://github.com/ivers9307-cyber/un1t-crm/pull/299)) · #5 ✅ payment/webhook idempotency tests across all 3 Revolut money routes ([#300](https://github.com/ivers9307-cyber/un1t-crm/pull/300), [#303](https://github.com/ivers9307-cyber/un1t-crm/pull/303)) · #6 ✅ cleanup migration + comment scrub ([#301](https://github.com/ivers9307-cyber/un1t-crm/pull/301), [#302](https://github.com/ivers9307-cyber/un1t-crm/pull/302)).
> **Beyond the shortlist:** Tier 2 advisor cleanup partly done — 9 FK indexes + 6 `auth_rls_initplan` wraps shipped (mig 242, [#304](https://github.com/ivers9307-cyber/un1t-crm/pull/304)); §4 `recharts` lazy-load + stale-fact refresh shipped ([#305](https://github.com/ivers9307-cyber/un1t-crm/pull/305)). **Still open:** the 61 `multiple_permissive_policies` + 194 `unused_index` (careful per-item review), Playwright e2e smoke, the `force-dynamic`/`'use client'` perf audit, and the value tier (Churn Radar Phase 2, win-back sequences, Analytics/BI).
> **Three audit recommendations were wrong on verification** and corrected rather than executed: revoke-2-RPCs (would break the customer portal), drop-`profiles`-comp-columns (still load-bearing — 48–69 live refs each), and blind-consolidate-the-61-policies (legitimate overlaps). Treat this doc as a strong map, not gospel — verify before destructive/security changes.

---

## 1. Security posture

**Overall: strong foundations, three real holes from later-added features.** Middleware/proxy, webhook signature verification (every webhook verifies HMAC/secret over the raw body and fails closed), service-role confinement (no browser-side service-role use), the master/impersonation model, PIN-login defence-in-depth, and `admin/password-override` hardening are all done correctly and well-documented. RLS is enabled on **all 132 tables**. The issues below are a narrow class, not systemic.

### 🔴 Must-fix (confirmed against source)

The common root cause: a route uses `createServerClient()` (service role — **bypasses RLS**) but a comment claims *"RLS enforces visibility."* It doesn't, because RLS policies only bind the `authenticated` role, never service-role. So there is **no** access filter.

| ID | Route | Exposure | Confirmed |
|----|-------|----------|-----------|
| **C1** | `src/app/api/contracts/route.js:44-62` (GET list) + `src/app/api/contracts/[id]/route.js` (GET detail) | Any authenticated user reads **every employment contract** across all tenants: rendered body, `variables_data` (salary/comp), `signature_value`, `signed_ip` | ✅ read the file |
| **H1** | `src/app/api/contacts/[id]/consent-log/route.js:25-45` | Any authenticated user reads **any contact's GDPR consent history**, incl. `ip_address` + `performed_by`, by enumerating contact IDs | ✅ read the file |
| **H2** | `src/app/api/assistant/chat/route.js` `executeTool()` | Assistant tools (`search_contacts`, `list_staff`, `create_contact`, `move_deal`, `create_activity`) run with **no `location_id` scoping** → a manager can read/mutate another tenant's data via chat; `create_contact` inserts unscoped rows | ⚠️ agent-reported, strong evidence — verify then fix |

**Severity note:** even with one operator today, *staff accounts exist* (coaches/managers at Stillorgan), so C1/H1 already leak colleagues' salaries and members' IPs internally — not just a future-multi-tenant concern.

**Fix pattern (reuse what already works):** mirror the correct post-fetch scoping in `src/app/api/invoices/[id]/route.js:41-51` and the `assertLocationAccess(user, locationId)` / `assertRowInOrg` helpers used throughout `cars/[id]`, `orders`, `contacts/[id]`. For the assistant, `context.locationId` is already in server scope — add `.eq('location_id', locationId)` to reads, stamp it on inserts, verify ownership before `move_deal`.

### 🟠 Should-fix
- **M1 — `contract_templates` not org-scoped** (`contract-templates/route.js:21-35`): owner of org A sees org B's templates. Low impact today (one master), but breaks the tenant isolation the org tier exists for.
- **M2 — silent secret fallback** (`src/lib/studio-session.js:38-49`): `STUDIO_SESSION_SECRET || SUPABASE_SERVICE_ROLE_KEY` violates the "no silent env fallbacks" rule and couples the cookie-signing key to the service-role key. Fail closed instead.
- **Supabase Auth — leaked-password protection is OFF** (advisor WARN): enable the HaveIBeenPwned check in the Auth dashboard (free, one toggle).
- **2 SECURITY DEFINER RPCs callable by `authenticated`** (advisor WARN) — **verified intentional, no action.** `public.list_enabled_integrations()` (returns only `provider` + `display_name`, never secrets) and `public.scan_straps_for_contact()` (gated internally by `private.auth_contact_id()`, returns ephemeral 30s strap-scan data) are deliberately called by signed-in **champ-app** customers (`account/integrations/page.jsx`, `account/devices/ScanForStraps.jsx`); `mig 216` already documents both as must-keep-grant. SECURITY DEFINER is required so customers can read this without direct table access. The advisor WARN is an accepted false-positive for these two — do **not** revoke (it would break the customer portal).

### 🟡 Low / informational
- **11 tables: RLS enabled, no policy** (advisor INFO: `api_keys`, `pin_login_attempts`, `location_trusted_ips`, `studio_devices`, `issues`, `checklist_*`, `ac_*`, `membership_snapshots`). This is **deny-all to browser clients** (service role still works) — safe *if* these are service-role-only by design (they appear to be). Action: confirm none need an authenticated browser read; if one does, add an explicit policy.
- **Cron auth uses plain `!==`** not constant-time (28 routes) — Vercel sets the header server-side so timing attack is impractical; route through `safeEqual()` for consistency.
- **`xero/debug`** reveals secret length + 8 chars to any owner — gate master-only.
- **`thinq.js:39` hardcoded key** — **not a secret** (LG's public Connect program key, documented). No action.

---

## 2. Supabase environment review

**Structure: healthy.** Postgres 17, eu-west-1, `ACTIVE_HEALTHY`. **132 public tables, RLS enabled on 100% of them**, 1 view. **DB size 72 MB** (well within any tier). Largest tables are all reasonable: `contacts` 13 MB / 8.2k rows, `glofox_webhook_events` 8.8 MB, `activities` 5 MB / 13k, `deals` 3.2 MB, `consent_log` 2.8 MB. No structural red flags.

**Performance advisor: 272 lints** — a hygiene backlog, not a fire:
- **196 `unused_index` (INFO)** — index bloat. *Don't blind-drop* (Free-tier stats reset on restart make "unused" unreliable, and some serve rare queries). Needs a deliberate audit pass once on Pro with stable stats.
- **61 `multiple_permissive_policies` (WARN)** — usually a stray wide-open `Service role full access` policy sitting alongside the real per-location one; adds per-query overhead. A consolidation pass (like mig 167) clears these.
- **9 `unindexed_foreign_keys` (WARN)** — easy win, add covering indexes.
- **6 `auth_rls_initplan` (WARN)** — RLS calling `auth.uid()` per-row instead of `(SELECT auth.uid())`; wrap them (CLAUDE.md PERF.1 fixed 8, these are stragglers).

→ One "advisor cleanup" migration knocks out the 61 + 9 + 6 WARNs cheaply; the 196 unused indexes are a separate, careful pass.

### Paid plan: **Yes — upgrade to Pro ($25/mo). Recommended.**

The org is on **Free**. The decision is **risk, not capacity** — we're at 14% of the size limit and MAU/egress are tiny for a single-gym staff tool. But Free is genuinely inappropriate for this system:

| Factor | Free | Pro | Verdict |
|--------|------|-----|---------|
| **Daily backups / PITR** | ❌ none | ✅ daily, 7-day retention (PITR add-on optional) | **Decisive.** Payments + member PII + GDPR records + employment contracts with *no backup* is unacceptable — and we apply migrations directly to prod. |
| **Auto-pause** | Pauses after 7 days inactivity | Never pauses | A cron/billing hiccup could take the live gym CRM offline |
| **Log retention** | 1 day | 7 days | The 2026-05-01 cron-secret drift took ~22h to surface; 1-day logs barely cover incidents |
| **Compute** | shared micro | dedicated, scalable | Fine now; a ceiling as data + crons grow |
| DB / MAU / egress | 500 MB / 50k / 5 GB | 8 GB / 100k / 250 GB | Not the constraint today |

**Recommendation:** upgrade the org to Pro now; **skip the PITR add-on** (daily backups suffice at this volume — revisit if transaction volume climbs). Note Pro is billed per-org; the separate `un1t-sentinel` project adds a small compute line — acceptable, and keeping Sentinel on its own project is the right call (so a CRM outage doesn't blind the watcher).

---

## 3. Feature completeness & maturity

**Density of incomplete work is low** — 6 total TODO/FIXME/XXX in all of `src/`, no routes returning mock data. Immaturity is concentrated in (a) deferred "Phase N" tails, (b) paper-only design docs, (c) whole missing categories. **Beware stale status markers**: several comments/docs describe a pre-build state for features that *shipped* (BCA route header, contracts "stub" comment, the STUDIO_AC_THINQ doc, the PLATFORM_ROADMAP "radars don't act" framing). Trust the code.

### Genuine gaps in shipped features
| Item | Status |
|------|--------|
| **Scheduled-report email delivery** (`cron/run-scheduled-reports/route.js:92`) | UI+schema exist; backend is a **TODO stub** — `deliver_email` silently no-ops |
| **Contracts PDF generation** | Deferred — HTML print-to-PDF is the current legal record |
| **2FA / SSO** (`settings/page.js:253,260`) | "Coming soon" placeholders, no backend |
| **Inbound SMS** | Outbound only |
| **Per-event-type sequence filter** (`SequenceEditor.jsx:1287`) | Booking sequences fire on *any* booking |
| **ANT+ HR bridge** | champ-bridge code merged but **never run on hardware** — the data-producing edge is unvalidated |
| **Glofox passcode 30-day TTL cleanup** (`glofox-push.js:223`) | Minor data-hygiene TODO |

### Paper-only / partially-built (design docs)
- **Revolut Business (outbound supplier payments)** — `docs/REVOLUT_PAYMENTS_DESIGN.md`: **zero code**, 4 open decisions block phase 1. (The existing `revolut.js` is the *Merchant* API for inbound only.)
- **Studio Devices** — Phase 0 (PIN auth) + Phase 1 (iPad) **shipped**; Phase 2 (Mac/Tauri) scaffolded in `desktop/` but CI/signing/auto-update unbuilt; Phase 3 (coach in-class) + Phase 4 (kiosk) not started.
- **Churn Radar** — Phase 1 live; Phase 2 (payment-trouble signal) + Phase 3 (leads/trials/ClassPass cohorts) designed-not-built.
- **Sentinel** — Phase 1+2 live; Phase 3 (auto-remediation) planned-not-shipped.
- **Note:** four design files you may expect at repo root (`whatsapp-coexistence-*`, `whatsapp-agent-plan`, `hatch-street-platform-integration-spec`, `un1tdublin-two-location-plan`) **are not in the repo** — their *features* are mostly built (customer-messaging agent is mature; WhatsApp coexistence storage/UI built but onboarding is gated on Meta Tech-Provider approval). Don't read their absence as "missing."

### Module maturity (condensed)
**Solid:** CRM/Pipeline, Events/Bookings, Email, WhatsApp, SMS, Roster v2, Cars, Xero, Revolut-inbound, UniFi Access + Protect attendance, Lead radar, Customer-messaging agent, Instagram, Mobile app, AC control (Sensibo+ThinQ), Approvals, Invoices-AP queue, Admin matrix/Orgs, Studio PIN+iPad.
**Has gaps:** HR/Reporting (email stub), Churn radar (phased), Contracts (PDF), TV/live-HR (bridge unproven), Sentinel (phase 3).
**Immature / paper:** Mac shell, coach-in-class, Revolut Business outbound.

### Whole-category gaps (confirmed: no code)
Referral program · Member NPS/feedback/surveys · Reviews/reputation (Google) · Marketing attribution (ad-spend → revenue) · Analytics/BI layer (MRR / churn-rate / LTV cohorts). Also absent: structured new-member onboarding journey, win-back/dunning sequences, coach performance scorecards, corporate/B2B memberships.

---

## 4. Technical debt & simplification

**Codebase is in good health** — the CLAUDE.md lessons are genuinely internalized (pagination discipline real, the supabase-js `.catch` gotcha gone from query builders, console.log down to 7 justified instances, response shape consistent). What remains:

**Simplify (high value / low effort):**
- **Drop deprecated columns** — `event_types.reminder_*` (actually **7** cols incl. `reminder_channel` + `reminder_whatsapp_template_id`, not 6): verified zero readers + no fn/view/trigger refs + zero live data → **dropped in mig 241** (CACHE-FREE win). **Correction:** the `profiles` comp columns (`annual_salary`/`hourly_rate`/`overtime_rate`/`contracted_hours_per_week`/`annual_leave_entitlement`) are **NOT droppable** — verification found 48–69 live refs each: `assistant/chat` (staff-cost tool), `contracts` (issuance), `invoices` (contractor rate), and `staff` route **dual-writes** to both `profiles` *and* `profile_compensation`. The migration to `profile_compensation` is an incomplete dual-write, not "phase 3 ready." Cutting the reads over to `profile_compensation` first is its own task before these can be dropped.
- **Delete `src/lib/xero/files.js`** (dead, zero importers) and **scrub ~14 stale `public.shifts` / "mig 068 trigger" comments** (the table+triggers were dropped in mig 238 — comments now mislead).
- **Pin device-key helpers** (triplicated verbatim across un1t-crm/champ-app/champ-bridge): don't package — add a shared golden-vector test fixture to all three suites to kill silent drift.

**Technical enhancements (ranked):**
1. **Prompt caching** on all 3 Anthropic callers — `invoice-extraction.js:52`, `assistant/chat/route.js:382 & 474` (re-sends full system prompt + tools every turn — biggest win), `agent/auto-reply.js:36`. None cached today. ~30 lines total. *(Confirm the beta header is still needed for the pinned API version — caching is GA now.)*
2. **`force-dynamic` on 123 `page.js`** — the largest untapped perf lever; many authed list/detail pages could use `revalidate` + static shell or Next-16 defaults.
3. **Dynamic-import `recharts`** in `dashboard/MembershipPanel.jsx:13` (static heavy import) — biggest one-line bundle win; only 3 `dynamic()` imports exist app-wide.
4. **Re-examine the `'use client'` audit** — CLAUDE.md says "46 components"; actual is **166**. The note is 3.5× stale.
5. **WAInbox 60s heartbeat** — Realtime has been live since mig 042; decide now to push to 5 min or drop (12× fewer requests).
6. **Refactor `ScheduleCalendar.jsx`** (2,023 lines, 40 `useState`, 6 in-file modals) — extract modals to `src/components/schedule/`; highest-leverage structural cleanup. `StaffForm.jsx` (1,942 lines) is the next.

**Test coverage — the one real structural gap:** ~2,890 tests but **lib-helper-heavy: 143/172 lib files tested, only 10/387 routes, zero e2e.** The untested **webhook + payment route handlers** (`webhooks/revolut/*`, `public/deposit/*/accept-and-pay`, `cars/[id]/issue-*`) carry exactly the idempotency/replay/state-reset risks CLAUDE.md says bit hardest. **Add route-level tests here first**, then a thin Playwright smoke (login→book→confirm; deposit→pay sandbox→webhook→status flips) to catch the build-wiring failures that slip past vitest+eslint.

**Doc drift to fix in CLAUDE.md:** "22 migrations" → 235; "Next 14" → Next 16; "46 'use client'" → 166; add `auto-reply.js` to the caching backlog; note the 7 storage `.remove().catch()` calls are *correct* (real Promise, not the builder gotcha) so nobody "fixes" them.

---

## 5. Future roadmap

Themed, synthesized from `docs/PLATFORM_ROADMAP.md` (19 opportunities), the CLAUDE.md backlog, and the gaps above. Not commitments — a menu to prioritize from.

### Near-term (weeks) — close loops already 80% built
- **Churn Radar Phase 2** — payment-trouble signal (now feasible: `glofox_invoices` flows in real-time; expiry/credits already synced). Highest-ROI retention lever.
- **Win-back / dunning sequences** — the sequence engine exists; wire overdue-payment + lapsed-member journeys into it. Pairs with the radars' one-click outreach (already shipped).
- **Scheduled-report email delivery** — finish the stub; operators expect it.
- **Re-enable Hatch Street** (open task) when it opens — one-line revert in `welcome/page.js`.

### Mid-term (1-2 quarters) — new capabilities with clear demand
- **Analytics / BI layer** — the biggest strategic gap. MRR, churn-rate-over-time, LTV cohorts, CAC. Per-contact LTV exists; there's no aggregated business-health view. Foundation for every other data decision.
- **Member NPS / feedback** — no sentiment capture anywhere; the radars see behaviour, not satisfaction. Post-class or periodic survey → feeds churn scoring.
- **Referral program** — `referral` is only a lead-source tag today; a real referral-link/reward engine is a proven gym-acquisition channel.
- **New-member onboarding journey** — structured 90-day automated sequence (currently ad-hoc).
- **Revolut Business (supplier payments)** — closes the AP loop (ingest → bill → *pay* → reconcile). Design exists; settle the 4 open decisions first.

### Longer-term (bets)
- **Marketing attribution** — tie ad spend (Meta/Google/TikTok) to conversions/revenue in-CRM; today spend and outcomes never meet.
- **Reviews / reputation** — automated Google-review prompting post-positive-experience.
- **Studio Devices Phase 2-3** — Mac shell to production, coach in-class mode (offline-first).
- **Brand-aware AppShell** — per-org chrome (CCF Autos vs UN1T) without separate deploys — increasingly relevant as the org tier fills out.
- **Sentinel Phase 3** — auto-remediation safe-list with approval.

---

## 6. Suggested sequencing

1. **First (safety):** fix C1/H1/H2 (PR + verify); upgrade Supabase to Pro; enable leaked-password protection. *(The 2 SECURITY DEFINER RPCs are intentional — see §1 — and were **not** revoked.)* *Hard-to-reverse / outward-facing — do under direct supervision.*
2. **Next (hygiene, low-risk):** advisor cleanup migration (FK indexes + initplan + multi-permissive); drop deprecated columns; delete dead file + scrub stale comments; add Anthropic prompt caching.
3. **Then (resilience):** route-level tests for webhooks/payments; Playwright smoke; refresh stale CLAUDE.md facts.
4. **Then (value):** Churn Radar Phase 2 + win-back sequences; scope the Analytics/BI layer.

---

## Verification / how to act on this

- **Security fixes:** after editing, re-run the 3 routes' access checks manually (impersonate a `staff` user via the now-hardened impersonation flow and confirm contracts list / consent-log / assistant return only in-scope data); add a route test asserting a non-owner gets 403/empty. Re-run `get_advisors(security)` after any DDL.
- **Supabase upgrade:** Dashboard → Org → Billing → upgrade to Pro; confirm "Daily backups" appears under Database → Backups within ~24h.
- **Advisor cleanup:** apply the migration, then re-run `get_advisors(performance)` — the 9 FK + 6 initplan + 61 multi-permissive WARNs should clear; unused-index count is expected to stay high (separate pass).
- **Prompt caching:** confirm cache hit-rate via the Anthropic usage dashboard after a day of real invoice/assistant traffic.
- Everything here is read-only-verified as of mig 240; re-confirm file:line before editing as the tree moves.
