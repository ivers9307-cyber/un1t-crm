# Host self-serve event creation — design (HOST-PORTAL.3)

**Date:** 2026-07-08
**Status:** approved (design), pending implementation plan
**Branch:** `host-selfserve-events`

## Goal

Let a 3rd-party event host create and edit their **own** events from the host portal, gated behind a UN1T review step: **draft → submit → UN1T approve → published** (with reject). Today the host portal is read-only and `host_id` is set only by staff in the internal event form; this closes that loop so UN1T is no longer in the critical path for a host to author an event, while keeping a legitimacy/quality gate before anything goes public and takes money.

This is Phase 2 of the events hosting platform (foundation + provisioning shipped in [#845], revenue + attendees in [#846]).

## Decisions (locked with Richard, 2026-07-08)

1. **Venue** — host events are at the host's **own** venue: free-text `venue_name` + `venue_address`, shown on the public page in place of a UN1T gym address.
2. **Pricing** — a **single ticket price per person** (stored in `non_member_fee_cents`; team total = price × team size, via the existing `computeTeamPricing`). No UN1T member/non-member split (`member_pricing_enabled=false`, `members_only=false`); the €2/ticket UN1T booking fee still applies at checkout via the existing path.
3. **Edit-after-publish** — cosmetic edits (description, image, email copy) go live immediately; changing **price or date** on a published event sends it **back to `pending_review`** for UN1T re-approval (no post-approval bait-and-switch on money/timing).
4. **Review home** — a dedicated **"Pending review" queue under Settings → Hosts**, org-scoped, `ADMIN_ROLES` (Manager+). Bespoke queue, not the approvals-inbox provider (hosts are org-scoped; the inbox is active-location-scoped). An approvals-provider badge can be layered on later.
5. **DB anchor (venue)** — each `event_host` gets **one hidden anchor `locations` row** (its `location_id` for all its events). Required because `race_events.location_id` is NOT NULL and load-bearing, and because `teams` is `UNIQUE (location_id, name)` — a shared anchor would let two hosts' identically-named teams collide/overwrite. Per-host isolation prevents cross-host team mixing while preserving the intended "returning team persists across a host's own event series" behavior.

## Current-state facts this design depends on

- **Only `active` gates visibility today.** Every public path filters `.eq('active', true)`; events go public the instant they're inserted. There is no draft/status concept on `race_events`. (mig 082; `src/app/api/public/events/[slug]/route.js:32`, `src/app/event/[slug]/page.js:44`, `src/app/welcome/[location]/events/page.js:91-97`, `src/app/api/public/events/[slug]/register/route.js:101`.)
- **`race_events.location_id`** is NOT NULL FK → `locations`, UNIQUE `(location_id, slug)` (mig 082). Load-bearing: RLS scope, team uniqueness, branding/email resolution, the `shared` cross-location flag.
- **`teams`** is `UNIQUE (location_id, name)` and the register route looks up/relinks teams by `(race.location_id, name)` (mig 081:53; `register/route.js:176-183`). Intentional team-persistence-per-location.
- **`event_hosts`** is org-scoped: `organization_id NOT NULL` (mig 381:15); `race_events.host_id` optional (`ON DELETE SET NULL`). Host session via `getCurrentHost()` → `{ host, authUserId, email }`, `host` limited to `HOST_PORTAL_COLS` (no Stripe token). Host has a `host_users` row, no `profiles` row (staff/host firewall).
- **Event create/edit today:** `POST /api/events` + `PUT /api/events/[id]`, `hasPermission('races')`, waves created in the same request; `host_id` requires `ADMIN_ROLES` + org match. Form: `src/components/RaceEventForm.jsx`.

## Data model (one migration, forward-only)

### `race_events` — new columns
| Column | Type | Notes |
|---|---|---|
| `status` | `TEXT NOT NULL DEFAULT 'published'` | CHECK in (`draft`,`pending_review`,`published`,`rejected`). Default `'published'` → **every existing + staff-created event is unaffected**. |
| `venue_name` | `TEXT` | free-text; host events only |
| `venue_address` | `TEXT` | free-text; host events only |
| `submitted_at` | `TIMESTAMPTZ` | set when host submits for review |
| `reviewed_at` | `TIMESTAMPTZ` | set on approve/reject |
| `reviewed_by` | `UUID` | staff profile id (approver) |
| `rejected_reason` | `TEXT` | shown to the host on rejection |

`status` semantics: only host-authored events ever leave `'published'`. Staff-created internal events keep the default and their edits never touch `status`.

### `event_hosts` — new column
| Column | Type | Notes |
|---|---|---|
| `anchor_location_id` | `UUID REFERENCES locations(id)` | the host's hidden anchor location; provisioned lazily on first event create |

### `locations` — new column
| Column | Type | Notes |
|---|---|---|
| `is_host_anchor` | `BOOLEAN NOT NULL DEFAULT false` | flags a hidden per-host anchor location; excluded from staff pickers, public UN1T listings, and location rollups |

Anchor provisioning (lazy, in the host event-create route): if `event_hosts.anchor_location_id IS NULL`, insert a `locations` row `{ organization_id: host.organization_id, name: host.name + ' (host events)', active: true, is_host_anchor: true }` (no `landing_page_settings` row → never publicly listed as a UN1T location), store its id on `event_hosts`, use it thereafter. No `profile_locations` rows → no staff gains access.

## Public visibility gating (the load-bearing change)

Add **`status='published'`** to every public path alongside the existing `active=true`. Default `'published'` means existing events are unaffected; only host drafts/pending/rejected are hidden + unbookable.

Four call-sites:
1. `src/app/api/public/events/[slug]/route.js:32` — data route `.single()` gate → 404 if not published.
2. `src/app/event/[slug]/page.js:44` — `generateMetadata` (no OG for unpublished).
3. `src/app/welcome/[location]/events/page.js:91-97` — public listing. Also add `host_id IS NULL` here so host events never appear in a UN1T location's public listing (they live at `/event/[slug]` + the future host subdomain). Belt-and-suspenders with the anchor (host events are anchored to a hidden location anyway).
4. `src/app/api/public/events/[slug]/register/route.js:101` — register gate → 404/booking-closed if not published (a draft/rejected event can never take money).

**Characterization tests** lock all four: an `active=true` event with default `status` stays visible/bookable; a `status='draft'|'pending_review'|'rejected'` event is invisible + unbookable + not listed.

## Host create/edit — portal UI + API

**Pages** (dark, host-styled, under `src/app/host/(portal)/`):
- `events/new/page.js` — create form.
- `events/[id]/edit/page.js` — edit form (host-scoped; `notFound()` if `race.host_id !== session.host.id`).
- The dashboard (`host/(portal)/page.js`) gains a "Create event" button and each event shows its `status` (Draft / In review / Published / Needs changes) + edit link.

**API** (new, `getCurrentHost()`-gated, force `host_id = session.host.id`):
- `POST /api/host/events` — create as `draft`. Provisions the anchor location if needed. Sets safe server-side defaults for UN1T-only fields.
- `PUT /api/host/events/[id]` — edit own event; enforces the edit-after-publish rule (§ edit policy). `notFound` if not this host's.
- `POST /api/host/events/[id]/submit` — `draft`|`rejected` → `pending_review`, stamp `submitted_at`.
- Register the routes' guard token (`getCurrentHost`) — already in `SESSION_GUARDS`.

**Host-controlled fields** (narrow, deliberate): `kind` (subset: workshop / seminar / masterclass / open_day / race), `name`, `description`, `race_date`, one session (`start_time` + `capacity` → synthesised single `race_waves` row, mirroring how non-race kinds work today), `allowed_team_sizes`, single ticket price (`non_member_fee_cents`), `hero_image_url`, `accent_hex`, `venue_name`, `venue_address`, and their email copy (`confirmation_email_*`, `reminder_email_*` — reuses [#844] config).

**Server-forced defaults** (never host-exposed): `location_id` = anchor, `host_id` = self, `member_pricing_enabled=false`, `members_only=false`, `member_fee_cents=null`, `shared=false`, `create_in_glofox=false`, `staff_required=0`, `payment_currency='EUR'`, `capacity_mode='people'` (host capacity is a headcount). Slug auto-derived from name, unique within the anchor location (auto-suffix on collision).

**Validation:** a new Zod `HostEventSchema` (a strict subset of the internal schema) — the host route never accepts the UN1T-only fields even if posted (defence-in-depth against a crafted request).

## Edit-after-publish rule (decision 3)

In `PUT /api/host/events/[id]`:
- If current `status !== 'published'` → apply all edits, keep status (`draft`/`rejected` stay as-is; a `rejected` edit may be followed by re-submit).
- If current `status === 'published'`:
  - If the submitted `race_date` or price (`non_member_fee_cents`) or any wave's `start_time` **differs** from stored → set `status='pending_review'`, clear `reviewed_at`, stamp `submitted_at`; the event **stays live at its old values until re-approved** (we do NOT unpublish immediately — avoid pulling a running event offline; the pending flag tells UN1T to re-check). *Open sub-decision, see Risks.*
  - Else (cosmetic only) → apply, stay `published`.

## UN1T review queue (decision 4)

- **`/settings/hosts`** gains a **"Pending review"** section/tab: lists `race_events` where `host_id ∈ (org's hosts)` and `status='pending_review'`, newest `submitted_at` first. Org-scoped via the existing `/api/hosts` org resolution; `ADMIN_ROLES`.
- Each row → a read-only preview (name, host, venue, date, price, session, description, hero) → **Approve & publish** or **Reject** (reason required).
- **`POST /api/events/[id]/review`** (staff, `ADMIN_ROLES`, event's host must be in the caller's org — IDOR guard mirroring `loadHostForOrg`): `{ action: 'approve' | 'reject', reason? }`. Approve → `status='published'`, stamp `reviewed_at`/`reviewed_by`. Reject → `status='rejected'`, store `rejected_reason`, stamp review fields. Fire-and-forget host notification email on both (reuses the transactional email path).
- A count badge on the Hosts nav item (pending count for the active org).

## Out of scope (v1)

- Approvals-inbox provider integration (badge/Today-feed) — layer on later.
- Host self-serve promo codes / editing published-event email templates beyond create-time (separate follow-up).
- Multi-session / multi-wave host events (v1 = single session). Team-size composition beyond simple sizes.
- Host-uploaded document/waiver, ticketing tiers, capacity per wave beyond one number.
- Geocoding / map pin for the venue (free-text address only).
- The pretty `host.un1tdublin.com` subdomain go-live (operator: DNS + `HOST_PORTAL_HOSTNAME`).

## Testing, rollout, review

- **Migration** applied via Supabase MCP against `iyvtbjjxdggiadzwwvdj`; `get_advisors` after DDL. Default `status='published'` = no backfill needed.
- **Unit tests:** the status state-machine transitions, the edit-after-publish diff (price/date vs cosmetic), the anchor-provisioning helper, the `HostEventSchema` rejects UN1T-only fields.
- **Characterization tests:** the four public gates (existing events stay visible; draft/pending/rejected hidden + unbookable + unlisted).
- **CI mirror + `next build`** green before PR. Migration applied before the code that reads `status` deploys.
- **Adversarial review before merge** on: (a) the public-visibility gate — no draft/rejected/pending event is ever viewable or bookable on any path; (b) host create/edit scoping — a host can never author or edit for another host, and the UN1T-only fields can't be injected; (c) the review route IDOR + role gate; (d) the anchor-provisioning race (two concurrent first-creates → one anchor, no duplicate).

## Risks / open sub-decisions

1. **Edit-after-publish: stay-live-until-reapproved vs unpublish-on-edit.** Spec picks *stay live at old values, flag pending*. Alternative (stricter) is to unpublish on a price/date edit. Chosen option avoids pulling a running event offline for a re-review; the tradeoff is the public still sees old price/date until UN1T re-approves — which is correct (the host can't unilaterally change money/timing on a live event). Revisit if UN1T wants edits to preview-then-swap.
2. **Anchor location in reporting.** `is_host_anchor` locations must be excluded from any staff report/dashboard that enumerates `locations` for org rollups. Audit those call-sites during implementation (grep `from('locations')` without a host-anchor filter).
3. **`kind`-specific behavior.** Some `kind`s trigger UN1T-specific features (e.g. race → TV logos, `create_in_glofox`). Host events force those off; confirm no code path assumes a host event's `kind` implies a UN1T location.
