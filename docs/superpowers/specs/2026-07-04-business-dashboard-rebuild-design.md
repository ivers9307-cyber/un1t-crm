# Business Dashboard Rebuild — Design

**Date:** 2026-07-04
**Status:** Approved by Richard (chat, 2026-07-04; layout chosen from rendered mockups: "Option A command centre + Option B's briefing line")
**Branch:** `feat/business-dashboard-rebuild`
**Model split (Richard's instruction):** Fable 5 plans and reviews; implementation subagents run on Opus 4.8.

## Problem

`/dashboard/business` is thin and deal-centric: pipeline deal KPIs, a membership panel, scheduled-labour cards. Revenue, churn, arrears, funnel, ads, and action items all live on other pages. The owner opens the dashboard and still has to visit five places to answer "how's the business and what needs me?"

## Goal

Rebuild `/dashboard/business` as an owner command centre answering both morning questions on one screen: a plain-English briefing line, a KPI grid with deltas, funnel/ads/ops panels, and an always-visible "Needs you" action rail. All data live per load, streamed so the page never feels slow.

## Decisions made (with Richard)

1. **Scope = Business dashboard only.** Studio, Today, and the tab pages (radars, engagement, ads) are untouched. The segmented control and `dashboard_business` permission gate stay as-is.
2. **Layout = command centre + briefing line** (chosen from two rendered mockups): briefing sentence across the top; left column = KPI 4-up, funnel + ads panels, membership trend, today's-ops strip; right rail = "Needs you" list.
3. **All-live data** (Richard overrode the hybrid recommendation). Engineering counterweight: per-block Suspense streaming so first paint is instant while heavier queries fill in.
4. **Blocks in scope (all four groups):** revenue + members + churn; acquisition funnel + ads; today's operations; action feed.
5. **Briefing line is deterministic** — a pure template function over the fetched numbers, no AI call. A Mia-written variant is a possible later layer (Wave-3-style), out of scope here.
6. **Failed executions appear in the action rail** — this deliberately resolves the open product question of where `agent_membership_requests.status='failed'` surfaces for staff.

## Composition (target render order)

```
[Chrome: "Business · <location>" + Business/Studio/Today segmented control]   (existing layout)
[Briefing line]                                    full width
[KPI 4-up: Revenue MTD · Members · Churn risk · Arrears]   left ⅔   [Needs you rail]  right ⅓
[Funnel panel | Ads panel]                          left ⅔   [  … rail continues  ]
[Membership trend (existing MembershipPanel)]       left ⅔
[Today strip: booked · classes · staff on · labour] left ⅔
```
Below `xl:` the rail stacks above the KPI grid (actions first on small screens). Each KPI card and rail row deep-links to its owning page (`/pipeline`→funnel, `/dashboard/churn-radar`, `/communications/inbox?c=…` for approvals, etc.).

### Block content
- **Revenue MTD**: sum of PAID Glofox invoice amounts this calendar month + delta vs same-day-of-month last month. Sub-label: paid count.
- **Members**: current active member count (existing `computeMembershipCounts`) + net change this month (from `membership_snapshots`).
- **Churn risk**: current churn-radar flagged count + new-this-week. Links to `/dashboard/churn-radar`.
- **Arrears**: € total + member count from the daily-reconcile output (mig 324 pipeline) — NEVER computed from raw `glofox_invoices`.
- **Funnel panel**: current-month counts per acquisition-funnel stage (`contacts.pipeline_stage_slug`, 5-col funnel) rendered as a mini bar set + "X leads → Y converted · Z%".
- **Ads panel**: last-7-days spend, leads, €/lead from the ads-insight tables (migs 358-361); "N booked a class" via the existing utm_content attribution.
- **Membership trend**: reuse the existing `MembershipPanel` (live counts + 12-mo `membership_snapshots` trend) unchanged.
- **Today strip**: bookings today (staff-facing counts are fine — the never-surface-capacity rule is customer-facing), class occurrences today, staff on shift today, scheduled labour € this week (existing calc).
- **Needs you rail**: one list in fixed category order — approvals, failed, arrears, churn, leads — each row = category chip + one-line summary + deep link; categories with zero items don't render. Categories v1: pending agent approvals (registry total), failed executions (`agent_membership_requests.status='failed'` within the last 7 days — no dismiss mechanism in v1, rows age out of the window; a dismiss affordance is a follow-up if the list proves noisy), arrears follow-ups, churn-radar quiet members, uncontacted leads older than 24h. Reuse/extend the existing "Needs attention" feed source from the sidebar IA regroup if its API covers these; add categories where it doesn't (planning verifies).

## Briefing line

Pure function `buildBusinessBriefing(blocks)` in `shared/` (mobile-reusable, unit-tested): takes the already-fetched block values, returns one sentence of the form "<tone word> <period>: €X MTD (±Y%), N members (±M). Watch: <top 2-3 attention items>." Tone word picked by simple thresholds (revenue delta sign, attention count). No model call, no randomness, deterministic for a given input.

## Architecture

- **Server components + Suspense per block.** The page renders chrome + layout immediately; each block is an async server component wrapped in `<Suspense fallback={<BlockSkeleton/>}>`. Blocks fetch in parallel by construction.
- **Per-block isolation.** Each block try/catches its own fetch; on failure renders a compact muted "Couldn't load — retry" cell. A single upstream failure can never blank the page (the current page's all-or-nothing `fetchBusinessDashboardData` error state goes away).
- **Data helpers live in `shared/dashboard-data.js`** (the existing web+mobile seam — the mobile BusinessDashboard reads it today): new fetchers added alongside `fetchBusinessDashboardData`, each independently callable, pure-JS + supabase-client-in. Web page calls them directly (server component, service-role client); mobile can adopt block-by-block later (out of scope).
- **The briefing needs the KPI values** → the briefing block awaits the same four cheap fetchers (they're each a single aggregate query; double-fetch avoided by module-level per-request memo or by lifting the four cheap fetches above the Suspense split — planning picks the simpler).
- **No new permission key** (`dashboard_business` gates everything). No migration expected; if the arrears-reconcile output or funnel counts need a covering index, that's a planning-time check with a forward-only migration via MCP if genuinely needed.
- **What's removed:** the pipeline deal KPI cards (open/won/lost/win-rate) leave the dashboard — deals live at `/pipeline`, and the funnel panel is the acquisition view that matches how the business actually runs. Scheduled-labour detail collapses into the Today strip.

## Data honesty rules (bind the implementation)

- Revenue from PAID rows only; the stale-invoices invariant means totals are webhook-fed — planning verifies against the arrears-reconcile code path and states the caveat in a code comment.
- Arrears exclusively from the reconcile output. Funnel counts exclusively from `pipeline_stage_slug` (trigger-maintained). `lead_created_at` is import-poisoned — any "new leads" measure uses `joined_at`/`created_at` per the funnel redesign's convention (planning confirms the exact column).
- Every aggregate is a single SQL aggregate (or an existing lib call) — no 1k-row-cap fan-outs in page render.

## Error handling / perf

Per-block failure isolation (above); no client-side polling (server-rendered per load; the browser refresh is the refresh); streaming keeps TTFB flat as blocks are added. Target: shell paint unchanged from today, all blocks settled well under the current single-blob load.

## Testing

Vitest for the pure parts: `buildBusinessBriefing` matrix, funnel aggregation shaping, any delta/formatting helpers. Fetchers follow house convention (no DB tests); page verified by `npm run build` + manual smoke. Full CI mirror before PR.

## Out of scope

Studio/Today/tab rebuilds; mobile adoption of the new blocks; Mia-written briefing; dashboard customisation (block picker); real-time push updates; historical revenue reporting beyond the MTD delta.
