# Phase 2D — Team Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Checkbox (`- [ ]`) steps.

**Goal:** Fourth hub. Team = Schedule + Contracts + Policies. Includes the second `/admin` extraction: `/admin/contracts/**` → `/contracts/**` (hyrox pattern at scale — long-lived issuer-email deep links protected by a WILDCARD redirect, and the email producer repointed test-first).

**Scope notes:** regroup only. ScheduleTabs' state-only→URL-driven migration (flagged in recon as the highest-value tab modernisation) is deliberately NOT this PR. `/account/contracts` (the staff signing surface) is untouched. `/admin/policies` (admin CRUD) waits for the dissolution PR; only the read surface `/policies` joins the hub. Team hub tabs are 3 (Schedule/Contracts/Policies) — the spec's finer tabs (attendance, time off…) stay inside `/schedule`'s own surface per the SIDEBAR-IA.1 comment restored in 2B.

**Branch:** worktree `hubs-2d-team` off origin/main (≥ 92d712a5, the 2C merge). `npm ci`, baseline.

**Verified facts (2026-08-15):** `/policies` gate = login only (openToAll semantics). `/schedule` gate = `schedule` perm. Contracts pages gate on `contracts` perm (sub-pages owner|master for issue/templates). Email producer: `src/lib/contracts-email.js:189,278` builds `${appUrl()}/admin/contracts/${contract.id}` (+ a :176 comment); `contracts-email.test.js` exists and may pin the URL. Admin card: `src/app/admin/page.js:59`. Contracts tree: `page.js`, `[id]/`, `issue/`, `templates/` (+`[id]`,`new`).

---

### Task 1: `/admin/contracts/**` → `/contracts/**` (move + wildcard redirect + repoints)

1. TDD on the email producer: check `src/lib/contracts-email.test.js` for URL assertions; update any `/admin/contracts` expectation to `/contracts` FIRST (RED), then edit `contracts-email.js:189,278` (+ fix the :176 comment) → GREEN. If the test doesn't pin URLs, add an assertion that the issued-email body contains `/contracts/${id}` (both senders), RED→GREEN the same way.
2. `git mv src/app/admin/contracts "src/app/(team)/contracts"` (create the group dir first). Read the moved pages: they relied on the `/admin` layout gate (`contracts` IS in ADMIN_CHILD_PERMS) — each page has its own `hasPermission('contracts')` or owner|master gate (verified in recon); confirm per page and report.
3. Repoint every live inbound link (grep `admin/contracts` across src/): known sites — `src/app/admin/page.js:59` card; internal back-links in `contracts/[id]/page.js`, `templates/page.js`, `issue/page.js`, `templates/[id]/page.js`, `templates/new/page.js`; `ContractIssueWizard.jsx` router.push sites (~409, ~915); `ContractRevokeButton.jsx:51`; `ContractTemplateForm.jsx` (~130, ~357). All become `/contracts/...`. Comments may stay.
4. `legacy-redirects.js` (before any conflicting rule; a comment citing HUBS.2d): 
   `{ source: '/admin/contracts/:path*', destination: '/contracts/:path*', permanent: false },`
   `{ source: '/admin/contracts', destination: '/contracts', permanent: false },`
   (exact rule BEFORE the wildcard per the shadow test). Add `'/admin/contracts'` to `DELETED_STUB_SOURCES` (moved-not-deleted comment, 2B precedent).
5. Nav-items has an `/admin/contracts` entry (team section) — LEAVE IT (Task 4 owns nav; it rides the redirect inside the branch).
6. `npm test` full; sweep grep = comments only. Commit.

### Task 2: `/team` index (TDD, mirror `/money` tests incl. `allDenied`)

`src/app/team/page.js`: signed-out → `/login`; `schedule` → `/schedule`; `contracts` → `/contracts`; else → `/policies` (openToAll — the chain never dead-ends at `/`; comment this). Tests (6): signed-out; all → /schedule; schedule denied → /contracts; only contracts → /contracts; none → /policies; location-gate `features:{schedule:false}` all granted → /contracts. Commit.

### Task 3: `(team)` route group

`git mv src/app/schedule src/app/policies "src/app/(team)/"` (contracts already in). Layout mirrors `(money)/layout.js`; TABS:

```js
const TABS = [
  { id: 'schedule',  label: 'Schedule',  href: '/schedule',  perms: ['schedule'] },
  { id: 'contracts', label: 'Contracts', href: '/contracts', perms: ['contracts'] },
  { id: 'policies',  label: 'Policies',  href: '/policies' }, // no perms — visible to every signed-in user (page is login-gated only)
]
```

Filter must treat missing `perms` as always-visible: `.filter(t => !t.perms || t.perms.some(p => hasPermission(user, p)))` — note this is a NEW capability vs the (money) template; comment it. Scan `/schedule` sub-tree for chrome-free candidates (payslip/print/export surfaces) — flag, don't move without instruction. `npm test` + `npm run build` (routes unchanged; `/team`, `/contracts` present; `/admin/contracts` gone). Commit.

### Task 4: Sidebar collapse (TDD)

Team → `['/team']`. Entry: `{ href: '/team', label: 'Team', icon: <unused lucide, e.g. UsersRound>, openToAll: true, extraActivePaths: ['/schedule', '/contracts', '/policies'], section: 'team' }` — `openToAll` because `/policies` already made the section universally visible (parity, not an add; comment it). DELETE `/schedule`, `/admin/contracts`, `/policies` entries — but KEEP the restored SIDEBAR-IA.1 Schedule/Attendance comment paragraph, relocated onto the new `/team` entry (it explains why attendance/time-off have no entries + the live `/schedule/attendance` cron-email deep link; it must not be dropped — 2B review precedent). Tests: membership, entry assertion (openToAll + extraActivePaths). Palette keeps `/schedule` entry; NO `/team` entry. Full suite. Commit.

### Task 5: Finalize

Full CI mirror + build + CHANGELOG (`HUBS.2d`, next number: the contracts extraction with wildcard redirect + email-producer repoint; the openToAll hub entry — first universally-visible hub; the no-perms tab capability; scope exclusions) + push + PR `"HUBS.2d — Team hub"` (QA notes: issuer emails' old `/admin/contracts/[id]` links 307 with id preserved; contracts pages show Team tabs; /policies reachable by everyone with tabs showing only their permitted set; /team lands per permission; sidebar Team lights on all three paths). Standard footer. Then final whole-branch review (seams: the wildcard redirect vs the exact rule ordering, email producer, openToAll entry semantics, contracts sub-page gates surviving the admin-layout removal).
