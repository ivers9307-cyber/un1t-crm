# Phase 2E — Operations Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Checkbox steps.

**Goal:** Fifth hub (Maintenance, Studio door/devices, TV displays, Presentations, Checklists) with two more `/admin` extractions, two full-screen escapes, and **the sidebar longest-match active-state fix this PR owns** — killing both known double-lights (/communications+tickets, Members+Operations on the timer path).

**Scope:** `/admin/fleet` and `/admin/studio-devices` deliberately deferred to the dissolution PR (mixed master/per-location gates belong with the platform-shell work; a deviation from the spec's Operations table, noted for the changelog). `/automations` stays in Marketing. The §3.2.4 Displays merge (TV+presentations one manager) is later phase work — this PR only regroups.

**Branch:** worktree `hubs-2e-operations` off origin/main (≥ 0653d913). `npm ci`, baseline.

**Facts to verify at execution (recon said, re-verify):** `/admin/tv-displays` gate = `tv_displays` (no-access text, redirect if no location); `/admin/checklists` gate = master||owner||`studio_management` else `redirect('/admin')` (target must become `/` after the move); `/maintenance` = anyPermission equipment_admin|equipment_inspect; `/presentations` gate = `presentations`; `/studio-management` = `studio_management`. Inbound: tv-displays ← nav child + admin card; checklists ← admin card + own redirect; presentations ← nav child + ~5 refs.

---

### Task 1: Extract `/admin/tv-displays` → `/tv-displays` and `/admin/checklists` → `/checklists`

Hyrox/contracts recipe ×2: `git mv` into `(operations)/`; repoint admin cards (`src/app/admin/page.js`); checklists' internal `redirect('/admin')` → `redirect('/')` (gate failure shouldn't land on the /admin grid it came from); legacy-redirects rules (`/admin/tv-displays` → `/tv-displays`, `/admin/checklists` → `/checklists`; tv-displays has co-located `TVAdmin.jsx` + `TemplateEditor.jsx` — move with dir) + both roots into `DELETED_STUB_SOURCES` (moved-not-deleted); grep sweeps; nav-items untouched (rides redirect until Task 5). Full suite. One commit.

### Task 2: `/operations` index (TDD, mirror /team tests)

```js
  if (hasPermission(user, 'equipment_admin') || hasPermission(user, 'equipment_inspect')) redirect('/maintenance')
  if (hasPermission(user, 'studio_management')) redirect('/studio-management')
  if (hasPermission(user, 'tv_displays')) redirect('/tv-displays')
  if (hasPermission(user, 'presentations')) redirect('/presentations')
  redirect('/')
```
Tests (7): signed-out; equipment_admin → /maintenance; equipment_inspect only → /maintenance; studio_management only → /studio-management; tv_displays only; presentations only; none → /. Plus location-gate case (features `{equipment_admin:false, equipment_inspect:false}` with all granted → /studio-management). Commit.

### Task 3: `(operations)` group with two escapes

Moves: `src/app/maintenance`, `src/app/presentations`, `src/app/studio-management` → `(operations)/` — THEN escape the full-screen surfaces back to literal trees (URLs unchanged, same technique as events check-in in 2B):
- `git mv "src/app/(operations)/studio-management/timer" src/app/studio-management/timer` (class timer — Members tab, chrome-free)
- `git mv "src/app/(operations)/presentations/[id]/present" "src/app/presentations/[id]/present"` (deck presenter — full-screen renderer)

Layout mirrors `(team)/layout.js` (incl. `print:hidden` wrapper); TABS:
```js
const TABS = [
  { id: 'maintenance',   label: 'Maintenance',   href: '/maintenance',       perms: ['equipment_admin', 'equipment_inspect'] },
  { id: 'studio',        label: 'Studio',        href: '/studio-management', perms: ['studio_management'] },
  { id: 'tv',            label: 'TV displays',   href: '/tv-displays',       perms: ['tv_displays'] },
  { id: 'presentations', label: 'Presentations', href: '/presentations',     perms: ['presentations'] },
  { id: 'checklists',    label: 'Checklists',    href: '/checklists',        perms: ['studio_management'] },
]
```
(Checklists' owner|master page gate exceeds `studio_management` for the tab — master resolves true via bypass; owner role default likely grants studio_management; verify and note.) Build must show all URLs unchanged + escaped routes exactly once. Commit.

### Task 4: Sidebar longest-match matcher (the owned fix) — TDD

New PURE exported helper in `src/lib/nav-items.js`:

```js
// activeHrefFor(pathname, items) — the ONE nav entry that should light.
// Longest-match across every item's href + extraActivePaths + children
// hrefs (CalendlyTabs semantics, hub-era necessity: /communications vs
// /communications/tickets and Members-vs-Operations on the timer path
// both double-lit under the old per-item bare startsWith).
```

Semantics: candidate paths = every item's href, extraActivePaths, children hrefs (each mapped back to its owning top-level item; a child match still returns the child's own href so the child row can light — preserve current child active behaviour). Match = exact or `pathname.startsWith(path + '/')`. Winner = longest matching path; return `{ itemHref, matchedPath }` or null. TESTS FIRST (new describe in nav-items.test.js): `/communications/tickets` → tickets entry only; `/communications/send` → `/communications`; `/studio-management/timer` → Members (`/studio-management/timer` beats Operations' `/studio-management`); `/studio-management` → Operations; `/contacts/abc` → `/sales`; `/hyrox?` (pathname without query) → `/members`; unknown path → null. Then rewire `src/components/Sidebar.jsx`: compute `const active = activeHrefFor(pathname, nav)` once; `SidebarItem`/child active = `active?.itemHref === item.href` / `active?.matchedPath === child.href` (adapt to the real render structure — read it first; keep group auto-open logic working). Full suite must stay green — this changes live behaviour for the messages section (that's the point). Commit.

### Task 5: Sidebar collapse (TDD)

Operations → `['/operations']`. Entry: `{ href: '/operations', label: 'Operations', icon: <unused lucide, e.g. Wrench>, anyPermission: ['equipment_admin', 'equipment_inspect', 'studio_management', 'tv_displays', 'presentations'], extraActivePaths: ['/maintenance', '/studio-management', '/tv-displays', '/presentations', '/checklists'], section: 'operations' }`. DELETE `/maintenance` + the `/studio-management` group entry (children die with it — tv-displays/presentations now hub tabs; groupId 'studio' localStorage key orphaned, harmless). The timer double-light is now IMPOSSIBLE by construction (Task 4) — assert it: a test that `activeHrefFor('/studio-management/timer', ALL_NAV).itemHref === '/members'`. Commit.

### Task 6: Finalize

Full CI mirror + build + CHANGELOG (`HUBS.2e`: two extractions; two escapes; THE MATCHER FIX with both killed double-lights named; fleet/studio-devices deferral noted) + push + PR `"HUBS.2e — Operations hub"` (QA notes: exactly ONE sidebar entry lights everywhere — spot /communications/tickets, the timer, /studio-management; old /admin/tv-displays + /admin/checklists 307; presenter + timer chrome-free) + final whole-branch review (seams: matcher vs groups/auto-open, the two escapes, checklists gate change).
