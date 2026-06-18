# Session Report — Slice 2: class category (cardio/strength/conditioning) — design spec

- **Date:** 2026-06-18
- **Status:** Draft for review
- **Ticket:** SESSION-REPORT.2
- **Slice:** Slice 2 of the post-class Session Report. Fills the two reserved null slots in the Slice 1 contract — `session.class.category` and `comparisons.vs_category` — and realigns the existing `vs_this_class` comparison onto the class name. Completes the original "compare to typical cardio/strength classes" ask.
- **Repos:** `un1t-crm` (canonical builder copy + migration + operator settings UI + email/loader) and `champ-app` (byte-identical builder + customer loader + session view). One migration; both apps share the Supabase project.

## Goal

Let a member's post-class report say "**top 18% of your cardio classes**" alongside the existing "**top X% of your RIDE classes**." This needs a cardio/strength/conditioning label per class, sourced from an operator-editable, **class-name-keyed** mapping so it covers the bridge-tracked Glofox class sessions that actually carry HR data — not just CRM bookings. As a necessary correctness fix in the same slice, the existing same-class comparison is realigned to key on the class name too (it currently keys on the CRM event type, which is null for class-goers without a CRM booking, conflating different classes).

## Why this shape (grounded in current state)

- **No category exists anywhere.** There is no `category`/`discipline`/`class_type` column on `event_types`, `class_occurrences`, or `bookings` (verified across both repos + migrations). The achievement/email/whatsapp/segment `category` columns are unrelated taxonomies. Slice 2 is net-new.
- **Two class-identity worlds, one shared key.** An HR session knows its class either via `booking_id → bookings.event_type_id → event_types.name` (CRM) OR via `heart_rate_sessions.class_name` + `glofox_event_id` (the Glofox class the bridge stamps, HR-CLASS-ALLOC.1/.2, mig 287/288). Class-goers are frequently created by the bridge by *presence* with **no CRM booking**, so they have `class_name` but no `event_type_id`. The one identifier both worlds share is the **class name** (`RIDE`, `DR1VE`, `TEMPO`…). So category is keyed on the (normalized) class name.
- **`vs_this_class` is currently wrong for bridge sessions.** Slice 1's `buildSessionAnalytics` groups history by `event_type_id` (`sameClassType`, `src/lib/hr-analytics.js`). For a presence session `event_type_id` is null, so `sameClassType(history, null)` matches *all* the member's other null-event-type sessions — lumping a RIDE in with a TEMPO. Re-keying on the class name fixes this and makes the comparison populate for real sessions.
- **History fetch already suffices.** `load-session-report.js` (champ-app) fetches the member's 90-day session history and filters in memory; the same set, re-grouped by category (and by class name), needs no broader query — just the class name on each row + the location's category mapping.
- **The builder is pure.** `buildSessionReport`/`buildSessionAnalytics` consume `thisSession` + `history` arrays. Category resolution (DB lookup) happens in the loaders, which attach `class_key` + `category` to each row before calling the pure builder — same architecture as Slice 1.

## Architecture

### Data model — one migration (next number, ~mig 293)

**`class_categories`** — operator-editable, per-location, name-keyed:

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `location_id` | uuid NOT NULL → `locations(id)` ON DELETE CASCADE | tenant scope |
| `class_name` | text NOT NULL | display name as the operator sees it (e.g. `RIDE`) |
| `class_name_normalized` | text NOT NULL | `lower(btrim(class_name))` — the match key |
| `category` | text NOT NULL | `CHECK (category IN ('cardio','strength','conditioning'))` |
| `created_at` / `updated_at` | timestamptz | |

`UNIQUE (location_id, class_name_normalized)`. Index: `(location_id)`.

**RLS:** `ENABLE ROW LEVEL SECURITY`. **SELECT for `authenticated` (unrestricted)** — these are non-sensitive class labels that BOTH the staff CRM and the customer app must read (the customer report loader needs them; a customer reading class labels is harmless). **Writes are service-role only** (via the manager-gated settings API). No INSERT/UPDATE/DELETE policy for `authenticated`. Run `get_advisors` after; the `SELECT USING (true)` policy is intentional and noted in a table comment.

**Category set:** `cardio`, `strength`, `conditioning`. An unmapped class has no row → resolves to `null` (no category comparison).

### Operator settings UI

A new **Settings → Class categories** page (`/settings/class-categories`), manager+ (role-gated; **no new permission key** → no mobile-parity work):
- Lists the **distinct class names seen** at the active location — a union of recent `heart_rate_sessions.class_name` and `class_occurrences.name` (deduped, normalized) — each with its current category (or "—") and a dropdown (cardio / strength / conditioning / clear).
- **API:** `GET /api/settings/class-categories?location_id=` returns `{ seen: [{ class_name, category|null }] }` (the seen names joined to existing mappings). `PUT /api/settings/class-categories` accepts `{ location_id, entries: [{ class_name, category|null }] }`, upserts rows (category set) / deletes rows (category cleared) for that location. Manager+ + `assertLocationAccess`.
- One-time setup, editable anytime. Variants (`DR1VE 45`, `DR1VE Express`) appear as separate rows the operator tags individually (prefix-collapsing is a deferred non-goal).

### Class-identity resolution (loaders — the seam)

Both loaders resolve a canonical class identity per session and attach it before the pure builder:
- **champ-app** `src/lib/load-session-report.js`: extend the session + history selects to include `heart_rate_sessions.class_name` (alongside the existing `booking.event_type` join). Resolve `className = session.class_name ?? booking.event_type.name ?? null`; `classKey = normalize(className)`. Fetch the location's `class_categories` once (`select class_name_normalized, category where location_id = <session location>`), build a `Map`, and set `category = map.get(classKey) ?? null` on `thisSession` and every history row. (History rows need `class_name` selected too.)
- **un1t-crm** the post-class email path (`hr-post-class-email.js` → its context loader): the same resolution, so the email's comparison block matches.

`normalize(name)` = `name.trim().toLowerCase()` (a shared pure helper, e.g. `normalizeClassName` in the report lib, used by loaders, the settings API, and tests so the key derivation can't drift).

### The comparison (pure builder — byte-identical in both repos)

`src/lib/hr-analytics.js` `buildSessionAnalytics({ thisSession, history, className, nowMs })` (rename `eventTypeName` → `className` for honesty; it's the resolved class name now):
- `thisSession` and `history` rows now carry `class_key` (normalized name) + `category`.
- **`sameClass`** = history filtered by `class_key === thisSession.class_key` (replaces `sameClassType` by `event_type_id`). Recent window + percentile/mean as today.
- **`sameCategory`** = history filtered by `category === thisSession.category` (only when `thisSession.category` is non-null). Recent window + `meanField`/`percentileOf` over `effort_points`, mirroring the class computation.
- Returns `classType` (unchanged shape) **plus** a new `category: { categoryName, recentCount, meanPoints, percentile }` (null when no category).

`src/lib/hr-session-report.js` `buildSessionReport`:
- `session.class.name` = `className`; `session.class.category` = `thisSession.category ?? null`.
- `comparisons.vs_this_class` — unchanged shape; its `event_type_name` field is populated with the class name (field key kept to avoid a breaking rename). Now grouped by class name.
- `comparisons.vs_category` fills the reserved slot:
  ```jsonc
  "vs_category": {
    "category": "cardio",          // 'cardio' | 'strength' | 'conditioning'
    "mean_points": 270,
    "percentile": 0.82,
    "sample_size": 9
  }                                  // or null when the class is unmapped / no category
  ```
- **`SESSION_REPORT_VERSION` stays `1`.** No existing field's shape or meaning changes (the `vs_this_class` grouping key is an internal implementation detail; its output shape + semantics — "vs your typical [this class]" — are unchanged). `vs_category` + `class.category` were reserved null slots. (`eventTypeName` → `className` is an internal builder parameter name, not a payload field.)

The shared `src/lib/__fixtures__/session-report.fixture.json` (both repos) gains `class_name` + `category` on its session/history rows; the builder tests assert `vs_category` + the re-keyed `vs_this_class` + the null-category path.

### Surfaces

`vs_category` renders alongside `vs_this_class` on the surfaces Slice 1 already built — no new surfaces:
- **champ-app session view** (`src/app/sessions/[id]/page.jsx`) "How this compares": add a line rendered when `vs_category` is non-null, e.g. "Top 18% of your cardio classes" / "vs your typical cardio class — 270 pts avg."
- **un1t-crm post-class email** (`src/lib/hr-post-class-email.js`): add the matching line to the body via the existing report adapter; behaviour-preserving otherwise.
- **Report API** (`GET /api/sessions/[id]/report`, champ-app): no change — the slot just becomes non-null.

## In scope

- `class_categories` table + RLS (one migration).
- Settings → Class categories page + `GET`/`PUT /api/settings/class-categories` (manager+).
- `normalizeClassName` shared helper; loader category-attach in both repos.
- `buildSessionAnalytics`/`buildSessionReport` changes (re-key `vs_this_class` on class name; add `vs_category` + `session.class.category`), byte-identical in both repos + shared fixture.
- Render `vs_category` in the champ-app session view + the post-class email.

## Out of scope (deliberate)

- **Prefix/variant collapsing** in matching (each distinct seen name is tagged individually for v1).
- **Per-occurrence category override** (category is per class type/name, not per scheduled instance).
- **Auto-categorization** (heuristics / HR-profile inference).
- **A version bump / field rename** of the payload (kept at v1; `vs_this_class.event_type_name` field name retained).
- **Slice 3 (`next_action`) / Slice 4 (push + card)** — separate slices; their null slots stay null.

## Data flow

```
operator → Settings → Class categories → PUT /api/settings/class-categories → class_categories rows

member opens session report (champ-app) OR session-end email fires (un1t-crm)
   → loader: resolve className = class_name ?? booking.event_type.name; classKey = normalize(className)
   → loader: fetch class_categories for the location → map; attach class_key + category to thisSession + history
   → buildSessionReport(ctx): vs_this_class grouped by class_key, vs_category grouped by category, class.category set
   → rendered in the session view + email; returned by the report API
```

## Edge cases

- **Unmapped class** (no `class_categories` row) → `category` null → `vs_category` null; `vs_this_class` still works (keyed on name). Graceful, like Slice 1 awaiting data.
- **No class identity** (no `class_name`, no booking) → `class_key` null → both comparisons null. (Anonymous null-contact walk-in sessions don't get customer reports anyway.)
- **First session in a category / class** → small `sample_size` (0 or 1); renderers gate on it as they already do for `vs_this_class`.
- **Class-name variants** → tagged individually (v1); an untagged variant simply resolves to null category.
- **Name normalization drift** → the single `normalizeClassName` helper is used by the settings API (write key), the loaders (read key), and tests, so the write key and read key can't diverge.
- **Category later changed** by the operator → applies to all future report loads immediately (no backfill; the report is computed live from the mapping).

## Testing

- **Pure builder (the contract):** `vs_category` math (filter by category, mean, percentile, sample_size), re-keyed `vs_this_class` (a RIDE only matches RIDEs; a presence session no longer conflates classes), `session.class.category` set, null-category → `vs_category` null. Both repos run the shared fixture (extended with `class_name` + `category`).
- **`normalizeClassName`:** trim/case/whitespace cases.
- **Settings API:** manager+ gate + `assertLocationAccess`; `GET` returns seen names ∪ mappings; `PUT` upserts set categories + deletes cleared ones; validation (category enum).
- **Loaders:** category + `class_key` attached from the mapping; fallback `class_name ?? event_type.name`.
- **Renderers:** thin; covered by the builder tests + a render smoke check (champ-app view + email line).

## Rollout

- One migration (`class_categories`) applied to prod **before** merge (additive, RLS'd; advisor-checked).
- Ships as two PRs (un1t-crm: migration + settings UI/API + loaders/email + builder + fixture; champ-app: byte-identical builder + loader + view) or a coordinated pair. Both auto-deploy on merge.
- Behaviour-preserving where unmapped: until the operator tags classes, `vs_category` is null and `vs_this_class` keeps working (now correctly grouped). The net member-visible change appears once categories are tagged.

## Open questions

1. **Category set** — `cardio / strength / conditioning` assumed. Confirm, or adjust (e.g. add `recovery`/`mobility`). *Default: the three above.*
2. **Settings placement** — a dedicated `/settings/class-categories` page assumed (manager+). Alternative: fold into an existing studio/HR settings hub. *Default: dedicated page.*
3. **Email line** — show `vs_category` in the post-class email now, or in-app only for v2? *Default: include it in the email (parity with `vs_this_class`).*
