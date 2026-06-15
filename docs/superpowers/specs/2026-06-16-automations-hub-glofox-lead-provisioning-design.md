# Automations Hub + Glofox lead-provisioning — Design

**Status:** approved 2026-06-16 (design dialogue). This spec covers a new **Automations** surface (a curated hub, registry-driven) and its **first automation**: auto-create a Glofox account + attach the studio trial when a new lead is created. The hub is built to grow (more automations, plus links out to the existing comms Sequences + the Mia agent).

**Goal:** Give the operator one place — `/automations` — to manage operational automations, and ship the first one: *every new lead gets a Glofox account with a trial membership*, on by location, with a one-time backfill for existing un-linked leads.

---

## Locked decisions (from the design dialogue)

1. **Curated hub, not a generic rules engine.** Registry pattern mirroring `/approvals` (`APPROVALS_PROVIDERS`). Each automation is a registered definition rendered as a card. New automations later = a registry entry + (if needed) a hook, no new plumbing.
2. **Trigger = on lead creation.** Hooked into the three real "a new lead just appeared" code paths (see Trigger surface). NOT pipeline-stage-based.
3. **Guaranteed exclusions** so it can never mass-misfire: contacts created by **Glofox sync** and **bulk CSV import** (those paths simply don't get the hook), **ClassPass shadow** contacts, contacts **already linked** to a Glofox member (link-only, never double-create), and contacts with **no email** (Glofox can't register without one).
4. **Action = reuse `findOrCreateGlofoxMember`** in `createIfMissing: true, attachTrial: true` mode — the same orchestrator these paths already call in link-only mode today. Failures land in the **existing** `glofox_push_events` Review queue (retry/dismiss already built).
5. **New "Automations" sidebar section** (its own section, room to grow), gated by a new `automations` web permission.
6. **Backfill included:** a "Push existing un-linked leads now" button in the card (one-time, confirm-with-count, chunked, idempotent). Sequenced as Phase 2 (the riskier bulk op).
7. **Assistant-created contacts are included** as a lead-creation path.

---

## Trigger surface (where leads are created)

Verified contact-INSERT sites and their disposition:

| Site | File | In scope? |
|---|---|---|
| Manual add / n8n | `src/app/api/contacts/route.js:59` | **YES** — already calls `findOrCreateGlofoxMember` (dup_check, link-only) at line ~92; we make that call create-and-trial when the automation is enabled. |
| Website lead form | `src/app/api/public/leads/route.js` (via `findOrCreateRaceContact`) | **YES** |
| In-app assistant creates a contact | `src/app/api/assistant/chat/route.js:92` | **YES** (locked decision 7) |
| Bulk CSV import | `src/lib/contact-import-runner.js:175` | **NO** — no hook (mass-create guard) |
| Glofox sync ingest | `src/lib/glofox-sync.js:1724` | **NO** — already in Glofox (circular) |
| Event / race / booking signup | `findOrCreateRaceContact` in event/race register routes + `handle_new_booking` | **NO** — these already have their own per-event `create_in_glofox` opt-in path; leaving them untouched avoids double-handling. |

So the automation governs the "generic lead" paths; the event/booking paths keep their existing per-event opt-in. (If the operator later wants those unified under the hub too, that's a follow-up — out of scope here.)

---

## Architecture

### 1. Config storage — `location_automations` (mig NNN)

```sql
create table public.location_automations (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  automation_key text not null,
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id),
  unique (location_id, automation_key)
);
create index idx_location_automations_loc on public.location_automations(location_id);
alter table public.location_automations enable row level security;
-- staff-in-location read; writes are service-role only (API routes)
create policy location_automations_loc on public.location_automations for all to authenticated
  using (private.auth_is_in_location(location_id))
  with check (private.auth_is_in_location(location_id));
```

- One row per `(location, automation_key)`. Absent row = disabled (default off — opt-in, never silently auto-enabled). `config` JSONB holds per-automation options (none required for v1's automation, but the column future-proofs the hub).
- `glofox_lead_provisioning` is the only `automation_key` in v1.

### 2. Registry — `src/lib/automations/registry.js`

Mirrors `src/lib/approvals/registry.js`. A pure array of definitions:

```js
export const AUTOMATIONS = [
  {
    key: 'glofox_lead_provisioning',
    label: 'Auto-create leads in Glofox',
    description: 'When a new lead is created, create their Glofox account and attach the studio trial membership.',
    supportsBackfill: true,
    // pure: is this automation even offerable at this location?
    isAvailable: (location) => glofoxConnected(location),     // branch_id + api_key + api_token present
    // pure: { glofoxConnected, trialConfigured, trialLabel } for the card status line
    statusSummary: (location) => ({ ... }),
  },
]
export function getAutomation(key) { ... }
```

`glofoxConnected(location)` + `statusSummary` are pure (tested). The hub reads `AUTOMATIONS`, joins with `location_automations` rows for the active location, and renders a card each.

### 3. The qualifier + hook — `src/lib/automations/glofox-lead-provisioning.js`

```js
// PURE — decides eligibility for a single contact.
export function qualifiesForGlofoxProvisioning(contact) {
  if (!contact) return false
  if (contact.glofox_member_id) return false            // already linked → link-only, never double-create
  if (!contact.email) return false                      // Glofox requires email
  if (contact.source === 'classpass') return false      // ClassPass shadow
  return true
}

// IO — the hook the three create-sites call. Fire-and-forget, never throws.
export async function maybeProvisionLeadInGlofox({ db, contact, locationId, source }) {
  // 1. read location_automations row for (locationId, 'glofox_lead_provisioning')
  // 2. if enabled AND qualifiesForGlofoxProvisioning(contact) AND glofox connected:
  //       findOrCreateGlofoxMember({ db, locationId, contact, source, createIfMissing: true, attachTrial: true })
  //    else (disabled / not eligible): keep TODAY's behaviour —
  //       findOrCreateGlofoxMember({ ..., createIfMissing: false, attachTrial: false })  // link-only dup-check
}
```

The three create-sites replace their current inline `findOrCreateGlofoxMember(... createIfMissing:false ...)` call with `maybeProvisionLeadInGlofox(...)`. So when the automation is **off**, behaviour is byte-identical to today (link-only dup-check); when **on**, eligible leads get created + trial. `findOrCreateGlofoxMember` already: searches-by-email-and-links first (idempotent), skips ClassPass server-side (defence-in-depth), and writes failures to `glofox_push_events`. No change to the orchestrator itself.

### 4. Failure handling

No new surface. `findOrCreateGlofoxMember` already records `status='needs_review'` rows in `glofox_push_events` on missing-fields / API failure (e.g. lead created with only an email → no last name → needs_review). The card links to that existing Review queue (`/api/admin/glofox-push-events`, with retry/dismiss). Lead creation itself is never blocked (fire-and-forget, per the codebase convention).

### 5. The hub UI — `/automations`

- New route `src/app/automations/page.js` (server) → `AutomationsView.jsx` (client).
- Renders a **card per registered automation**, scoped to the **active location**:
  - **Toggle** (enabled on/off) → `PUT /api/automations/[key]`.
  - **Status line**: "Glofox connected ✓ · Trial: Active Trial ✓" or, when no trial configured, "⚠ No trial set — [link to Settings → Glofox]". When Glofox isn't connected at this location (e.g. Hatch Street), the card is shown disabled with "Glofox not connected here."
  - **Recent failures** link → the Glofox Review queue.
  - **(Phase 2)** "Push existing un-linked leads now" button → confirm modal showing the eligible count → `POST /api/automations/[key]/backfill`.
- **"See also"** footer linking to **Sequences** (`/communications/sequences`, comms automation) and the **Mia agent** (`/settings/customer-agent`) — so the hub is the map of everything that runs automatically. (Links only; those surfaces are not moved in v1.)

### 6. API routes

- `PUT /api/automations/[key]` — body `{ location_id, enabled, config? }`. `automations` permission + `assertLocationAccess`. Upserts `location_automations`. Standard `{ success, data }`.
- `POST /api/automations/[key]/backfill` — **Phase 2**. `automations` perm + `assertLocationAccess`. Finds eligible contacts (location, `glofox_member_id IS NULL`, has email, `source <> 'classpass'`, source not import/sync-origin), runs `findOrCreateGlofoxMember(create+trial)` per contact in **bounded chunks** with throttling, idempotent (already-linked skipped), failures → `glofox_push_events`. Returns `{ processed, created, needs_review, remaining }`. Re-clickable to continue, or drained by a small cron if the eligible set is large. A `GET` variant (or the same route with `?count=1`) returns the eligible count for the confirm modal.
- Register all in `src/lib/openapi.js`.

### 7. Permission + nav + parity

- New **`automations`** web permission in `shared/permissions.js` + `DEFAULT_WEB_PERMISSIONS_BY_ROLE` (on for owner/manager/master; off for head_coach/staff). Add to `WEB_ONLY_OK` in `check-mobile-parity.mjs` (reason: "operational-automation admin hub; web/operator surface, no mobile counterpart").
- New **sidebar section** `automations` with one entry `{ href: '/automations', label: 'Automations', permission: 'automations' }` in `src/lib/nav-items.js` (+ a section header "Automations").

---

## Decomposition / phasing

- **Phase 1 (core):** mig (`location_automations`) + registry + qualifier + `maybeProvisionLeadInGlofox` hook wired into the 3 create-sites + `/automations` hub page + card with toggle + status + Review link + `PUT /api/automations/[key]` + `automations` permission + nav entry. **Forward auto-create works end-to-end.**
- **Phase 2 (backfill):** the "Push existing un-linked leads now" button + `POST /api/automations/[key]/backfill` (chunked/throttled/idempotent) + eligible-count confirm.

Each phase is independently shippable + testable.

---

## Testing

- **Pure, unit-tested:** `qualifiesForGlofoxProvisioning` (email present / absent, already-linked, classpass, happy path); `glofoxConnected` + `statusSummary` in the registry; registry shape contract (mirrors `registry.test.js` for approvals).
- **Hook (`maybeProvisionLeadInGlofox`)** with mocked `db` + mocked `findOrCreateGlofoxMember`: enabled→create+trial, disabled→link-only, ineligible→link-only, not-connected→no-op.
- **Routes** (mock `getCurrentUser` + db): `PUT /api/automations/[key]` permission 403, cross-location guard, upsert; backfill count + chunk.
- **`next build`** for the hub page + components.

---

## Self-review

- **Placeholders:** mig number is `NNN` (assigned at apply time) — everything else concrete. No TODOs.
- **Consistency:** "off by default / opt-in" (decision 3 + table default) is consistent with "guaranteed exclusions." The hook preserves today's link-only behaviour when disabled, so shipping Phase 1 with the toggle off is a no-op — safe to merge before the operator flips it on.
- **Scope:** one hub + one automation + a backfill, phased. Coherent for a single plan (two phases). The "unify event/booking paths under the hub" idea is explicitly deferred.
- **Ambiguity:** "new lead" is pinned to the three named create-sites with explicit exclusions; "attach trial" uses the per-location `settings.glofox.trial_membership_id` we just repaired (#543). When no trial is configured, the account is still created and the trial step → `needs_review` (card warns up-front).
