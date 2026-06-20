# Event-registration audience filter (2026-06)

**Status:** design — awaiting review
**Author:** Richard + Claude
**Scope:** add a "Registered for event" filter to the audience selector so operators can send to everyone signed up for a specific event, across every channel (email, SMS, WhatsApp, sequences) + the live audience count.

---

## 1. Goal / user story

> As an operator, I want to email (or SMS / WhatsApp) **everybody registered for a specific event** — e.g. "reminder: the nutrition workshop is this Saturday" — by adding an **event filter** in the audience selector.

"Event" = the **Events feature** (`race_events`): races, **workshops, seminars, open days, masterclasses**. Class `bookings` are explicitly out of scope.

---

## 2. Background — how the audience filter works today

- The audience filter is a **single-table query on `contacts`** (`src/lib/audience-filter.js`). No joins/embeds — a deliberate decision to avoid the PostgREST count-under-inner-join bug class (see CLAUDE.md).
- Real columns filter directly. **Virtual fields** that aren't `contacts` columns (today only `tag`) are resolved **async**: a pre-fetch turns them into a `contacts.id IN (…)` constraint, injected onto the query. See `resolveTagFilters()` + `applyAudienceFilterAsync()`.
- `applyAudienceFilter()` (sync) **skips** virtual fields (`if (fieldConfig.type === 'tag') continue`). So virtual fields only take effect on callers that use the **async** path.

**Async callers (virtual fields work):** email `sendCampaign` (`buildAudienceQueryAsync`), sequence audience checks (`contactMatchesSequenceAudience`, `segment-sync`), Contacts page search.
**Sync callers (virtual fields silently ignored today):** the live count route, SMS broadcasts (`buildSmsAudience`), WhatsApp broadcasts (`buildWhatsAppAudience`).

The "all channels" decision means we upgrade the sync callers — which **also** makes the existing `tag` filter work on SMS/WhatsApp/count for the first time.

---

## 3. Data model

| Table | Role |
|---|---|
| `race_events` | one row per event. `kind ∈ {race, workshop, seminar, open_day, masterclass}` (mig 122), location-scoped, has `name`, `race_date`, `slug`. |
| `race_registrations` | one per team per event. `contact_id` = the registrant (captain). `status ∈ {pending_payment, confirmed, cancelled, no_show}` (mig 084). |
| `team_members` | people on a team. `contact_id` set for the captain (always) and for any linked teammate; NULL for un-linked teammates. |

**Status lifecycle (mig 084, verified in code):**
- Paid signup → `pending_payment`, flips to `confirmed` on the Revolut webhook (`race-payments.js`).
- Free signup → `confirmed` immediately (`race-register-solo.js`).
- `cancelled` = operator removed; `no_show` = race day passed.
- The codebase already uses `status IN ('pending_payment','confirmed')` as the "live registration" predicate (capacity check at `events/[slug]/register/route.js`, `event-signups.test.js`).

---

## 4. Resolver semantics

**"Registered for event X" (op `eq`)** = the set of `contacts.id` where:

```
race_registrations.race_event_id = X
  AND race_registrations.status IN ('pending_payment', 'confirmed')
  → contact_id                                    (the registrant)
UNION
team_members.contact_id                            (linked teammates)
  for team_ids of those same live registrations
```

- ✅ `pending_payment` (signed up, not yet paid) — per Richard
- ✅ `confirmed` (paid, or free events) — per Richard
- ❌ `cancelled` — per Richard
- ❌ `no_show` — excluded (post-event; matches the existing "live registration" predicate). *Revisit if a post-event win-back email ever wants them.*
- NULL `contact_id`s are dropped (un-linked teammates have no contact row → unreachable anyway).

**"Not registered for event X" (op `neq`)** = `contacts.id NOT IN (the set above)`. A cancelled/no-show/never-registered contact therefore counts as "not registered".

**Empty set** (event has zero live registrations): `eq` → unsatisfiable predicate → count 0 (mirrors the tag zero-intersection guard). `neq` → no constraint (everyone qualifies).

**Location scoping:** the chosen event id is itself location-bound, and the registration lookup is scoped to it, so results never cross locations. The base contacts query already pins `location_id`.

---

## 5. Design

### 5.1 `src/lib/audience-filter.js`

- **Whitelist:** add to `AUDIENCE_FIELDS`:
  ```js
  event_registration: { type: 'event', ops: ['eq', 'neq'] },
  ```
  `applyAudienceFilter()` gets a `if (fieldConfig.type === 'event') continue` so the sync path skips it (same as `tag`).

- **New `resolveEventFilters({ db, query, filter, locationId })`** — mirrors `resolveTagFilters` exactly:
  - For each `event_registration` clause, look up the live-registration contact-id set (§4).
  - `eq` clauses **intersect** (AND); empty intersection → unsatisfiable (`query.eq('id', ZERO_UUID)`).
  - `neq` clauses → `query.not('id', 'in', '(…)')`.
  - Returns the wrapped `{ query }` (the thenable-unwrap guard, same as `resolveTagFilters`).
  - Looks up via two cheap reads scoped by `race_event_id`: `race_registrations` (status-filtered) then `team_members` by the resulting `team_id`s. `>1k`-safe paging on both reads (CLAUDE.md convention) since a popular event can exceed 1k.

- **`applyAudienceFilterAsync`** chains the resolvers: `resolveTagFilters → resolveEventFilters → applyAudienceFilter`. **Callers that already use this async helper get events for free** (email `sendCampaign`, sequence checks, Contacts search). The count + SMS callers get it once §5.2 points them at the async path.

- **`resolveAudienceIds({ db, filter, locationId })`** (new, for paging) — computes the combined virtual-field constraint **once** and returns `{ unsatisfiable, includeIds|null, excludeIds[] }`, plus a sync `applyResolvedAudienceIds(query, resolved)`. Used by the WhatsApp paged path so it doesn't re-resolve per page. (Factoring: `resolveTagFilters`/`resolveEventFilters` and this share one id-computation helper — exact shape left to the plan.)

### 5.2 Channel wiring

| File | Change |
|---|---|
| `src/app/api/communications/audience-count/route.js` | Switch `applyAudienceFilter` → `applyAudienceFilterAsync` (await + destructure `{ query }`). Fixes the count for events **and** the existing tag blind spot. |
| `src/lib/postmark.js` | No change — `sendCampaign` already uses `buildAudienceQueryAsync`. |
| `src/lib/sequences/*` | No change — already async. |
| `src/lib/sms.js` | Add `buildSmsAudienceAsync` (resolves virtual fields); `sendBroadcast` calls it (single-shot await — returns `{data,error}` via the double-unwrap). Keep sync `buildSmsAudience` for back-compat or delete if unused. |
| `src/lib/whatsapp.js` | `sendBroadcast` (single-shot) → async builder. `fetchAllWhatsAppAudience` (paged) → resolve virtual ids **once** via `resolveAudienceIds`, then per-page rebuild applies the id-constraint + scalar filters via the sync applier (keeps `.order().range()` paging intact, no per-page re-resolve). |

### 5.3 UI — `src/components/AudienceBuilder.jsx`

- New field option:
  ```js
  { value: 'event_registration', label: 'Registered for event', type: 'event-select' }
  ```
- New `OPS_BY_TYPE['event-select']`: `eq → 'registered for'`, `neq → 'not registered for'`.
- Lazy-load event options when an `event_registration` row is present (same pattern as `tag-select`/`plan-select`): `GET /api/communications/events` → render `name — kind — date` in a dropdown whose value is the event id.

### 5.4 New endpoint — `GET /api/communications/events`

- Returns `{ success, data: [{ id, name, kind, race_date, registration_count }] }` for the operator's **active location**, all kinds, most-recent first.
- Manager+ gated; master + no active location → aggregate (mirrors `/api/segments` scoping exactly).
- `registration_count` = live registrations (`status IN ('pending_payment','confirmed')`) so the dropdown shows "Nutrition Seminar — seminar — 2026-06-28 (23)".

---

## 6. Testing

- `audience-filter.test.js`: `event_registration` whitelisted; bad op rejected; sync `applyAudienceFilter` skips it.
- `resolveEventFilters` units: eq → IN(registrants ∪ linked teammates); excludes cancelled + no_show; multiple eq intersect; neq → NOT IN; empty event → unsatisfiable.
- Count route honours an event filter (and a tag filter — regression catch).
- SMS + WhatsApp async builders apply the event constraint; WhatsApp paged path resolves once.
- Endpoint test: active-location scoping + manager gate + count shape.

---

## 7. Out of scope / notes

- Class `bookings` (Richard's call — Events feature only).
- **No migration** — pure read-side. **No new permission** — reuses the communications/campaign surface.
- Touching the SMS/WhatsApp send libs → run the **full CI mirror + a real `next build`** before pushing (import-resolution + Turbopack gate).
- Bonus: upgrading the sync callers fixes the existing `tag` filter on SMS/WhatsApp/count.
- Latent (not fixed here): `buildSmsAudience` awaits a single page (1k PostgREST cap) — pre-existing, separate concern.

---

## 8. File change list

**New:** `src/app/api/communications/events/route.js`, its `route.test.js`.
**Edited:** `src/lib/audience-filter.js` (+test), `src/lib/sms.js`, `src/lib/whatsapp.js`, `src/app/api/communications/audience-count/route.js`, `src/components/AudienceBuilder.jsx`.
**Docs:** register the new route in `src/lib/openapi.js`.
