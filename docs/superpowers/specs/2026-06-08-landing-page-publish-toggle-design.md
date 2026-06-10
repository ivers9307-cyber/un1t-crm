# Landing-page publish toggle — design

**Date:** 2026-06-08
**Status:** Approved (design) — pending spec review → implementation plan
**Author:** Claude (brainstormed with Richard)

## Problem

Turning a public studio/marketing page on or off (e.g. the Hatch Street launch)
currently requires editing code and live data in **three** disconnected places:

1. `DISABLED_TILE_PATHS` — a hardcoded `Set` in `src/app/welcome/page.js` that
   dims the chooser tile. Code edit + deploy.
2. The `un1t-marketing` `allowedPaths` allowlist in `src/lib/brands.js` — controls
   whether the pretty/direct URL (`un1tdublin.com/hatch-street`) resolves vs.
   bounces to the chooser. Code edit + deploy.
3. The `landing_page_settings.chooser_label` / `chooser_cta_text` copy — edited by
   hand (SQL or the editor) and easy to leave stale (the Hatch Street tile shipped
   reading literally `"COMING SOON"` for both label and CTA).

There is **no operator toggle and no `published` flag** in the database. The
`landing_page_settings` table holds copy/image/order fields but nothing for
on/off state. An operator (master/owner) cannot turn a page on or off without an
engineer.

## Goals

- A master/owner can switch a studio page **Live / Coming soon / Hidden** from the
  existing Settings UI — no code edit, no SQL.
- The chooser tile **and** the page's direct URL both honour that one setting.
- Retire the `DISABLED_TILE_PATHS` code path entirely.
- Prevent the stale-"COMING SOON"-copy failure mode by rendering the coming-soon
  state automatically rather than via hand-typed label text.

## Non-goals

- Toggling arbitrary CRM/app pages. CRM module visibility is already handled by the
  per-location `features` JSONB gate (mig 032). This feature is scoped to the
  **public studio marketing pages** driven by `landing_page_settings`.
- A generic CMS/page registry. There are two marketing pages; a general system is
  YAGNI.
- Making the `brands.js` marketing allowlist fully DB-driven. The two current
  studios are already allowlisted, so toggling them is 100% UI. A brand-**new**
  future studio's *direct pretty path* still needs a one-line allowlist entry once
  (documented boundary below). Revisit dynamic allowlisting if/when a 3rd studio
  lands.

## Approach (chosen)

Add a single `publish_state` enum to `landing_page_settings`, surface a 3-way
control in the existing chooser editor (`ChooserEditorForm`), and have both the
chooser render and the per-studio page read it. Delete `DISABLED_TILE_PATHS`.

### Rejected alternatives

- **Reuse the per-location `features` JSONB gate (mig 032).** Wrong semantics — it
  gates CRM-module visibility for logged-in *staff* per location, and it's boolean
  (no "coming soon" tri-state). Conflating "staff can see module X" with "public
  page is live" is a category error.
- **Generic CMS `pages` table with publish states for any route.** Over-engineered
  for exactly two marketing pages. YAGNI.

## Data model

Migration **247** (`247_landing_page_publish_state.sql`):

```sql
ALTER TABLE public.landing_page_settings
  ADD COLUMN publish_state text NOT NULL DEFAULT 'hidden'
    CHECK (publish_state IN ('live', 'coming_soon', 'hidden'));

-- Backfill existing studios to their current real-world state.
UPDATE public.landing_page_settings
  SET publish_state = 'live'
  WHERE public_path IN ('stillorgan', 'hatch-street');

COMMENT ON COLUMN public.landing_page_settings.publish_state IS
  'Public visibility of this studio page. live = active+clickable tile + page renders; '
  'coming_soon = dimmed non-clickable teaser tile + page 404s; '
  'hidden = no tile + page 404s. Replaces the hardcoded DISABLED_TILE_PATHS set (UNLOCK-HATCH.1).';
```

- **Default `hidden`** so a newly-created studio page is never accidentally public
  before the operator publishes it.
- No RLS change needed — writes go through the service-role `PUT /api/chooser-settings`
  route (master/owner gated in app code, matching the existing chooser write path).

## Behaviour matrix

`publish_state` is the single source of truth.

| State | Chooser tile (`/welcome`) | Studio page (`/welcome/<path>`, `/<path>`) |
|---|---|---|
| `live` | active `<Link>`, clickable, CTA shown | renders normally |
| `coming_soon` | dimmed, non-clickable `<div>`, **auto "Coming soon" badge**, no CTA | `notFound()` (404) |
| `hidden` | omitted from `tiles` entirely | `notFound()` (404) |

Edit-mode preview (`?edit=1`) is **exempt** from the page-level 404 so operators can
preview an unpublished page from the editor before flipping it live.

## Components & changes

### 1. `src/app/welcome/page.js` (chooser)
- `loadFrontPage()` selects `publish_state` and surfaces it on each tile.
- Filter out `hidden` tiles before render.
- Tile render branches on state: `live` → `<Link>`; `coming_soon` → dimmed `<div>`
  (current disabled styling) **plus** an automatic "Coming soon" badge element.
- **Delete `DISABLED_TILE_PATHS`** and its lookup. The `disabled` boolean on each
  tile becomes `tile.publish_state !== 'live'`.

### 2. `src/app/welcome/[location]/page.js` (studio page)
- After `loadByPath(path)`, if `row.publish_state !== 'live'` **and** not in
  `?edit=1` preview → `notFound()`.
- `generateMetadata` returns the generic `{ title: 'UN1T Dublin' }` for a
  non-live page (don't leak a rich title/OG for an unpublished studio).

### 3. Pure helper `src/lib/landing-page-visibility.js` (new) + test
- `tileModeFor(publishState)` → `'active' | 'coming_soon' | 'hidden'` (defaults
  unknown/null → `'hidden'` defensively).
- `isPubliclyVisible(publishState)` → `publishState === 'live'` (used by the page
  gate).
- Unit-tested in `landing-page-visibility.test.js` (every branch + null/unknown
  input). Keeps the render/gate logic pure and DB-free, matching the repo's
  pure-helper convention.

### 4. `src/app/api/chooser-settings/route.js` (PUT)
- Extend the per-tile payload schema to accept `publish_state` (Zod enum
  `['live','coming_soon','hidden']`).
- Persist `publish_state` alongside `chooser_label` / `chooser_cta_text` in the
  per-tile update. Auth unchanged (`canEdit` = master/owner).
- The GET/load path that seeds the editor returns `publish_state` per tile.

### 5. `src/components/ChooserEditorForm.jsx` (editor UI)
- Add a 3-way segmented control (Live / Coming soon / Hidden) to each tile card,
  next to the label/CTA fields. State held in the existing `tiles` array via
  `patchTile(locationId, { publish_state })`.
- Include `publish_state` in the `PUT /api/chooser-settings` body.
- Helper hint under the control: "Coming soon = dimmed teaser tile, page not
  reachable. Hidden = removed from the front page." So the operator understands
  each state without guessing.

### 6. `src/lib/brands.js` (no functional change)
- Leave `/stillorgan` + `/hatch-street` in `allowedPaths`. The page-level
  `publish_state` gate (404 when not live) is what closes the direct URL when off,
  so the allowlist entry can stay regardless of state. **Documented boundary:** a
  brand-new future studio's direct pretty path needs one allowlist line added once;
  the chooser-tile route `/welcome/<path>` needs no change (`/welcome` is already
  allowlisted).

## Permissions

Unchanged. `publish_state` is edited through the same `PUT /api/chooser-settings`
route and `/settings/landing-page` page, both gated to **master OR owner**
(`canEdit` in the route; `hasPermission(user, 'landing_page')` on the page). No new
permission key, so no `WEB_PERMISSIONS` / mobile-parity change.

## Testing

- `landing-page-visibility.test.js` — `tileModeFor` + `isPubliclyVisible` across
  all three states + null/unknown input.
- Extend the chooser-settings route test (if present) to assert `publish_state`
  validates (rejects values outside the enum) and round-trips.
- Manual verification post-deploy (per the Hatch Street unlock pattern): toggle a
  page to each state in the editor and confirm (a) chooser tile appearance and (b)
  direct-URL behaviour (200 vs 404) for each.

## Migration / rollout

1. Ship migration 247 (adds column, backfills both studios to `live`).
2. Ship the code (render reads `publish_state`, page gate, editor control, route
   validation, delete `DISABLED_TILE_PATHS`).
3. Because the backfill sets both live studios to `live`, **behaviour is identical
   on deploy** — no visible change until an operator uses the new control.
4. CI mirror before push: `npm test && npm run lint && npm run check:mobile-parity
   && npm run check:mobile-imports`, plus `npm run build` (this change is logic-only
   with no new cross-module imports, but the migration + new lib file warrant a
   build check). Branch → PR → merge (Vercel auto-deploys `main`).

## Files touched

| File | Change |
|---|---|
| `supabase/migrations/247_landing_page_publish_state.sql` | new — column + backfill |
| `src/lib/landing-page-visibility.js` | new — pure helpers |
| `src/lib/landing-page-visibility.test.js` | new — unit tests |
| `src/app/welcome/page.js` | read `publish_state`; filter hidden; coming-soon badge; **delete `DISABLED_TILE_PATHS`** |
| `src/app/welcome/[location]/page.js` | `notFound()` when not live (preview exempt); guard metadata |
| `src/app/api/chooser-settings/route.js` | validate + persist `publish_state` per tile; return it on load |
| `src/components/ChooserEditorForm.jsx` | 3-way Live/Coming soon/Hidden control per tile |

## Open questions

None outstanding. Decisions locked during brainstorming:
- 3-way state (Live / Coming soon / Hidden). ✓
- Default `hidden` for new pages. ✓
- Auto "Coming soon" badge instead of hand-typed label. ✓
- New-studio pretty path left as a documented one-line `brands.js` boundary. ✓
- Permission: master/owner (inherited from existing chooser editor). ✓
