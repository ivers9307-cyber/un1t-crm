# Crossover contacts in the studio contacts list — design

**Date:** 2026-06-08
**Status:** Approved (design) — pending spec review → implementation plan
**Author:** Claude (brainstormed with Richard)

## Problem

`contacts.email` is **globally unique** (`contacts_email_unique` on `(email) WHERE email IS NOT NULL`) — one email = exactly one contact, owned by one studio (`contacts.location_id`). When someone who is already a contact at one studio signs up via another studio's public lead form (e.g. an existing **Stillorgan** member joins the **Hatch Street** founding-member waitlist), the form helper (`findOrCreateRaceContact`) reuses the existing contact and attaches the new lead as a **deal + tag** at the new studio. Result: the lead shows in the new studio's **pipeline** (the deal) but **not** its **contacts list** (the contact is still owned by the original studio).

Operators want these "crossover" leads visible in the destination studio's contacts list, **with their origin-studio context** (which studio owns them + how that studio has tagged them), so the team can see "this is a Stillorgan member who's now a Hatch lead."

## Decisions locked (brainstorming)

- **Crossover rule:** a contact appears in a studio's contacts list if it has **any deal (any status) at that studio** — "any Hatch deal ever" — in addition to contacts the studio owns.
- **Show the origin context:** crossover rows display the **home-studio name** + that contact's **tags**.
- **In the list, not a separate tab:** crossovers are mixed into the contacts list, distinguished by a badge (not a second surface).
- **Tags shown on crossover rows only** (not on every contact), to keep the payload small and the signal focused.

## Goals

- A studio's contacts list = contacts it **owns** ∪ contacts with **any deal at it**.
- Crossover rows are clearly marked (home-studio pill) and show that contact's tags.
- No change to the per-location data model or RLS (the list is already service-role + app-filtered).

## Non-goals

- Changing the global-unique-email model / allowing the same person as two contacts.
- Gating or changing the contact **detail** page — it already loads any contact by id with no location check, so clicking a crossover already works. (The broader "any authed user can open any contact by id" is a **pre-existing** concern flagged separately; out of scope here.)
- Showing tags for non-crossover (owned) contacts.
- Re-scoping the status/stage filter per-studio (see trade-offs).

## Architecture

The contacts list is rendered two ways, both **service-role** (`createServerClient`, RLS-bypassing) and **app-filtered** by `.eq('location_id', activeLocation)`:

1. `src/app/contacts/page.js` — initial server render (no advanced filter).
2. `src/app/api/contacts/search/route.js` — client path once an advanced filter/search is applied.

Both must change identically (the repo already requires `CONTACT_LIST_FIELDS` to stay in lock-step across them). The change is a **query union** + a **crossover-context fetch**, behind a shared helper so the two paths can't drift.

```
active studio L:
  ownedContacts   = contacts WHERE location_id = L
  crossoverIds    = SELECT DISTINCT contact_id FROM deals WHERE location_id = L
  listContacts    = contacts WHERE location_id = L OR id IN (crossoverIds)   (+ existing status/search filters)
  crossoverCtx    = for each listContact with location_id != L:
                      { homeStudio: locations.name, tags: contact_tags.tag[] }
  → ContactsView(initialContacts, crossoverCtx, activeLocationId)
```

## Components

### 1. Shared helper — `src/lib/contact-crossovers.js` (new) + test
Keeps the two list paths identical. Exposes pure + IO helpers:
- `markCrossovers(contacts, activeLocationId)` — **pure**: returns the contacts with an added `is_crossover` boolean (`c.location_id && c.location_id !== activeLocationId`). Unit-tested.
- `fetchCrossoverContext(db, contacts, activeLocationId)` — IO: for the crossover contacts, returns `{ [contactId]: { homeStudio, tags } }` (one query for `locations` names, one for `contact_tags` where `removed_at IS NULL`). Returns `{}` when there are none.
- `crossoverContactIds(db, locationId)` — IO: `SELECT DISTINCT contact_id FROM deals WHERE location_id = L` (paginated per the repo's >1k-row rule), returns a string[]. Used to build the union filter.

### 2. `src/app/contacts/page.js`
- Add `location_id` to `CONTACT_LIST_FIELDS`.
- Build the union: get `crossoverContactIds(db, locationId)`, then filter
  `query.or(`location_id.eq.${locationId},id.in.(${ids.join(',')})`)` instead of `.eq('location_id', …)`. When there are no crossover ids, keep the plain `.eq` (avoid an empty `in.()`).
- After the list loads, `markCrossovers(...)` + `fetchCrossoverContext(...)`; pass `crossoverContext` + `activeLocationId` to `<ContactsView>`.
- Status + search filters apply unchanged (they ride on the same query).

### 3. `src/app/api/contacts/search/route.js`
- Mirror exactly: add `location_id` to its `CONTACT_LIST_FIELDS`, swap `.eq('location_id', …)` for the same union on **both** `listQuery` and `countQuery`, and return `crossoverContext` in the response so the client path renders crossovers identically.

### 4. `src/components/ContactsView.jsx` / `ContactsTable.jsx`
- Accept `crossoverContext` + `activeLocationId`.
- A row where `is_crossover` (or `contact.location_id !== activeLocationId`) renders:
  - a **home-studio pill** next to the name (e.g. `Stillorgan`), using `crossoverContext[id].homeStudio`;
  - the contact's **tags** as small chips, from `crossoverContext[id].tags`.
- Owned rows are unchanged. Clicking any row opens `/contacts/[id]` (already works for crossovers).

## Data flow / correctness

- **No double-counting:** the `OR` naturally de-dupes (an owned contact with an owned deal matches `location_id.eq`; it isn't a crossover).
- **Crossover detection** is by `location_id` comparison, so it's robust even though tags/home-studio are only fetched for the crossover subset.
- **Bounded:** `crossoverContactIds` is deals at a single studio — small in practice; still paginated to respect the 1k-row PostgREST cap.

## Trade-offs (explicit)

- **Status/stage filter** filters the contact's *global* `pipeline_stage_slug`. For a crossover that reflects their home-studio status, not their deal stage at this studio. Acceptable for v1; documented so it isn't mistaken for a bug.
- **"Any deal ever"** surfaces closed/won/lost-deal crossovers too (past leads/members), per the chosen rule.
- The `id.in.(…)` filter can get long if a studio has very many crossover deals; if it ever approaches URL limits, switch that path to a SQL view/RPC. Not expected at current scale.

## Error handling

- `crossoverContactIds` / `fetchCrossoverContext` are best-effort: on failure they return `[]` / `{}` and the list falls back to owned-only (never 500s the contacts page).
- Empty crossover set → plain `.eq('location_id')` query (no malformed `in.()`).

## Testing

- `contact-crossovers.test.js` — `markCrossovers` (owned vs crossover vs null location_id; same-id de-dupe), and the shaping of `fetchCrossoverContext`'s return given stub rows.
- Build + manual: on the Hatch list, confirm an existing Stillorgan member with a Hatch deal appears with a `Stillorgan` pill + their tags; an owned Hatch contact appears unchanged; clicking a crossover opens their profile.

## Files touched

| File | Change |
|---|---|
| `src/lib/contact-crossovers.js` + `.test.js` | new — pure `markCrossovers` + IO `crossoverContactIds` / `fetchCrossoverContext` |
| `src/app/contacts/page.js` | union query + `location_id` field + crossover context → ContactsView |
| `src/app/api/contacts/search/route.js` | mirror the union on list + count; return `crossoverContext` |
| `src/components/ContactsView.jsx` | thread `crossoverContext` / `activeLocationId` |
| `src/components/ContactsTable.jsx` | home-studio pill + tag chips on crossover rows |

No migration (reuses `contacts` / `deals` / `contact_tags` / `locations`).

## Open questions

None outstanding. Locked: crossover rule = any deal ever at the studio; show home-studio pill + tags; mixed into the list; tags on crossover rows only. Implementation detail to confirm in the plan (not a blocker): exact `ContactsTable` row markup for the pill + chips.
