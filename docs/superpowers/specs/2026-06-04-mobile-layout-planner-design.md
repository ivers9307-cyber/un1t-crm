# Mobile Layout Planner — Design

**Date:** 2026-06-04 · **Status:** approved (brainstorming) → ready for implementation plan
**Repo:** un1t-crm · **Surface:** Expo iOS app (`mobile/`) + web StaffForm (`src/`) + shared (`shared/permissions.js`)

**Goal:** Let an operator control the *layout* of each staff member's mobile app — which features occupy the bottom-bar slots vs. live under "More" — on top of the existing permission toggles, driven by role + employment-type templates with per-person overrides.

---

## 1. Problem

Today the mobile bottom bar and the "More" overflow are **hardcoded in `mobile/app/(tabs)/_layout.jsx` + `more.jsx`, identical for every staff member**. The permission toggles (`MOBILE_PERMISSIONS`, shipped in MOBILE-PERMS / PR #367) decide *whether* a feature appears at all, but nothing decides *where* it lives. So a sales-leaning manager's Pipeline is buried two taps deep in "More", while a coach who never opens WhatsApp still gets it in a prime bottom slot.

We want a way to **organise each person's screen** — arrange their bottom bar to match their actual job — without giving up central control.

## 2. Locked decisions (from brainstorming)

1. **Control model:** role templates (the backbone) → per-person override (admin) → bounded staff reorder (a "bit of C"). The admin sets the policy; the staff member personalises *within* it.
2. **Structure:** the bottom bar is **Home (fixed anchor) + 3 feature slots + More (fixed anchor)**. Everything not in a slot auto-lists under More.
3. **Staff bounds:** option B — the admin defines an **allowed set** (bar-eligible features) per role/person; staff may swap which of the *allowed* set occupies the 3 slots and reorder them. Anything outside the allowed set, or toggled off, can never reach the bar.
4. **Templates are role × employment-type:** a contractor and a full-timer in the same role get different defaults (the finance surface swaps Invoices ↔ Expenses; either can be promoted into the bar).
5. **Per-location:** the layout resolves for the *active* studio, consistent with the existing per-assignment permission model (enabled features already differ per location).
6. **Phasing:** Phase 1 = the full admin side (this effort). Phase 2 = the on-phone staff reorder (fast follow).
7. **Role templates are code defaults** in Phase 1 (not an in-app template editor); the per-person override is the operator's lever. In-app template editing is explicitly deferred.

## 3. The three-layer model

Each navigable feature passes through three layers, top to bottom:

| Layer | Question | Where it lives | Status |
|---|---|---|---|
| 1 · Toggle | Is the feature enabled at all? | `permissions.mobile.<key>` (+ cross-platform keys) | **shipped** (MOBILE-PERMS) |
| 2 · Allowed-for-bar | Of the enabled features, which are bar-eligible? | `permissions.mobile.layout.allowed[]` | **new** |
| 3 · Placement | Which ≤3 allowed features sit in the bar + order; rest → More | `permissions.mobile.layout.bar[]` | **new** |

Layer 1 is unchanged. Layers 2 + 3 are this feature.

## 4. Navigable-feature registry + bar-eligibility

Layout operates on a registry of **navigable surfaces**. A new shared constant (proposed `MOBILE_NAV_FEATURES` in `shared/permissions.js` or a sibling `shared/mobile-nav.js`) lists each, with the metadata the planner + renderer need:

```js
// { key, label, icon, permKey, barEligible }
// permKey: the toggle that enables it (canMobile/canDashboard key)
// barEligible: can it occupy a bottom-bar slot in Phase 1?
```

**Bar-eligible in Phase 1 = features that are already expo-router bottom-tab routes** (`mobile/app/(tabs)/*`):

`schedule`, `bookings`, `pipeline`, `whatsapp`, `studio` (studio_management), `invoices`, `expenses`.

**More-only (Phase 1, not bar-eligible):** `tasks`, `radar` (churn/lead glance), `issues`, `contracts`, `policies` — these are pushed routes *outside* the `(tabs)` group, so they can't occupy a tab slot without being converted to a (hidden) tab. They remain in More. Making one bar-eligible later is a mechanical follow-up (move the route into `(tabs)` as a hidden `Tabs.Screen`); call it out but don't build it now.

**Fixed anchors (never in the registry's slot pool):** `index` (Home) and `more`.

> The realistic bar-worthy set (Schedule, WhatsApp, Studio, Pipeline, Bookings, Invoices, Expenses) is entirely already-tabs, so Phase 1 covers the actual use cases without the route-conversion work.

## 5. Default templates — role × employment-type

A code map keyed by role, with an employment-type axis, e.g. `DEFAULT_MOBILE_LAYOUT[role][employmentType] = { bar: [...], allowed: [...] }`. Proposed starting points (operator overrides per person):

| Role · type | Default bar (≤3 slots) | Also allowed (swap-in) |
|---|---|---|
| Owner | Schedule · Studio (2 — lean by design) | WhatsApp, Pipeline, Bookings |
| Manager | Schedule · WhatsApp · Studio | Pipeline, Bookings |
| Head coach | Schedule · WhatsApp · Studio | Bookings, Pipeline |
| Staff · FTE | Schedule | Expenses, Bookings |
| Staff · Contractor | Schedule | Invoices, Bookings |
| Master | (inherits owner) | (broad) |

Rules:
- **Owner default is intentionally lean — `Schedule · Studio` (2 slots, 1 empty)** — per the operator's call ("everything else can be configured in settings later"). Owners arrange the rest (WhatsApp / Pipeline / Bookings, all in `allowed`) themselves via the StaffForm planner. This is the **one** role whose default deliberately differs from today (WhatsApp drops to More until configured).
- **Employment-type only swaps the finance surface** by default (Expenses for `fte`, Invoices for `contractor`) in `allowed`/More; both bar lists are otherwise identical per role. Either finance surface may be promoted into the bar via override.
- The template lists *intent*; resolution always intersects with the user's **enabled** features, so a referenced key that's toggled off simply doesn't appear.
- **Backward-compatibility invariant:** every existing role *except owner* resolves to today's bar (`Schedule · WhatsApp · Studio`) with default toggles — zero visible change. Owner is the single deliberate exception (lean 2-slot default).

## 6. Data model

Reuse the existing per-assignment JSONB — no new table in Phase 1:

```
profile_locations.permissions.mobile.layout = {
  bar:     ["schedule", "whatsapp", "studio"],   // ordered, ≤3, bar-eligible keys
  allowed: ["schedule", "whatsapp", "studio", "pipeline", "bookings"]
}
```

- Written by StaffForm (admin), per location/assignment — same storage, same RLS path as today's `permissions.mobile.<toggle>`.
- **Absent** (the default for every existing user) → fall back to the role × employment-type code template. So shipping Phase 1 writes nothing and changes nothing until an admin customises someone.
- `employment_type` is read from the profile (already serialized to `/api/mobile/me`), not stored in the layout blob.

## 7. Resolution — one pure function

`resolveMobileLayout({ role, employmentType, enabledKeys, override })` → `{ bar, more, allowed }`. Pure, no IO, unit-tested. Lives in `shared/` so web + mobile share it.

```
base    = override ?? DEFAULT_MOBILE_LAYOUT[role][employmentType] ?? DEFAULT_MOBILE_LAYOUT[role].fte
allowed = base.allowed  ∩ enabledKeys ∩ BAR_ELIGIBLE      // drop toggled-off / non-eligible
bar     = (base.bar ∩ allowed), de-duped, capped at 3      // ordered
more    = enabledKeys − bar                                // everything else enabled, grouped order
return { bar, more, allowed }
```

- `enabledKeys` = the set of navigable features the user passes Layer-1 for at the active location (computed from `canMobile`/`canDashboard` + employment-type gating for invoices/expenses).
- `allowed` is returned so Phase 2 can clamp the staff's on-phone arrangement to `allowed ∩ enabled`.
- `more` ordering: a stable, sensible grouping (e.g. Operations → Finance → Insights → Report → Documents, matching today's `more.jsx` sections) rather than raw set order.

**Worked examples** (with default toggles):
- Manager, no override → bar `[schedule, whatsapp, studio]`, more `[pipeline, bookings, tasks, radar, issues, contracts, policies]`.
- Manager, override `bar:[schedule, pipeline, whatsapp]`, `allowed:[schedule, whatsapp, studio, pipeline, bookings]` → bar `[schedule, pipeline, whatsapp]`, Studio drops to More.
- Contractor coach → finance surface in More is Invoices (not Expenses).
- Studio toggled off for a user whose template bar includes it → bar silently becomes `[schedule, whatsapp]` (2 slots).

## 8. API

`/api/mobile/me` (`src/app/api/mobile/me/route.js`) serializes the resolved layout per location, so the app renders from data:

```
location.layout = { bar: [...keys], more: [...keys] }   // per serialized location
```

Computed server-side via `resolveMobileLayout` using that location's enabled set + the assignment's `permissions.mobile.layout` override + the profile's role/employment_type. (Active-location block + each location in the list, mirroring how `features`/`permissions` are already attached.)

## 9. Mobile rendering refactor (the core change)

**`mobile/app/(tabs)/_layout.jsx`** stops hardcoding which tabs are bottom-bar vs. hidden. Instead:
- Every `Tabs.Screen` is still declared (expo-router requires the file-based tree).
- `href` / visibility for each bar-eligible tab is driven by `activeLocation.layout.bar`: a key in `bar` → visible at its slot order; not in `bar` → `tabBarItemStyle: { display: 'none' }` (reachable from More, as today).
- Home + More remain always-visible anchors.
- Bar order follows the `bar` array.

**`mobile/app/(tabs)/more.jsx`** renders its rows from `activeLocation.layout.more` (the overflow), keeping the existing grouped sections (Operations / Finance / Insights / Report / Documents) but only showing rows whose key is in `more`. The per-feature permission gates added in MOBILE-PERMS stay as the source of "enabled"; layout decides bar-vs-More among the enabled.

This is the largest mechanical piece and must preserve every existing route + the impersonation banner + push registration.

## 10. Admin UI — StaffForm bottom-bar planner

In StaffForm's existing **"Mobile App Features"** section (`src/components/StaffForm.jsx`), for the currently-selected location/assignment, add a **Bottom-bar planner**:
- Three slot chips (Home and More shown as fixed, greyed) + the **allowed pool** + a **More** list.
- Pre-filled from the role × employment-type template; the admin drags features between Allowed / Bar / More and reorders the 3 slots.
- Only **bar-eligible + enabled** features are draggable into slots; toggling a feature off in the section above removes it from the planner live.
- Writes `permissions.mobile.layout = { bar, allowed }` into the same assignment blob the toggles use. "Reset to role default" clears the override.

Keep it consistent with the existing per-location tab strip + the `patchSelectedMobilePerms` plumbing.

## 11. Edge cases / invariants

- **Toggled-off feature** → auto-drops from bar + allowed (resolver intersects with enabled). No dangling slots.
- **Fewer than 3 allowed/enabled** → bar renders fewer slots; never an empty placeholder.
- **Brand-new feature** added later → lands in More by default (not auto-promoted) unless a template/override places it.
- **Multi-location staff** → layout resolves per active studio; switching location re-fetches `/me` and re-renders.
- **Master** → still sees everything; default layout = owner's; per-person override still applies.
- **Home + More** always present.
- **Impersonation** → the impersonated user's resolved layout is what renders (consistent with the just-shipped identity-aware refetch work).

## 12. Backward compatibility

With the current default toggles, **every existing role except owner resolves to today's bar** (`Home · Schedule · WhatsApp · Studio · More`) — no change until an admin customises. **Owner is the one deliberate exception** (operator's call): owner's default is the lean `Home · Schedule · Studio · More`, with WhatsApp/Pipeline/Bookings in `allowed` and dropped to More until the owner arranges them in the planner.

## 13. Open items to confirm during planning

1. ~~**Owner default bar**~~ — **DECIDED:** `Schedule · Studio` (lean 2-slot default); WhatsApp/Pipeline/Bookings stay in `allowed`, configured via the planner. Owner is the single role that deviates from today.
2. **More-ordering** — adopt today's section grouping verbatim; no per-user More ordering in Phase 1.
3. **`radar`** — the More "Radar" row is gated by `churn_radar || lead_radar`; treat as a single nav key `radar` for layout purposes (More-only, not bar-eligible in Phase 1).

## 14. Phasing

**Phase 1 (this effort) — admin-controlled layout, per-location:**
- `MOBILE_NAV_FEATURES` registry + `DEFAULT_MOBILE_LAYOUT[role][employmentType]` + `resolveMobileLayout` (shared, pure, tested).
- `/api/mobile/me` serializes resolved `{ bar, more }` per location.
- `_layout.jsx` + `more.jsx` render from the resolved layout.
- StaffForm bottom-bar planner writes `permissions.mobile.layout`.
- Backward-compat default reproduces today's bar.

**Phase 2 (fast follow, not now) — on-phone staff reorder:**
- A mobile "Customise bar" screen (drag within the allowed pool).
- A user-writable store + endpoint (e.g. `PUT /api/mobile/layout` writing a self-owned `profiles.mobile_layout` or a `mobile_layout_prefs` row — chosen in its own design).
- Resolver clamps the staff's arrangement to `allowed ∩ enabled` (the `allowed` output already exists from Phase 1).

## 15. Out of scope (Phase 1)

- On-phone staff reorder (Phase 2).
- In-app editing of role templates (code defaults + per-person override only).
- Converting More-only pushed routes (tasks/radar/issues/contracts/policies) into bar-eligible tabs.
- Per-user ordering of the More list.
- Customising Home or More themselves.

## 16. Testing

- **Unit (vitest, shared):** `resolveMobileLayout` — intersection with enabled, ≤3 cap, ordering, override-beats-template, employment-type finance swap, empty/short cases, non-bar-eligible keys rejected, backward-compat (default templates reproduce today's bar per role).
- **Default-template snapshot:** assert each role × type template's resolved bar against the expected set with default toggles.
- **Parity / mobile-parity:** unaffected (no new permission keys; layout is a sub-blob). Confirm `check:mobile-parity` stays green.
- **Manual (auth-gated, OTA):** StaffForm planner writes the blob; impersonate a user with a custom layout and confirm the bar + More render correctly per location.

## 17. Ship / deploy notes

- Touches `shared/**` + `mobile/**` + `src/**` → merging to `main` auto-publishes an **OTA** (`eas-update.yml`) and rebuilds the web StaffForm.
- Mobile UI isn't covered by web CI/lint; the `resolveMobileLayout` purity + the data-driven `_layout.jsx` are the risk surface — lean on the shared unit tests + a real on-device check.
