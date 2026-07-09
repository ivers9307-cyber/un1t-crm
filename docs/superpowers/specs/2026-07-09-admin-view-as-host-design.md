# Admin view-as-host — design (HOST-PORTAL.4)

**Date:** 2026-07-09
**Status:** approved (design), pending implementation plan
**Branch:** `admin-view-as-host`

## Goal

Let an **owner/manager** open any host's portal from the CRM and act inside it *as that host* — see their events/revenue/attendees and create/edit/submit their events — **without a host login or a Stripe connect account of their own**. This is the host analog of the CRM's existing "View as user" master impersonation.

## Why (the driving cases)

1. **Preview / support** — an admin needs to see and manage what a host sees.
2. **The same-email host** — the one live host-connect account shares its email with a staff profile. Supabase `auth.users.email` is UNIQUE, so that person **cannot** have a second (host) auth account, and the staff↔host firewall (STAFF-XOR, `host-auth.js`) forbids linking a `host_users` row to a staff login. View-as sidesteps both: the admin reaches the host's portal via a transient override — **no persistent dual account, firewall intact**.

## Decisions (locked with Richard, 2026-07-09)

- **Access scope: full manage** — while viewing-as, the admin can view *and* act (create/edit/submit events, export attendee CSV) as the host. The banner makes the acting-as state explicit.
- **Audit: yes** — a `host_impersonation_log` table records who viewed which host's portal and when (mirrors the CRM's `impersonation_log`, mig 035).
- **Mechanism: cookie + per-request re-validation** — a `un1t_host_impersonate` cookie holds the host_id; authorization (admin role + org membership) is re-checked on every `getCurrentHost()`. The cookie is a pointer, not a grant.

## Mechanism — extend `getCurrentHost()` only

`getCurrentHost()` (`src/lib/host-auth.js`) is the single gate every `/host` page + `/api/host/*` route already calls. Extend just this function:

1. **Real host first** — the existing `host_users` → `event_hosts` lookup. A real host always resolves to themselves (an admin has no `host_users` row, so this is null for them).
2. **Then impersonation** — if step 1 is null, read the `un1t_host_impersonate` cookie. If set, resolve the caller with `getCurrentUser()` (their staff session is untouched — the cookie is additive). **Only if** `ADMIN_ROLES.includes(user.role)` AND `loadHostForOrg(db, hostId, user's orgId)` returns the host, return `{ host, authUserId: user.id, email: user.email, impersonatedBy: { id: user.id, name } }`. Otherwise ignore the cookie (return null).

Because the admin+org check runs on **every** request, a stale cookie (admin lost the role, host left the org, cookie tampered) resolves to nothing. No `/api/host/*` route changes — they all inherit the extended resolver, so "full manage" falls out for free.

**Ordering guarantee:** a real host can never impersonate (they have no staff session / `ADMIN_ROLES`), and an admin's own `host_users` lookup is null, so the two branches never collide.

## Data model (one migration, forward-only)

`host_impersonation_log` (mirrors `impersonation_log`):
| Column | Type | |
|---|---|---|
| `id` | uuid pk | |
| `admin_user_id` | uuid | the acting admin (auth user / profiles id) |
| `host_id` | uuid → event_hosts | the host being viewed |
| `organization_id` | uuid | the admin's org at start (audit) |
| `started_at` | timestamptz default now() | |
| `ended_at` | timestamptz null | stamped on exit; null = open |
| `auto_closed` | boolean default false | set by the stale-row reaper |
| `ip` / `user_agent` | text null | best-effort request metadata |

RLS on, no policy (service-role only). Index on `(admin_user_id) where ended_at is null`.

## Components

- **`src/lib/host-impersonation.js`** (mirrors `impersonation.js`): `HOST_IMPERSONATE_COOKIE = 'un1t_host_impersonate'`; `startHostImpersonation({ admin, hostId, ip, userAgent })` (closes any open row for this admin, inserts a new open row, sets the HttpOnly cookie); `stopHostImpersonation({ adminUserId })` (stamps `ended_at` on the open row, clears the cookie); a `readHostImpersonationCookie()` helper. Reuse the reaper pattern (`closeStaleOpenRows`) if trivially portable; else defer the reaper (cookie max-age bounds it).
- **`src/lib/host-auth.js`** — the resolver extension above; header comment updated to record the impersonation exception to STAFF-XOR (still no persistent dual account).
- **`POST /api/hosts/[id]/impersonate`** — `getCurrentUser` → `ADMIN_ROLES` (403) → `loadHostForOrg` (404) → `startHostImpersonation` → `{ success }`. Client then navigates to `/host`.
- **`POST /api/hosts/impersonate/exit`** — `getCurrentUser` (the admin's staff session is still live) → `stopHostImpersonation` → `{ success }`. Callable from inside the host portal (same domain, staff cookie sent).
- **`HostDetail.jsx`** (Settings → Hosts → [host]) — an **"Open host portal"** button (ADMIN only) → POST impersonate → `window.location = '/host'`.
- **Host portal `(portal)/layout.js`** — when `session.impersonatedBy` is set, render a banner: *"Viewing {host.name}'s portal as admin — Exit to CRM"* with an Exit action (POST exit → navigate to `/settings/hosts`). A small `HostImpersonationBanner.jsx` client component owns the exit fetch.

## Security properties (the bar)

- **Org-scoped:** an admin can only view-as a host in their own org (`loadHostForOrg` 404s cross-org, re-checked every request).
- **Role-gated:** only `ADMIN_ROLES` (owner/manager/master) — enforced in the impersonate route AND in the resolver (not just the UI).
- **No enumeration:** cross-org / unknown host_id → 404.
- **Firewall preserved:** the admin never gains a `host_users` row; STAFF-XOR still holds. Impersonation is transient + additive to their staff session.
- **Audited:** every view-as opens a `host_impersonation_log` row (admin, host, org, time); exit closes it.
- **Real host unaffected:** the `host_users` branch is checked first and is authoritative for genuine hosts; the cookie only ever helps an admin.

## Out of scope (v1)

- Cross-subdomain view-as (works at `crm.un1tdublin.com/host` where the admin's staff session cookie lives; the `host.un1tdublin.com` subdomain would need the session cookie on `.un1tdublin.com` — a separate infra decision).
- A stale-row reaper cron (rely on cookie max-age for v1 unless the existing reaper ports trivially).
- Non-admin (staff/head_coach) view-as. Mobile parity (host portal is web-only).

## Testing + rollout

- **Unit:** the resolver's impersonation branch (admin+org → host; non-admin → null; cross-org → null; real-host branch wins); the log start/stop closing semantics; the cookie helpers.
- **Migration** applied via Supabase MCP (`iyvtbjjxdggiadzwwvdj`) + `get_advisors`.
- **CI mirror + `next build`** green. Route-guards recognises the new staff routes (getCurrentUser).
- **Adversarial review before merge:** (a) can a non-admin or cross-org user resolve an impersonated host? (b) can a real host be hijacked (host_users branch precedence)? (c) does the cookie grant anything without the per-request admin+org check? (d) does exit fully clear + close the log row?
