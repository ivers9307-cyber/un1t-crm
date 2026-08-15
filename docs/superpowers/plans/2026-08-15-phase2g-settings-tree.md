# Phase 2G — Settings Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Checkbox steps.

**Goal:** Replace the 551-line `/settings` card grid with the spec's 7-group tree (§3.4), give `/settings/*` a shared layout ending the hand-rolled back-link chaos, and close the four ungated settings pages found in exploration.

**Scope:** `/admin` dissolution is the NEXT PR (2H) — this PR only restructures `/settings` itself. Links into surviving `/admin/*` pages (glofox-import, marketing-import, achievements, integrations) keep their current hrefs and re-point in 2H. Per-location tabs (`/settings/locations/[id]?section=…`) untouched.

**Branch:** worktree `settings-2g-tree` off origin/main (after 2F merges). `npm ci`, baseline.

**Grounding (from the 2026-08-15 settings exploration — re-verify at execution):** index gate = `settings` perm; 9 card sections, 24 links (5 into /admin); NO settings layout exists — every sub-page self-gates and back-links are inconsistent (ArrowLeft vs ChevronLeft, 3 sizes, 14 variants, some absent); FOUR pages have NO server gate (client components relying on API gates): `customer-agent/page.js`, `customer-agent/analytics/page.js`, `customer-agent/requests/page.js`, `scoring/page.js`. Tests pinning settings routes: `integrations-hub.test.js:125,157-162`, `integration-health.test.js:274`, `command-palette.test.js:170`, `wallet-topup.test.js:188`, `host-notifications.test.js:34`, `account-nav.test.js:35,38` — none pin the INDEX's structure, so the grid rewrite is test-free at the index level (add structure tests, below).

---

### Task 1: Server gates for the four ungated pages (security rider, ships first)

Each of `customer-agent` (+`analytics`, `requests`) and `scoring` gets a server gate. They're `'use client'` pages — convert each to the established wrapper pattern: a thin server `page.js` (getCurrentUser → login redirect; gate; render the client component moved to a sibling file) — mirror how `settings/scoring`'s API (`/api/settings/scoring`) gates and use the same key it enforces (READ the API routes to pick the true keys: customer-agent API gate vs scoring API gate — mirror exactly; report the keys found). TDD: page tests per the TPL-IDOR.1/hub-index house pattern. Commit per page-pair or one commit — implementer's call, reviewed.

### Task 2: `/settings` shared layout

New `src/app/settings/layout.js`: server component; getCurrentUser → `/login`; NO blanket permission gate (sub-pages have heterogeneous gates — a layout-level `settings` gate would lock out e.g. MANAGER_ROLES-only pages whose users lack the `settings` key; verify this heterogeneity claim against the exploration table before deciding, and if a common floor exists, state it) — the layout provides CHROME only: a consistent header with a breadcrumb (`Settings / <section>`) and ONE standardized back-link, replacing the 14 hand-rolled variants. Sub-pages keep their own gates. Delete the per-page back-link JSX from every `/settings/*` page in the same commit (list them from the exploration: class-categories, holidays, usage, email-domain, billing, notifications, api-keys, hosts, staff, impersonate + the notifications/health, customer-agent/analytics, hosts/[id] deep variants — deep pages' parent-back-links may stay if they point at a mid-level parent, judgment call, documented). Visual QA note for the PR.

### Task 3: The 7-group tree index (TDD-able structure)

Rewrite `src/app/settings/page.js`: a data-driven `SETTINGS_TREE` exported constant (new `src/lib/settings-tree.js` — testable like nav-items):

1. **Workspace** — locations (+Add Location master CTA), branding→`/settings/locations/[id]?section=branding` note (branding is per-location; the group links the locations list), holidays, class-categories
2. **Team** — staff (+Add Staff CTA), impersonate (master tools fold in here, master-gated rows)
3. **Communications** — notifications, customer-agent, scoring, usage… CHECK spec §3.4: usage sits in Billing; follow the SPEC's seven groups exactly: Workspace / Team / Communications (email domain, notifications+health, customer agent, scoring) / Integrations (integrations-hub, integration-health, status-page, zoom-contacts — finally LINK the orphan) / Billing & usage (billing, usage) / Data (glofox-import→/admin for now, marketing-import→/admin for now, api-keys, landing-page settings) / Security (audit-log→/admin for now, access-history, impersonate, 2FA/SSO coming-soon rows)
   (Where my two lists above disagree, the SPEC section list wins; resolve and document.)
3. Each row: `{ id, label, href, description, gate }` with gate = the same shape nav-items uses (permission/anyPermission/roles/openToAll) evaluated server-side. Tests (`src/lib/settings-tree.test.js`): every href resolves to a real page under src/app (reuse the K5 disk-walk helper pattern — route-group aware), every row has label+description+gate, no duplicate hrefs, the 5 /admin hrefs are exactly the known surviving set (pins the 2H handoff).
4. The index page renders the tree grouped, rows filtered by gate — visually: compact grouped list (not cards), keeping the staff/location count badges where the grid had them.

### Task 4: Finalize

CI mirror + build + CHANGELOG (`SETTINGS.2g`: the four gate closures NAMED as the security fix they are; the layout/back-link unification; the tree + its structure tests; the /admin handoff pins) + PR + final whole-branch review (seams: no sub-page lost its gate in the layout refactor; the four new server gates match their APIs' keys; tree gate parity vs old card grid — nobody sees fewer rows than before unless the row was ungated-by-accident).

**Hands off to 2H (admin dissolution):** the tree's Data/Security groups still point at 4-5 `/admin` pages; 2H moves those + the platform-tier set into the Platform shell, re-points the tree, and deletes `/admin`.
