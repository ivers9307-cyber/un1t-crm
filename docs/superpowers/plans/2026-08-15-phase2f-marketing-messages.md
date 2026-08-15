# Phase 2F — Marketing Hub + Messages Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Checkbox steps.

**Goal:** Sixth+seventh hub actions in one PR. Messages: collapse the two sidebar entries into one with a SUMMED badge (WhatsApp unresolved + email tickets). Marketing: a real hub over `/automations` (+ sub-pages) and the landing page, with a new-tab tab capability.

**Scope:** The deep Messages/Marketing content split (campaigns/segments/templates out of /communications) is SPEC PHASE 4 — not here. /communications keeps CommunicationsTabs as its hub-internal strip (it predates HubTabs and already does badges; converging them is optional later work, NOT this PR).

**Branch:** worktree `hubs-2f-marketing-messages` off origin/main (after 2E merges). `npm ci`, baseline.

---

### Task 1: Messages collapse (TDD)

- nav-items: messages section → `['/communications']` single entry: keep its existing anyPermission [email, whatsapp, sms] but EXTEND to include `email_inbox` (the tickets entry's key — parity: tickets-only users must keep seeing Messages), label stays 'Communications' or rename to 'Messages'? RENAME to 'Messages' (hub era; comms-ia-labels.test.js pins the TICKETS entry label — that entry is being deleted, so update that test: its guarantee becomes "the tickets TAB label is 'Email inbox'" (CommunicationsTabs) only — read comms-ia-labels.test.js first and adapt its sidebar half with justification). extraActivePaths: none needed (prefix covers /communications/*).
- DELETE the `/communications/tickets` entry. Badge: Sidebar.jsx — the entry's badge becomes the SUM of the wa count + tickets count (mirror the /dashboard churn+lead summing precedent at ~line 128); each usePolledCount keeps its own permission-gated `enabled`. titleBadgeCount unchanged (already sums separately).
- activeHrefFor: with tickets entry gone, /communications/tickets resolves to /communications — the Task-4 (2E) test asserting the tickets entry wins must be UPDATED (it asserted against the then-current ALL_NAV; new expectation: itemHref '/communications'). Tests first.
- Palette: keep `email-tickets` NAV_COMMAND (deep link). Full suite. Commit.

### Task 2: Marketing hub (TDD)

- `/marketing` index (literal): `automations` (or `email`/`whatsapp`? — the /automations page gate is anyPermission [automations, email, whatsapp]: mirror it) → `/automations`; `landing_page` → `/welcome`?? NO — /welcome is a PUBLIC page (new tab); an index redirect must not land there. Chain: if any of [automations, email, whatsapp] → /automations; else if landing_page → /settings/landing-page (the editor, a real in-app page); else /.
- `(marketing)` group: move `src/app/automations` in; layout with TABS:
  - Automations `/automations` perms ['automations','email','whatsapp']
  - Landing page `/welcome` perms ['landing_page'], `newTab: true` — EXTEND HubTabs: a tab with `newTab` renders `<a target="_blank" rel="noopener noreferrer">` + the ExternalLink icon (mirror the sidebar's openInNewTab rendering); add a HubTabs test case. Landing SETTINGS (`/settings/landing-page`) stays in settings.
- Sidebar: marketing section → `['/marketing']` entry: anyPermission ['automations', 'email', 'whatsapp', 'landing_page'], extraActivePaths ['/automations'] (NOT /welcome — public page, never a pathname inside the app shell), icon unused lucide (e.g. Megaphone). DELETE /automations + /welcome entries.
- Tests per the established recipe. Full suite + build. Commit(s) — split index/group/collapse commits as the prior hubs did.

### Task 3: Finalize

CI mirror + build + CHANGELOG (HUBS.2f: Messages summed badge + entry rename with the comms-ia-labels test adaptation justified; Marketing hub + HubTabs newTab capability; phase-4 deferral restated) + PR + final whole-branch review (seams: the summed badge triangle vs CommunicationsTabs' per-tab badges + title count; activeHrefFor updated expectation; newTab tab rendering).

**Post-2F sidebar state:** pinned /portfolio + /dashboard; Messages, queues (approvals/issues), Sales, Members, Money, Marketing, Team, Operations, modules (/cars/active), Account (/settings) — every multi-entry section collapsed except queues (phase 3) and the singletons.
