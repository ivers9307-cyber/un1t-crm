# Landing-page Publish Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a master/owner switch a public studio page between **Live / Coming soon / Hidden** from the Settings → Landing Page editor, replacing the hardcoded `DISABLED_TILE_PATHS` code path.

**Architecture:** A single `publish_state` enum column on `landing_page_settings` is the source of truth. A pure helper (`src/lib/landing-page-visibility.js`) maps that state to tile-render-mode and page-reachability. The chooser render, the per-studio page gate, the chooser-settings API schema, and the editor UI all consume the helper. Migration 247 backfills both existing studios to `live`, so behaviour is identical on deploy.

**Tech Stack:** Next.js 16 (App Router, server components), React 19, Supabase (Postgres, service-role server client), Zod, Vitest, Tailwind (`un1t-*` tokens).

**Spec:** `docs/superpowers/specs/2026-06-08-landing-page-publish-toggle-design.md`

**Branch:** `landing-page-publish-toggle` (already created off `main`; the spec commit is the first commit).

---

## Testing approach (read first)

This repo's Vitest suite covers **pure lib helpers only** — there is no React-component or server-page test infrastructure (per `CLAUDE.md`). So:

- **Tasks 2 and 3** (the pure helper + the route's Zod schema) get real TDD — failing test first, then code.
- **Tasks 1, 4, 5, 6, 7** (migration, server pages, the React editor) are verified by `npm run build` + targeted manual checks against the running site, matching how the rest of this codebase verifies pages/components. Do **not** invent an RTL harness — follow the existing pattern.

Run the full CI mirror before the final push (Task 8):
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run build
```

---

## File Structure

| File | Responsibility | Create/Modify |
|---|---|---|
| `supabase/migrations/247_landing_page_publish_state.sql` | Add `publish_state` column + backfill | Create |
| `src/lib/landing-page-visibility.js` | Pure source of truth: states + tile-mode + reachability | Create |
| `src/lib/landing-page-visibility.test.js` | Unit tests for the helper | Create |
| `src/app/api/chooser-settings/route.js` | Validate (Zod enum) + persist + return `publish_state` | Modify |
| `src/app/api/chooser-settings/route.test.js` | Test the exported `TileSchema` accepts/rejects `publish_state` | Create |
| `src/app/settings/landing-page/page.js` | Seed `publish_state` into the editor's `initialTiles` | Modify |
| `src/components/ChooserEditorForm.jsx` | 3-way Live/Coming soon/Hidden control per tile + send in save | Modify |
| `src/app/welcome/page.js` | Read `publish_state`; filter hidden; coming-soon badge; **delete `DISABLED_TILE_PATHS`** | Modify |
| `src/app/welcome/[location]/page.js` | `notFound()` when not live (preview exempt); guard metadata | Modify |

---

## Task 1: Migration — add `publish_state`

**Files:**
- Create: `supabase/migrations/247_landing_page_publish_state.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- 247_landing_page_publish_state.sql
-- Operator-controlled publish state for public studio marketing pages.
-- Replaces the hardcoded DISABLED_TILE_PATHS set in src/app/welcome/page.js
-- (the Hatch Street unlock, UNLOCK-HATCH.1) with a single DB column the
-- Settings → Landing Page editor owns.

ALTER TABLE public.landing_page_settings
  ADD COLUMN IF NOT EXISTS publish_state text NOT NULL DEFAULT 'hidden'
    CHECK (publish_state IN ('live', 'coming_soon', 'hidden'));

-- Backfill the two existing studios to their current real-world state
-- (both are live as of the Hatch Street unlock). New rows default to
-- 'hidden' so a freshly-created studio page is never accidentally public.
UPDATE public.landing_page_settings
  SET publish_state = 'live'
  WHERE public_path IN ('stillorgan', 'hatch-street');

COMMENT ON COLUMN public.landing_page_settings.publish_state IS
  'Public visibility: live = active clickable tile + page renders; coming_soon = dimmed non-clickable teaser tile + page 404s; hidden = no tile + page 404s. Operator-set via /settings/landing-page. Replaces DISABLED_TILE_PATHS.';
```

- [ ] **Step 2: Apply the migration to the project**

Apply via the Supabase MCP `apply_migration` tool (project_id `iyvtbjjxdggiadzwwvdj`, name `247_landing_page_publish_state`) with the SQL above, OR paste into the Supabase SQL Editor. Migrations are forward-only.

This is backward-compatible (adds a defaulted column; the currently-deployed code ignores it), so it is safe to apply before the code merges.

- [ ] **Step 3: Verify the column + backfill**

Run via MCP `execute_sql` (project `iyvtbjjxdggiadzwwvdj`):
```sql
select public_path, publish_state from landing_page_settings order by public_path;
```
Expected: `hatch-street → live`, `stillorgan → live` (any other rows → `hidden`).

- [ ] **Step 4: Run the security advisor**

Run the Supabase MCP `get_advisors` tool (type=security) for project `iyvtbjjxdggiadzwwvdj`.
Expected: no NEW findings attributable to this column (it adds no table/view/RLS surface). If something unrelated is already flagged, leave it.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/247_landing_page_publish_state.sql
git commit -m "feat(mig 247): publish_state column on landing_page_settings

Live / coming_soon / hidden, default hidden, backfill both studios to live."
```

---

## Task 2: Pure visibility helper (TDD)

**Files:**
- Create: `src/lib/landing-page-visibility.js`
- Test: `src/lib/landing-page-visibility.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/landing-page-visibility.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { PUBLISH_STATES, tileModeFor, isPubliclyVisible } from './landing-page-visibility'

describe('landing-page visibility helpers', () => {
  it('lists exactly the three states in order', () => {
    expect(PUBLISH_STATES).toEqual(['live', 'coming_soon', 'hidden'])
  })

  it('tileModeFor maps each known state', () => {
    expect(tileModeFor('live')).toBe('active')
    expect(tileModeFor('coming_soon')).toBe('coming_soon')
    expect(tileModeFor('hidden')).toBe('hidden')
  })

  it('tileModeFor fails closed on unknown / null / undefined', () => {
    expect(tileModeFor(null)).toBe('hidden')
    expect(tileModeFor(undefined)).toBe('hidden')
    expect(tileModeFor('bogus')).toBe('hidden')
  })

  it('isPubliclyVisible is true only for live', () => {
    expect(isPubliclyVisible('live')).toBe(true)
    expect(isPubliclyVisible('coming_soon')).toBe(false)
    expect(isPubliclyVisible('hidden')).toBe(false)
    expect(isPubliclyVisible(null)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/landing-page-visibility.test.js`
Expected: FAIL — cannot resolve `./landing-page-visibility` (module not found).

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/landing-page-visibility.js`:
```js
// Pure helpers for public landing-page visibility (publish_state).
// Single source of truth for the three states + the render/gate mapping.
// Consumed by the chooser render (src/app/welcome/page.js), the studio-page
// gate (src/app/welcome/[location]/page.js), the chooser-settings API schema,
// and the editor UI (ChooserEditorForm).

export const PUBLISH_STATES = ['live', 'coming_soon', 'hidden']

// Map a publish_state to how its chooser tile should render.
// Unknown / null / off-list defaults to 'hidden' — fail closed so a
// misconfigured row never leaks as a live, clickable tile.
export function tileModeFor(state) {
  if (state === 'live') return 'active'
  if (state === 'coming_soon') return 'coming_soon'
  return 'hidden'
}

// True only when the page should be publicly reachable at its URL.
export function isPubliclyVisible(state) {
  return state === 'live'
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/landing-page-visibility.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/landing-page-visibility.js src/lib/landing-page-visibility.test.js
git commit -m "feat: landing-page visibility helper (publish_state → tile mode / reachability)"
```

---

## Task 3: chooser-settings API — accept + persist `publish_state` (TDD)

**Files:**
- Modify: `src/app/api/chooser-settings/route.js`
- Test: `src/app/api/chooser-settings/route.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/chooser-settings/route.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { TileSchema } from './route'

describe('chooser-settings TileSchema.publish_state', () => {
  const base = {
    location_id: '00000000-0000-0000-0000-000000000001',
    public_path: 'hatch-street',
  }

  it('accepts each valid publish_state', () => {
    for (const s of ['live', 'coming_soon', 'hidden']) {
      expect(() => TileSchema.parse({ ...base, publish_state: s })).not.toThrow()
    }
  })

  it('rejects an invalid publish_state', () => {
    expect(() => TileSchema.parse({ ...base, publish_state: 'bogus' })).toThrow()
  })

  it('allows publish_state to be omitted (back-compat)', () => {
    expect(() => TileSchema.parse({ ...base })).not.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/api/chooser-settings/route.test.js`
Expected: FAIL — `TileSchema` is not exported (import resolves to `undefined`, `.parse` throws), AND `.strict()` would reject the `publish_state` key once exported but not yet in the schema.

- [ ] **Step 3: Add the import + export the schema + add the field**

In `src/app/api/chooser-settings/route.js`:

(a) Add to the imports (after the `uuidLike` import line):
```js
import { PUBLISH_STATES } from '@/lib/landing-page-visibility'
```

(b) Change the `TileSchema` declaration from `const TileSchema = z.object({` to an **exported** schema and add the `publish_state` field. Replace the whole `TileSchema` block with:
```js
export const TileSchema = z.object({
  location_id:      uuidLike,
  public_path:      z.string().trim().min(1).max(120),
  chooser_label:    z.string().trim().max(200).nullable().optional(),
  chooser_cta_text: z.string().trim().max(60).nullable().optional(),
  publish_state:    z.enum(PUBLISH_STATES).optional(),
}).strict()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/api/chooser-settings/route.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Persist `publish_state` in the PUT update**

In the PUT handler's per-tile loop, replace the `.update(...)` call:
```js
    const { error } = await db.from('landing_page_settings')
      .update({ chooser_label: t.chooser_label ?? null, chooser_cta_text: t.chooser_cta_text ?? null })
      .eq('location_id', t.location_id)
```
with (only sets `publish_state` when the client sent it, so a partial payload never clobbers it):
```js
    const tilePatch = { chooser_label: t.chooser_label ?? null, chooser_cta_text: t.chooser_cta_text ?? null }
    if (t.publish_state) tilePatch.publish_state = t.publish_state
    const { error } = await db.from('landing_page_settings')
      .update(tilePatch)
      .eq('location_id', t.location_id)
```

- [ ] **Step 6: Return `publish_state` from GET so the editor seeds correctly**

In the GET handler, the `landing_page_settings` select string — add `publish_state`:
```js
      .select('location_id, public_path, chooser_label, chooser_cta_text, chooser_image_url, publish_state, locations:location_id ( name )')
```
and in the `tiles` map, add the field to each returned object:
```js
        publish_state: t.publish_state,
```

- [ ] **Step 7: Run the route test again + the whole suite**

Run: `npx vitest run src/app/api/chooser-settings/route.test.js && npm test`
Expected: route test PASS; full suite PASS (no regressions).

- [ ] **Step 8: Commit**

```bash
git add src/app/api/chooser-settings/route.js src/app/api/chooser-settings/route.test.js
git commit -m "feat(chooser-settings): validate + persist publish_state per tile"
```

---

## Task 4: Settings page — seed `publish_state` into the editor

**Files:**
- Modify: `src/app/settings/landing-page/page.js`

(No unit test — server page; verified by build in Task 8.)

- [ ] **Step 1: Add `publish_state` to the chooser-mode select**

In the `searchParams?.page === 'chooser'` branch, the `landing_page_settings` select — add `publish_state`:
```js
      db.from('landing_page_settings')
        .select('location_id, public_path, chooser_label, chooser_cta_text, chooser_image_url, publish_state, locations:location_id ( name )')
        .not('public_path', 'is', null),
```

- [ ] **Step 2: Pass `publish_state` through in the tile map**

In the same branch's `tiles` map, add the field to each tile object:
```js
    const tiles = (tilesRes.data || []).map((t) => ({
      location_id: t.location_id,
      public_path: t.public_path,
      name: t.locations?.name || t.public_path,
      chooser_label: t.chooser_label,
      chooser_cta_text: t.chooser_cta_text,
      chooser_image_url: t.chooser_image_url,
      publish_state: t.publish_state,
    }))
```

- [ ] **Step 3: Commit**

```bash
git add src/app/settings/landing-page/page.js
git commit -m "feat(landing-page settings): seed publish_state into the chooser editor"
```

---

## Task 5: ChooserEditorForm — 3-way Live/Coming soon/Hidden control

**Files:**
- Modify: `src/components/ChooserEditorForm.jsx`

(No unit test — React component; verified by build + manual toggle in Task 8.)

- [ ] **Step 1: Send `publish_state` in the save payload**

In `handleSave`, the `tiles:` array inside the PUT body — add `publish_state` to each mapped tile:
```js
          tiles: tiles.map((t) => ({
            location_id: t.location_id,
            public_path: t.public_path,
            chooser_label: (t.chooser_label || '').trim() || null,
            chooser_cta_text: (t.chooser_cta_text || '').trim() || null,
            publish_state: t.publish_state || 'hidden',
          })),
```

- [ ] **Step 2: Add the 3-way control to each tile card**

Inside the tile card `<div>` (the one keyed `t.location_id`), insert this block **immediately after** the header row `<div className="flex items-start justify-between gap-3 mb-3">…</div>` (the block containing the name + up/down arrows) and **before** the `<div className="grid sm:grid-cols-2 gap-3">` label/CTA grid:
```jsx
            {/* Visibility — Live / Coming soon / Hidden (publish_state). */}
            <div className="mb-3">
              <label className="block text-xs text-un1t-subtle mb-1">Visibility</label>
              <div className="inline-flex rounded-md border border-un1t-border overflow-hidden">
                {[
                  { v: 'live', label: 'Live' },
                  { v: 'coming_soon', label: 'Coming soon' },
                  { v: 'hidden', label: 'Hidden' },
                ].map((opt) => {
                  const active = (t.publish_state || 'hidden') === opt.v
                  return (
                    <button
                      key={opt.v}
                      type="button"
                      onClick={() => patchTile(t.location_id, { publish_state: opt.v })}
                      className={`px-3 py-1.5 text-xs font-medium border-r border-un1t-border last:border-r-0 ${active ? 'bg-un1t-text text-un1t-bg' : 'bg-un1t-bg text-un1t-subtle hover:text-un1t-text'}`}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>
              <p className="text-[11px] text-un1t-muted mt-1">
                Live = clickable tile + page reachable. Coming soon = dimmed teaser tile, page not reachable. Hidden = removed from the front page.
              </p>
            </div>
```
Note: every `<button>` is `type="button"` — without it, clicking would submit the form (a known repo gotcha).

- [ ] **Step 3: Lint the file**

Run: `npx eslint src/components/ChooserEditorForm.jsx`
Expected: clean (the pre-existing line-179 `no-img-element` disable warning is unrelated and may remain).

- [ ] **Step 4: Commit**

```bash
git add src/components/ChooserEditorForm.jsx
git commit -m "feat(chooser editor): 3-way Live/Coming soon/Hidden visibility control per tile"
```

---

## Task 6: Chooser render — read `publish_state`, delete `DISABLED_TILE_PATHS`

**Files:**
- Modify: `src/app/welcome/page.js`

(No unit test — server page; the mapping logic lives in the Task-2 helper which IS tested. Verified by build + manual in Task 8.)

- [ ] **Step 1: Import the helper**

Add after the existing import of `EditModeOverlay`:
```js
import { tileModeFor } from '@/lib/landing-page-visibility'
```

- [ ] **Step 2: Delete the `DISABLED_TILE_PATHS` block**

Remove the entire block — the `// ─── Temporarily disabled tiles ───…` comment through the `const DISABLED_TILE_PATHS = new Set([])` declaration (the comment + the `new Set([])`). Leave `TILE_ORDER` intact.

- [ ] **Step 3: Add `publish_state` to the `loadFrontPage` select**

In `loadFrontPage`, the `landing_page_settings` select — add `publish_state`:
```js
      db.from('landing_page_settings')
        .select('public_path, chooser_label, chooser_cta_text, chooser_image_url, blocks, publish_state, locations:location_id ( name )')
        .not('public_path', 'is', null),
```

- [ ] **Step 4: Derive tile mode from `publish_state` and drop hidden tiles**

Replace the `const tiles = order.map(...)...` chain with:
```js
    const tiles = order
      .map((path) => byPath.get(path))
      .filter(Boolean)
      .map((r) => {
        const hero = blocksOrDefault(r.blocks).find((b) => b.type === 'hero')
        const mode = tileModeFor(r.publish_state)   // 'active' | 'coming_soon' | 'hidden'
        return {
          path: r.public_path,
          // Operator label wins over the location name; fall back to path.
          name: (r.chooser_label && r.chooser_label.trim())
            || r.locations?.name
            || r.public_path,
          cta: (r.chooser_cta_text && r.chooser_cta_text.trim()) || 'Enter',
          cover: r.chooser_image_url || hero?.image_url || null,
          mode,
          // coming_soon tiles render dimmed + non-clickable (the old
          // DISABLED_TILE_PATHS behaviour); hidden tiles are removed below.
          disabled: mode === 'coming_soon',
        }
      })
      .filter((t) => t.mode !== 'hidden')
```

- [ ] **Step 5: Add the auto "Coming soon" badge in `TileBody`**

In `TileBody`, inside `<div className="relative z-10 text-center px-6">`, insert the badge **between** the `UN1T Dublin` eyebrow `<div>` and the `<h2>`:
```jsx
        <div className="text-[11px] uppercase tracking-[0.3em] text-white/60 mb-3">UN1T Dublin</div>
        {s.disabled && (
          <div className="mb-3 inline-block rounded-full border border-white/40 px-3 py-1 text-[10px] uppercase tracking-[0.25em] text-white/80">
            Coming soon
          </div>
        )}
        <h2 className={`text-3xl md:text-5xl font-extrabold tracking-tight ${s.disabled ? 'text-white/70' : ''}`}>{s.name}</h2>
```
(The render loop below — `s.disabled ? <div> : <Link>` — is unchanged; hidden tiles never reach it because they're filtered out.)

- [ ] **Step 6: Commit**

```bash
git add src/app/welcome/page.js
git commit -m "feat(chooser): drive tiles off publish_state; auto coming-soon badge; remove DISABLED_TILE_PATHS"
```

---

## Task 7: Studio page — gate non-live with `notFound()`

**Files:**
- Modify: `src/app/welcome/[location]/page.js`

(No unit test — server page; reachability logic is the Task-2 helper, which IS tested. Verified by build + manual in Task 8.)

- [ ] **Step 1: Import the helper**

Add after the `EditModeOverlay` import:
```js
import { isPubliclyVisible } from '@/lib/landing-page-visibility'
```

- [ ] **Step 2: Gate the page render**

In `StudioLandingPage`, immediately after `const row = await loadByPath(params.location)` / `if (!row) notFound()`, add (the `?edit=1` preview stays exempt so operators can preview an unpublished page):
```js
  // Public reachability gate. A page that isn't 'live' 404s for the public,
  // but the editor's live-preview iframe (?edit=1) still renders so the
  // operator can preview before publishing.
  const isEditPreview = searchParams?.edit === '1'
  if (!isEditPreview && !isPubliclyVisible(row.publish_state)) notFound()
```

- [ ] **Step 3: Guard the metadata for non-live pages**

In `generateMetadata`, change the early-return so an unpublished page doesn't leak a rich title/OG. Replace `if (!row) return { title: 'UN1T Dublin' }` with:
```js
  if (!row || !isPubliclyVisible(row.publish_state)) return { title: 'UN1T Dublin' }
```

- [ ] **Step 4: Commit**

```bash
git add 'src/app/welcome/[location]/page.js'
git commit -m "feat(studio page): 404 when publish_state is not live (editor preview exempt)"
```

---

## Task 8: Full verification, build, ship

**Files:** none (verification + PR).

- [ ] **Step 1: Run the full CI mirror + production build**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run build
```
Expected: tests PASS (includes the 2 new test files), lint clean (the pre-existing `ChooserEditorForm` line-179 warning may remain), parity + imports clean, `next build` succeeds. The build is the gate that catches the new `@/lib/landing-page-visibility` import resolving correctly across the three consumers.

- [ ] **Step 2: Manual verification via the editor (local `npm run dev` or a Vercel preview)**

Sign in as master/owner → **Settings → Landing Page → Front page**. For the Hatch Street tile, exercise each state and confirm:

| Set state | `un1tdublin.com` chooser | `…/hatch-street` (direct) | `…/welcome/hatch-street` |
|---|---|---|---|
| **Live** | clickable tile, CTA shown | renders the page (200) | renders (200) |
| **Coming soon** | dimmed tile + "Coming soon" badge, no button | 404 | 404 |
| **Hidden** | no Hatch tile at all | 404 | 404 |

Also confirm the editor's **Preview** (`?edit=1`) still renders the studio page even when it's set to Coming soon / Hidden.

> Local note: the apex-host brand routing keys off the `Host` header. To exercise `/hatch-street` + the chooser locally, set `MARKETING_HOSTNAMES=localhost` in `.env.local` (or test on a Vercel preview by temporarily pointing `MARKETING_HOSTNAMES` at the preview host). Revert any local env change before finishing. The `/welcome/*` paths work without this.

Finish with the Hatch Street tile back on **Live** (its production state).

- [ ] **Step 3: Push the branch**

```bash
git push -u origin landing-page-publish-toggle
```

- [ ] **Step 4: Open the PR** (per `CLAUDE.md` ship loop — token from the remote URL)

```bash
TOKEN=$(git config --get remote.origin.url | sed -E 's|.*x-access-token:([^@]+)@.*|\1|')
curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/ivers9307-cyber/un1t-crm/pulls \
  -d @- <<'JSON' | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('html_url') or r.get('message') or r)"
{
  "title": "LANDING-TOGGLE.1 — operator on/off toggle for public studio pages",
  "head": "landing-page-publish-toggle",
  "base": "main",
  "body": "Adds a Live / Coming soon / Hidden control per studio tile in Settings → Landing Page, backed by `landing_page_settings.publish_state` (mig 247, both studios backfilled to `live`). Chooser render + studio-page reachability both gate on it; `DISABLED_TILE_PATHS` is removed. Master/owner only (unchanged). Spec + plan under `docs/superpowers/`.\n\nVerified: tests (incl. 2 new files) · lint · parity · imports · build · manual toggle of each state.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"
}
JSON
```
Report the returned PR URL. Migration 247 was already applied in Task 1, so merging this PR (Vercel auto-deploys `main`) is safe and produces no visible change until an operator uses the new control.

---

## Self-Review (completed by plan author)

**1. Spec coverage** — every spec section maps to a task:
- Data model / mig 247 + default hidden + backfill → Task 1.
- Behaviour matrix (live/coming_soon/hidden → tile + URL) → helper Task 2; chooser Task 6; page gate Task 7.
- Editor 3-way control → Task 5; API persist/validate → Task 3; seed → Task 4.
- Auto "Coming soon" badge → Task 6 Step 5.
- Delete `DISABLED_TILE_PATHS` → Task 6 Step 2.
- Permissions unchanged (master/owner) → no permission task needed; `canEdit` untouched in Task 3.
- `brands.js` unchanged (documented boundary) → intentionally no task.
- Tests → Tasks 2 + 3; build/manual → Task 8.

**2. Placeholder scan** — no TBD/TODO; every code step shows complete code or an exact command.

**3. Type/name consistency** — `publish_state` values `'live' | 'coming_soon' | 'hidden'` identical across migration, `PUBLISH_STATES`, Zod `z.enum(PUBLISH_STATES)`, editor options, and helper. Helper exports `PUBLISH_STATES` / `tileModeFor` / `isPubliclyVisible` — the same names are imported in Tasks 3, 6, 7. `TileSchema` is exported in Task 3 and imported by its test.
