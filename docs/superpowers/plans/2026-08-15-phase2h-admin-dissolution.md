# Phase 2H — /admin Dissolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Checkbox steps.

**Goal:** The last phase-2 PR. The `/admin` card-grid hub dies; its remaining residents disperse or get the Platform shell at their existing URLs. After this PR, `/admin` is only the URL prefix of platform-tier console pages.

**Key insight (avoids URL churn):** the Platform shell is a PATH-PREDICATE (`isPlatformTierPath` + `user.isMaster`), so master-only pages get the right chrome by ADDING their existing `/admin/*` paths to `PLATFORM_TIER_PATHS` — no moves needed. Non-masters at those URLs keep the Studio shell (predicate falls through) — which is exactly right for the two mixed-gate pages (webhook-dead-letter's owner access, fleet's per-location perms).

**Branch:** worktree `admin-2h-dissolution` off origin/main (≥ ffc41fd6, the 2G merge). `npm ci`, baseline.

**Current /admin residents** (post 2B/2D/2E extractions): index page.js, achievements, audit-log, bridges, fleet, glofox-import, health, integrations, marketing-import, matrix, plans, policies(+2), studio-devices, tenant-domains, tenants(+2), webhook-dead-letter.

---

### Task 1: Move the five studio/settings-tier pages out (hyrox recipe ×5)

| From | To | Gate (unchanged) | Repoints |
|---|---|---|---|
| `/admin/glofox-import` | `/settings/glofox-import` | glofox_import | settings-tree row; `src/lib/automations/registry.js` reviewBase (+ its test); AutomationsView renders it |
| `/admin/marketing-import` | `/settings/marketing-import` | preferences_import | settings-tree row |
| `/admin/audit-log` | `/settings/audit-log` | master | settings-tree row; platform-nav ACTION href (+ platform-nav.test) |
| `/admin/achievements` | `/achievements` in `(members)/` | master | settings-tree row (master-tools). No Members tab (master-only surface; tabs render harmlessly for master) |
| `/admin/integrations` | `/settings/service-credentials` | master | settings-tree row (rename label 'Service credentials (Strava / Garmin / Apple)') |

Plus `/admin/policies/**` → `(team)/policies/manage/**` (URLs `/policies/manage`, `/policies/manage/[slug]`, `/policies/manage/[slug]/versions/[n]`; owner|master gates stand alone — verify per page) with a "Manage policies" button (owner|master) added on the `(team)/policies` read page.

Each move: git mv, redirect rule (+ `:path*` wildcards where subroutes exist: policies, and NONE else have children except tenants which is NOT moving), `DELETED_STUB_SOURCES` entries, inbound-link grep sweep, settings-tree pin test UPDATE (the 6-href /admin pin shrinks — new pin: tree contains NO /admin hrefs at all; delete the admin-hub row outright, the index is dying). Full suite. One commit per logical move or one for all — implementer's call, but TDD the pinned tests first.

### Task 2: Platform-tier expansion + fleet's Operations tab (TDD)

1. `src/lib/platform-nav.js`: `PLATFORM_TIER_PATHS` += `'/admin/matrix'`, `'/admin/bridges'`, `'/admin/studio-devices'`, `'/admin/webhook-dead-letter'` (health/tenants/plans/tenant-domains already there). `PLATFORM_PRIMARY_ITEMS` += Matrix (LayoutGrid?), Bridges, Studio devices, Dead letters — pick icons; keep the console coherent (8 items). The audit ACTION now points at `/settings/audit-log` (insideShell:false stays). UPDATE `platform-nav.test.js` (it hard-asserts the four roots + explicitly asserts matrix/audit-log are NOT platform — rewrite those expectations, TDD first).
2. Fleet: add Operations hub tab `{ id: 'fleet', label: 'Fleet', href: '/admin/fleet', perms: ['fleet_restart', 'fleet_admin'] }` (page stays at /admin/fleet in the Studio shell — tab href outside the group = no strip on arrival, Live-HR precedent; comment it). Update the /operations index chain? NO — fleet is a specialist surface, not a landing candidate; leave the chain.
3. AppShell: no change (predicate covers it). Verify `dashboard-redirect.js` PLATFORM_CONSOLE_HOME (/admin/tenants) untouched.

### Task 3: Kill the index; rework the layout gate (TDD)

1. Delete `src/app/admin/page.js`. Redirect `{ source: '/admin', destination: '/settings', permanent: false }` + `DELETED_STUB_SOURCES += '/admin'`. (The exact rule must precede any `/admin/...`-prefixed shadowing concern — verify order vs the existing /admin/contracts and /admin/hyrox rules; exact-match rules don't shadow each other, but keep the file tidy.)
2. `src/app/admin/layout.js`: residents are now ONLY tenants/plans/tenant-domains/health/matrix/bridges/studio-devices/webhook-dead-letter (master; predicate gives Platform shell) + fleet (per-location perms) + webhook-dead-letter's owner access. Rework the gate: master passes; else `role === 'owner'` passes (webhook page's own gate does the rest); else any of ['fleet_restart', 'fleet_admin'] passes (fleet's page does per-device checks); else redirect('/'). ADMIN_CHILD_PERMS as it stood is obsolete — replace + rewrite the comment (the old five keys' pages have ALL moved out). Check each remaining page's own gate still stands alone (they do per prior exploration — verify).
3. Grep sweep: no live `/admin` hrefs anywhere outside the remaining resident set + redirects + comments (nav has none since 2E; tree has none after Task 1; `integration-health.js:497` remediation href `/admin/webhook-dead-letter` REMAINS VALID (page stays) ✓ its test untouched).

### Task 4: Finalize + PR + final review

CI mirror + build (route list: no `/admin` index; moved routes present; `/admin/tenants` etc. unchanged) + CHANGELOG (`ADMIN.2h`: **phase 2 complete** — the spec's §3.4 dissolution executed; the path-predicate insight that saved URL churn; the layout gate rework; settings tree now /admin-free) + PR `"ADMIN.2h — /admin dissolved; phase 2 complete"` (QA notes: /admin 307s to /settings; master sees Matrix/Bridges/Studio devices/Dead letters in the Platform console; owner still reaches webhook dead-letters (Studio shell); fleet reachable as an Operations tab for restart-permission holders; imports/audit-log/achievements/service-credentials at their new homes via the settings tree) + final whole-branch review (seams: the layout gate rework vs each resident's own gate; platform-nav test rewrite; the tree pin flip to zero /admin hrefs).
