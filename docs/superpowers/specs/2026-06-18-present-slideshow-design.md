# PRESENT — laptop-driven, multi-screen synced slideshow

**Status:** approved design, 2026-06-18
**Working name:** Present (feature key `presentations`)
**Driver:** Richard is running a workshop the weekend of 2026-06-20/21 and needs to run a
slide deck from a laptop onto multiple TVs/screens, advancing slides from the laptop with
every screen following in near-real-time.

## Summary

A standalone CRM feature for running a slide deck across many screens, driven from one
laptop. Slides are uploaded **as images** (the presenter exports PowerPoint → JPEG/PNG).
Each screen opens a **public viewer link**; the presenter opens a **remote** on their
laptop and clicks next/prev (or arrow keys) — every viewer advances within ~1 second.

It is deliberately **independent of the registered TV displays** (`tv_displays` / `/tv/cast`):
the viewer link works in any browser, on any screen, with no device registration. It reuses
the *patterns* of the TV-cast system (public token route, polling, public storage bucket) but
not its tables.

## Decisions locked in brainstorming

- **Standalone present-link**, not tied to `tv_displays`. (User chose this over riding the
  existing cast plumbing and over an off-the-shelf tool like PowerPoint Live.)
- **Slides are uploaded as images** — no `.pptx`/PDF conversion, no `pdf.js`. The viewer is a
  dumb `<img>` shower. Most bulletproof for a hard deadline.
- **Sync = 1-second poll** (not Supabase Realtime). Matches the existing cast pattern, dead
  simple, reliable; "feels instant" for a slideshow. Realtime is an easy later upgrade.
- **New `presentations` web-only permission** (not reusing `tv_displays`) for a clean,
  self-contained surface.

## Non-goals (v1)

`.pptx`/PDF auto-conversion · speaker notes / presenter-view annotations · audience phones /
follow-on-your-own-device · portrait rotation of the viewer · slide transitions or build
animations · embedded video in slides · analytics. Static slide images, presenter-advanced —
that is the whole of v1.

## Data model — migration 291 (next sequential)

**`presentations`** (the deck)

| column | type | notes |
|---|---|---|
| `id` | uuid pk default `gen_random_uuid()` | |
| `location_id` | uuid not null → `locations(id)` | tenant scope |
| `title` | text not null | |
| `view_token` | uuid not null unique default `gen_random_uuid()` | the public viewer URL key |
| `current_index` | int not null default 0 | the live slide pointer (0-based) |
| `version` | int not null default 0 | bumps on every advance — the viewer's change signal |
| `created_by` | uuid → `profiles(id)` | |
| `created_at` / `updated_at` | timestamptz default now() | |

**`presentation_slides`**

| column | type | notes |
|---|---|---|
| `id` | uuid pk default `gen_random_uuid()` | |
| `presentation_id` | uuid not null → `presentations(id)` **on delete cascade** | |
| `location_id` | uuid not null → `locations(id)` | **denormalised** from the parent at insert, for a clean single-table RLS policy (the `car_notes` precedent) |
| `position` | int not null | 0-based order; gapless not required, just monotonic |
| `image_path` | text not null | path within the `presentation-slides` bucket |
| `created_at` | timestamptz default now() | |

**Indexes:** `presentations(location_id)`, unique `presentations(view_token)`,
`presentation_slides(presentation_id, position)`.

**Storage:** new **public** bucket `presentation-slides` (mirrors the existing public
`tv-content` bucket). Slide images are served via public bucket URL, resolved server-side in
the viewer-state API (so the client never builds Supabase paths) — same as the TV content route.

**RLS** (defence-in-depth; API routes use the service-role client and are the real gate):
- `presentations` + `presentation_slides`: authenticated **read/write** scoped via
  `private.auth_is_in_location(location_id)` on each table — `presentation_slides` carries its
  own denormalised `location_id` (set from the parent at insert) so both tables use the same
  single-table policy. Enable RLS, no `USING (true)` policies.
- The public viewer never uses the authenticated client — it hits a service-role API keyed on
  `view_token`, exactly like `/api/public/tv/[token]/content`.
- Run `get_advisors type=security` after applying; fix any RLS/search_path/grant flags.

## API routes

All session routes follow the standard skeleton: `getCurrentUser()` → permission check
(`hasPermission(user, 'presentations')`) → `assertLocationAccess` → `validateBody` →
service-role client → `{ success, ... }` response. Register new routes in `src/lib/openapi.js`.

| Route | Method | Purpose |
|---|---|---|
| `/api/presentations` | GET | list decks at the active location |
| `/api/presentations` | POST | create a deck `{ location_id, title }` → returns row incl. `view_token` |
| `/api/presentations/[id]` | GET / DELETE | fetch one (with slides) / delete (cascade slides + storage) |
| `/api/presentations/[id]/slides` | POST | **multipart** upload of N images → store to bucket, insert slide rows appended after current max `position`, natural-sorted by filename. Mirrors `/api/admin/tv-displays/upload`. |
| `/api/presentations/[id]/slides/[slideId]` | DELETE | remove one slide (+ its storage object) |
| `/api/presentations/[id]/slides/reorder` | PUT | `{ order: [slideId, …] }` → rewrite `position` |
| `/api/presentations/[id]/advance` | POST | `{ index }` (clamped to `[0, slideCount-1]`) → set `current_index`, `version = version + 1`; returns new `{ current_index, version }` |
| `/api/public/presentations/[token]/state` | GET | **public, no auth** — resolve `view_token` → `{ success, title, current_index, version, slides: [resolvedUrl…] }`. Service-role client. `dynamic = 'force-dynamic'`, cache-busted. 404 on bad token. |

**Filename natural sort:** PowerPoint exports `Slide1.JPG … Slide10.JPG`; a lexicographic sort
puts `Slide10` before `Slide2`. Sort uploaded filenames with a numeric-aware comparator
(`localeCompare(b, undefined, { numeric: true })`) before assigning positions. Manual reorder
is the fallback when names don't sort cleanly.

## Surfaces (pages + components)

- **`/presentations`** — list decks (title, slide count, "Present" + "Edit" + copy-viewer-link)
  + "New presentation". Add a **`/presentations`** entry to `nav-items.js` (gym or studio
  section; gated by the `presentations` permission).
- **`/presentations/[id]`** — author/edit: multi-file **image uploader** (drag-drop or picker),
  slide grid with reorder (up/down or dnd) + delete, **Copy viewer link**, **Present** button.
- **`/presentations/[id]/present`** — **presenter remote** (client component, logged in):
  - Big **Prev / Next**; keyboard **← / → / Space** (next) / **Backspace** (prev); **Home/End**.
  - "Slide N / total", **current + next-slide thumbnails**, and a **jump grid** of all slides.
  - Each navigation `POST`s `/advance {index}`; optimistic local update, reconcile on response.
  - Polls `/state` itself too (so two presenters / a reload stay consistent).
- **`/present/[token]`** — **public viewer** (the screen/TV): fullscreen black stage (mirror
  `TVDisplay.jsx`'s fixed-inset black container), shows the current slide as a preloaded
  `<img>` with `object-fit: contain`. **Preload all slide images once** (hidden), then only
  toggle which is visible on `current_index` change — **no reload, no flash** on advance.
  Polls `/state` every **~1s**; swaps slide when `version` changes. Idle/empty deck → a simple
  "Waiting for the presenter" / UN1T mark screen.

## Sync contract

1. Presenter clicks Next → `POST /api/presentations/[id]/advance { index: current+1 }` →
   server clamps, sets `current_index`, `version++`.
2. Every viewer polls `GET /api/public/presentations/[token]/state` every ~1s. It already holds
   the full `slides[]` (loaded once on mount); when the returned `version` differs from the
   last seen, it shows `slides[current_index]`. Because images are preloaded, the swap is
   instant and network-free.
3. New slides added / reordered mid-session also bump `version` (advance is not the only
   writer) so viewers re-pull the slide list — keep `/state` returning the full list each poll
   (it's small: URLs + two ints), so a re-pull on version change refreshes order too.

**Latency:** ≤ ~1s presenter-click-to-screen. Acceptable for a slideshow; matches the existing
cast's poll-based model.

## Auth / public exposure

- **Authoring + remote**: behind CRM login, location-scoped, gated by a **new `presentations`
  permission**:
  - Add to `WEB_PERMISSIONS` in `shared/permissions.js` + a default in
    `DEFAULT_WEB_PERMISSIONS_BY_ROLE` for every role (suggest: on for owner/manager/head_coach,
    off for staff).
  - It's web-only → add `presentations` to `WEB_ONLY_OK` in `scripts/check-mobile-parity.mjs`
    with a reason ("desktop authoring + present surface; no mobile screen"). No mobile counterpart.
- **Viewer `/present/[token]`**: fully public (token = auth, like `/tv/cast/[token]` and
  `/deposit/[token]`). **Add `/present/` to BOTH** (known footgun — both are required):
  1. the **middleware** public-paths allowlist (`src/middleware.js` / `proxy.js`), and
  2. the **AppShell** `publicPaths` suppression list (`src/components/AppShell.jsx`),
  so the screen renders the bare slide with no login redirect and no CRM sidebar.
  `/api/public/presentations/...` is already covered by the existing `/api/public/` allowlist.
- The viewer route lives at top-level `src/app/present/[token]/` (its own segment, outside any
  auth-gated layout — same reasoning as `/deposit` living outside `/cars`).

## Testing

Pure-logic units (no DB) following the repo's vitest convention:
- **Natural-sort** of slide filenames (`Slide2` before `Slide10`; mixed/odd names fall back to
  stable order).
- **`clampIndex(index, count)`** for `/advance` (negative → 0; ≥count → count-1; empty deck → 0).
- **`nextVersion` / change-detection** predicate the viewer uses (show new slide iff version
  changed).
- Route-guard + openapi registration covered by the existing CI checks.

Manual verification (operator, before the workshop): create a deck, upload exported slide
images, open `/present/<token>` on a second screen, open the remote, advance — confirm the
screen follows within ~1s with no flash; test ← → + Space; test the jump grid; test a second
screen stays in sync.

## Build phasing (one weekend, one focused PR)

**PR1 — MVP (the whole thing):** migration + bucket + RLS → API routes (CRUD, upload, advance,
public state) → `/presentations` list + `/presentations/[id]` author (upload/reorder/delete +
copy link) → `/present/[token]` viewer (preload + soft-swap + 1s poll) → `/presentations/[id]/present`
remote (prev/next + keys + counter) → `presentations` permission + nav entry + public-path
wiring → unit tests. Fold the **jump grid** and **next-slide thumbnail** into the remote if time
allows; they're the only deferrable niceties and both are small.

**Later (not blocking the weekend):** Supabase Realtime for true-instant sync · PDF/`.pptx`
upload with client-side rasterisation · portrait rotation · speaker notes.

## Reuse / precedents in the codebase

- Public token + service-role read: `src/app/api/public/tv/[token]/content/route.js`.
- Fullscreen black viewer: `src/app/tv/cast/[token]/TVDisplay.jsx`.
- Public bucket + upload: `tv-content` bucket + `src/app/api/admin/tv-displays/upload/route.js`.
- Public page outside auth + dual allowlist gotcha: `/deposit/[token]` (middleware + AppShell).
- New permission flow: `shared/permissions.js` + `scripts/check-mobile-parity.mjs` `WEB_ONLY_OK`.
