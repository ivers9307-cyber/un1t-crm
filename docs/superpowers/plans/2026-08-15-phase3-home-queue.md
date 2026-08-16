# Phase 3 — Home Needs-Attention Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Checkbox steps.

**Goal:** One aggregated, item-level needs-attention queue on the Today dashboard — approvals (11 registry providers), email tickets, and WA/IG threads as actual rows with ages and deep links — retiring the sidebar badge apparatus and the interim `queues` section.

**Architecture (from the 2026-08-15 grounding report):** REUSE, don't rebuild. The approvals registry (`src/lib/approvals/registry.js`) already returns `ApprovalItem` rows (`{id,title,subtitle,meta,submittedAt,reviewUrl}`) behind per-provider gates — that's 3 of the 6 named sources for free (incl. issues + offer sales + supplier invoices). A new `src/lib/home-queue.js` fans out over: the registry (`getPendingApprovals`) + a tickets source (the `email/tickets` route's own helpers: `loadVisibleMailboxes` + `scopeToNeedsReply` + `scopeToUnmerged` — the mailbox-visibility layer is the one non-trivial scoping rule) + a WA/IG source (the `needsAction` predicate from `src/lib/inbox-queues.js`, filtered in-process like the count route). Merge-sort by `submittedAt`/`last_message_at`, cap at 30 rows + per-source counts. One endpoint `/api/home-queue` (+ `/api/home-queue/count` for the document title). Error posture: the email-count precedent — quiet 0 for ineligible, 500 only when a visibility lookup itself fails.

**Contract preservation:** `shared/today-feed.js` row-id vocabulary is shared with the morning-briefing email and mobile (`mobile/lib/today-feed-nav.js`) — it STAYS for the count-summary rows the email renders. The Today page's web block swaps to the new item-level queue; the cron's `fetchLocationTodayFeed` variant keeps working (approvals row stays null there — no viewer; tickets stay OUT of the email, documented: mailbox visibility is per-viewer).

**Inconsistencies to resolve IN this phase (each a place two numbers disagree):**
1. WA: badge uses `needsAction`, today-feed-data uses raw `unread_count` sum — unify BOTH paths on `needsAction` (including the location-level cron variant; changelog-note the briefing semantics change).
2. Issues: `/api/issues/count` counts open+in_progress, the approvals provider open-only — unify BOTH on open+in_progress (update the provider + its test).
3. Email tickets absent from today-feed despite a sidebar badge — resolved by the queue itself (web); email deliberately excluded (above).
4. `host_events` is org-scoped vs everything else location-scoped — KEEP as-is, rendered with an org-wide marker on the row; comment the decision.

**Branch:** worktree `home-3-queue` off origin/main (post-chips-PRs if those merged first — rebase-tolerant either way). `npm ci`, baseline. ONE test-running worktree at a time (8GB machine).

---

### Task 1: `src/lib/home-queue.js` + endpoints (TDD)

1. `assembleHomeQueue(db, user)` → `{ rows: QueueRow[], counts: {approvals, tickets, inbox}, total }` where `QueueRow = { source, sourceLabel, id, title, subtitle, occurredAt, href, orgWide? }`. Approvals rows map from `getPendingApprovals` (source = provider key, href = reviewUrl, occurredAt = submittedAt, orgWide for host_events). Tickets rows: call the tickets helpers directly (NOT the HTTP route) with the viewer's active location + mailbox visibility; href `/communications/tickets` (+ id param matching what the tickets UI reads — verify). Inbox rows: conversations filtered by `needsAction` (select the predicate columns + contact name, JS-filter, cap), href = the inbox thread deep link (read WAInbox for the param it consumes). Merge-sort desc by recency, cap 30 (per-source pre-cap 20), counts are UNCAPPED true counts.
2. Gates per source mirror the existing count routes exactly (approvals: registry visibility; tickets: `hasPermissionForLocation(email_inbox)` + mailbox layer; inbox: `hasPermission('whatsapp')`). No active location → empty.
3. Unify inconsistency #2 first (issues provider counts open+in_progress; TDD against `src/lib/approvals/providers/issues.test.js` if it exists, else the registry tests) and #1 (today-feed-data's WA source → `needsAction`; update its tests + the briefing note).
4. Routes: `GET /api/home-queue` (withAuth; full assemble) and `GET /api/home-queue/count` (cheap: reuse `getPendingApprovalsCount` + the two count queries; same envelope `{success, data:{count}}` so `usePolledCount` can consume). Route-guard script compliance (withAuth idiom).
5. Tests: unit-test `assembleHomeQueue` with a mocked db per source (fixture pattern from registry tests); route tests per the repo's API-test idiom if one exists (check how other /api tests are written — many aren't; the lib tests are the substance).
6. Full `npm test`. Commit.

### Task 2: The Today page queue panel

1. Replace the count-row "Needs attention" block in `src/app/dashboard/today/page.js` (:129-153) with the item-level queue: server-fetch `assembleHomeQueue` alongside the existing parallel fetches; render with the existing `SectionHeader`/`ListCard`/`PendingRow` primitives (PendingRow's `time` slot takes the age — add a tiny `formatAge(occurredAt)` helper or reuse one if it exists — grep for relative-time helpers first). Per-source subheaders with counts when rows from 3+ sources mix; "View all" links to /approvals, /communications/tickets, /communications/inbox per section.
2. `shared/today-feed.js` untouched EXCEPT the WA-predicate unification from Task 1 already changed `today-feed-data.js` — verify the email rendering still works (`morning-briefing` tests).
3. The Today page keeps roster/KPI/alert blocks as-is. Empty state: "Nothing needs your attention" (only when every source the viewer can see is empty).
4. Full `npm test` + `npm run build`. Commit.

### Task 3: Retire the sidebar apparatus + queues section (TDD)

1. nav-items tests first: `queues` section GONE from NAV_SECTIONS; `/approvals` + `/issues` entries deleted (pages survive as deep-link destinations); delete the interim-section test. Check the palette has approvals/issues entries for keyboard reach (add if missing — real pages, K5-safe).
2. `Sidebar.jsx`: delete the poller imports + the 8 `usePolledCount` calls + the `badges` map + `badge` prop threading (KEEP `SidebarItem`'s badge rendering ability if trivial, else remove it too — decide by diff size; hub-tab badges are a different surface and stay). Document-title effect: ONE `usePolledCount` on `/api/home-queue/count` (gate: any of the queue-feeding permissions — or ungated-enabled since the endpoint quietly returns the viewer-scoped count; decide, comment).
3. Count-route audit: after this, `/api/issues/count`, `/api/churn-radar/count`, `/api/lead-radar/count`, `/api/hosts/pending-events/count`, `/api/approvals/count` may be consumer-less on web — but mobile + hub tabs still consume several. CHECK each caller (grep + mobile/) and delete ONLY truly-orphaned routes, listing the evidence; keep any with doubt (deletion is cheap later).
4. Sidebar.test.jsx + full suite + build. Commit.

### Task 4: Finalize + PR + final review

CI mirror + build + CHANGELOG (`HOME.3`: phase 3 delivered — the queue, the two unified count definitions with the briefing-semantics note, the sidebar badge retirement, the org-scoped host_events decision, tickets-in-email exclusion rationale) + PR `"HOME.3 — the needs-attention queue; sidebar badges retire"` (QA notes: Today shows item rows with ages + working deep links incl. approvals ?focus= params; document title counts the queue; sidebar has NO badges and NO queue section; Messages/Money hub TAB badges still work; morning-briefing email unchanged except WA row now counts needs-action) + final whole-branch review (seams: per-source gate parity vs the old badges; the mailbox-visibility layer; the briefing email; count-route deletions' evidence) + merge per standing auth.
