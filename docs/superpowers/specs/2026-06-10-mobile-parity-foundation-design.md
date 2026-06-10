# Mobile↔Web Parity Foundation — Design

**Date:** 2026-06-10
**Status:** Approved (design); pending implementation plan
**Author:** Richard Ivers (with Claude)
**Scope of this doc:** Cycle 1 — the shared-core foundation + Staff & Access Management as its first consumer. Later feature waves each get their own spec built on these rails.

---

## 1. Goal & context

Bring the mobile app (Expo / React Native, `mobile/`) to **full management parity** with the web back-office (Next.js, `src/`) for the admin/master/owner/manager persona, and make web↔mobile parity **structural** so it can't silently drift again.

Today the split is large but mostly *deliberate*: dashboards, pipeline, and studio management are at full mobile parity; schedule, WhatsApp inbox, approvals, tasks, bookings, and the radars are partial; ~18 web capabilities are explicitly marked desktop-only in `scripts/check-mobile-parity.mjs` (`WEB_ONLY_OK`). "Full management on mobile" therefore means **reversing those desktop-only decisions one wave at a time and building real, responsive phone+tablet UI** for surfaces that are table- and form-heavy — for which mobile currently has no primitives (4 today: Button, Card, Field, Screen; no Modal, no Table).

### Decisions locked during brainstorming

| Axis | Decision |
|---|---|
| Target depth | **Total parity** — every operator web screen gets a real mobile equivalent |
| Primary device | **Both equally responsive** — phone and tablet are first-class |
| Parity rule | **Shared-core architecture** — parity is structural, not just policed |
| Foundation sequencing | **Foundation-first** — build the complete rails up front, driven by a real feature's requirements |
| First consumer | **Staff & Access Management** — the marquee master task, currently zero on mobile |
| Shared-core model | **Unified API + typed client SDK** — one JWT-auth `/api` layer is the single source of truth |

---

## 2. Architecture — three layers

Every operator capability is restructured into three layers so that the **view is the only thing that differs** between web and mobile.

### 2.1 Service layer — `src/lib/services/<domain>.js`

Pure-ish functions shaped `(ctx, input) → result`, where `ctx = { db, actor, scope }`:
- `db` — the service-role Supabase client (server-only).
- `actor` — the resolved caller (`getCurrentUser()` output: role, locations, permissions, impersonation).
- `scope` — the resolved location/org scope the actor is allowed to act within.

Service functions own: Zod validation (schemas from `shared/schemas`), business rules, and data access. Logic currently inlined in fat route files moves here — e.g. the 632-LOC `PUT /api/staff/[id]` becomes `staffService.update(ctx, input)`.

These functions are unit-testable in isolation (they take `db`), exactly like the existing `src/lib/*.test.js` suites.

### 2.2 Transport layer — thin `/api` route handlers

A single wrapper standardizes every route:

```js
export const PUT = withAuth(
  async (ctx, input) => staffService.update(ctx, input),
  { permission: 'settings', roles: ADMIN_ROLES, scope: 'location', schema: StaffUpdateSchema }
)
```

`withAuth(handler, opts)`:
1. Resolves the actor via `getCurrentUser()` — already supports **both** the web cookie session and the mobile `Authorization: Bearer <jwt>` path, plus `x-active-location` / `x-impersonate-target`.
2. Enforces `roles` / `permission` / `scope` (location/org). Returns 401/403 on failure.
3. Validates the request body against `opts.schema` (Zod) → 400 + `issues` on failure.
4. Calls `handler(ctx, input)` and returns the `{ success, data | error, issues }` envelope.

**This wrapper is also the remediation for the 2026-05/06 audit finding** that authorization is hand-rolled across ~286 routes with no CI enforcement: one guard, one place, lint-enforced (§5).

### 2.3 Client layer — `shared/sdk/`

A typed client SDK, one method per endpoint (`sdk.staff.update(id, patch)`). **No business logic** — transport, auth-header injection, and envelope handling only. Both web components and RN screens import it; the call site is identical on both platforms.

### 2.4 Data-path consolidation

Mobile's current direct-to-Supabase operator paths (pipeline CRUD, etc.) migrate onto the SDK wave by wave. RLS (`private.auth_mobile_can`, migrations 218–219) **stays as defense-in-depth** and remains the boundary for anything still on the direct path. Web is unaffected (service-role bypasses RLS; the route is the boundary).

> **Known conversion cost:** several web CRUD routes (`/api/deals`, `/api/contacts`, `/api/notes`, `/api/activities`, `/api/stages`) are currently `requireApiKey()`-only (n8n) — which is *why* mobile pipeline goes direct-to-Supabase today. Migrating those domains onto the SDK means adding a **session/JWT auth path** to those routes (via `withAuth`) alongside the existing API-key path. Tracked per-wave, not in the foundation.

---

## 3. The shared SDK (`shared/sdk/`)

- **Language:** plain JS with Zod-inferred types (`z.infer`) — staying JS-not-TS, consistent with the codebase. No TypeScript migration.
- **Pluggable transport:** `createSdk({ getAuthHeaders, baseUrl, fetch })`.
  - **Web** injects a same-origin cookie transport.
  - **Mobile** injects the existing `buildAuthHeaders` logic (Bearer JWT + `x-active-location` + `x-impersonate-target`), promoted from `mobile/lib/api-headers.js` into `shared/`.
- **Structure:** one module per domain, mirroring the route tree (`shared/sdk/staff.js`, `shared/sdk/contacts.js`, …).
- **Authoring:** hand-written (not codegen — overkill for this codebase and adds build complexity). The parity linter (§5) asserts every session-auth route has a matching SDK method so they can't drift.
- **Errors:** normalized to the existing `{ success: false, error, issues }` envelope so all callers handle uniformly.
- **Imports:** web via `@shared/sdk/*` (jsconfig alias); mobile via the metro `watchFolders` shared mechanism already in place.

---

## 4. Responsive mobile primitive library (`mobile/components/ui/`)

Built on NativeWind + the existing shared `un1t-*` Tailwind tokens (bespoke, not a third-party RN kit — consistent with the 4 existing primitives). New primitives, each **responsive by construction**:

| Primitive | Phone | Tablet |
|---|---|---|
| **Modal / Sheet** | bottom sheet | centered dialog |
| **DataTable / DataList** | stacked cards | columnar table |
| **Form + FormField** | full-width stacked | two-column where sensible |
| **Tabs** | scrollable strip | inline |
| **SplitView (master-detail)** | stacked push-nav | side-by-side list + detail |

- **Responsive mechanism:** a `useBreakpoint` hook (extending the existing `use-is-tablet`); the primitives switch layout internally, so screens get responsive behavior **for free** by composing them. This is how "both equally responsive" is delivered without per-screen responsive plumbing.
- **FormField** is wired to the shared Zod schema so validation messages are byte-identical to web.
- The set mirrors web's `src/components/ui` (Button / Modal / Card / Field / Table) **1:1**, so the two design systems stay paired (a parity concern in its own right — enforced by §5).

---

## 5. Parity-by-default enforcement (inverting the rule)

Today `scripts/check-mobile-parity.mjs` *allows* web-only with a one-line `WEB_ONLY_OK` reason. We **invert the default**:

1. **A new operator route/permission with no mobile counterpart FAILS CI** unless it is in an `EXEMPT` map that requires **both** a reason **and** a tracking-issue link — so exemptions are visible, time-boxed debt, not permanent escapes. (The existing `WEB_ONLY_OK` entries are migrated into `EXEMPT` with backfilled issue links during the foundation.)
2. **Route-coverage check:** every session-auth `/api` operator route must have (a) a `withAuth` guard, (b) a matching SDK method, and (c) a mobile screen — or an explicit exemption.
3. **PR-checklist item** + CI gate in `.github/workflows/web-ci.yml`.

This machinery simultaneously closes the audit's "no CI lint enforces per-route guards" finding — `withAuth` presence and mobile parity are checked by the same pass.

---

## 6. First consumer — Staff & Access Management

The validation target for the foundation because it exercises nearly the whole stack at once.

**Capabilities (must work on phone AND tablet):**
- Staff **list** — DataTable primitive, responsive, location-scoped.
- Staff **detail / edit** — Form + FormField with shared-schema validation.
- **Permissions matrix** — dense grid: side-by-side on tablet, scoped tabs (per-location, per-category) on phone.
- **Per-location role wizard** — multi-step Form; assignment role change resets that assignment's permissions to role defaults (existing rule in `defaultPermissionsByRole`).
- **Door / AC toggles** — orchestration through the SDK → UniFi/AC services (the toggle bounces back on UniFi failure, preserving the existing `unifi_failed` contract).
- **Tenant scoping** — the `withAuth` `scope: 'location'`/`'org'` parameter; cross-tenant access denied identically to web.

**Cycle-1 deliverable:** staff management fully usable on mobile (phone + tablet), built entirely on the new rails — **and the web staff management refactored onto the same services + SDK**, so the two platforms are one implementation. That web refactor is what proves "shared core" rather than "mobile got its own copy."

**Acceptance criteria:**
- A master can create/edit a staff member, set per-location roles + permissions, and toggle door access from an iPhone and an iPad.
- Web staff management behaves identically and is calling the same `sdk.staff.*` methods.
- All staff service functions are unit-tested; the `withAuth` wrapper is unit-tested once.
- The parity linter passes with `settings`/staff no longer exempt.

---

## 7. Testing strategy

- **Service layer + SDK contract** — unit-tested once with Vitest (pure functions taking `db`; the established `src/lib/*.test.js` pattern). Correctness proven once, trusted on both platforms.
- **`withAuth` wrapper** — unit-tested for the full allow/deny matrix (role, permission, scope, actor resolution incl. Bearer vs cookie vs impersonation).
- **Screen/component tests** — stay light, as today (mobile currently tests pure logic only).
- **No DB required** — lib helpers remain pure; suite stays in the few-seconds range.

---

## 8. Migration strategy — strangler-fig

- The foundation is **additive**: the other ~400 routes keep working untouched.
- Staff & Access is the **first domain** moved onto services + SDK on both platforms.
- Each later wave moves **its own domain** the same way, adding the mobile screen, with the parity linter ratcheting as exemptions are removed.
- **No big-bang rewrite** of 408 routes. Web components adopt the SDK incrementally (many already call `/api` via fetch), so web is never disrupted.

---

## 9. Program shape (waves beyond this spec)

Each wave is its own spec → plan → build cycle on these rails:

- **Foundation** — this spec (rails + Staff & Access Management).
- **Wave 1 — operational:** contacts (search/list/profile), feature toggles, issue triage inbox, tasks create/assign, approvals issues-tab.
- **Wave 2 — finance:** orders, cars (CCF Autos), supplier-invoice inbox, bookkeeper queue, audit log.
- **Wave 3 — comms & authoring:** WhatsApp broadcasts/templates + Instagram inbox, email/SMS campaign builders, sequences, landing-page editor, admin matrix, CSV importers, assistant, races, TV displays, attendance.

Heavy authoring lands in Wave 3 deliberately — by then the responsive primitives and shared core are proven, so the editors and matrices are the *last* thing built on the rails, not the first.

---

## 10. Risks & open questions

- **R1 — `requireApiKey`→session-auth conversion.** Domains whose web CRUD routes are n8n-key-only (deals/contacts/notes/activities/stages) need a session-auth path added before mobile can use the SDK for them. Mitigation: `withAuth` and `requireApiKey` coexist on the same route during transition; handled per-wave.
- **R2 — Wave-3 WYSIWYG editors.** The email and landing-page editors depend on `window.unlayer`, a web-only library with no RN equivalent. "Total parity" there means either a different mobile editor or an Expo DOM-component webview. Flagged as a known hard case to solve when Wave 3 is specced — not the foundation.
- **R3 — over-abstraction (foundation-first).** Building the full rails up front risks abstracting for needs not yet met. Mitigation: the foundation is **designed against Staff & Access Management's real requirements** plus a scan across the waves, and validated by shipping that feature in cycle 1 — not built in a vacuum.
- **R4 — primitive scope creep.** The responsive primitive set could balloon. Mitigation: build only the 5 primitives staff management needs (Modal, DataTable, Form, Tabs, SplitView); add more only when a wave demands them.
- **R5 — OTA release coupling.** Mobile changes auto-publish an OTA to production on merge (`eas-update.yml`, now gated by the full CI mirror). Foundation work is JS-only and rides that lane; native changes (none anticipated) would need a runtime-version bump. Coordinate with any in-flight native release (e.g. the v1.3.0 Face ID build).

---

## 11. Decision log

1. Total parity (not operational-only) — user choice, 2026-06-10.
2. Both phone + tablet responsive — user choice.
3. Shared-core architecture (not policy-only) — user choice.
4. Foundation-first (not pilot-driven or incremental) — user choice; mitigated by driving the design from a real feature (R3).
5. Staff & Access Management as first consumer — user choice.
6. Unified API + typed SDK (not shared-domain-functions or schemas-only) — user choice; chosen for single source of logic + consolidated authz + alignment with the working mobile Schedule pattern.
