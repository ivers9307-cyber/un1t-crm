# Link a staff login to a host — design (HOST-PORTAL.5)

**Date:** 2026-07-09
**Status:** approved (design), pending implementation plan
**Branch:** `host-staff-link`

## Goal

Let an admin give a **UN1T staff member** access to a host's portal **using their existing staff login** — one account, one password, that works as staff in the CRM *and* as that host in the portal. Solves the recurring case where a staff member is also an event host and shares one email (auth emails are unique, so they can't have a second account).

## The key insight (why this is small + safe)

The two identity resolvers are **already independent**:
- `getCurrentUser()` (staff) resolves via a `profiles` row.
- `getCurrentHost()` (host) resolves via a `host_users` row.

Neither checks for the *absence* of the other, so a single auth user with **both** rows already resolves as staff in the CRM and host in the portal. The staff↔host firewall (STAFF-XOR) lives **entirely on the provisioning side**:
- the invite route (`POST /api/hosts/[id]/invite`) refuses to link an email that already has a `profiles` row, and
- mig 387 gates `handle_new_user` so host-portal *invites* create no `profiles` row.

So this feature is a **contained, deliberate exception to the provisioning guard**: a new admin action that creates a `host_users` row for an *existing staff* auth user. **No migration, no new tables** (`host_users` from mig 386 suffices). The invite flow + mig 387 are untouched — 3rd-party hosts stay fully firewalled.

## Decisions (locked with Richard, 2026-07-09)

- Admin links a staff member **by email**, from **Settings → Hosts → [host]**.
- The linked user reaches their portal via a **"Host portal" item in the CRM sidebar**, shown only to users who are a linked host.
- Admin can **unlink** to revoke.
- Sits alongside the existing card actions: **Open host portal** (admin view-as, transient) and **Invite to portal** (3rd-party host, separate email). This new one is for *staff who are also hosts*.

## Components

### 1. Link/unlink API — `src/app/api/hosts/[id]/link-staff/route.js`
- **`POST`** `{ email }` — `getCurrentUser` → `ADMIN_ROLES` (403) → org resolved from session → `loadHostForOrg(db, id, orgId)` (404 if host not in org). Then:
  1. Find the staff user: `profiles` row by (lower-cased) email → `staff` (their `id` is the `auth.users` id). **No profiles row → 400** "That email isn't a UN1T staff account — use *Invite to portal* for a 3rd-party host on a separate email."
  2. Verify the staff user is in the **admin's org** (a `profile_locations` → `locations.organization_id === orgId`). Cross-org → 400.
  3. Check `host_users` for that `auth_user_id`: already linked to **this** host → `{ success:true, already:true }`; linked to a **different** host → 400 "already linked to another host."
  4. Insert `host_users { host_id, auth_user_id: staff.id, email }`.
  - Returns `{ success:true, data:{ linked:{ name, email } } }`.
- **`DELETE`** `{ auth_user_id }` — same admin+org gate; deletes the `host_users` row **on this host** (scoped `.eq('host_id', id).eq('auth_user_id', auth_user_id)`), so an admin can't delete another host's link. Returns `{ success:true }`.
- **`GET`** — same admin+org gate; returns this host's links: `[{ auth_user_id, email, full_name }]` (join `host_users` → `profiles` on `auth_user_id` for the name). The card fetches this on load and re-fetches after link/unlink.

### 2. HostDetail card — `src/components/settings/HostDetail.jsx`
In the "Host portal" `Card`, add a **"Staff logins"** subsection:
- An email input + **"Link staff login"** button → `POST …/link-staff`.
- A list of currently-linked staff (name + email) each with an **Unlink** button → `DELETE …/link-staff`.
- Inline success/error (reuse the file's existing action-feedback pattern). Clarifying helper text: "Give an existing UN1T staff member access to this host's portal with their normal login."

### 3. Sidebar entry point — the CRM shell
Show a **"Host portal" → `/host`** nav item **only** for a logged-in user who is a linked host. Resolve this once server-side where the sidebar/nav is built (the shell already loads `getCurrentUser()`): a single `host_users` lookup by `auth_user_id` → `isLinkedHost` (+ optionally the `host_id`). Pass it to the nav; render the item when true. (Do NOT add the `host_users` query to `getCurrentUser()` itself — it's on the per-request hot path; keep it to the shell's render.)

## Security (this relaxes STAFF-XOR — kept tightly bounded)

- **Admin-gated + org-scoped:** only `ADMIN_ROLES`, only a host in the admin's org, only a staff user in the admin's org. The route re-checks every time; never trusts client input for the host or org.
- **One direction only:** it *adds host access to an existing staff user*. It never grants **staff/CRM** access to a pure host — a 3rd-party host still has no `profiles` row and the invite flow + mig 387 are unchanged. The dangerous direction stays closed.
- **Target must be staff:** a non-staff email is refused (points to Invite instead), so this can't be used to mint a brand-new dual account by side door.
- **One host per user:** the existing `host_users UNIQUE(auth_user_id)` prevents linking one login to multiple hosts.
- **Unlink is scoped** to `(host_id, auth_user_id)` so an admin can only remove links on hosts in their org.
- **Adversarial review before merge:** self-linking without admin, cross-org link/unlink, escalating a staff user's host access beyond the single linked host, and confirming a linked staff-host's `getCurrentHost` resolves only to their own host.

## Interactions / known limitations

- **View-as precedence:** for a linked staff-host, `getCurrentHost()` resolves them to their **own** host via the `host_users` row (step 1) before the impersonation cookie is consulted. So an admin who is *also* a linked host can't use "Open host portal" to view-as a *different* host (they're always resolved to their own). Edge case, acceptable for v1 — note it.
- **Cross-subdomain:** the linked user reaches their portal at `crm.un1tdublin.com/host` (their session cookie lives there). Same subdomain limitation as view-as; `host.un1tdublin.com` would need the cookie on `.un1tdublin.com`.
- The firewall header comments (`host-auth.js`, the invite route) get a one-line update noting this deliberate admin-linked exception to STAFF-XOR.

## Out of scope (v1)

- Multiple hosts per staff login (the `UNIQUE(auth_user_id)` stays; revisit only if needed).
- A staff member self-requesting host access (admin-initiated only).
- Non-admin roles performing the link.
- Mobile (host portal is web-only).

## Testing + rollout

- **Unit:** the link-eligibility logic as a pure helper — `linkStaffDecision({ staffProfile, existingLink, sameOrg })` → `ok | not_staff | cross_org | other_host | already`. Covers each branch.
- **Route/guard:** `check:route-guards` recognises `getCurrentUser`; no migration.
- **CI mirror + `next build`** green.
- **Adversarial review** on the security bullets above before PR.
- No migration; `host_users` already exists. Roll out behind the normal PR/merge.
